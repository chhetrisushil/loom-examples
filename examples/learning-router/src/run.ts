import type { EventEnvelope } from "@loom/core";
import type { Policy, Trajectory } from "@loom/learning";
import { trajectories } from "@loom/learning";
import { buildApp } from "./app";
import { type Route, type Ticket, tickets } from "./domain";
import { registerTriageFlow } from "./flow";
import type { TriageInput, TriageOutput } from "./flow";

// ── Driving the online half, and reading the log back ─────────────────────────

export interface RunResult {
  events: EventEnvelope[];
  results: TriageOutput[];
  trajectories: Trajectory<Route>[];
  /** Mean quality actually delivered — what the live policy was worth. */
  meanQuality: number;
}

/**
 * Serve `count` tickets through the flow, then read every execution's log back
 * the way an offline job would: from the store, after the fact, with no special
 * instrumentation. The log is the whole interface between online and offline.
 */
export async function serveTickets(
  policy: Policy<Route>,
  count: number,
  opts: { learnable?: boolean; stream?: Ticket[] } = {}
): Promise<RunResult> {
  const flow = registerTriageFlow(policy, opts.learnable ?? true);
  const app = buildApp(flow);
  const runtime = app.runtime;
  const eventStore = app.stores.eventStore;

  const stream = opts.stream ?? tickets(count);
  const results: TriageOutput[] = [];
  const executionIds: string[] = [];

  for (const ticket of stream) {
    const input: TriageInput = {
      ticketId: ticket.id,
      urgent: ticket.urgent,
      length: ticket.length,
    };
    const handle = await runtime.start(flow, input);
    const final = await handle.waitForCompletion();
    executionIds.push(handle.executionId);
    results.push(final.variables._output as TriageOutput);
  }

  const events = (await Promise.all(executionIds.map((id) => eventStore.read(id)))).flat();
  const meanQuality = results.reduce((a, r) => a + r.quality, 0) / (results.length || 1);

  return {
    events,
    results,
    trajectories: trajectories<Route>(events),
    meanQuality,
  };
}
