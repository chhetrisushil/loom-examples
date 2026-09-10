import type { Policy, PolicyChoice, PolicyContext } from "@loom/learning";
import { FLAG_CATALOGUE, flagDefinition } from "./flags";
import type { OperatorProfile } from "./profile";

// ── The exploration floor ────────────────────────────────────────────────────
//
// A system that only surfaces what it already believes someone can use learns nothing it
// does not already believe: the operator never sees the capability, never uses it, and
// the absence of use is read back as confirmation. So a fixed fraction of steady-state
// sessions leads with exactly ONE capability above the operator's assessed level, and the
// outcome is recorded whether or not it is used.
//
// Two things make that fraction a measurement rather than a gesture, and both are easy to
// leave out:
//
//   • the PROPENSITY is recorded at the moment of the draw. It cannot be reconstructed
//     afterwards — the policy's state at decision time is gone after the next change —
//     and without it `evaluatePolicy` refuses a value estimate and reports
//     `agreement-only`. A log that omits it looks completely fine and is silently
//     unevaluable.
//   • NON-USE is recorded as a zero, not as an absence. An absent outcome is skipped by
//     credit assignment; a zero is evidence. Recording only the successes produces a
//     profile that inflates monotonically, which is the failure this whole floor exists
//     to prevent.

/** `none` means "surface nothing above the assessed level this session". */
export const NO_EXPLORATION = "none";

export interface ExplorationContext extends PolicyContext {
  subject: string;
  /** How many capabilities the operator already holds — the assessed level, coarsely. */
  held: number;
  topic: string;
}

/**
 * A fixed-budget explorer: with probability `rate`, surface one unheld capability chosen
 * uniformly; otherwise surface nothing.
 *
 * Uniform, not "the most likely to land". A sampler that favours what the system already
 * expects to succeed reproduces the blind spot the floor exists to break, and it makes
 * the propensities harder to reason about for no measured gain.
 */
export class ExplorationFloor implements Policy<string> {
  readonly id = "exploration-floor";
  readonly version = "1.0.0";

  constructor(
    private readonly rate = 0.15,
    private readonly random: () => number = Math.random
  ) {
    if (rate < 0 || rate >= 1) {
      throw new RangeError(`exploration rate must be in [0, 1) (got ${rate})`);
    }
  }

  select(_context: PolicyContext, actions: readonly string[]): PolicyChoice<string> {
    const candidates = actions.filter((a) => a !== NO_EXPLORATION);
    // Nothing above the assessed level on this surface: the honest propensity is 1, not a
    // pretend fraction over an empty candidate set.
    if (candidates.length === 0) return { action: NO_EXPLORATION, propensity: 1 };

    if (this.random() >= this.rate) {
      return { action: NO_EXPLORATION, propensity: 1 - this.rate };
    }
    const index = Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length));
    return {
      action: candidates[index] as string,
      // The probability of THIS action, not of exploring: ε spread over the candidates.
      propensity: this.rate / candidates.length,
    };
  }
}

/**
 * The capabilities worth surfacing to this operator on this surface: catalogue flags they
 * do NOT hold whose widget is actually present, plus the option of surfacing nothing.
 *
 * A capability the surface cannot show is not a candidate — exploring it would record an
 * outcome for something the operator was never offered.
 */
export function explorationActions(
  profile: OperatorProfile | null,
  available: readonly string[]
): string[] {
  const held = new Set(profile?.flags ?? []);
  const candidates = FLAG_CATALOGUE.filter(
    (f) => !held.has(f.id) && available.includes(f.promotes)
  ).map((f) => f.id);
  return [NO_EXPLORATION, ...candidates];
}

/** The widget a surfaced capability leads with, or null when nothing was surfaced. */
export function surfacedWidget(action: string): string | null {
  return action === NO_EXPLORATION ? null : flagDefinition(action).promotes;
}
