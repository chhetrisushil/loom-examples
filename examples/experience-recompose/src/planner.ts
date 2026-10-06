import type { DecideContext, DecideOptionsLike, DecideScope, PlannerModel } from "@loom-ui/planner";

// The compose draft and two revisions, as a real model would return them. Ids are STABLE across
// revisions — that is what keyed recompose keys on. Spans: a 12-column row. The planner appends
// a NEW node at the end and never re-types or moves one; the app's layout rules do the moving
// ("alerts first", "metrics below the collections" — `layoutRules` in app.ts).
const node = (
  id: string,
  type: string,
  label: string,
  span: number,
  props: Record<string, unknown>,
  binding?: unknown
) => ({ id, type, label, span, props, ...(binding !== undefined && { binding }) });
const bind = (path: string, priority: "P0" | "P1") => ({
  capability: "latency_summary",
  arguments: { window: "1h" },
  path,
  priority,
});

export const COMPOSE = JSON.stringify({
  summary: "Latency board with a handoff note.",
  nodes: [
    node("latency", "Metric", "Latency p99", 4, { unit: "ms" }, bind("p99Ms", "P0")),
    node("phase", "Status", "Phase", 4, {}, bind("phase", "P1")),
    node("memo", "Note", "Note", 4, { label: "Handoff note" }),
    node(
      "recent",
      "Collection",
      "Recent samples",
      12,
      { columns: ["at", "ms"] },
      bind("recent", "P1")
    ),
  ],
});

/** "add an alert above the note, move the metric below the list, show latency in seconds, drop the badge" — the model cannot move a node, so the move is left to the app's layout rule. */
export const REVISE_MAIN = JSON.stringify({
  summary: "Alert added; latency in seconds; badge dropped.",
  nodes: [
    node("latency", "Metric", "Latency p99", 4, { unit: "s" }, bind("p99Ms", "P0")),
    node("memo", "Note", "Note", 4, { label: "Handoff note" }),
    node(
      "recent",
      "Collection",
      "Recent samples",
      12,
      { columns: ["at", "ms"] },
      bind("recent", "P1")
    ),
    node("alert", "Alert", "Provider degraded — values may lag", 12, { tone: "warn" }),
  ],
});

/** "relabel the note for the on-call" */
export const REVISE_RELABEL = JSON.stringify({
  summary: "Note relabelled.",
  nodes: [
    node("latency", "Metric", "Latency p99", 4, { unit: "ms" }, bind("p99Ms", "P0")),
    node("phase", "Status", "Phase", 4, {}, bind("phase", "P1")),
    node("memo", "Note", "Note", 4, { label: "Notes for the on-call" }),
    node(
      "recent",
      "Collection",
      "Recent samples",
      12,
      { columns: ["at", "ms"] },
      bind("recent", "P1")
    ),
  ],
});

/** Picks the scripted reply by the revise request text; the compose reply first. */
export function scriptedModel(): PlannerModel {
  let composed = false;
  return {
    async complete(req) {
      if (!composed) {
        composed = true;
        return { content: COMPOSE };
      }
      const text = req.messages.map((m) => m.content).join("\n");
      return { content: text.includes("relabel") ? REVISE_RELABEL : REVISE_MAIN };
    },
  };
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

/** Runs the decider once per id and remembers the result — loom's `ctx.decide` shape, in memory. */
export function memoryDecide(): DecideContext {
  const decisions = new Map<string, unknown>();
  return {
    async decide<T>(
      id: string,
      decider: (scope: DecideScope) => T | Promise<T>,
      _opts?: DecideOptionsLike
    ): Promise<T> {
      if (decisions.has(id)) return decisions.get(id) as T;
      const v = await decider(NO_SCOPE);
      decisions.set(id, JSON.parse(JSON.stringify(v)));
      return v;
    },
  };
}
