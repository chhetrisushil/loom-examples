import {
  type Experience,
  type Intent,
  type SemanticCatalog,
  defineSemanticCatalog,
  genesis,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  type CapabilityRef,
  type DecideContext,
  type DecideOptionsLike,
  type DecideScope,
  type PlanResult,
  type PlannerModel,
  type PlannerUsage,
  ReferencePlanner,
  providerHandle,
} from "@loom-ui/planner";

// A greenhouse board: air temperature, humidity and the watering log, all read from ONE climate
// tool. Three paths into one tool are three providers (the reshaping path is part of a
// provider's identity), which is what lets one widget and its provider be retired on its own.

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.board-edit.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
    {
      name: "Collection",
      version: "1.0.0",
      props: ["columns"],
      binding: "required",
      surfaces: { web: { kind: "DataTable" }, terminal: { kind: "DataTable" } },
    },
  ],
});

export const climate: CapabilityRef = {
  handle: "climate_now",
  toolName: "greenhouse.climate",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:greenhouse-climate-1-0",
  description: "Current greenhouse climate readings and today's watering log",
  sampleOutput: { airC: 24.5, humidityPct: 61, log: [{ at: "06:00", litres: 12 }] },
};

/** The provider handle the reference planner mints for a path into the climate tool. */
export const handleFor = (path: string): string =>
  providerHandle(climate.toolName, climate.toolVersion, climate.toolSchemaHash, {}, path);

export const intent: Intent = {
  objective: "Watch the greenhouse climate and the watering log",
  source: "user",
};
export const meta: Experience["meta"] = {
  author: "grower",
  createdAt: "2026-09-23T00:00:00Z",
  sourceKind: "example",
};

const node = (
  id: string,
  type: string,
  label: string,
  span: number,
  props: Record<string, unknown>,
  path: string,
  priority: "P0" | "P1"
) => ({
  id,
  type,
  label,
  span,
  props,
  binding: { capability: "climate_now", arguments: {}, path, priority },
});

/** What a model returns for the compose. */
export const COMPOSE = JSON.stringify({
  summary: "Climate and watering at a glance.",
  nodes: [
    node("temperature", "Metric", "Air temperature", 4, { unit: "°C" }, "airC", "P0"),
    node("humidity", "Metric", "Humidity", 4, { unit: "%" }, "humidityPct", "P1"),
    node("watering", "Collection", "Watering log", 12, { columns: ["at", "litres"] }, "log", "P1"),
  ],
});
/** "drop the watering log" — the user already resized temperature to 6 and retired humidity; the reply keeps both. */
export const REVISE_DROP_LOG = JSON.stringify({
  summary: "Watering log removed.",
  nodes: [node("temperature", "Metric", "Air temperature", 6, { unit: "°C" }, "airC", "P0")],
});

/** The token counts the scripted model reports — what a real provider's `usage` would carry. */
export const USAGE = {
  compose: { inputTokens: 900, outputTokens: 210 },
  revise: { inputTokens: 1100, outputTokens: 60 },
} as const satisfies Record<string, PlannerUsage>;

/** Compose reply first, then the revision; each with its usage. Counts calls. */
export function scriptedModel(): PlannerModel & { calls: number } {
  const replies = [
    { content: COMPOSE, usage: USAGE.compose },
    { content: REVISE_DROP_LOG, usage: USAGE.revise },
  ];
  const model = {
    calls: 0,
    async complete() {
      const reply = replies[Math.min(model.calls, replies.length - 1)]!;
      model.calls += 1;
      return { content: reply.content, usage: { ...reply.usage } };
    },
  };
  return model;
}

/**
 * The scope this in-memory decide hands its decider. These scripted models never reach a tool
 * through it, so a call is a bug in the example — say so rather than invent an answer.
 */
const NO_SCOPE: DecideScope = {
  invokeTransient() {
    return Promise.reject(new Error("the in-memory decide has no transient scope"));
  },
};

/**
 * loom's `ctx.decide` shape, in memory: the decider runs once per id and the value is kept as
 * JSON — the form loom persists it in — so a replay is served exactly what the log would hold.
 */
export function memoryDecide(): DecideContext {
  const decisions = new Map<string, unknown>();
  return {
    async decide<T>(
      id: string,
      decider: (scope: DecideScope) => T | Promise<T>,
      _opts?: DecideOptionsLike
    ): Promise<T> {
      if (decisions.has(id)) return decisions.get(id) as T;
      const value = await decider(NO_SCOPE);
      decisions.set(id, JSON.parse(JSON.stringify(value)));
      return value;
    },
  };
}

export async function composeBoard(): Promise<{
  model: PlannerModel & { calls: number };
  ctx: DecideContext;
  planner: ReferencePlanner;
  input: { intent: Intent; catalog: SemanticCatalog; capabilities: CapabilityRef[] };
  composed: PlanResult;
  board: Experience;
}> {
  const model = scriptedModel();
  const ctx = memoryDecide();
  const planner = new ReferencePlanner({ model, modelId: "scripted-board" });
  const input = { intent, catalog, capabilities: [climate] };
  const composed = await planner.compose(input, ctx);
  const folded = replay(genesis({ experienceId: "greenhouse", intent, meta }), composed.ops);
  if (!folded.ok) throw new Error(folded.finding.message);
  return { model, ctx, planner, input, composed, board: seal(folded.value) };
}
