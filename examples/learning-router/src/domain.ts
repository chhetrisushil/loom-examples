// ── The simulated world ───────────────────────────────────────────────────────
//
// Everything here is DETERMINISTIC. A learning demo that depends on Math.random
// teaches nothing reproducible, and — more importantly — a Loom flow must be
// replayable, so the only randomness in this example is a seeded PRNG that is
// explicitly injected into the policy (see policy.ts).

/** The three model tiers a ticket can be routed to. */
export const ROUTES = ["gemma", "sonnet", "opus"] as const;
export type Route = (typeof ROUTES)[number];

export interface Ticket {
  id: string;
  /** 1 = customer is escalating, 0 = routine. */
  urgent: number;
  /** Normalized ticket length in [0,1]. */
  length: number;
}

/**
 * Ground truth the policy has to discover, and never gets told.
 *
 * The shape is chosen so a CONTEXT-BLIND bandit cannot win: averaged over all
 * tickets the three routes are close together, but conditioned on the
 * observation the right answer flips. Cheap handles routine short tickets as
 * well as anything; the expensive tier only earns its cost on hard ones.
 */
export function quality(route: Route, ticket: Ticket): number {
  const hard = ticket.urgent === 1 || ticket.length > 0.6;
  if (route === "gemma") return hard ? 0.25 : 0.9;
  if (route === "sonnet") return hard ? 0.6 : 0.75;
  return hard ? 0.95 : 0.7; // opus: great when it's hard, wasteful when it isn't
}

/** A fixed, reproducible ticket stream — half of them hard. */
export function tickets(count: number): Ticket[] {
  const out: Ticket[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `TICK-${String(i).padStart(4, "0")}`,
      urgent: i % 3 === 0 ? 1 : 0,
      // Deterministic spread in [0,1) that is not correlated with `urgent`.
      length: ((i * 37) % 100) / 100,
    });
  }
  return out;
}

/** Mulberry32 — a small seeded PRNG, so "exploration" is reproducible run to run. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
