import type { ReadPolicy } from "@loom-ui/core";
import type { TransientInvoker } from "@loom-ui/hydration";
import { type CapabilityRef, declaredToolClassesFrom } from "@loom-ui/planner";

// The tools behind the triage view. Three are internal; the refund exposure is CLASSIFIED
// (`secret`): the class is declared ONCE, on the capability, and everything else follows from it.

const cap = (
  handle: string,
  toolName: string,
  description: string,
  sensitivity: NonNullable<CapabilityRef["sensitivity"]>,
  sampleOutput: unknown
): CapabilityRef => ({
  handle,
  toolName,
  toolVersion: "1.0.0",
  toolSchemaHash: `sha256:${toolName.replace(".", "-")}-1-0`,
  description,
  sensitivity,
  sampleOutput,
});

export const stats = cap("ticket_stats", "tickets.stats", "Ticket counts", "internal", {
  open: 42,
  waiting: 11,
  breaches: 5,
});
export const queue = cap("ticket_queue", "tickets.queue", "The triage queue", "internal", {
  queue: [{ id: "T-1", subject: "Cannot log in", priority: "high" }],
});
export const history = cap("ticket_history", "tickets.history", "Resolved per day", "internal", {
  history: [{ day: "Mon", resolved: 31 }],
});
export const refunds = cap(
  "refund_exposure",
  "billing.refunds",
  "Refunds awaiting approval (finance only)",
  "secret",
  { pending: 18400, count: 23 }
);
export const capabilities: CapabilityRef[] = [stats, queue, history, refunds];

/**
 * The host's read policy, derived from the SAME capabilities the planner is offered, so the two
 * cannot disagree. ONE table, passed to every read path: the hydration controller and `Lineage`
 * bind it once; `compile` takes it per call (core has no bound option).
 */
export const declaredToolClasses = declaredToolClassesFrom(capabilities);
export const readPolicy: ReadPolicy = { declaredToolClasses };

/** What the tools return right now. Row counts differ from the one-row samples on purpose. */
export const LIVE: Record<string, unknown> = {
  "tickets.stats": { open: 42, waiting: 11, breaches: 5 },
  "tickets.queue": {
    queue: [
      { id: "T-1", subject: "Cannot log in", priority: "high" },
      { id: "T-2", subject: "Invoice is wrong", priority: "normal" },
      { id: "T-3", subject: "Export fails", priority: "high" },
    ],
  },
  "tickets.history": {
    history: [
      { day: "Mon", resolved: 31 },
      { day: "Tue", resolved: 27 },
      { day: "Wed", resolved: 35 },
    ],
  },
  "billing.refunds": { pending: 18400, count: 23 },
};

/** A fake transient invoker: answers each tool from {@link LIVE} and records which it was asked. */
export class TriageInvoker implements TransientInvoker {
  readonly calls: string[] = [];
  async invokeTransient<TIn, TOut>(_toolId: string, input: TIn): Promise<TOut> {
    const toolName = String((input as { toolName?: unknown }).toolName);
    if (!(toolName in LIVE)) throw new Error(`no fake tool "${toolName}"`);
    this.calls.push(toolName);
    return LIVE[toolName] as TOut;
  }
}
