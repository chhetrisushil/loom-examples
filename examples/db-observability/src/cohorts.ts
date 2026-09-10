import type { Topic } from "./catalogue";
import type { OperatorProfile } from "./profile";

// ── Phase 3 — cohorts, and the first change that cannot be quietly undone ────
//
// PROCEEDING WITHOUT THE GATE. `phase3Gate` returned `insufficient-evidence` on the data
// available — two sessions against a required two hundred — and this phase was started on
// an explicit decision rather than on a measured effect. That is recorded here, in the
// code it authorises, because the reason a gate exists is to be visible when it is
// overridden. Nothing below is unsound; it is simply unjustified BY MEASUREMENT so far,
// and the honest consequence is that the floors and the identity pinning below carry the
// whole weight of keeping it safe.
//
// What changes, and why it is different in kind from Phases 1–2: a cohort is an input to
// GENERATION. Phases 0–2 only ever rearranged what the agent had already chosen, which is
// why they were reversible and why blueprint identity never moved. A cohort decides what
// the blueprint CONTAINS, so two operators can be looking at structurally different
// surfaces — and a surface that differs per person is one that cannot be referenced in a
// runbook unless something guarantees the parts everyone shares.
//
// That something is the floor, and it is the reason this phase is safe at all.

/** Bump on ANY change to the rules below — the cohort a run resolved is version-scoped. */
export const COHORT_MODEL_VERSION = 1;

/**
 * Deliberately few, and deliberately named for what an operator DOES rather than for who
 * they are. `k` is bounded above by the cost of the surfaces it multiplies and below by
 * expressiveness; four is the smallest number that says anything useful here.
 */
export type CohortId = "shallow" | "relational_deep" | "infra_deep" | "unassigned";

export interface CohortRule {
  id: CohortId;
  /** Read to the operator when they ask why their console looks like this. */
  describes: string;
  /** A RULE over the flag set — reviewable before it ships, not merely observable after. */
  holds: (flags: ReadonlySet<string>) => boolean;
  /** Widgets this cohort adds ABOVE the floor, by catalogue id. Never subtracts. */
  adds: Partial<Record<Topic, string[]>>;
}

// Rules rather than clustering, for three reasons that all survive contact with a review:
// a rule is explicable to the operator whose interface it changed, it is reviewable BEFORE
// it ships rather than only observable after, and it changes under version control rather
// than whenever a batch job reruns. Clustering is deferred, not rejected — but the burden
// of proof sits with the learned component, and it inherits the obligation to explain.
export const COHORT_RULES: readonly CohortRule[] = [
  {
    id: "relational_deep",
    describes: "reads query plans, so plan-level detail leads rather than being one step away",
    holds: (flags) => flags.has("reads_query_plans"),
    adds: { cpu: ["queries.plan"], queries: ["queries.plan"] },
  },
  {
    id: "infra_deep",
    describes: "works at the pool and replica level",
    holds: (flags) => flags.has("inspects_connections") || flags.has("tracks_replication"),
    adds: { cpu: ["connections.waiting"], connections: ["replication.lag"] },
  },
  {
    id: "shallow",
    describes: "has not yet used the deeper views; nothing is hidden, and the summary leads",
    holds: () => true,
    adds: {},
  },
];

/**
 * Assign a cohort by rule. First match wins, and the last rule matches everything, so this
 * is total: there is no operator the model has no answer for.
 *
 * An EMPTY profile is `unassigned` rather than `shallow`. They look the same on screen and
 * mean different things — "we have seen nothing from you" is not "we have seen enough to
 * place you at the shallow end" — and a cohort transition out of `unassigned` is an
 * ordinary first observation rather than a reassessment worth telling someone about.
 */
export function assignCohort(profile: OperatorProfile | null): CohortId {
  if (profile === null || profile.flags.length === 0) return "unassigned";
  const flags = new Set(profile.flags);
  return (COHORT_RULES.find((rule) => rule.holds(flags)) as CohortRule).id;
}

export function cohortRule(id: CohortId): CohortRule | null {
  return COHORT_RULES.find((rule) => rule.id === id) ?? null;
}

// ── Hysteresis ───────────────────────────────────────────────────────────────

export interface CohortState {
  /** The cohort in force. Changes only through {@link nextCohortState}. */
  current: CohortId;
  /** The cohort the rules would assign right now, if it differs from `current`. */
  pending: CohortId | null;
  /** Consecutive evaluation windows `pending` has held for. */
  windows: number;
}

export const INITIAL_COHORT_STATE: CohortState = {
  current: "unassigned",
  pending: null,
  windows: 0,
};

/** Windows a proposed cohort must hold for before it takes effect. */
export const HYSTERESIS_WINDOWS = 2;

export interface CohortTransition {
  from: CohortId;
  to: CohortId;
  /** True on the window the change actually takes effect. */
  applied: boolean;
}

/**
 * Advance the cohort state by one evaluation window.
 *
 * A transition requires its predicate to hold across two consecutive windows, because each
 * one changes what that operator's console CONTAINS and invalidates whatever was composed
 * under the old one. Flapping is therefore not merely untidy: it is a cost paid per
 * flap, and a cohort that oscillates weekly is worse than one that is slightly wrong and
 * stable.
 *
 * A proposal that lapses resets the count rather than decrementing it — two windows on,
 * one off, two on is not four windows of evidence, and treating it as such is how a
 * hysteresis that was supposed to damp oscillation ends up ratifying it.
 */
export function nextCohortState(
  state: CohortState,
  proposed: CohortId
): { state: CohortState; transition: CohortTransition | null } {
  if (proposed === state.current) {
    return { state: { ...state, pending: null, windows: 0 }, transition: null };
  }
  const windows = state.pending === proposed ? state.windows + 1 : 1;
  if (windows >= HYSTERESIS_WINDOWS) {
    return {
      state: { current: proposed, pending: null, windows: 0 },
      transition: { from: state.current, to: proposed, applied: true },
    };
  }
  return {
    state: { current: state.current, pending: proposed, windows },
    transition: { from: state.current, to: proposed, applied: false },
  };
}

/** What the operator is told when their cohort changes. C2 — never a silent reassignment. */
export function describeTransition(transition: CohortTransition): string {
  const to = cohortRule(transition.to);
  return transition.applied
    ? `Your console now leads with more detail: you moved from "${transition.from}" to "${transition.to}"${to ? ` — ${to.describes}` : ""}. Everything you could see before is still there.`
    : `Pending: "${transition.to}" (holding ${HYSTERESIS_WINDOWS - 1} more window${HYSTERESIS_WINDOWS - 1 === 1 ? "" : "s"} before anything changes).`;
}
