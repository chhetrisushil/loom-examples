import type { EventEnvelope } from "@loom/core";

// ── Phase 0 — the baseline, and why it comes first ───────────────────────────
//
// No target below is falsifiable without a distribution to compare it against, so this
// phase produces one with adaptation OFF. It is not overhead; it is what makes every
// later claim testable rather than assertable.
//
// Everything here is a read-only lens over the log — the same posture `@loom/analytics`
// takes. Nothing is stored, nothing is derived at write time, and a report can be
// recomputed for any window from history that already exists.
//
// The shape of every number below is the same, and it is the point: a rate carries its
// DENOMINATOR, and a rate over an empty denominator is `null` rather than `0`. "Nobody
// succeeded" and "nobody tried" are different findings, and a dashboard that renders them
// identically will be read as the first one.

export const SESSION_STARTED = "SESSION_STARTED";
export const SESSION_SUCCEEDED = "SESSION_SUCCEEDED";
export const SESSION_ENDED = "SESSION_ENDED";
export const INCIDENT_OPENED = "INCIDENT_OPENED";
export const INCIDENT_MITIGATED = "INCIDENT_MITIGATED";

/**
 * The closed set of things that count as succeeding. An explicit event, always.
 *
 * Speed without one cannot be told apart from abandonment: the fastest session in any log
 * is someone opening the console, seeing nothing useful, and closing it. Inferring success
 * from a session's end would score exactly that as the best outcome in the product.
 */
export const SUCCESS_KINDS = [
  "mitigation.applied",
  "query.saved",
  "plan.exported",
  "alert.resolved",
] as const;
export type SuccessKind = (typeof SUCCESS_KINDS)[number];

export interface SessionStarted {
  sessionId: string;
  tenant: string;
  operator: string;
  topic: string;
  /** False for the control arm — the same code path with the profile zeroed (§5.4). */
  adaptive: boolean;
  /** Set when the session opened under an incident. */
  canonicalReason?: string;
}

export interface SessionSucceeded {
  sessionId: string;
  kind: SuccessKind;
}

export interface SessionEnded {
  sessionId: string;
  /** True when the operator was still in the canonical view when they left. */
  endedCanonical?: boolean;
}

export interface IncidentEvent {
  incidentId: string;
  resource: string;
  /** Which arm the responders were on — the guardrail is segmented by it, not pooled. */
  adaptive: boolean;
}

/** A measured quantity and the population it was measured over. */
export interface Rate {
  /** `null` when the denominator is zero: no evidence, which is not the same as zero. */
  rate: number | null;
  numerator: number;
  denominator: number;
}

const rateOf = (numerator: number, denominator: number): Rate => ({
  rate: denominator === 0 ? null : numerator / denominator,
  numerator,
  denominator,
});

export interface Distribution {
  n: number;
  meanMs: number | null;
  p50Ms: number | null;
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { n: 0, meanMs: null, p50Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms:
      sorted.length % 2 === 1
        ? (sorted[mid] as number)
        : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2,
  };
}

export interface BaselineReport {
  /** PRIMARY — did the operator finish the job they came to do? */
  taskSuccess: Rate;
  /** PRIMARY — how long it took, over successes ONLY. */
  timeToSuccess: Distribution;
  /**
   * COUNTER — operators using a capability for the FIRST TIME EVER in this window, over
   * the operators active in it. Every efficiency metric in this class improves when the
   * system shows less; if efficiency rises while this falls, the system is failing and
   * the primary metrics will not say so.
   */
  discovery: Record<string, Rate>;
  /** COUNTER — how often adaptation was wrong, measured directly. */
  escapeHatch: Rate;
  /** COUNTER — how often operators stayed canonical after leaving an incident behind. */
  canonicalPreference: Rate;
  /** GUARDRAIL — segmented, never pooled. A regression here blocks a release. */
  incidentTimeToMitigate: { adaptive: Distribution; canonical: Distribution };
  /** The population everything above was computed over. */
  sessions: number;
}

interface Window {
  from: number;
  to: number;
}

const inWindow = (at: number, window?: Window): boolean =>
  window === undefined || (at >= window.from && at <= window.to);

/**
 * Compute the baseline report from a raw event log.
 *
 * `window` bounds the reporting period. Discovery deliberately reads the WHOLE log to
 * decide what "first time" means, and only then filters to the window — see below.
 */
export function baselineReport(events: readonly EventEnvelope[], window?: Window): BaselineReport {
  const started = new Map<string, { at: number; event: SessionStarted }>();
  const succeeded = new Map<string, number>();
  const ended: { sessionId: string; endedCanonical: boolean }[] = [];
  const incidentOpened = new Map<string, { at: number; adaptive: boolean }>();
  const ttm: { ms: number; adaptive: boolean }[] = [];
  /** action → operator → the first time that operator ever did it. */
  const firstUse = new Map<string, Map<string, number>>();
  const activeOperators = new Set<string>();
  let escapes = 0;

  for (const event of events) {
    switch (event.eventType) {
      case SESSION_STARTED: {
        const payload = event.payload as SessionStarted;
        if (inWindow(event.timestamp, window)) {
          started.set(payload.sessionId, { at: event.timestamp, event: payload });
          activeOperators.add(`${payload.tenant}:${payload.operator}`);
        }
        break;
      }
      case SESSION_SUCCEEDED: {
        const payload = event.payload as SessionSucceeded;
        if (inWindow(event.timestamp, window)) succeeded.set(payload.sessionId, event.timestamp);
        break;
      }
      case SESSION_ENDED: {
        const payload = event.payload as SessionEnded;
        if (inWindow(event.timestamp, window)) {
          ended.push({
            sessionId: payload.sessionId,
            endedCanonical: payload.endedCanonical === true,
          });
        }
        break;
      }
      case INCIDENT_OPENED: {
        const payload = event.payload as IncidentEvent;
        incidentOpened.set(payload.incidentId, {
          at: event.timestamp,
          adaptive: payload.adaptive,
        });
        break;
      }
      case INCIDENT_MITIGATED: {
        const payload = event.payload as IncidentEvent;
        const opened = incidentOpened.get(payload.incidentId);
        if (opened !== undefined && inWindow(event.timestamp, window)) {
          ttm.push({ ms: event.timestamp - opened.at, adaptive: opened.adaptive });
        }
        break;
      }
      case "OPERATOR_ACTION": {
        const payload = event.payload as { tenant: string; operator: string; action: string };
        const subject = `${payload.tenant}:${payload.operator}`;
        if (payload.action === "escape.canonical" && inWindow(event.timestamp, window)) escapes++;
        // First use is computed over ALL history, deliberately. Ask only "was this their
        // first use INSIDE the window" and every habitual user counts as a discoverer the
        // moment the window moves — a metric that rises when nothing changed.
        let byOperator = firstUse.get(payload.action);
        if (byOperator === undefined) {
          byOperator = new Map();
          firstUse.set(payload.action, byOperator);
        }
        const prior = byOperator.get(subject);
        if (prior === undefined || event.timestamp < prior)
          byOperator.set(subject, event.timestamp);
        break;
      }
      default:
        break;
    }
  }

  const durations: number[] = [];
  for (const [sessionId, at] of succeeded) {
    const start = started.get(sessionId);
    // A success with no start in this window has no duration to report — counting it as
    // zero would be the fastest session in the log.
    if (start !== undefined) durations.push(at - start.at);
  }

  const discovery: Record<string, Rate> = {};
  for (const [action, byOperator] of firstUse) {
    let discoverers = 0;
    for (const [subject, at] of byOperator) {
      if (activeOperators.has(subject) && inWindow(at, window)) discoverers++;
    }
    discovery[action] = rateOf(discoverers, activeOperators.size);
  }

  const canonicalEnds = ended.filter((e) => e.endedCanonical).length;

  return {
    taskSuccess: rateOf(succeeded.size, started.size),
    timeToSuccess: distribution(durations),
    discovery,
    escapeHatch: rateOf(escapes, started.size),
    canonicalPreference: rateOf(canonicalEnds, ended.length),
    incidentTimeToMitigate: {
      adaptive: distribution(ttm.filter((t) => t.adaptive).map((t) => t.ms)),
      canonical: distribution(ttm.filter((t) => !t.adaptive).map((t) => t.ms)),
    },
    sessions: started.size,
  };
}

/**
 * The release gate: has time-to-mitigate regressed against the baseline?
 *
 * Deliberately fails CLOSED on thin evidence. "We could not tell" must not read as "no
 * regression" on the one metric that is allowed to block a release, so an absent
 * distribution is a refusal to clear rather than a pass.
 */
export function ttmRegressed(
  baselineMs: number | null,
  candidate: Distribution,
  tolerance = 0.1
): { blocked: boolean; reason: string } {
  if (baselineMs === null) {
    return { blocked: true, reason: "no baseline to compare against" };
  }
  if (candidate.n === 0 || candidate.meanMs === null) {
    return { blocked: true, reason: "no incidents measured in the candidate window" };
  }
  const ratio = candidate.meanMs / baselineMs;
  return ratio > 1 + tolerance
    ? {
        blocked: true,
        reason: `time-to-mitigate up ${Math.round((ratio - 1) * 100)}% against baseline`,
      }
    : { blocked: false, reason: `within ${Math.round(tolerance * 100)}% of baseline` };
}
