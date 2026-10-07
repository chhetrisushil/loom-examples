import type { DecideContext, DecideOptionsLike, DecideScope, PlannerModel } from "@loom-ui/planner";

// ── The scripted model ──────────────────────────────────────────────────────────────────────
// A reply is the FLAT entry list the planner contract takes: a container is an entry with
// `container`, and its members name it with `parent` (an EARLIER container). A revise reply
// restates the whole planner-owned region as it should be afterwards — the planner diffs it
// against what is there, entry by entry.

type Entry = Record<string, unknown>;

const box = (id: string, container: string, title: string | null, parent?: string): Entry => ({
  id,
  container,
  ...(title !== null && { title }),
  span: 12,
  ...(parent !== undefined && { parent }),
});
const metric = (
  id: string,
  label: string,
  cap: string,
  path: string,
  unit: string,
  parent: string
): Entry => ({
  id,
  type: "Metric",
  label,
  span: 6,
  parent,
  props: { unit },
  binding: { capability: cap, arguments: {}, path, priority: "P1" },
});
const table = (
  id: string,
  label: string,
  cap: string,
  path: string,
  columns: string[],
  parent: string
): Entry => ({
  id,
  type: "Collection",
  label,
  span: 12,
  parent,
  props: { columns },
  binding: { capability: cap, arguments: {}, path, priority: "P1" },
});
const memo = (id: string, text: string, parent: string): Entry => ({
  id,
  type: "Memo",
  label: "Notes",
  span: 12,
  parent,
  props: { text },
});

export interface Shape {
  /** The role of the one container that holds the panels. */
  role?: "tabs" | "stepper";
  /** Which panel holds the SLA-breach metric. */
  sla?: "queue" | "overview";
  /** A Notes panel on the end. */
  notes?: boolean;
  /**
   * A Refunds panel. `true`: its cards are ALL bound to the `secret` capability. `"mixed"`: one
   * card is, one is an ordinary ticket count.
   */
  refunds?: boolean | "mixed";
}

/** The reply that yields `shape` (the default is the first composition). */
export function entries({
  role = "tabs",
  sla = "queue",
  notes = false,
  refunds = false,
}: Shape = {}): Entry[] {
  const slaCard = metric("sla", "SLA breaches", "ticket_stats", "breaches", "tickets", sla);
  return [
    box("views", role, "Support triage"),
    box("overview", "section", "Overview", "views"),
    metric("open", "Open tickets", "ticket_stats", "open", "tickets", "overview"),
    metric("waiting", "Awaiting customer", "ticket_stats", "waiting", "tickets", "overview"),
    ...(sla === "overview" ? [slaCard] : []),
    box("queue", "section", "Queue", "views"),
    ...(sla === "queue" ? [slaCard] : []),
    table(
      "queue_list",
      "Triage queue",
      "ticket_queue",
      "queue",
      ["id", "subject", "priority"],
      "queue"
    ),
    box("history", "section", "History", "views"),
    table(
      "history_list",
      "Resolved per day",
      "ticket_history",
      "history",
      ["day", "resolved"],
      "history"
    ),
    ...(notes
      ? [
          box("notes", "section", "Notes", "views"),
          memo("handoff", "Hand off open escalations before 17:00.", "notes"),
        ]
      : []),
    ...(refunds
      ? [
          box("refunds", "section", "Refunds", "views"),
          metric(
            "refund_pending",
            "Pending refunds",
            "refund_exposure",
            "pending",
            "USD",
            "refunds"
          ),
          refunds === "mixed"
            ? metric("refund_note", "Open tickets", "ticket_stats", "open", "tickets", "refunds")
            : metric(
                "refund_count",
                "Refund requests",
                "refund_exposure",
                "count",
                "requests",
                "refunds"
              ),
        ]
      : []),
  ];
}

export const reply = (nodes: Entry[], summary = "Ticket triage"): string =>
  JSON.stringify({ summary, nodes });

/** A model that serves `replies` in order (the last repeats) and counts its calls. */
export function scriptedModel(replies: readonly string[]): PlannerModel & { calls: number } {
  const model = {
    calls: 0,
    async complete() {
      const content = replies[Math.min(model.calls, replies.length - 1)] as string;
      model.calls += 1;
      return { content, usage: { inputTokens: 600, outputTokens: 220 } };
    },
  };
  return model;
}

const NO_SCOPE: DecideScope = {
  invokeTransient() {
    return Promise.reject(new Error("the in-memory decide has no transient scope"));
  },
};

/** loom's `ctx.decide` shape in memory: one decision per id, kept as JSON like the log keeps it. */
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
