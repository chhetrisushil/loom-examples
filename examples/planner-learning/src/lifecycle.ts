import {
  type EvalReport,
  PromotionRefusedError,
  type RolloutState,
  type Trajectory,
  evaluatePolicy,
  promotionGate,
  sliceByVersion,
} from "@loom/learning";
import { BOOTSTRAP, type Batch, GATE, type Lab } from "./lab";
import { POLICY_ID, type Version, versionHash } from "./policies";
import type { Epoch, Layout } from "./world";

// ── The rollout controller (APPLICATION code) ───────────────────────────────────────────────
// loom ships the primitives (register / promote / ramp / rollback, each gated); WHEN to call them
// is yours (ADR 0124 D9). This is the smallest honest controller: every transition is a fresh
// off-policy evaluation of the candidate on traffic the INCUMBENT served, run through the registry's
// own gate. A refused promotion is the signal to roll back.

/** The steps an arm of a rollout served: sliced by the version that ACTED (per-arm, ADR 0124 D2). */
export function armOf(trajs: Trajectory<Layout>[], version: string): Trajectory<Layout>[] {
  return sliceByVersion(trajs, "policy").get(`${POLICY_ID}\u0000${version}`) ?? [];
}

/** Mean delivered reward of an arm (what viewers actually rated). */
export function meanReward(trajs: Trajectory<Layout>[]): number {
  const r = trajs
    .flatMap((t) => t.steps)
    .flatMap((s) => (s.reward === undefined ? [] : [s.reward]));
  return r.length === 0 ? Number.NaN : r.reduce((a, b) => a + b, 0) / r.length;
}

/** Evaluate `candidate` on a log the incumbent wrote: SNIPS + a seeded unit-bootstrap interval. */
export function evaluateCandidate(
  lab: Lab,
  trajs: Trajectory<Layout>[],
  candidate: Version
): EvalReport {
  return evaluatePolicy(trajs, lab.policies.candidate(candidate), { bootstrap: BOOTSTRAP });
}

export const fmt = (n: number | undefined, d = 3): string =>
  n === undefined || Number.isNaN(n) ? "n/a" : n.toFixed(d);

export function describeReport(r: EvalReport): string {
  const iv = r.intervals?.snips?.lift;
  const ci = iv === undefined ? "" : ` CI[${fmt(iv.lower)}, ${fmt(iv.upper)}]`;
  const gate = promotionGate(r, GATE);
  return `v${r.policy.version}: logged ${fmt(r.loggedValue)} -> est ${fmt(r.estimatedValue)} lift ${fmt(r.lift)}${ci} over ${r.evaluated} steps / ${r.units ?? "?"} units => gate ${gate.ok ? "PASS" : `REFUSE (${gate.reasons[0]})`}`;
}

export interface TrialOptions {
  /** A log the incumbent wrote, to judge the candidate on BEFORE it touches anyone. */
  evidence: Trajectory<Layout>[];
  incumbent: Version;
  shadow: { users: number; epoch: Epoch };
  canary: { users: number; epoch: Epoch; fraction: number };
  say?: (line: string) => void;
}

export interface TrialResult {
  candidate: Version;
  outcome: "promoted" | "rolled-back" | "refused-offline" | "refused-after-shadow";
  reports: { offline: EvalReport; shadow?: EvalReport; canary?: EvalReport };
  batches: { shadow?: Batch; canary?: Batch };
  state?: RolloutState;
  reasons: string[];
}

/** The gate's reasons for a refusal. Anything else (a KV/IO failure) is NOT a refusal: it is rethrown. */
const refusal = (e: unknown): string[] => {
  if (!(e instanceof PromotionRefusedError)) throw e;
  return e.reasons.length > 0 ? [...e.reasons] : [e.message];
};

/**
 * register -> offline gate -> SHADOW -> gate -> CANARY -> gate -> FULL, or rollback.
 * Each `promote` re-runs the gate inside the registry over the report passed to it.
 */
export async function trial(lab: Lab, candidate: Version, o: TrialOptions): Promise<TrialResult> {
  const say = o.say ?? (() => {});
  const reg = lab.registry;
  const now = () => Date.parse(lab.iso());
  const result: TrialResult = {
    candidate,
    outcome: "promoted",
    reports: { offline: evaluateCandidate(lab, o.evidence, candidate) },
    batches: {},
    reasons: [],
  };
  await reg.register({
    id: POLICY_ID,
    version: candidate,
    contentHash: versionHash(candidate),
    now: now(),
  });
  say(`registered v${candidate} (${versionHash(candidate).slice(0, 19)}...)`);
  say(`offline  ${describeReport(result.reports.offline)}`);

  try {
    await reg.promote({
      id: POLICY_ID,
      version: candidate,
      report: result.reports.offline,
      mode: "shadow",
      now: now(),
    });
  } catch (e) {
    result.outcome = "refused-offline";
    result.reasons = refusal(e);
    say(`offline gate refused: ${result.reasons.join("; ")}`);
    return result;
  }

  // SHADOW: the candidate is run on every decision and logged, but the incumbent acts.
  const shadow = await lab.serve(`shadow-${candidate}`, o.shadow.users, o.shadow.epoch);
  await lab.settle(shadow);
  const shadowTrajs = await lab.trajectories(shadow);
  result.batches.shadow = shadow;
  result.reports.shadow = evaluateCandidate(lab, armOf(shadowTrajs, o.incumbent), candidate);
  say(
    `shadow   ${shadow.surfaces.length} users served by v${o.incumbent} only; ${describeReport(result.reports.shadow)}`
  );
  try {
    await reg.promote({
      id: POLICY_ID,
      version: candidate,
      report: result.reports.shadow,
      mode: "canary",
      canaryFraction: o.canary.fraction,
      now: now(),
    });
  } catch (e) {
    result.reasons = refusal(e); // before the rollback: an IO failure must not masquerade as a refusal
    await reg.rollback({ id: POLICY_ID, now: now(), note: "shadow gate refused" });
    result.outcome = "refused-after-shadow";
    say(`shadow gate refused: ${result.reasons.join("; ")}`);
    return result;
  }

  // CANARY: a stable slice of units is served by the candidate.
  const canary = await lab.serve(`canary-${candidate}`, o.canary.users, o.canary.epoch);
  await lab.settle(canary);
  const canaryTrajs = await lab.trajectories(canary);
  result.batches.canary = canary;
  const mine = armOf(canaryTrajs, candidate);
  const theirs = armOf(canaryTrajs, o.incumbent);
  say(
    `canary   ${mine.length} users on v${candidate} (mean rating ${fmt(meanReward(mine))}) vs ${theirs.length} on v${o.incumbent} (${fmt(meanReward(theirs))})`
  );
  // Judge the candidate on the INCUMBENT's randomised arm of the canary window: fresh traffic.
  result.reports.canary = evaluateCandidate(lab, theirs, candidate);
  say(`canary   ${describeReport(result.reports.canary)}`);
  try {
    result.state = await reg.promote({
      id: POLICY_ID,
      version: candidate,
      report: result.reports.canary,
      mode: "full",
      now: now(),
    });
    result.outcome = "promoted";
    say(`PROMOTED v${candidate} to full`);
  } catch (e) {
    result.reasons = refusal(e);
    result.state = await reg.rollback({ id: POLICY_ID, now: now(), note: "canary gate refused" });
    result.outcome = "rolled-back";
    say(`gate refused (${result.reasons.join("; ")}) -> ROLLED BACK to v${result.state.incumbent}`);
  }
  return result;
}
