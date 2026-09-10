import type { EventEnvelope, FlowDefinition } from "@loom/core";
import type { ReadModelDefinition, ReadModelRow } from "@loom/plugin-read-model";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";
import { FLAG_CATALOGUE, FLAG_CATALOGUE_VERSION, flagDefinition } from "./flags";
import type { PreferenceScope } from "./preferences";

// ── Phase 2 — the profile is DERIVED, and the derivation is the interesting part ──
//
// Phase 1 stored what the operator said. This stores nothing: a flag is a function of
// events that already exist, so there is no write path from a run into profile state and
// replaying a run cannot mutate a profile. The three mechanisms below are what make that
// hold, and each replaces something the original design specified differently.
//
//   1. The profile is a READ MODEL over ordinary run logs, not a projection folded per
//      run. A projection has no snapshot anchor — every fold starts from `initialState` —
//      and an operator's history is unbounded, so a run-start re-fold is O(lifetime).
//   2. Expiry is an EVENT, not a timestamp comparison at read time. A flag that lapses
//      "when read after its horizon" makes the fold a function of (events, now), so
//      pinning anything pins nothing and two reads of the same history disagree. Here a
//      scheduled evaluator observes the horizon and EMITS a lapse; the fold stays pure.
//   3. The resolved profile is journaled through `ctx.decide`, not a log offset. An offset
//      reproduces the events but not the FOLD, and the fold is this file plus a versioned
//      catalogue — both of which will change. What a run used has to be recorded as what
//      it used.

export const OPERATOR_ACTION = "OPERATOR_ACTION";
export const FLAG_LAPSED = "FLAG_LAPSED";

export interface OperatorActionPayload {
  tenant: string;
  operator: string;
  /** The catalogue action id, e.g. "open.queries.slow". */
  action: string;
}

export interface FlagLapsedPayload {
  tenant: string;
  operator: string;
  flag: string;
  /** The evidence that expired — kept so the operator can be told what lapsed and when. */
  lastEvidencedAt: number;
}

/** The subject key a row is filed under. Per-tenant AND per-operator, never merged. */
export const subjectOf = (tenant: string, operator: string): string => `${tenant}:${operator}`;

// ── The read model ───────────────────────────────────────────────────────────

/**
 * Evidence and lapses, indexed by subject. One model over both kinds deliberately: a flag
 * is decided by their INTERLEAVING, and two models would have to be read consistently
 * with each other, which is a guarantee neither of them offers.
 */
export const PROFILE_MODEL: ReadModelDefinition = {
  id: "operator-evidence",
  kinds: [OPERATOR_ACTION, FLAG_LAPSED],
  indexes: ["subject", "action", "flag"],
  extract: (event) => {
    if (event.eventType === OPERATOR_ACTION) {
      const p = event.payload as OperatorActionPayload;
      return [{ fields: { subject: subjectOf(p.tenant, p.operator), action: p.action, flag: "" } }];
    }
    const p = event.payload as FlagLapsedPayload;
    return [{ fields: { subject: subjectOf(p.tenant, p.operator), action: "", flag: p.flag } }];
  },
};

// ── The fold: rows → flags. A pure function of the rows, and of nothing else ──

export interface FlagState {
  id: string;
  /** Timestamps of the observations that set it, oldest first. */
  evidence: number[];
  lastEvidencedAt: number;
}

export interface OperatorProfile {
  subject: string;
  flags: string[];
  /** Which catalogue produced this — half of the fold, so it travels with the result. */
  catalogueVersion: number;
  /** Per-flag detail, for the operator-facing explanation. */
  detail: FlagState[];
}

export const EMPTY_PROFILE = (subject: string): OperatorProfile => ({
  subject,
  flags: [],
  catalogueVersion: FLAG_CATALOGUE_VERSION,
  detail: [],
});

/**
 * Fold evidence rows into the flag set.
 *
 * Deliberately takes NO clock. Everything time-dependent already happened and is in the
 * rows: a lapse is a row, so evidence recorded before the most recent lapse of that flag
 * is spent. Call this twice a month apart over the same rows and it answers identically,
 * which is the property that makes a journaled profile reproducible at all.
 */
export function foldProfile(subject: string, rows: readonly ReadModelRow[]): OperatorProfile {
  const evidenceByAction = new Map<string, number[]>();
  const lapsedAt = new Map<string, number>();

  for (const row of rows) {
    if (row.fields.subject !== subject) continue;
    const action = row.fields.action as string;
    const flag = row.fields.flag as string;
    if (action !== "") {
      const list = evidenceByAction.get(action);
      if (list === undefined) evidenceByAction.set(action, [row.timestamp]);
      else list.push(row.timestamp);
    } else if (flag !== "") {
      const prior = lapsedAt.get(flag) ?? 0;
      if (row.timestamp > prior) lapsedAt.set(flag, row.timestamp);
    }
  }

  const detail: FlagState[] = [];
  for (const definition of FLAG_CATALOGUE) {
    const spentBefore = lapsedAt.get(definition.id) ?? 0;
    // Evidence older than the last lapse is spent, not deleted: the row stays in the log
    // as the record of something that did happen, and the fold simply stops counting it.
    const live = (evidenceByAction.get(definition.evidencedBy) ?? [])
      .filter((at) => at > spentBefore)
      .sort((a, b) => a - b);
    if (live.length >= definition.threshold) {
      detail.push({
        id: definition.id,
        evidence: live,
        lastEvidencedAt: live[live.length - 1] as number,
      });
    }
  }

  return {
    subject,
    flags: detail.map((d) => d.id),
    catalogueVersion: FLAG_CATALOGUE_VERSION,
    detail,
  };
}

// ── Expiry: a scheduled evaluator, whose output is events ────────────────────

/**
 * Which flags have outlived their horizon as of `now`.
 *
 * This is where a clock is legitimate: it is a scheduled job observing the world, not a
 * read serving a request. Its output is a list of lapses to APPEND, so the fold above
 * never has to know what time it is — and an operator can be told "this lapsed on the
 * 24th" rather than discovering that a read they made yesterday would answer differently
 * today.
 */
export function dueLapses(profile: OperatorProfile, now: number): FlagLapsedPayload[] {
  const [tenant = "", operator = ""] = profile.subject.split(":");
  const due: FlagLapsedPayload[] = [];
  for (const state of profile.detail) {
    const horizon = flagDefinition(state.id).horizonMs;
    if (now - state.lastEvidencedAt > horizon) {
      due.push({ tenant, operator, flag: state.id, lastEvidencedAt: state.lastEvidencedAt });
    }
  }
  return due;
}

/** What the product shows when an operator asks why a flag is set. */
export function explainFlag(state: FlagState): string {
  const definition = flagDefinition(state.id);
  const when = new Date(state.lastEvidencedAt).toISOString().slice(0, 10);
  return `${definition.id}: set because you did "${definition.evidencedBy}" ${state.evidence.length} times, most recently on ${when} — ${definition.describes}`;
}

// ── Resolving it into a run, as a recorded decision ──────────────────────────

export interface ResolveInput {
  scope: PreferenceScope;
}

const profileSchema = z.object({
  subject: z.string(),
  flags: z.array(z.string()),
  catalogueVersion: z.number().int().positive(),
  detail: z.array(
    z.object({ id: z.string(), evidence: z.array(z.number()), lastEvidencedAt: z.number() })
  ),
});

export const RESOLVE_PROFILE_FLOW_ID = "resolve-operator-profile";

export const resolveProfileFlowDef: FlowDefinition<ResolveInput, OperatorProfile> = {
  _tag: "FlowDefinition",
  id: RESOLVE_PROFILE_FLOW_ID,
  name: "Resolve the operator profile",
  version: "1.0.0",
  inputSchema: z.object({
    scope: z.object({ tenant: z.string(), operator: z.string(), topic: z.string() }),
  }) as unknown as z.ZodSchema<ResolveInput>,
  outputSchema: profileSchema as unknown as z.ZodSchema<OperatorProfile>,
  steps: [],
};

/**
 * Resolve the profile and RECORD it, rather than recording where to look it up.
 *
 * `ctx.decide` runs the deriver once and serves the recorded value on every replay, so the
 * profile a run was arranged under is answerable later even though the read model has
 * moved on and the catalogue has been revised. Recording a log offset instead would
 * reproduce the events and re-derive them through today's fold, which is the same class of
 * silent substitution the replay inspector refuses when a projection's code has changed.
 */
export function resolveProfileRunner(
  derive: (subject: string) => Promise<OperatorProfile>
): FlowRunner<ResolveInput, OperatorProfile> {
  return async (ctx, { scope }) => {
    const subject = subjectOf(scope.tenant, scope.operator);
    return ctx.decide(
      `profile:${subject}`,
      () => derive(subject),
      // The catalogue version rides along as rationale: two runs that resolved the same
      // flag set under different catalogues did not resolve the same profile.
      { source: "profile", rationale: { catalogueVersion: FLAG_CATALOGUE_VERSION } }
    );
  };
}

/** True for the event kinds the profile read model indexes (wire this into `onEvent`). */
export const isProfileEvent = (event: EventEnvelope): boolean =>
  event.eventType === OPERATOR_ACTION || event.eventType === FLAG_LAPSED;
