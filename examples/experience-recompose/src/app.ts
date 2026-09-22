import {
  type Experience,
  type ExperienceNode,
  type Intent,
  type Operation,
  compile,
  genesis,
  isContainer,
  orderKeyBetween,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationController,
  HydrationStore,
  type TransientInvoker,
} from "@loom-ui/hydration";
import { type CapabilityRef, ReferencePlanner, buildProviderSpec } from "@loom-ui/planner";
import {
  type DomRegistry,
  type DomRenderHandle,
  type DomWidgetRenderer,
  type RecomposeReport,
  litRegistry,
  renderBlueprintDom,
} from "@loom-ui/renderer-lit/dom";
import { type Blueprint, RendererRegistry } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { catalog } from "./catalog";
import { alert, noteInput } from "./noteInput";
import { memoryDecide, scriptedModel } from "./planner";

const latencySummary: CapabilityRef = {
  handle: "latency_summary",
  toolName: "latency.summary",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:latency-summary-1-0",
  description: "p99 latency, phase and recent samples for a window",
  inputSchema: { type: "object", properties: { window: { type: "string" } } },
  sampleOutput: { p99Ms: 412, phase: "steady", recent: [{ at: "10:00", ms: 400 }] },
};
export const capabilities: CapabilityRef[] = [latencySummary];

const intent: Intent = {
  objective: "Watch checkout latency and leave a handoff note",
  source: "user",
};
const meta: Experience["meta"] = {
  author: "example",
  createdAt: "2026-09-22T00:00:00Z",
  sourceKind: "example",
};

/**
 * The fake tool behind the capability: what `latency.summary` returns at runtime. The planner
 * pinned `outputShapeHash` from the one-row `sampleOutput`; a shape hash deduplicates array
 * element shapes, so 30 rows of the same shape pass the pin.
 */
export const LIVE_OUTPUT = {
  p99Ms: 412,
  phase: "steady",
  recent: Array.from({ length: 30 }, (_, i) => ({
    at: `10:${String(i).padStart(2, "0")}`,
    ms: 380 + i,
  })),
};

/**
 * A `TransientInvoker` (the one method hydration needs from loom's runtime) that answers every
 * `latency.summary` call with {@link LIVE_OUTPUT} and records it. `executeProvider` routes each
 * step through loom's MCP invoke tool with `{ toolName, args, expectedSchemaHash }` as input.
 */
export class LatencyInvoker implements TransientInvoker {
  readonly calls: string[] = [];
  async invokeTransient<TIn, TOut>(_toolId: string, input: TIn): Promise<TOut> {
    const toolName = (input as { toolName?: unknown }).toolName;
    if (toolName !== "latency.summary") throw new Error(`no fake tool "${String(toolName)}"`);
    this.calls.push(toolName);
    return LIVE_OUTPUT as TOut;
  }
}

/** The app's own kinds, outside loom's catalogue. `patchable: false` drops NoteInput's `patch`. */
export const appRegistryFor = (opts: { patchable: boolean }): DomRegistry =>
  new RendererRegistry<DomWidgetRenderer>()
    .register("NoteInput", noteInput(opts))
    .register("Alert", alert);
export const appRegistry = appRegistryFor({ patchable: true });

export interface App {
  readonly runtime: InMemoryProjectionRuntime;
  readonly store: HydrationStore;
  readonly controller: HydrationController;
  readonly invoker: LatencyInvoker;
  readonly executionId: string;
  readonly registry: DomRegistry;
  readonly host: HTMLElement;
  handle: DomRenderHandle;
  experience: Experience;
  blueprint: Blueprint;
  compose(): Promise<void>;
  revise(text: string): Promise<RecomposeReport>;
  retype(nodeId: string, type: string, props: Record<string, unknown>): RecomposeReport;
  /**
   * Bind `memo`'s Note directly to a live value (the planner never does this — see
   * `catalog.ts`'s comment on `Note`'s binding). Exercises `NoteInput.update`'s "write only when
   * the bound value changed" branch, which nothing else here reaches.
   */
  bindNote(): RecomposeReport;
  /** Fire the controller's batch timers and wait until nothing is in flight. */
  settle(): Promise<void>;
  dispose(): void;
}

export const compileOptions = {
  surface: "web",
  catalog,
  hydrationProjectionId: HYDRATION_PROJECTION_ID,
  hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
} as const;

const compileWeb = (exp: Experience): Blueprint => {
  const r = compile(exp, compileOptions);
  if (!r.ok) throw new Error(`compile failed: ${r.findings.map((f) => f.message).join("; ")}`);
  return r.blueprint;
};

/** The app's layout policy, applied after the planner's ops on every revision. */
export const layoutRules: ReadonlyArray<(exp: Experience) => Operation[]> = [
  alertsFirst,
  metricsBelowCollections,
];

export function createApp(opts: { patchable?: boolean } = {}): App {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "recompose" });
  const invoker = new LatencyInvoker();
  // The controller's batch window (P1) runs on an injected timer so the example is deterministic:
  // `settle()` fires what is due instead of waiting on wall-clock time.
  const timers: Array<() => void> = [];
  const controller = new HydrationController({
    invoker,
    store,
    setTimer: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const planner = new ReferencePlanner({ model: scriptedModel(), modelId: "scripted" });
  const ctx = memoryDecide();
  const registry = litRegistry.merge(appRegistryFor({ patchable: opts.patchable ?? true }));
  const host = document.createElement("div");
  document.body.appendChild(host);

  const loaded = (exp: Experience) => {
    const { findings } = controller.load(exp);
    if (findings.length > 0) throw new Error(`hydration refused: ${JSON.stringify(findings)}`);
  };

  // `handle`/`experience`/`blueprint` don't exist until `compose()` runs (it's a method on the
  // same `App`, called by the caller after `createApp()` returns), so the object literal below
  // cannot supply real values for them up front. Backing them with `let`s the accessors below
  // read and write needs no placeholder cast: reading before `compose()` throws instead of
  // silently handing back a lie typed as the real thing.
  let handleVal: DomRenderHandle | undefined;
  let experienceVal: Experience | undefined;
  let blueprintVal: Blueprint | undefined;
  const notReady = (what: string): never => {
    throw new Error(`${what} is not ready — call compose() first`);
  };

  const app: App = {
    runtime,
    store,
    controller,
    invoker,
    executionId: store.executionId,
    registry,
    host,
    get handle() {
      return handleVal ?? notReady("handle");
    },
    set handle(h) {
      handleVal = h;
    },
    get experience() {
      return experienceVal ?? notReady("experience");
    },
    set experience(e) {
      experienceVal = e;
    },
    get blueprint() {
      return blueprintVal ?? notReady("blueprint");
    },
    set blueprint(b) {
      blueprintVal = b;
    },
    async compose() {
      const composed = await planner.compose({ intent, catalog, capabilities }, ctx);
      if (composed.ops.length === 0)
        throw new Error(`compose refused: ${JSON.stringify(composed.findings)}`);
      const g = genesis({ experienceId: "recompose", intent, meta });
      const a = replay(g, composed.ops);
      if (!a.ok) throw new Error(a.finding.message);
      app.experience = seal(a.value);
      loaded(app.experience);
      app.blueprint = compileWeb(app.experience);
      app.handle = renderBlueprintDom(host, app.blueprint, {
        projectionRuntime: runtime,
        executionId: store.executionId,
        registry,
      });
      await app.settle();
    },
    async revise(text) {
      const revised = await planner.revise(
        { experience: app.experience, request: { text }, catalog, capabilities },
        ctx
      );
      if (revised.ops.length === 0)
        throw new Error(`revise refused: ${JSON.stringify(revised.findings)}`);
      // The planner's ops, then the APP's layout policy — the planner appends new nodes and never
      // moves one; "alerts first" and "metrics below the collections" are this app's rules,
      // authored as moveNode operations and replayed in the same revision.
      let cur = replay(app.experience, revised.ops);
      for (const rule of layoutRules) {
        if (!cur.ok) break;
        cur = replay(cur.value, rule(cur.value));
      }
      if (!cur.ok) throw new Error(cur.finding.message);
      const report = land(seal(cur.value));
      await app.settle();
      return report;
    },
    retype(nodeId, type, props) {
      // A kind change is remove + insert with the SAME id: the planner refuses to re-type a node
      // (`type-unchanged`), so an app that wants one authors these two operations itself.
      const root = app.experience.root;
      if (!isContainer(root)) throw new Error("root is not a container");
      const current = root.children.find((c) => c.id === nodeId);
      if (!current || current.kind !== "semantic") throw new Error(`no semantic node "${nodeId}"`);
      const entry = catalog.entries.find((e) => e.name === type);
      if (!entry) throw new Error(`no catalogue entry "${type}"`);
      const ops: Operation[] = [
        { type: "removeNode", nodeId },
        {
          type: "insertNode",
          parentId: root.id,
          node: { ...current, type, typeVersion: entry.version, props },
        },
      ];
      const a = replay(app.experience, ops);
      if (!a.ok) throw new Error(a.finding.message);
      return land(seal(a.value));
    },
    bindNote() {
      // The same helper the planner's `materialize` uses to turn a capability + JSONPath into a
      // `ProviderSpec` — reused directly, since the app is authoring this binding itself, the
      // same way `retype` authors its own ops. `phase` is the same field the badge already
      // reads; a different node can bind the same path under its own handle.
      const built = buildProviderSpec(
        latencySummary,
        {
          capability: "latency_summary",
          arguments: { window: "1h" },
          path: "phase",
          priority: "P1",
        },
        "memo"
      );
      if (!built.ok) throw new Error(built.finding.message);
      const ops: Operation[] = [
        { type: "remapProvider", handle: built.spec.handle, spec: built.spec },
        { type: "bindProvider", nodeId: "memo", handle: built.spec.handle, priority: "P1" },
      ];
      const a = replay(app.experience, ops);
      if (!a.ok) throw new Error(a.finding.message);
      return land(seal(a.value));
    },
    async settle() {
      for (let round = 0; round < 50; round++) {
        for (const fn of timers.splice(0)) fn();
        await new Promise((r) => setTimeout(r, 0));
        if (timers.length === 0 && controller.inFlight().length === 0) return;
      }
      throw new Error("hydration did not settle");
    },
    dispose() {
      app.handle.dispose();
      controller.dispose();
      host.remove();
    },
  };
  // The two-line recipe: hydration recomposes (handles only the old artifact bound are aborted
  // and dropped, shared ones keep their values), then the DOM is reconciled by widget id.
  const land = (next: Experience): RecomposeReport => {
    app.experience = next;
    loaded(next);
    app.blueprint = compileWeb(next);
    return app.handle.update(app.blueprint);
  };
  return app;
}

const byOrder = (x: ExperienceNode, y: ExperienceNode) =>
  x.order < y.order ? -1 : x.order > y.order ? 1 : 0;
const isType = (n: ExperienceNode, type: string) => n.kind === "semantic" && n.type === type;

/** Layout rule: every Alert node goes before everything else, in its existing relative order. */
export function alertsFirst(exp: Experience): Operation[] {
  if (!isContainer(exp.root)) return [];
  const children = [...exp.root.children].sort(byOrder);
  const first = children[0];
  const alerts = children.filter((c) => isType(c, "Alert"));
  if (!first || alerts.length === 0) return [];
  const ops: Operation[] = [];
  let before: string | null = null;
  const after: string = first.order;
  for (const a of alerts) {
    if (a === first) {
      before = a.order;
      continue;
    }
    const newOrder = orderKeyBetween(before, after);
    ops.push({ type: "moveNode", nodeId: a.id, newParentId: exp.root.id, newOrder });
    before = newOrder;
  }
  return ops;
}

/**
 * Layout rule: every Metric goes after the last Collection ("the metric below the list"), in its
 * existing relative order. A Metric already below every Collection is left where it is.
 */
export function metricsBelowCollections(exp: Experience): Operation[] {
  if (!isContainer(exp.root)) return [];
  const children = [...exp.root.children].sort(byOrder);
  let lastCollection = -1;
  children.forEach((c, i) => {
    if (isType(c, "Collection")) lastCollection = i;
  });
  if (lastCollection < 0) return [];
  const ops: Operation[] = [];
  let before = (children[lastCollection] as ExperienceNode).order;
  const after = children[lastCollection + 1]?.order ?? null;
  for (const m of children.slice(0, lastCollection).filter((c) => isType(c, "Metric"))) {
    const newOrder = orderKeyBetween(before, after);
    ops.push({ type: "moveNode", nodeId: m.id, newParentId: exp.root.id, newOrder });
    before = newOrder;
  }
  return ops;
}
