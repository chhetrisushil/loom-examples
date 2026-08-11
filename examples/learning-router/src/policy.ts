import type { Policy, PolicyContext, TrajectoryStep } from "@loom/learning";
import { LinUcbPolicy, numericFeatures } from "loom-plugin-linucb";
import { type Route, seededRng } from "./domain";

// ── The policy (third-party) ──────────────────────────────────────────────────
//
// Note what is NOT in this file: any loom import that does learning. Loom ships
// the substrate — the durable (context, action, propensity, reward) record and
// the machinery to evaluate a candidate — and the algorithm comes from a 3P
// package implementing the one-method `Policy` SPI. Swapping LinUCB for anything
// else is a one-line change here and nothing else in the example moves.

/** The observation the policy keys on. Keep it small — it is written to the log. */
export const FEATURES = numericFeatures(["urgent", "length"]);

export function buildPolicy(opts: {
  version: string;
  epsilon?: number;
  seed?: number;
}): LinUcbPolicy<Route> {
  return new LinUcbPolicy<Route>({
    id: "triage-router",
    version: opts.version,
    ...FEATURES,
    alpha: 0.6,
    // WHY epsilon > 0: with epsilon 0 LinUCB is deterministic, every decision is
    // logged with propensity 1, and the resulting log contains no counterfactuals
    // — so it can never support an unbiased estimate of the NEXT candidate. A
    // small epsilon is what keeps the loop able to keep learning. The `rng` is
    // injected and seeded so this example is reproducible.
    epsilon: opts.epsilon ?? 0.15,
    rng: seededRng(opts.seed ?? 42),
  });
}

/** Turn a ticket into the context the policy (and the log) will see. */
export function contextOf(ticket: { urgent: number; length: number }): PolicyContext {
  return { urgent: ticket.urgent, length: ticket.length };
}

/**
 * Train a fresh policy offline from trajectories mined out of the log. This is
 * the whole "training" story: it happens out of band, it reads only durable
 * facts, and it produces a NEW VERSION rather than mutating anything live.
 */
export function trainCandidate(
  steps: readonly TrajectoryStep<Route>[],
  version: string
): { policy: Policy<Route>; applied: number; evidence: Record<string, number> } {
  // epsilon 0: a candidate under evaluation should be judged on what it would
  // actually choose, not on its exploration noise.
  const policy = buildPolicy({ version, epsilon: 0 });
  const applied = policy.fit(steps);
  return { policy, applied, evidence: policy.evidence() };
}
