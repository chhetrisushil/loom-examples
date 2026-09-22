import {
  type Experience,
  type Intent,
  type Operation,
  compile,
  experienceHandles,
  genesis,
  isContainer,
  orderKeyBetween,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
} from "@loom-ui/hydration";
import { type CapabilityRef, ReferencePlanner } from "@loom-ui/planner";
import {
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

export const capabilities: CapabilityRef[] = [
  {
    handle: "latency_summary",
    toolName: "latency.summary",
    toolVersion: "1.0.0",
    toolSchemaHash: "sha256:latency-summary-1-0",
    description: "p99 latency, phase and recent samples for a window",
    inputSchema: { type: "object", properties: { window: { type: "string" } } },
    sampleOutput: { p99Ms: 412, phase: "steady", recent: [{ at: "10:00", ms: 400 }] },
  },
];

const intent: Intent = {
  objective: "Watch checkout latency and leave a handoff note",
  source: "user",
};
const meta: Experience["meta"] = {
  author: "example",
  createdAt: "2026-09-22T00:00:00Z",
  sourceKind: "example",
};

/** The app's own kinds, outside loom's catalogue. `patchable: false` drops NoteInput's `patch`. */
export const appRegistryFor = (opts: { patchable: boolean }) =>
  new RendererRegistry<DomWidgetRenderer>()
    .register("NoteInput", noteInput(opts))
    .register("Alert", alert);
export const appRegistry = appRegistryFor({ patchable: true });

export interface App {
  readonly runtime: InMemoryProjectionRuntime;
  readonly store: HydrationStore;
  readonly executionId: string;
  readonly host: HTMLElement;
  handle: DomRenderHandle;
  experience: Experience;
  blueprint: Blueprint;
  compose(): Promise<void>;
  revise(text: string): Promise<RecomposeReport>;
  retype(nodeId: string, type: string, props: Record<string, unknown>): RecomposeReport;
}

const compileWeb = (exp: Experience): Blueprint => {
  const r = compile(exp, {
    surface: "web",
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
  });
  if (!r.ok) throw new Error(`compile failed: ${r.findings.map((f) => f.message).join("; ")}`);
  return r.blueprint;
};

/** What the scripted provider delivers, by the JSONPath the planner pinned for each handle. */
const SAMPLE: Record<string, unknown> = {
  p99Ms: 412,
  phase: "steady",
  recent: Array.from({ length: 30 }, (_, i) => ({
    at: `10:${String(i).padStart(2, "0")}`,
    ms: 380 + i,
  })),
};

export function createApp(opts: { patchable?: boolean } = {}): App {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "recompose" });
  const planner = new ReferencePlanner({ model: scriptedModel(), modelId: "scripted" });
  const ctx = memoryDecide();
  const registry = litRegistry.merge(appRegistryFor({ patchable: opts.patchable ?? true }));
  const host = document.createElement("div");
  document.body.appendChild(host);

  // Scripted "hydration": what the provider would deliver for each handle the artifact binds.
  // Handles are content hashes (`providerHandle`), so the value is chosen by the provider spec's
  // pinned JSONPath (`reshaping.scriptRef`), not by the handle's name.
  const deliver = (exp: Experience) => {
    for (const h of experienceHandles(exp)) {
      const path = exp.providers[h.handle]?.reshaping.scriptRef;
      if (path !== undefined && path in SAMPLE)
        store.setValue(h.handle, SAMPLE[path], { state: "ready" });
    }
  };

  const app: App = {
    runtime,
    store,
    executionId: store.executionId,
    host,
    handle: undefined as unknown as DomRenderHandle,
    experience: undefined as unknown as Experience,
    blueprint: undefined as unknown as Blueprint,
    async compose() {
      const composed = await planner.compose({ intent, catalog, capabilities }, ctx);
      if (composed.ops.length === 0)
        throw new Error(`compose refused: ${JSON.stringify(composed.findings)}`);
      const g = genesis({ experienceId: "recompose", intent, meta });
      const a = replay(g, composed.ops);
      if (!a.ok) throw new Error(a.finding.message);
      app.experience = seal(a.value);
      deliver(app.experience);
      app.blueprint = compileWeb(app.experience);
      app.handle = renderBlueprintDom(host, app.blueprint, {
        projectionRuntime: runtime,
        executionId: store.executionId,
        registry,
      });
    },
    async revise(text) {
      const revised = await planner.revise(
        { experience: app.experience, request: { text }, catalog, capabilities },
        ctx
      );
      if (revised.ops.length === 0)
        throw new Error(`revise refused: ${JSON.stringify(revised.findings)}`);
      // The planner's ops, then the APP's layout rule — the planner appends new nodes and never
      // moves one; "alerts first" is this app's policy, authored as moveNode operations.
      const a = replay(app.experience, revised.ops);
      if (!a.ok) throw new Error(a.finding.message);
      const b = replay(a.value, alertsFirst(a.value));
      if (!b.ok) throw new Error(b.finding.message);
      return land(seal(b.value));
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
  };
  const land = (next: Experience): RecomposeReport => {
    app.experience = next;
    deliver(next); // in a real app: controller.load(next) — hydration recomposes, shared handles keep their values
    app.blueprint = compileWeb(next);
    return app.handle.update(app.blueprint);
  };
  return app;
}

/** The app's layout rule: every Alert node goes before everything else, in its existing relative order. */
export function alertsFirst(exp: Experience): Operation[] {
  if (!isContainer(exp.root)) return [];
  const children = [...exp.root.children].sort((x, y) =>
    x.order < y.order ? -1 : x.order > y.order ? 1 : 0
  );
  const first = children[0];
  const alerts = children.filter((c) => c.kind === "semantic" && c.type === "Alert");
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
