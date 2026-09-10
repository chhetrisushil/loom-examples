import type { BaselineReport, Distribution, Rate } from "./metrics";
import { ttmRegressed } from "./metrics";

// ── The Phase 3 gate: is there enough here to justify touching identity? ─────
//
// Phases 0–2 do not modify the compiler, the blueprint, or blueprint identity, which is
// what makes them reversible. Phase 3 does. So the question this answers is not "did
// adaptation help" but "did it help ENOUGH, and without harm, to justify a change that
// cannot be quietly undone".
//
// The submission gates Phase 3 on a cache-degradation analysis at k ∈ {4, 6, 12}. That
// gate has no referent here: there is no derivation cache to degrade, so the analysis
// would measure nothing. What remains is the part that always mattered — evidence that
// the effect is real, that the counter-metrics did not move the wrong way, and that the
// guardrail held.
//
// Three verdicts, deliberately, because two would collapse the one distinction that
// matters most:
//
//   • `blocked`               — measured, and the answer is no.
//   • `insufficient-evidence` — not measured well enough to say. NOT a pass, and not a
//                               failure either: the next action is more data, not a
//                               redesign.
//   • `clear`                 — measured, positive, and nothing else regressed.
//
// A gate that returned `clear` on a thin sample would be worse than no gate: it would
// launder an absence of evidence into a decision, and the decision it launders is an
// irreversible one.

export type GateDecision = "clear" | "blocked" | "insufficient-evidence";

export interface MetricComparison {
  metric: string;
  baseline: number | null;
  candidate: number | null;
  /** `null` when either side is unmeasured — never silently zero. */
  delta: number | null;
  /** The populations behind the two numbers, so a "20% lift" over nine sessions reads as one. */
  support: { baseline: number; candidate: number };
}

export interface GateVerdict {
  decision: GateDecision;
  reasons: string[];
  comparisons: MetricComparison[];
}

export interface GateThresholds {
  /**
   * Sessions required in EACH arm before any comparison is believed. Deliberately a
   * parameter with an explicit default rather than a constant buried in the code: it is
   * the number that decides whether a result is evidence, and it should be argued about.
   */
  minSessionsPerArm?: number;
  /** Minimum improvement in task success worth an irreversible change. */
  minSuccessLift?: number;
  /** How much worse discovery may get before the trade is refused. */
  maxDiscoveryDrop?: number;
  /** How much more often operators may reach for the canonical view. */
  maxEscapeHatchRise?: number;
}

const compare = (metric: string, baseline: Rate, candidate: Rate): MetricComparison => ({
  metric,
  baseline: baseline.rate,
  candidate: candidate.rate,
  delta: baseline.rate === null || candidate.rate === null ? null : candidate.rate - baseline.rate,
  support: { baseline: baseline.denominator, candidate: candidate.denominator },
});

/** Mean discovery across capabilities — the counter-metric, pooled for a single reading. */
function meanDiscovery(discovery: Record<string, Rate>): Rate {
  const measured = Object.values(discovery).filter((r) => r.rate !== null);
  if (measured.length === 0) return { rate: null, numerator: 0, denominator: 0 };
  return {
    rate: measured.reduce((sum, r) => sum + (r.rate as number), 0) / measured.length,
    numerator: measured.reduce((sum, r) => sum + r.numerator, 0),
    denominator: measured.reduce((sum, r) => sum + r.denominator, 0),
  };
}

/**
 * Judge an adaptive arm against the Phase 0 baseline.
 *
 * `baseline` is the control (adaptation off) and `candidate` the arm with Phases 1–2
 * running. Both come from `baselineReport` over the same window — the control arm is free
 * precisely because it is the same code path with the profile zeroed.
 */
export function phase3Gate(
  baseline: BaselineReport,
  candidate: BaselineReport,
  thresholds: GateThresholds = {}
): GateVerdict {
  const minSessions = thresholds.minSessionsPerArm ?? 200;
  const minSuccessLift = thresholds.minSuccessLift ?? 0.02;
  const maxDiscoveryDrop = thresholds.maxDiscoveryDrop ?? 0;
  const maxEscapeRise = thresholds.maxEscapeHatchRise ?? 0.02;

  const success = compare("task success", baseline.taskSuccess, candidate.taskSuccess);
  const discovery = compare(
    "capability discovery",
    meanDiscovery(baseline.discovery),
    meanDiscovery(candidate.discovery)
  );
  const escapeHatch = compare("escape hatch", baseline.escapeHatch, candidate.escapeHatch);
  const canonical = compare(
    "canonical preference",
    baseline.canonicalPreference,
    candidate.canonicalPreference
  );
  const comparisons = [success, discovery, escapeHatch, canonical];

  // 1. Is this measured at all? Asked FIRST, because every judgment below is meaningless
  //    otherwise, and because a thin sample that happens to look good is the single most
  //    dangerous input this function can receive.
  const thin: string[] = [];
  if (baseline.sessions < minSessions) {
    thin.push(`baseline arm has ${baseline.sessions} sessions (need ${minSessions})`);
  }
  if (candidate.sessions < minSessions) {
    thin.push(`adaptive arm has ${candidate.sessions} sessions (need ${minSessions})`);
  }
  if (success.delta === null) {
    thin.push("task success is unmeasured in one of the arms");
  }
  if (thin.length > 0) return { decision: "insufficient-evidence", reasons: thin, comparisons };

  const reasons: string[] = [];

  // 2. The guardrail. Segmented, and it fails closed on its own account.
  const guardrail = ttmRegressed(
    baseline.incidentTimeToMitigate.canonical.meanMs,
    candidate.incidentTimeToMitigate.adaptive
  );
  if (guardrail.blocked) reasons.push(`guardrail: ${guardrail.reason}`);

  // 3. The counter-metrics. Every efficiency metric in this class improves when the system
  //    shows less, so a rise in success bought with a fall in discovery is not a win —
  //    it is the capability trap, and the primary metric will not say so.
  if (discovery.delta !== null && discovery.delta < -maxDiscoveryDrop) {
    reasons.push(
      `capability discovery fell ${(-discovery.delta * 100).toFixed(1)}pp while efficiency rose — the primary metric cannot see this`
    );
  }
  if (escapeHatch.delta !== null && escapeHatch.delta > maxEscapeRise) {
    reasons.push(
      `escape-hatch use rose ${(escapeHatch.delta * 100).toFixed(1)}pp — operators are correcting the system more often, which is the most direct measure of it being wrong`
    );
  }

  // 4. And finally: was it worth it? A neutral result is not a reason to touch blueprint
  //    identity — "no harm" justifies keeping Phases 1–2, not proceeding past them.
  if ((success.delta as number) < minSuccessLift) {
    reasons.push(
      `task success moved ${((success.delta as number) * 100).toFixed(1)}pp, below the ${(minSuccessLift * 100).toFixed(1)}pp worth an irreversible change`
    );
  }

  return {
    decision: reasons.length === 0 ? "clear" : "blocked",
    reasons,
    comparisons,
  };
}

/** One line per metric, with the support that makes a percentage readable. */
export function formatVerdict(verdict: GateVerdict): string {
  const lines = [`decision: ${verdict.decision.toUpperCase()}`];
  for (const c of verdict.comparisons) {
    const show = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
    lines.push(
      `  ${c.metric}: ${show(c.baseline)} → ${show(c.candidate)}` +
        ` (n=${c.support.baseline} vs ${c.support.candidate})`
    );
  }
  for (const reason of verdict.reasons) lines.push(`  · ${reason}`);
  return lines.join("\n");
}

/** A distribution's mean, or null — exported so callers need not reach into the shape. */
export const meanOf = (d: Distribution): number | null => d.meanMs;
