import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { decideWithPolicy } from "@loom/learning";
import type { Policy } from "@loom/learning";
import type { ReadModelDefinition, ReadModelRow } from "@loom/plugin-read-model";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";
import {
  type ExplorationContext,
  NO_EXPLORATION,
  explorationActions,
  surfacedWidget,
} from "./exploration";
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
/** C7 — the operator's own statement about themselves. Outranks every inference, forever. */
export const FLAG_DECLARED = "FLAG_DECLARED";

export interface OperatorActionPayload {
  tenant: string;
  operator: string;
  /** The catalogue action id, e.g. "open.queries.slow". */
  action: string;
}

export interface FlagDeclaredPayload {
  tenant: string;
  operator: string;
  flag: string;
  /** `true` sets it, `false` clears it. Both are statements; neither is an absence. */
  value: boolean;
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
/**
 * The declared semantics of the extractor below (ADR 0095).
 *
 * The other half of the fold, and the half that used to travel with nothing. Changing
 * `extract` is silent by construction: the rows the old one wrote stay, the watermark is
 * already past the events that produced them, and one query then answers from two
 * extractors at once. Bump this when what a row MEANS changes — a new indexed field, a
 * different `kind` vocabulary, a filter — and the journaled profiles derived under the old
 * one say so instead of looking current.
 */
export const EVIDENCE_MODEL_VERSION = "1";

export const PROFILE_MODEL: ReadModelDefinition = {
  id: "operator-evidence",
  version: EVIDENCE_MODEL_VERSION,
  kinds: [OPERATOR_ACTION, FLAG_LAPSED, FLAG_DECLARED],
  indexes: ["subject", "action", "flag", "kind"],
  extract: (event) => {
    const p = event.payload as { tenant: string; operator: string };
    const subject = subjectOf(p.tenant, p.operator);
    if (event.eventType === OPERATOR_ACTION) {
      const action = (event.payload as OperatorActionPayload).action;
      return [{ fields: { subject, action, flag: "", kind: "evidence" } }];
    }
    if (event.eventType === FLAG_DECLARED) {
      const declared = event.payload as FlagDeclaredPayload;
      return [
        {
          fields: {
            subject,
            action: "",
            flag: declared.flag,
            kind: declared.value ? "declared:set" : "declared:clear",
          },
        },
      ];
    }
    const lapse = event.payload as FlagLapsedPayload;
    return [{ fields: { subject, action: "", flag: lapse.flag, kind: "lapse" } }];
  },
};

// ── The fold: rows → flags. A pure function of the rows, and of nothing else ──

export interface FlagState {
  id: string;
  /** Timestamps of the observations that set it, oldest first. Empty when declared. */
  evidence: number[];
  lastEvidencedAt: number;
  /**
   * How this flag came to be set. A `declared` one was stated by the operator: it never
   * expires and no inference overwrites it (C7). Recording the SOURCE rather than just
   * the value is what lets the product tell someone why they are seeing something, and
   * what stops a correction being quietly undone by the next evidence sweep.
   */
  source: "observed" | "declared";
}

export interface OperatorProfile {
  subject: string;
  flags: string[];
  /** Which catalogue produced this — half of the fold, so it travels with the result. */
  catalogueVersion: number;
  /**
   * Which evidence model produced it — the OTHER half. A journaled profile is reproducible
   * because `ctx.decide` recorded the value; this is what lets a later reader ask whether
   * the rows it was derived FROM still mean the same thing (ADR 0095).
   */
  evidenceVersion: string;
  /** Per-flag detail, for the operator-facing explanation. */
  detail: FlagState[];
}

export const EMPTY_PROFILE = (subject: string): OperatorProfile => ({
  subject,
  flags: [],
  catalogueVersion: FLAG_CATALOGUE_VERSION,
  evidenceVersion: EVIDENCE_MODEL_VERSION,
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
  /** The operator's latest word on each flag, by timestamp. */
  const declared = new Map<string, { value: boolean; at: number }>();

  for (const row of rows) {
    if (row.fields.subject !== subject) continue;
    const action = row.fields.action as string;
    const flag = row.fields.flag as string;
    // A row written by an earlier version of the extractor has no `kind`. It is skipped
    // rather than guessed at — a read model is a cache with a documented rebuild path
    // (RM-2), and guessing would let a stale row understate a profile silently.
    const kind = typeof row.fields.kind === "string" ? row.fields.kind : "";
    if (kind === "evidence" && action !== "") {
      const list = evidenceByAction.get(action);
      if (list === undefined) evidenceByAction.set(action, [row.timestamp]);
      else list.push(row.timestamp);
    } else if (kind === "lapse" && flag !== "") {
      const prior = lapsedAt.get(flag) ?? 0;
      if (row.timestamp > prior) lapsedAt.set(flag, row.timestamp);
    } else if (kind.startsWith("declared:") && flag !== "") {
      const prior = declared.get(flag);
      if (prior === undefined || row.timestamp >= prior.at) {
        declared.set(flag, { value: kind === "declared:set", at: row.timestamp });
      }
    }
  }

  const detail: FlagState[] = [];
  for (const definition of FLAG_CATALOGUE) {
    // C7 first, and terminally. A statement is not a stronger piece of evidence to be
    // weighed against the rest — it replaces the question. An operator who cleared a flag
    // must not have it set again by the next three observations, or the correction was
    // theatre and they will stop making them.
    const stated = declared.get(definition.id);
    if (stated !== undefined) {
      if (stated.value) {
        detail.push({
          id: definition.id,
          evidence: [],
          lastEvidencedAt: stated.at,
          source: "declared",
        });
      }
      continue;
    }

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
        source: "observed",
      });
    }
  }

  return {
    subject,
    flags: detail.map((d) => d.id),
    catalogueVersion: FLAG_CATALOGUE_VERSION,
    evidenceVersion: EVIDENCE_MODEL_VERSION,
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
    // A declared flag never expires: expiry exists to stop an INFERENCE outliving its
    // evidence, and a statement has none to outlive.
    if (state.source === "declared") continue;
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
  if (state.source === "declared") {
    return `${definition.id}: set because you said so on ${when} — ${definition.describes}. It will not expire, and nothing the system observes will change it.`;
  }
  return `${definition.id}: set because you did "${definition.evidencedBy}" ${state.evidence.length} times, most recently on ${when} — ${definition.describes}`;
}

// ── Resolving it into a run, as a recorded decision ──────────────────────────

export interface ResolveInput {
  scope: PreferenceScope;
  /**
   * Canonical mode: the shared reference frame an incident needs. The profile is zeroed
   * for the duration and exploration is suppressed entirely — an incident is not a place
   * to run an experiment, and a bridge call where two people describe different panels is
   * worse than either arrangement.
   */
  canonical?: { active: boolean; reason?: string };
  /** WHY widgets available on this surface — the range exploration may draw from. */
  available?: string[];
}

/** What one session resolved: the profile it will be arranged under, and the draw. */
export interface SessionProfile {
  profile: OperatorProfile;
  /** The capability surfaced above the assessed level this session, if any. */
  surfaced: string | null;
  /** The exploration decision id, so the outcome can be recorded against it. */
  explorationId: string | null;
  canonical: { active: boolean; reason?: string };
}

const profileSchema = z.object({
  subject: z.string(),
  flags: z.array(z.string()),
  catalogueVersion: z.number().int().positive(),
  evidenceVersion: z.string().min(1),
  detail: z.array(
    z.object({
      id: z.string(),
      evidence: z.array(z.number()),
      lastEvidencedAt: z.number(),
      source: z.enum(["observed", "declared"]),
    })
  ),
});

export const RESOLVE_PROFILE_FLOW_ID = "resolve-operator-profile";

const canonicalSchema = z.object({ active: z.boolean(), reason: z.string().optional() });

export const resolveProfileFlowDef: FlowDefinition<ResolveInput, SessionProfile> = {
  _tag: "FlowDefinition",
  id: RESOLVE_PROFILE_FLOW_ID,
  name: "Open a session: resolve the profile and draw exploration",
  version: "1.0.0",
  inputSchema: z.object({
    scope: z.object({ tenant: z.string(), operator: z.string(), topic: z.string() }),
    canonical: canonicalSchema.optional(),
    available: z.array(z.string()).optional(),
  }) as unknown as z.ZodSchema<ResolveInput>,
  outputSchema: z.object({
    profile: profileSchema,
    surfaced: z.string().nullable(),
    explorationId: z.string().nullable(),
    canonical: canonicalSchema,
  }) as unknown as z.ZodSchema<SessionProfile>,
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
  derive: (subject: string) => Promise<OperatorProfile>,
  policy: Policy<string>
): FlowRunner<ResolveInput, SessionProfile> {
  return async (ctx, { scope, canonical, available }) => {
    const subject = subjectOf(scope.tenant, scope.operator);
    const mode = canonical ?? { active: false };

    // Canonical mode zeroes the profile — and does so through the SAME resolution, not a
    // branch around it, so the canonical surface cannot drift from the adaptive one.
    const profile = mode.active
      ? EMPTY_PROFILE(subject)
      : await ctx.decide(
          `profile:${subject}`,
          () => derive(subject),
          // The catalogue version rides along as rationale: two runs that resolved the
          // same flag set under different catalogues did not resolve the same profile.
          { source: "profile", rationale: { catalogueVersion: FLAG_CATALOGUE_VERSION } }
        );

    if (mode.active) {
      return { profile, surfaced: null, explorationId: null, canonical: mode };
    }

    const actions = explorationActions(profile, available ?? []);
    const explorationId = `explore:${subject}`;
    const drawn = await decideWithPolicy(
      ctx,
      explorationId,
      policy,
      {
        subject,
        held: profile.flags.length,
        topic: scope.topic,
      } satisfies ExplorationContext,
      actions
    );

    return {
      profile,
      surfaced: surfacedWidget(drawn),
      // Only a real draw gets an outcome: recording one against a session that surfaced
      // nothing would score the absence of an experiment as its result.
      explorationId: drawn === NO_EXPLORATION ? null : explorationId,
      canonical: mode,
    };
  };
}

/** True for the event kinds the profile read model indexes (wire this into `onEvent`). */
export const isProfileEvent = (event: EventEnvelope): boolean =>
  event.eventType === OPERATOR_ACTION || event.eventType === FLAG_LAPSED;
