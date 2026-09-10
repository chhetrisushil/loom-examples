import { projection$ } from "@loom/core";
import type { EventEnvelope } from "@loom/core";

// ── The derivations a saved view binds THROUGH ───────────────────────────────
//
// A `DataBinding` is `{ projectionId, path }` — a NAME. What that name means is the fold
// registered under it, and the fold is where the window, the filter and the aggregation
// live. Two of the three things below are the same projection id at two different meanings,
// which is the whole point of the example: nothing about the blueprint changes when the
// fold does.
//
// `version` is the declaration that makes the difference visible (loom ADR 0095). It is the
// author's: no framework can derive it, because a fold closure has no stable fingerprint.

export const SPEND_SAMPLED = "SPEND_SAMPLED";
export const INCIDENT_OPENED = "INCIDENT_OPENED";

export interface SpendSample {
  /** Days before "now" this sample belongs to. Keeps the example clock-free. */
  daysAgo: number;
  /** Whether it falls inside the current calendar month. */
  thisMonth: boolean;
  amount: number;
}

export interface SpendState {
  total: number;
  samples: number;
}

export interface IncidentState {
  open: number;
}

const EMPTY_SPEND: SpendState = { total: 0, samples: 0 };

/**
 * v1 — **rolling 7 days**. A view promoted against this one means "spend over the last
 * week, evaluated at render".
 */
export const spendRolling7d = projection$({
  id: "spend",
  name: "Cloud spend (rolling 7 days)",
  version: "1",
  initialState: EMPTY_SPEND,
  handlers: {
    [SPEND_SAMPLED]: (state: SpendState, event: EventEnvelope): SpendState => {
      const sample = event.payload as SpendSample;
      if (sample.daysAgo > 7) return state;
      return { total: state.total + sample.amount, samples: state.samples + 1 };
    },
  },
});

/**
 * v2 — **calendar month to date**, under the SAME id. Every widget renders identically,
 * every binding resolves, the blueprint's content address is unchanged, and the number
 * means something else. This is the change the pin exists to report.
 */
export const spendMonthToDate = projection$({
  id: "spend",
  name: "Cloud spend (month to date)",
  version: "2",
  initialState: EMPTY_SPEND,
  handlers: {
    [SPEND_SAMPLED]: (state: SpendState, event: EventEnvelope): SpendState => {
      const sample = event.payload as SpendSample;
      if (!sample.thisMonth) return state;
      return { total: state.total + sample.amount, samples: state.samples + 1 };
    },
  },
});

/** Unchanged across the deploy — so a report can show one binding drifting and one not. */
export const incidents = projection$({
  id: "incidents",
  name: "Open incidents",
  version: "1",
  initialState: { open: 0 } satisfies IncidentState,
  handlers: {
    [INCIDENT_OPENED]: (state: IncidentState): IncidentState => ({ open: state.open + 1 }),
  },
});
