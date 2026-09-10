import type { Topic } from "./catalogue";

// ── The flag catalogue: a closed, versioned vocabulary ───────────────────────
//
// A capability flag asserts that an operator has demonstrably DONE something, scoped to
// a resource class. Three properties make it usable in an operations tool, and each is a
// constraint on this file rather than a feature elsewhere:
//
//   • it is CLOSED. Flags are added here, by review. A system that can invent its own
//     features about people is a system whose behaviour cannot be reviewed — and a
//     catalogue that could grow at runtime would make "why am I seeing this" unanswerable
//     by construction.
//   • it is VERSIONED. The catalogue is half of the fold that turns evidence into a
//     profile, so a run that resolved a profile under v1 did not resolve the same profile
//     v2 would. That is why the resolved profile is journaled with this version beside it.
//   • nothing here can encode a demographic, a title, or a tenure. There is no flag such
//     an attribute could set, which is what makes the exclusion enforceable rather than a
//     policy statement.

/** Bump on ANY change to the entries below — a different catalogue is a different fold. */
export const FLAG_CATALOGUE_VERSION = 1;

export interface FlagDefinition {
  id: string;
  /** The resource class this flag is scoped to. Competence is not uniform across them. */
  topic: Topic;
  /** The interaction that evidences it, as recorded on an OPERATOR_ACTION event. */
  evidencedBy: string;
  /**
   * How many separate observations set it. One is an accident or a misclick; the point of
   * a threshold is that a flag says "does this", not "did this once".
   */
  threshold: number;
  /**
   * How long an unevidenced flag survives, in ms. Expiry replaces weighting because it is
   * explicable: "this lapses on the 24th unless you use it again" is a sentence a person
   * can act on, and "your weight decayed to 0.61" is not.
   */
  horizonMs: number;
  /** Shown to the operator when they ask why a flag is set. */
  describes: string;
  /**
   * The WHY widget this flag suggests leading with, by catalogue id.
   *
   * A SUGGESTION, and the weakest input in the system: a stated preference overrides it
   * (§C7 — what an operator says about themselves outranks what the system inferred), and
   * it can only reorder a set the agent already chose.
   */
  promotes: string;
}

const DAY = 24 * 60 * 60 * 1000;

export const FLAG_CATALOGUE: readonly FlagDefinition[] = [
  {
    id: "reads_query_plans",
    topic: "queries",
    evidencedBy: "open.queries.slow",
    threshold: 3,
    horizonMs: 30 * DAY,
    describes: "reads query plans directly rather than working from a summary",
    promotes: "queries.slow",
  },
  {
    id: "inspects_connections",
    topic: "connections",
    evidencedBy: "open.connections.waiting",
    threshold: 2,
    horizonMs: 30 * DAY,
    describes: "inspects the connection pool's queue rather than its headline number",
    promotes: "connections.waiting",
  },
  {
    id: "tracks_replication",
    topic: "replication",
    evidencedBy: "open.replication.lag",
    threshold: 2,
    horizonMs: 14 * DAY,
    describes: "tracks replica apply lag",
    promotes: "replication.lag",
  },
];

const BY_ID = new Map(FLAG_CATALOGUE.map((f) => [f.id, f]));

/**
 * Look up a flag, refusing an unknown id.
 *
 * The refusal is the closure property doing its job: a caller that could quietly ask about
 * `"senior_engineer"` and get `undefined` back would make the closed catalogue a
 * convention rather than a boundary.
 */
export function flagDefinition(id: string): FlagDefinition {
  const flag = BY_ID.get(id);
  if (!flag) throw new Error(`no flag "${id}" in the catalogue (v${FLAG_CATALOGUE_VERSION})`);
  return flag;
}

/** The action ids the profile takes evidence from — everything else is not signal. */
export function evidencedActions(): string[] {
  return FLAG_CATALOGUE.map((f) => f.evidencedBy);
}
