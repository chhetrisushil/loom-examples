import { z } from "zod";
import type { RiskLevel } from "../domain";

// ── Candidate remediation strategies ──────────────────────────────────────────
//
// The incident (read-replica lag spiking on the primary) has more than one
// defensible fix — and they are *mutually exclusive*: you cannot both fail over
// the primary AND keep scaling its replicas. That exclusivity is exactly what
// makes git-style "branch, preview, pick a winner — no merge" the honest model.
//
// Each strategy is projected to a deterministic Outcome so the whole demo runs
// offline. In a real deployment `projectOutcome` would call a dry-run planner
// (e.g. `terraform plan`, a capacity model, a shadow apply) instead.

export const StrategyIdSchema = z.enum(["scale-replicas", "failover-primary", "throttle-writes"]);
export type StrategyId = z.infer<typeof StrategyIdSchema>;

export interface Strategy {
  id: StrategyId;
  label: string;
  risk: RiskLevel;
  description: string;
}

// The three candidate branches the operator gets to explore at the gate.
export const STRATEGIES: readonly Strategy[] = [
  {
    id: "scale-replicas",
    label: "Scale read replicas",
    risk: "medium",
    description: "Add 2 read replicas to spread WAL apply load and drain the backlog.",
  },
  {
    id: "failover-primary",
    label: "Fail over the primary",
    risk: "high",
    description: "Promote the healthiest replica to primary; briefly pauses writes.",
  },
  {
    id: "throttle-writes",
    label: "Throttle writes",
    risk: "low",
    description:
      "Rate-limit write QPS so the existing replicas catch up. Degrades write throughput.",
  },
];

export function strategyById(id: StrategyId): Strategy {
  const found = STRATEGIES.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown strategy: ${id}`);
  return found;
}

// The projected (simulate) or realized (real) result of applying a strategy.
// Speculative branches carry `simulated: true`; the promoted, committed branch
// carries `simulated: false, applied: true`.
export interface StrategyOutcome {
  strategy: StrategyId;
  label: string;
  simulated: boolean;
  applied: boolean;
  risk: RiskLevel;
  etaMinutes: number;
  downtimeSeconds: number;
  costPerHourUsd: number;
  // The metric the operator actually cares about: replica lag after the fix.
  projectedLagMs: number;
  summary: string;
}

// Deterministic projection for a strategy. Pure and side-effect-free, so a
// speculative branch can preview an outcome without touching real infrastructure.
export function projectOutcome(
  strategy: StrategyId,
  simulate: boolean,
  target: string
): StrategyOutcome {
  const s = strategyById(strategy);
  const base = {
    strategy,
    label: s.label,
    simulated: simulate,
    applied: !simulate,
    risk: s.risk,
  };
  const verb = simulate ? "Projected" : "Applied";
  switch (strategy) {
    case "scale-replicas":
      return {
        ...base,
        etaMinutes: 4,
        downtimeSeconds: 0,
        costPerHourUsd: 12,
        projectedLagMs: 180,
        summary: `${verb}: +2 read replicas on ${target}. WAL backlog drains, lag falls ~4200 → ~180ms. No downtime; +$12/hr.`,
      };
    case "failover-primary":
      return {
        ...base,
        etaMinutes: 9,
        downtimeSeconds: 12,
        costPerHourUsd: 0,
        projectedLagMs: 20,
        summary: `${verb}: promote healthiest replica to primary on ${target}. Lag ~4200 → ~20ms, but ~12s write pause during cutover.`,
      };
    case "throttle-writes":
      return {
        ...base,
        etaMinutes: 1,
        downtimeSeconds: 0,
        costPerHourUsd: 0,
        projectedLagMs: 600,
        summary: `${verb}: rate-limit writes on ${target} so replicas catch up. Lag ~4200 → ~600ms fast and free, but write throughput is degraded.`,
      };
  }
}

// The resume payload delivered to the suspended remediation flow at the gate —
// carries which branch (strategy) this execution is exploring and whether it is
// a dry-run simulation or the real, committed apply.
//
// Declared as a SCHEMA, not an interface: the flow lists it in `resumeSchemas`, so the gate
// parses it before the payload is appended (ADR 0077), and the static type is derived from
// the same declaration. One source of truth — the type cannot drift from what is enforced.
export const RemediationDecisionSchema = z.object({
  approved: z.boolean(),
  strategy: StrategyIdSchema,
  simulate: z.boolean(),
  approvedBy: z.string(),
  // Only the committing resume carries these: the candidate set that was on the table
  // and why this one won. They are what turns a promotion from a pointer move into a
  // durable decision (see the `ctx.decide` in `remediateLagRunner`).
  candidates: z.array(StrategyIdSchema).optional(),
  reason: z.string().optional(),
});
export type RemediationDecision = z.infer<typeof RemediationDecisionSchema>;

// ── The gate INSIDE a branch ──────────────────────────────────────────────────
//
// Each simulated branch parks for the strategy owner's sign-off. That is the whole
// point of this example: the branches are not a fan-out that finishes, they are N
// independent durable executions each waiting on a different human, for as long as
// that person takes.

/** The resume eventType that settles one branch's review. */
export const SIMULATION_REVIEWED = "SimulationReviewed";

export const BranchReviewSchema = z.object({
  // The approval NAMES the branch it approves. `ResumeEvent` is `{ eventType, payload }`,
  // so a `ResumeAuthenticator` never sees which execution it is being applied to —
  // evidence minted for one branch is byte-identical for its sibling. The address has to
  // travel IN the payload, and the gate's contract has to require it. The runner then
  // checks it against its own executionId and re-parks on a mismatch.
  branchExecutionId: z.string().min(1),
  approved: z.boolean(),
  reviewer: z.string().min(1),
  note: z.string().optional(),
});
export type BranchReview = z.infer<typeof BranchReviewSchema>;

/** A simulated branch's outcome once its reviewer has ruled on it. */
export interface ReviewedOutcome extends StrategyOutcome {
  review?: { reviewer: string; approved: boolean; note?: string };
}
