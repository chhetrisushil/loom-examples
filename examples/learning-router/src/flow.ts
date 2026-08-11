import { recordOutcome } from "@loom/analytics";
import { flow$, handler$, step$ } from "@loom/core";
import { decideWithPolicy } from "@loom/learning";
import type { Policy } from "@loom/learning";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { ROUTES, type Route, quality } from "./domain";
import { contextOf } from "./policy";

// ── The online half ───────────────────────────────────────────────────────────
//
// One flow, one learned decision. The two lines that matter are `decideWithPolicy`
// and `recordOutcome`; everything else is ordinary Loom.
//
// The property that makes this safe: the route is resolved through `ctx.decide`,
// so it is recorded once and served from the log on every replay. The policy can
// improve between runs — that is the point — and no past execution ever replays
// differently. A learned system that stayed auditable.

const triageInput = z.object({
  ticketId: z.string(),
  urgent: z.number(),
  length: z.number(),
});
const triageOutput = z.object({
  ticketId: z.string(),
  route: z.string(),
  quality: z.number(),
});

export type TriageInput = z.infer<typeof triageInput>;
export type TriageOutput = z.infer<typeof triageOutput>;

export const AnswerStep = step$({
  id: "answer-ticket",
  inputSchema: z.object({
    ticketId: z.string(),
    route: z.string(),
    urgent: z.number(),
    length: z.number(),
  }),
  outputSchema: z.object({ quality: z.number() }),
  handler: handler$(
    async (input: { ticketId: string; route: string; urgent: number; length: number }) => {
      // Stands in for actually calling the model. Deterministic, so the example's
      // output is stable and the execution replays identically.
      return {
        quality: quality(input.route as Route, {
          id: input.ticketId,
          urgent: input.urgent,
          length: input.length,
        }),
      };
    }
  ),
});

/**
 * @param policy the LIVE policy — the one choosing right now. It is a plain
 * constructor argument, not framework state: loom has no idea a policy exists.
 * @param learnable when false, the flow makes the same choice through a bare
 * `ctx.decide` with no context and an unlinked outcome — the "before" case, kept
 * so the example can show what such a log costs you later.
 */
export function triageRunner(
  policy: Policy<Route>,
  learnable = true
): FlowRunner<TriageInput, TriageOutput> {
  return async (ctx, input) => {
    const context = contextOf(input);

    const route = learnable
      ? await decideWithPolicy(ctx, "route", policy, context, [...ROUTES])
      : ((await ctx.decide("route", () => policy.select(context, [...ROUTES]).action)) as Route);

    const { quality: score } = await ctx.run(AnswerStep, {
      ticketId: input.ticketId,
      route,
      urgent: input.urgent,
      length: input.length,
    });

    // `decisionId` is what turns a global per-arm average into per-decision
    // credit. Omit it and the reward can still be counted, but it can no longer
    // be attributed — which is the difference between a number and a lesson.
    recordOutcome(ctx, {
      key: route,
      score,
      ...(learnable && { decisionId: "route" }),
    });

    return { ticketId: input.ticketId, route, quality: score };
  };
}

export const TriageFlow = flow$({
  id: "triage",
  name: "Ticket Triage",
  version: "1.0.0",
  inputSchema: triageInput,
  outputSchema: triageOutput,
  steps: [AnswerStep],
});

export function registerTriageFlow(policy: Policy<Route>, learnable = true): RegisteredFlow {
  return {
    definition: TriageFlow,
    runner: triageRunner(policy, learnable) as FlowRunner<unknown, unknown>,
  };
}
