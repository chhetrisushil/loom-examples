import type { SurfaceEmitter } from "@loom/agent-surface";
import type { ExecutionState } from "@loom/core";
import type { ExecutionDispatcher } from "@loom/dispatcher";
import type { BranchRegistry } from "@loom/event-runtime";
import { parallelLimit } from "@loom/scheduler";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { MigrationExecutionFlow } from "../capabilities/flows";
import { BRANCH_TARGET } from "../compute/dispatcher";
import { progressHub } from "../runtime/progressHub";
import type { BranchSurface, BranchView } from "../warroom/branchView";
import { emptyBranchSurface } from "../warroom/branchView";
import {
  SHADOW_VERIFIED,
  STRATEGIES,
  type StrategyId,
  type StrategyOutcome,
  strategyById,
} from "../warroom/strategies";

// ── BranchOrchestrator — Loom's git-style branching, made a live experience ────
//
// This is the whole point of the example. It drives the fork → simulate →
// compare → promote loop over a durably-suspended migration execution:
//
//   1. prepare()  — start the migration flow, run it to the approval gate
//                   (ctx.suspend), point `main` at it, and propose the candidate
//                   strategies. The parent is now a durable fork point.
//   2. explore()  — fork one child per candidate strategy from the gate, then
//                   resume each *in simulate mode* CONCURRENTLY (@loom/scheduler
//                   parallelLimit — deterministic, input-ordered results). Each
//                   branch runs its strategy against a shadow schema, streaming
//                   live backfill progress, without touching the real table.
//                   The parent log is never touched (copy-on-write).
//   3. promote()  — repoint `main` onto the winner (records the decision), then
//                   fork a fresh commit branch and apply it FOR REAL. Losing
//                   branches remain as immutable lineage — the "alternatives
//                   considered" audit trail. There is no merge.
//
// Every mutation mirrors the BranchSurface to the "branch" A2UI surface, so the
// Migration Board graph + diff fill in live over SSE — including the three
// backfill progress bars advancing at once during exploration.

export interface BranchOrchestratorDeps {
  runtime: WorkflowRuntime;
  branchRegistry: BranchRegistry;
  branch: SurfaceEmitter;
  /**
   * OPTIONAL compute placement for branch work. A simulated migration clones a table and
   * backfills it — capacity sized for a branch, not for the web server. With a dispatcher
   * wired, each branch is dispatched to the `branch` lane instead of running in-process;
   * without one the example behaves exactly as before (and the progress bars still work,
   * which is itself a finding — see the README).
   */
  dispatcher?: ExecutionDispatcher;
}

export class BranchOrchestrator {
  private state: BranchSurface = emptyBranchSurface();
  private migrationExecId: string | null = null;

  constructor(private readonly deps: BranchOrchestratorDeps) {}

  getSurface(): BranchSurface {
    return this.state;
  }

  reset(): void {
    this.state = emptyBranchSurface();
    this.migrationExecId = null;
    this.publish();
  }

  // Phase 1 — run the migration flow to its durable gate and propose strategies.
  async prepare(target: string, migrationExecId: string): Promise<void> {
    const handle = await this.deps.runtime.start(
      MigrationExecutionFlow,
      { target },
      { executionId: migrationExecId }
    );
    const suspended = await handle.waitForSuspend();
    const forkPoint = suspended.sequence;
    this.migrationExecId = migrationExecId;

    // Point the canonical `main` ref at the suspended migration execution.
    const now = Date.now();
    await this.deps.branchRegistry.putRef({
      name: "main",
      executionId: migrationExecId,
      tip: forkPoint,
      createdAt: now,
      updatedAt: now,
    });

    this.state = {
      ...emptyBranchSurface(),
      target,
      parentExecutionId: migrationExecId,
      forkPoint,
      phase: "prepared",
      branches: STRATEGIES.map(
        (s): BranchView => ({
          strategy: s.id,
          label: s.label,
          branchName: `spec/${s.id}`,
          status: "proposed",
          risk: s.risk,
          description: s.description,
        })
      ),
    };
    await this.refreshRefs();
    this.publish();
  }

  // Phase 2 — fork + speculatively simulate every candidate, concurrently, each
  // streaming its live backfill progress onto the branch surface.
  async explore(): Promise<StrategyOutcome[]> {
    const parent = this.migrationExecId;
    const forkPoint = this.state.forkPoint;
    if (parent === null || forkPoint === null || this.state.phase === "idle") {
      throw new Error("Cannot explore branches before prepare().");
    }
    this.setPhase("exploring");

    // parallelLimit preserves input order in the result array — the branch list
    // stays deterministic for replay even though the simulations interleave.
    const outcomes = await parallelLimit(
      STRATEGIES.map((s) => async (_signal: AbortSignal) => {
        const branchName = `spec/${s.id}`;
        // Copy-on-write fork of the suspended gate. Parent stays intact.
        // Placed, not merely dispatched. Passing a target per dispatch is ephemeral — it
        // lives in this process's memory — so the FIRST dispatch would land on the worker
        // and every later wake would land wherever the timer service runs (loom#392).
        // Recording it on the branch at fork time is what makes the placement survive the
        // suspension this branch is about to take.
        const fork = await this.deps.runtime.fork(parent, forkPoint, {
          branchName,
          ...(this.deps.dispatcher !== undefined && { computeTarget: BRANCH_TARGET }),
        });
        this.patchBranch(s.id, {
          executionId: fork.executionId,
          status: "simulating",
          progress: 0,
        });

        // Stream this branch's backfill progress onto the surface as it simulates.
        const unsub = progressHub.onProgress(fork.executionId, (pct) => {
          this.patchBranch(s.id, { progress: pct });
        });
        try {
          // Drive this branch down the alternate path — dry-run only. Dispatched to the
          // `branch` lane when a dispatcher is wired: the package carries identity and
          // resume coordinates, never code or state, so the worker rebuilds the branch
          // from the shared stores and this process never runs the backfill.
          const resumeEvent = {
            eventType: "MigrationDecision",
            payload: { approved: true, strategy: s.id, simulate: true, approvedBy: "explorer" },
          };
          const final = await this.drive(fork.executionId, resumeEvent);
          await this.deps.branchRegistry.moveTip(branchName, final.sequence);

          // A simulated branch does not finish here any more: it parks for shadow
          // verification. The outcome is readable once that gate is answered.
          const suspended = final.status === "suspended";
          this.patchBranch(s.id, {
            status: suspended ? "awaiting-verification" : "simulated",
            progress: 100,
            ...(suspended ? {} : { outcome: final.variables._output as StrategyOutcome }),
          });
          await this.refreshRefs();
          return final.variables._output as StrategyOutcome;
        } finally {
          unsub();
        }
      }),
      { limit: STRATEGIES.length }
    );

    this.setPhase("explored");
    await this.refreshRefs();
    this.publish();
    return outcomes;
  }

  // Phase 3 — pick a winner: promote its ref onto main (the decision record),
  // then fork a fresh commit branch and apply it FOR REAL. No merge.
  async promote(strategy: StrategyId): Promise<StrategyOutcome> {
    const parent = this.migrationExecId;
    const forkPoint = this.state.forkPoint;
    if (parent === null || forkPoint === null || this.state.phase !== "explored") {
      throw new Error("Cannot promote before branches are explored.");
    }
    const winnerBranch = `spec/${strategy}`;
    this.setPhase("committing");
    this.patchBranch(strategy, { status: "committing", winner: true });
    // Mark the others as rejected (kept immutable as lineage / audit trail).
    for (const s of STRATEGIES) {
      if (s.id !== strategy) this.patchBranch(s.id, { status: "rejected" });
    }

    // Repoint main onto the winning exploration — records the human decision.
    await this.deps.branchRegistry.promote(winnerBranch, "main");

    // Commit for real: a fresh branch forked from the same gate, resumed with
    // simulate:false. The real migration is itself a durable, replayable execution.
    const commit = await this.deps.runtime.fork(parent, forkPoint, { branchName: "commit" });
    const resumed = await this.deps.runtime.resume(commit.executionId, {
      eventType: "MigrationDecision",
      payload: { approved: true, strategy, simulate: false, approvedBy: "operator" },
    });
    const final = await resumed.waitForCompletion();
    await this.deps.branchRegistry.moveTip("commit", final.sequence);
    // main now names the applied execution — "what we actually did".
    await this.deps.branchRegistry.promote("commit", "main");

    const outcome = final.variables._output as StrategyOutcome;
    this.patchBranch(strategy, { status: "committed", progress: 100, outcome, winner: true });
    this.setPhase("committed");
    await this.refreshRefs();
    this.publish();
    return outcome;
  }

  /**
   * Run one branch step, wherever the branch belongs. With a dispatcher this crosses the
   * placement boundary as an `ExecutionPackage`; without one it is an in-process resume.
   * Both return the folded state at the stopping point — completed OR suspended.
   */
  private async drive(
    executionId: string,
    resumeEvent: { eventType: string; payload: unknown }
  ): Promise<ExecutionState> {
    if (this.deps.dispatcher === undefined) {
      const resumed = await this.deps.runtime.resume(executionId, resumeEvent);
      // waitForSuspend resolves for a parked branch; waitForCompletion never would.
      return await Promise.race([resumed.waitForSuspend(), resumed.waitForCompletion()]);
    }
    const result = await this.deps.dispatcher.dispatch(
      {
        executionId,
        workflowId: MigrationExecutionFlow.definition.id,
        flowId: MigrationExecutionFlow.definition.id,
        resumeEvent,
      },
      { target: BRANCH_TARGET }
    );
    return result.state;
  }

  /** A DBA answers one branch's shadow verification. Arrives whenever that person gets to it. */
  async verify(
    strategy: StrategyId,
    verdict: { verified: boolean; verifiedBy: string; rowsChecked?: number }
  ): Promise<StrategyOutcome | null> {
    const branch = this.state.branches.find((b) => b.strategy === strategy);
    if (!branch?.executionId) throw new Error(`Branch "${strategy}" has not been forked.`);
    if (branch.status !== "awaiting-verification") return branch.outcome ?? null;

    const final = await this.drive(branch.executionId, {
      eventType: SHADOW_VERIFIED,
      payload: {
        branchExecutionId: branch.executionId,
        verified: verdict.verified,
        verifiedBy: verdict.verifiedBy,
        ...(verdict.rowsChecked !== undefined && { rowsChecked: verdict.rowsChecked }),
      },
    });
    await this.deps.branchRegistry.moveTip(branch.branchName, final.sequence);
    const outcome = final.variables._output as StrategyOutcome;
    this.patchBranch(strategy, {
      status: verdict.verified ? "simulated" : "rejected",
      outcome,
    });
    if (this.state.branches.every((b) => b.status !== "awaiting-verification")) {
      this.setPhase("explored");
    }
    await this.refreshRefs();
    this.publish();
    return outcome;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private setPhase(phase: BranchSurface["phase"]): void {
    this.state = { ...this.state, phase };
    this.deps.branch.set("phase", phase);
  }

  private patchBranch(strategy: StrategyId, patch: Partial<BranchView>): void {
    this.state = {
      ...this.state,
      branches: this.state.branches.map((b) => (b.strategy === strategy ? { ...b, ...patch } : b)),
    };
    // Push the whole list so the graph + diff widgets re-read granularly.
    this.deps.branch.set("branches", this.state.branches);
  }

  private async refreshRefs(): Promise<void> {
    const refs = await this.deps.branchRegistry.listRefs();
    this.state = {
      ...this.state,
      refs: refs
        .map((r) => ({ name: r.name, executionId: r.executionId, tip: r.tip }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      lineageCount: this.migrationExecId
        ? (await this.deps.branchRegistry.children(this.migrationExecId)).length
        : 0,
    };
    this.deps.branch.merge("", { refs: this.state.refs, lineageCount: this.state.lineageCount });
  }

  private publish(): void {
    this.deps.branch.set("", this.state);
  }
}

export { STRATEGIES, strategyById };
