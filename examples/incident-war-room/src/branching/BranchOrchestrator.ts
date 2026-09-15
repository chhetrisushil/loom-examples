import type { SurfaceEmitter } from "@loom/agent-surface";
import type { BranchRegistry } from "@loom/event-runtime";
import { parallelLimit } from "@loom/scheduler";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { RemediateLagFlow } from "../capabilities/flows";
import type { BranchSurface, BranchView } from "../warroom/branchView";
import { emptyBranchSurface } from "../warroom/branchView";
import {
  type ReviewedOutcome,
  SIMULATION_REVIEWED,
  STRATEGIES,
  type StrategyId,
  type StrategyOutcome,
  strategyById,
} from "../warroom/strategies";

// ── BranchOrchestrator — Loom's git-style branching, made a live experience ────
//
// This is the whole point of the example. It drives the fork → simulate →
// compare → promote loop over a durably-suspended remediation execution:
//
//   1. prepare()  — start the remediation flow, run it to the approval gate
//                   (ctx.suspend), point `main` at it, and propose the candidate
//                   branches. The parent is now a durable fork point.
//   2. explore()  — fork one child per candidate strategy from the gate, then
//                   resume each *in simulate mode* CONCURRENTLY (@loom/scheduler
//                   parallelLimit — deterministic, input-ordered results). Each
//                   branch previews its projected outcome without mutating infra.
//                   The parent log is never touched (copy-on-write).
//   3. promote()  — repoint `main` onto the winner (records the decision), then
//                   fork a fresh commit branch and resume it for REAL. Losing
//                   branches remain as immutable lineage — the "alternatives
//                   considered" audit trail. There is no merge.
//
// Every mutation mirrors the BranchSurface to the "branch" A2UI surface, so the
// War Room graph + diff fill in live over SSE.

export interface BranchOrchestratorDeps {
  runtime: WorkflowRuntime;
  branchRegistry: BranchRegistry;
  branch: SurfaceEmitter;
}

export class BranchOrchestrator {
  private state: BranchSurface = emptyBranchSurface();
  private remediationExecId: string | null = null;

  constructor(private readonly deps: BranchOrchestratorDeps) {}

  getSurface(): BranchSurface {
    return this.state;
  }

  reset(): void {
    this.state = emptyBranchSurface();
    this.remediationExecId = null;
    this.publish();
  }

  // Phase 1 — run the remediation flow to its durable gate and propose branches.
  async prepare(target: string, remediationExecId: string): Promise<void> {
    const handle = await this.deps.runtime.start(
      RemediateLagFlow,
      { target },
      { executionId: remediationExecId }
    );
    const suspended = await handle.waitForSuspend();
    const forkPoint = suspended.sequence;
    this.remediationExecId = remediationExecId;

    // Point the canonical `main` ref at the suspended remediation execution.
    const now = Date.now();
    await this.deps.branchRegistry.putRef({
      name: "main",
      executionId: remediationExecId,
      tip: forkPoint,
      createdAt: now,
      updatedAt: now,
    });

    this.state = {
      ...emptyBranchSurface(),
      target,
      parentExecutionId: remediationExecId,
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

  // Phase 2 — fork every candidate and start its simulation. Returns once every
  // branch is PARKED on its own review gate, not once they have finished.
  //
  // This is the shape the example exists to show. The previous version awaited
  // `waitForCompletion()` inside the fan-out, which works only while a branch runs
  // straight through: the suspend path never resolves the completion promise, so the
  // first branch that parks on a human would hang the whole explore() forever. A
  // cohort of long-running branches has to be driven by arrivals, not by awaiting.
  async explore(): Promise<BranchView[]> {
    const parent = this.remediationExecId;
    const forkPoint = this.state.forkPoint;
    if (parent === null || forkPoint === null || this.state.phase === "idle") {
      throw new Error("Cannot explore branches before prepare().");
    }
    this.setPhase("exploring");

    // parallelLimit preserves input order in the result array — the branch list
    // stays deterministic for replay even though the simulations interleave.
    await parallelLimit(
      STRATEGIES.map((s) => async (_signal: AbortSignal) => {
        const branchName = `spec/${s.id}`;
        // Copy-on-write fork of the suspended gate. Parent stays intact. With `timers`
        // wired the fork also carries the gate's deadline: a timer row is keyed by
        // execution, so each branch gets its own rather than sharing the parent's.
        const fork = await this.deps.runtime.fork(parent, forkPoint, { branchName });
        this.patchBranch(s.id, { executionId: fork.executionId, status: "simulating" });

        // Resume this branch down the alternate path — dry-run only. It runs the
        // simulation and then parks on ITS OWN gate, waiting for that strategy's owner.
        const resumed = await this.deps.runtime.resume(fork.executionId, {
          eventType: "RemediationDecision",
          payload: { approved: true, strategy: s.id, simulate: true, approvedBy: "explorer" },
        });
        const parked = await resumed.waitForSuspend();
        await this.deps.branchRegistry.moveTip(branchName, parked.sequence);
        this.patchBranch(s.id, { status: "awaiting-review" });
        await this.refreshRefs();
      }),
      { limit: STRATEGIES.length }
    );

    this.setPhase("reviewing");
    await this.refreshRefs();
    this.publish();
    return this.state.branches;
  }

  // Phase 2b — one branch's reviewer answers. Each arrives independently, whenever
  // that person gets to it; the cohort becomes decidable only when the last one lands.
  async review(
    strategy: StrategyId,
    verdict: { approved: boolean; reviewer: string; note?: string }
  ): Promise<StrategyOutcome | null> {
    const branch = this.state.branches.find((b) => b.strategy === strategy);
    if (!branch?.executionId) throw new Error(`Branch "${strategy}" has not been forked.`);
    if (branch.status !== "awaiting-review") return branch.outcome ?? null;

    // The review NAMES its branch. The gate's schema requires the field and the runner
    // checks it against its own executionId, so an answer meant for a sibling is ignored
    // rather than silently settling this one.
    const resumed = await this.deps.runtime.resume(branch.executionId, {
      eventType: SIMULATION_REVIEWED,
      payload: {
        branchExecutionId: branch.executionId,
        approved: verdict.approved,
        reviewer: verdict.reviewer,
        ...(verdict.note !== undefined && { note: verdict.note }),
      },
    });
    const final = await resumed.waitForCompletion();
    await this.deps.branchRegistry.moveTip(branch.branchName, final.sequence);

    const outcome = final.variables._output as ReviewedOutcome;
    this.patchBranch(strategy, {
      status: verdict.approved ? "simulated" : "declined",
      outcome,
      ...(outcome.review !== undefined && { review: outcome.review }),
    });

    // Decidable once nothing is still parked. Branches that were declined stay in the
    // cohort as lineage — they were answered, they just lost on their own merits.
    if (this.state.branches.every((b) => b.status !== "awaiting-review")) {
      this.setPhase("explored");
    }
    await this.refreshRefs();
    this.publish();
    return outcome;
  }

  // Phase 3 — pick a winner: promote its ref onto main (the decision record),
  // then fork a fresh commit branch and apply it FOR REAL. No merge.
  async promote(strategy: StrategyId): Promise<StrategyOutcome> {
    const parent = this.remediationExecId;
    const forkPoint = this.state.forkPoint;
    // Deliberately NOT gated on the whole cohort being answered. The first branch to
    // come back cleared can win; the rest are retracted below. Waiting for every
    // reviewer would make the slowest one the critical path for an incident fix.
    if (parent === null || forkPoint === null) {
      throw new Error("Cannot promote before prepare().");
    }
    if (this.state.phase !== "reviewing" && this.state.phase !== "explored") {
      throw new Error("Cannot promote before branches have been simulated.");
    }
    const winner = this.state.branches.find((b) => b.strategy === strategy);
    if (winner?.review?.approved !== true) {
      throw new Error(`Cannot promote "${strategy}": its reviewer has not cleared it.`);
    }
    const winnerBranch = `spec/${strategy}`;
    this.setPhase("committing");
    this.patchBranch(strategy, { status: "committing", winner: true });

    // Repoint main onto the winning exploration — records the human decision.
    //
    // `expect` makes this a compare-and-set. Two operators can be looking at the same War
    // Room, and a promotion is last-write-wins without it: the second one lands silently on
    // top of the first, and `main` ends up naming a strategy nobody chose second. Here we
    // assert main still names the gate we forked from.
    const winnerExecId = winner.executionId as string;
    await this.deps.branchRegistry.promote(winnerBranch, "main", { expect: parent });

    // Close the cohort — AFTER the guarded ref move, never before. `promote()` is a pointer
    // move: on its own it leaves every other branch suspended and resumable, so their
    // reviewers still owe an answer nobody needs, and a late answer would resume a loser and
    // run its effects for real. But retracting first would mean a LOST compare-and-set had
    // already cancelled three people's open questions for a promotion that never happened.
    for (const s of STRATEGIES) {
      if (s.id === strategy) continue;
      const other = this.state.branches.find((b) => b.strategy === s.id);
      if (other?.status === "awaiting-review" && other.executionId) {
        await this.deps.runtime.cancel(other.executionId, `superseded by "${strategy}"`);
        this.patchBranch(s.id, { status: "cancelled" });
      } else {
        // Answered already — kept immutable as lineage / the audit trail.
        this.patchBranch(s.id, { status: "rejected" });
      }
    }

    // Commit for real: a fresh branch forked from the same gate, resumed with
    // simulate:false. The real mutation is itself a durable, replayable execution.
    const commit = await this.deps.runtime.fork(parent, forkPoint, { branchName: "commit" });
    const resumed = await this.deps.runtime.resume(commit.executionId, {
      eventType: "RemediationDecision",
      payload: {
        approved: true,
        strategy,
        simulate: false,
        approvedBy: "operator",
        // What the committing execution records with ctx.decide: the alternatives that
        // were on the table, and why this one won. Without them the log holds "applied
        // scale-replicas" and the reasoning lives only in a UI.
        candidates: STRATEGIES.map((s) => s.id),
        reason: winner.review?.note ?? `cleared by ${winner.review?.reviewer ?? "review"}`,
      },
    });
    const final = await resumed.waitForCompletion();
    await this.deps.branchRegistry.moveTip("commit", final.sequence);
    // main now names the applied execution — "what we actually did". Expect the ref we
    // just moved: if anything else repointed main while the real apply was running, this
    // refuses rather than overwriting whatever that was.
    await this.deps.branchRegistry.promote("commit", "main", { expect: winnerExecId });

    const outcome = final.variables._output as StrategyOutcome;
    this.patchBranch(strategy, { status: "committed", outcome, winner: true });
    this.setPhase("committed");
    await this.refreshRefs();
    this.publish();
    return outcome;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** How many branches are still parked on their own review gate. */
  private openCohort(): number {
    return this.state.branches.filter((b) => b.status === "awaiting-review").length;
  }

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
      lineageCount: this.remediationExecId
        ? (await this.deps.branchRegistry.children(this.remediationExecId)).length
        : 0,
    };
    this.deps.branch.merge("", { refs: this.state.refs, lineageCount: this.state.lineageCount });
  }

  private publish(): void {
    this.state = { ...this.state, awaitingReview: this.openCohort() };
    this.deps.branch.set("", this.state);
  }
}

export { STRATEGIES, strategyById };
