import type { RiskLevel } from "../domain";
import type { StrategyId, StrategyOutcome } from "./strategies";

// ── Branch surface view model ─────────────────────────────────────────────────
//
// The projected state of the "branch" A2UI surface — what the War Room renders.
// Framework-agnostic and type-only so the Web Components client can import it
// without pulling in any server code.

export type BranchStatus =
  | "proposed" // a candidate the operator can explore
  | "simulating" // forked, dry-run in flight
  | "awaiting-review" // dry-run done; PARKED on its own gate, waiting for its reviewer
  | "simulated" // reviewed and cleared — a promotable candidate
  | "declined" // reviewed and rejected by its owner
  | "cancelled" // still parked when another branch was promoted; its ask was retracted
  | "committing" // the winner, applying for real
  | "committed" // the winner, applied
  | "rejected"; // a losing branch, kept as lineage

export interface BranchView {
  strategy: StrategyId;
  label: string;
  branchName: string; // git-style ref name, e.g. "spec/scale-replicas"
  executionId?: string;
  status: BranchStatus;
  risk: RiskLevel;
  description: string;
  outcome?: StrategyOutcome;
  winner?: boolean;
  /** Who ruled on this branch's simulation, once its own gate has been answered. */
  review?: { reviewer: string; approved: boolean; note?: string };
}

export type BranchPhase =
  | "idle"
  | "prepared" // gate reached; branches proposed, not yet explored
  | "exploring" // speculative forks running
  | "reviewing" // every branch is PARKED on its own review gate — the cohort is open
  | "explored" // every branch has been ruled on; the cohort is decidable
  | "committing" // winner applying for real
  | "committed"; // done

export interface BranchSurface {
  target: string;
  parentExecutionId: string | null;
  forkPoint: number | null; // the sequence the branches fork at
  phase: BranchPhase;
  branches: BranchView[];
  // Immutable fork lineage: how many branches were spun off the gate.
  lineageCount: number;
  // The ref table (git-style movable pointers).
  refs: Array<{ name: string; executionId: string; tip: number }>;
  note: string;
  /**
   * The open cohort: branches forked from one gate that are still parked on their own
   * review. A promotion is only decidable once this is empty, and promoting RETRACTS
   * whatever is left — a pointer move alone would leave those asks live, and a late
   * answer on a loser would resume it and run its effects for real.
   */
  awaitingReview: number;
}

export function emptyBranchSurface(): BranchSurface {
  return {
    target: "",
    parentExecutionId: null,
    forkPoint: null,
    phase: "idle",
    branches: [],
    lineageCount: 0,
    refs: [],
    note: "Branch-only, no merge: mutually-exclusive fixes can't be reconciled — you pick one.",
    awaitingReview: 0,
  };
}

export type { StrategyOutcome };
