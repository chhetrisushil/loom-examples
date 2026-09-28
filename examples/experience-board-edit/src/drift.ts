import {
  type Experience,
  type Intent,
  type Operation,
  type ProviderSpec,
  type SemanticCatalog,
  defineSemanticCatalog,
  genesis,
  isContainer,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  type DriftRecord,
  type TransientInvoker,
  executeProvider,
  outputShapeHashOf,
} from "@loom-ui/hydration";
import {
  type CapabilityRef,
  type DecideContext,
  type DecideOptionsLike,
  type PlannerModel,
  ReferencePlanner,
  driftCapabilities,
  driftRequest,
  reviseForDrift,
} from "@loom-ui/planner";

// ── A SECOND greenhouse widget, whose own provider is TWO steps (gap G4) ──────────────────────
// Every other provider on this board (climate.ts) is one step. Trend is not: the node's own
// capability — `greenhouse.trend`, a percentage off the current reading — depends on a raw
// station read the provider inlines as an EARLIER step. `executionGraph[0]` is therefore that
// unrelated upstream step, never the node's own (terminal) one — the shape loom-ui's own
// `driftCapabilities`/`reviseForDrift` (planner/src/drift.ts) key against. When the trend TOOL
// changes its own reply shape, hydration's real `executeProvider` produces a `DriftRecord` keyed
// on the TERMINAL step (`stepId`), and the reference planner's `revise` repairs it from a sample
// attached to THAT step's tool — never the upstream's, which is untouched throughout.

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.board-edit.drift.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
  ],
});

export const STATION_STEP = "station-read";
export const TREND_STEP = "trend-calc";

/** The inlined upstream step's own tool — NOT a capability any node binds directly. Carried as a
 * capability only so the example can prove its sample is left alone by a trend-tool drift. */
export const stationTool: CapabilityRef = {
  handle: "station_now",
  toolName: "greenhouse.station",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:greenhouse-station-1-0",
  description: "The raw current station reading — trend's inlined upstream step",
  sampleOutput: { raw: { c: 24.5 } },
};

/** The node's OWN (terminal) capability. */
export const trend: CapabilityRef = {
  handle: "trend_now",
  toolName: "greenhouse.trend",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:greenhouse-trend-1-0",
  description: "Trend, as a percentage change, off the current station reading",
  sampleOutput: { trend: { pct: 3.2 } },
};

export const capabilities: readonly CapabilityRef[] = [stationTool, trend];

/** The two-step provider: an inlined upstream read, then the node's own (terminal) calculation. */
export function trendProviderSpec(): ProviderSpec {
  return {
    handle: trend.handle,
    executionGraph: [
      {
        stepId: STATION_STEP,
        toolName: stationTool.toolName,
        toolVersion: stationTool.toolVersion,
        toolSchemaHash: stationTool.toolSchemaHash,
        arguments: {},
        dependsOn: [],
        idempotent: true,
      },
      {
        stepId: TREND_STEP,
        toolName: trend.toolName,
        toolVersion: trend.toolVersion,
        toolSchemaHash: trend.toolSchemaHash,
        // References the inlined upstream step's own output — a real dependency, not a decoration.
        arguments: { baselineC: `{{steps.${STATION_STEP}.output.raw.c}}` },
        dependsOn: [STATION_STEP],
        idempotent: true,
      },
    ],
    reshaping: { engine: "JSONPath", scriptRef: "trend.pct" },
    outputShapeHash: outputShapeHashOf(3.2),
    cachePolicy: { ttlSeconds: 60, scope: "principal" },
  };
}

/**
 * Answers both tools. `garbleTrend` changes ONLY the trend tool's own reply shape (nesting the
 * percentage one level deeper) — the upstream station read is untouched, so a drift here can only
 * ever be about the terminal step.
 */
export class GreenhouseSensor implements TransientInvoker {
  readonly calls: string[] = [];
  /** Each call's resolved arguments, so a test can prove a `{{steps…}}` template really flowed. */
  readonly args: unknown[] = [];
  constructor(private readonly opts: { garbleTrend?: boolean } = {}) {}
  async invokeTransient<TIn, TOut>(_toolId: string, input: TIn): Promise<TOut> {
    const { toolName, args } = input as { toolName: string; args?: unknown };
    this.calls.push(toolName);
    this.args.push(args);
    if (toolName === stationTool.toolName) return { raw: { c: 24.5 } } as unknown as TOut;
    if (toolName === trend.toolName) {
      return (this.opts.garbleTrend
        ? { trend: { pct: { value: 3.2 } } }
        : { trend: { pct: 3.2 } }) as unknown as TOut;
    }
    throw new Error(`no fake tool "${toolName}"`);
  }
}

export const intent: Intent = { objective: "Watch the greenhouse trend", source: "user" };
export const meta: Experience["meta"] = {
  author: "grower",
  createdAt: "2026-09-23T00:00:00Z",
  sourceKind: "example",
};

/**
 * One Metric, bound to the two-step trend provider. Authored directly with `remapProvider` +
 * an embedded `binding` (the same recipe `experience-stepped`'s `initialOperations` uses). A
 * planner's `materialize` builds a single-step provider from a fresh capability, but when a repair
 * keeps a call it rebuilds the upstream steps that call depends on, so the repaired provider
 * stays multi-step and runnable.
 */
export function trendBoard(): Experience {
  const g = genesis({ experienceId: "greenhouse-trend", intent, meta });
  const ops: Operation[] = [
    { type: "remapProvider", handle: trend.handle, spec: trendProviderSpec() },
    {
      type: "insertNode",
      parentId: g.root.id,
      node: {
        id: "trend",
        order: "a",
        kind: "semantic",
        type: "Metric",
        typeVersion: "1.0.0",
        span: 4,
        label: { key: "board.trend.label", fallback: "Trend" },
        props: { unit: "%" },
        binding: { handle: trend.handle, priority: "P0" },
      },
    },
  ];
  const r = replay(g, ops);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
}

/** The scripted repair reply: the same node and call, its path re-authored one level deeper. */
export function repairReplyFor(board: Experience): string {
  const node = isContainer(board.root) ? board.root.children[0] : undefined;
  if (node === undefined || node.kind !== "semantic" || node.binding === undefined)
    throw new Error("expected one bound semantic node");
  return JSON.stringify({
    summary: "Trend path re-authored for the new tool shape.",
    nodes: [
      {
        id: node.id,
        type: node.type,
        label: node.label?.fallback ?? node.type,
        span: node.span,
        props: node.props,
        binding: {
          capability: "trend_now",
          // Keep the observed call's argument: the drift sample belongs to this exact call.
          arguments: { baselineC: `{{steps.${STATION_STEP}.output.raw.c}}` },
          path: "trend.pct.value",
          priority: "P0",
        },
      },
    ],
  });
}

/** A `ReferencePlanner` scripted to return exactly one reply — the repair — plus loom's `ctx.decide` shape in memory. */
export function repairPlanner(reply: string): { planner: ReferencePlanner; ctx: DecideContext } {
  const model: PlannerModel = {
    async complete() {
      return { content: reply };
    },
  };
  const decisions = new Map<string, unknown>();
  const ctx: DecideContext = {
    async decide<T>(
      id: string,
      decider: () => T | Promise<T>,
      _opts?: DecideOptionsLike
    ): Promise<T> {
      if (decisions.has(id)) return decisions.get(id) as T;
      const v = await decider();
      decisions.set(id, JSON.parse(JSON.stringify(v)));
      return v;
    },
  };
  return { planner: new ReferencePlanner({ model, modelId: "scripted-repair" }), ctx };
}

export { driftCapabilities, driftRequest, executeProvider, reviseForDrift };
export type { DriftRecord };
