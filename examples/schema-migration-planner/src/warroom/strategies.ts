import { z } from "zod";
import type { RiskLevel } from "../domain";

// ── Candidate migration strategies ────────────────────────────────────────────
//
// Backfilling a NOT NULL column onto a large, actively-written table has more than
// one defensible strategy — and they are *mutually exclusive*: you run exactly one
// migration, you can't half-do an online-DDL and half-do a dual-write. That
// exclusivity is exactly what makes git-style "branch, preview, pick a winner — no
// merge" the honest model: explore several, commit one, keep the rest as an audit
// trail of alternatives considered.
//
// Each strategy is projected to a deterministic Outcome so the whole demo runs
// offline. In a real deployment `projectOutcome` would run the migration against a
// shadow schema (or a dry-run planner like gh-ost's `--dry-run`) instead.

export const StrategyIdSchema = z.enum(["online-ddl", "shadow-copy", "dual-write"]);
export type StrategyId = z.infer<typeof StrategyIdSchema>;

export interface Strategy {
  id: StrategyId;
  label: string;
  risk: RiskLevel;
  description: string;
}

// The three candidate branches the operator gets to explore at the gate. There is
// deliberately no dominant option — every comparison column trades off against the
// others (that is what makes the decision hard, and worth branching).
export const STRATEGIES: readonly Strategy[] = [
  {
    id: "online-ddl",
    label: "Online DDL (gh-ost)",
    risk: "medium",
    description: "Build a shadow table, copy rows in chunks, atomically rename. ~3s cutover lock.",
  },
  {
    id: "shadow-copy",
    label: "Shadow copy + swap",
    risk: "low",
    description:
      "Bulk-copy into a new table, swap in one transaction, drop the old — fast but irreversible once swapped.",
  },
  {
    id: "dual-write",
    label: "Dual-write + backfill",
    risk: "high",
    description:
      "App writes both schemas, backfill in the background, flip a cutover flag. Zero lock, but heavy app coordination.",
  },
];

export function strategyById(id: StrategyId): Strategy {
  const found = STRATEGIES.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown strategy: ${id}`);
  return found;
}

// The projected (simulate) or realized (real) result of running a migration
// strategy. Speculative branches carry `simulated: true`; the promoted, committed
// branch carries `simulated: false, applied: true`.
export interface StrategyOutcome {
  strategy: StrategyId;
  label: string;
  simulated: boolean;
  applied: boolean;
  risk: RiskLevel;
  // Write-lock time during cutover — the number everyone fears.
  lockSeconds: number;
  // Total wall-clock time to complete the migration.
  durationMinutes: number;
  // Rows rewritten / copied to the new schema.
  rowsCopied: number;
  // Can it be aborted/rolled back cleanly mid-flight?
  rollbackable: boolean;
  summary: string;
}

// Deterministic projection for a strategy against the target table's row count.
// Pure and side-effect-free, so a speculative branch can preview an outcome
// without touching the real table.
export function projectOutcome(
  strategy: StrategyId,
  simulate: boolean,
  target: string,
  rowCount: number
): StrategyOutcome {
  const s = strategyById(strategy);
  const base = {
    strategy,
    label: s.label,
    simulated: simulate,
    applied: !simulate,
    risk: s.risk,
    rowsCopied: rowCount,
  };
  const verb = simulate ? "Projected" : "Applied";
  const rows = `${(rowCount / 1_000_000).toFixed(0)}M rows`;
  switch (strategy) {
    case "online-ddl":
      return {
        ...base,
        lockSeconds: 3,
        durationMinutes: 22,
        rollbackable: true,
        summary: `${verb}: online DDL on ${target} — chunked copy of ${rows}, ~3s cutover lock, ~22m total. Abortable during copy.`,
      };
    case "shadow-copy":
      return {
        ...base,
        lockSeconds: 8,
        durationMinutes: 14,
        rollbackable: false,
        summary: `${verb}: shadow-copy ${rows} on ${target}, swap in a txn (~8s lock), ~14m total. Fastest, but the old table is dropped — no rollback after swap.`,
      };
    case "dual-write":
      return {
        ...base,
        lockSeconds: 0,
        durationMinutes: 40,
        rollbackable: true,
        summary: `${verb}: dual-write + background backfill of ${rows} on ${target}. Zero lock, ~40m total, but needs app changes and careful cutover.`,
      };
  }
}

// The resume payload delivered to the suspended migration flow at the gate —
// carries which branch (strategy) this execution is running and whether it is a
// dry-run simulation (against a shadow schema) or the real, committed apply.
//
// A SCHEMA, not an interface: the flow lists it in `resumeSchemas`, so the gate parses it
// before the payload is appended (ADR 0077), and the static type is inferred from the same
// declaration — the type cannot drift from what is enforced.
export const MigrationDecisionSchema = z.object({
  approved: z.boolean(),
  strategy: StrategyIdSchema,
  simulate: z.boolean(),
  approvedBy: z.string(),
});
export type MigrationDecision = z.infer<typeof MigrationDecisionSchema>;

// ── The shadow-verification gate ─────────────────────────────────────────────
//
// A shadow migration does not end when the backfill does. Someone compares row
// counts, checks constraint violations, and signs the branch off — and that person
// is not waiting at a keyboard while 40 million rows copy. So a simulated branch
// suspends here, which is what makes a branch LONG-RUNNING rather than merely slow:
// the compute that ran the backfill is finished and released, and the execution is
// parked in storage until a human answers.
export const SHADOW_VERIFIED = "ShadowVerified";

export const ShadowVerificationSchema = z.object({
  // The verification names the branch it settles: a sibling's sign-off parses
  // identically at the same gate (see incident-war-room for the same contract).
  branchExecutionId: z.string().min(1),
  verified: z.boolean(),
  verifiedBy: z.string().min(1),
  rowsChecked: z.number().int().nonnegative().optional(),
});
export type ShadowVerification = z.infer<typeof ShadowVerificationSchema>;
