import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForPhase } from "@loom/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiagnoseCpuFlow } from "../src/capabilities/flows";
import { type ServerApp, createApp } from "../src/server/app";
import { STRATEGIES } from "../src/warroom/strategies";

const CPU_GOAL = "Why is CPU utilization high? Fix it if remediation is low risk.";
const REPLICA_GOAL =
  "Investigate the read-replica lag issue and fix it if remediation is low risk, else wait for my approval.";

describe("incident war room (durable, headless)", () => {
  let dataDir: string;
  let app: ServerApp;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "war-room-"));
    app = createApp({ dataDir, missionId: "m-test" });
  });
  afterEach(() => {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const mission = () => app.projectionRuntime.getState<{ phase?: string }>("mission", "m-test");
  const telemetry = () =>
    app.projectionRuntime.getState<{ metrics: Record<string, number> }>("telemetry", "m-test");
  // Reach a mission phase, failing loudly on timeout (vs the old silent poll loop).
  const reachPhase = (phase: string) =>
    waitForPhase(app.projectionRuntime, "mission", "m-test", phase, {
      timeoutMs: 10000,
      intervalMs: 25,
    });

  it("refuses a wrongly-shaped resume at the gate, before it reaches the log", async () => {
    // The gate declares its contract via `resumeSchemas` (ADR 0077). Without it, this payload
    // would be appended verbatim and the runner's cast would hand the flow a `strategy` of
    // `undefined` — a silent wrong answer, permanently in the log.
    void app.orchestrator.run(REPLICA_GOAL);
    await reachPhase("awaiting-branches");

    const parentId = app.orchestrator.branchSurface().parentExecutionId;
    expect(parentId).toBeTruthy();
    const before = await app.missionRuntime.loadState(parentId as string);

    await expect(
      app.missionRuntime.resume(parentId as string, {
        eventType: "RemediationDecision",
        payload: { approved: true, approvedBy: "operator" }, // missing strategy + simulate
      })
    ).rejects.toThrow(/resumeSchemas/);

    // Refused BEFORE the append: the execution is untouched and still resumable.
    const after = await app.missionRuntime.loadState(parentId as string);
    expect(after?.sequence).toBe(before?.sequence);
    expect(after?.status).toBe("suspended");

    // And a well-formed payload at the same gate still lands.
    await expect(
      app.missionRuntime.resume(parentId as string, {
        eventType: "RemediationDecision",
        payload: {
          approved: true,
          strategy: "scale-replicas",
          simulate: true,
          approvedBy: "operator",
        },
      })
    ).resolves.toBeDefined();
  });

  it("forks the gate into candidate branches, each parking on its own review", async () => {
    void app.orchestrator.run(REPLICA_GOAL);

    // The replica remediation reaches the gate and opens the War Room.
    await reachPhase("awaiting-branches");
    const prepared = app.orchestrator.branchSurface();
    expect(prepared.branches).toHaveLength(STRATEGIES.length);
    const parentId = prepared.parentExecutionId as string;
    const forkPoint = prepared.forkPoint;

    // Phase 2 — fork + simulate every candidate. This RETURNS while every branch is
    // still suspended: each one parked on its own review gate. The previous version of
    // this orchestrator awaited waitForCompletion() here, which never resolves for a
    // suspended execution — one human-gated branch would have hung the whole fan-out.
    await app.orchestrator.exploreBranches();
    expect(mission().phase).toBe("reviewing-branches");

    const open = app.orchestrator.branchSurface();
    expect(open.phase).toBe("reviewing");
    expect(open.awaitingReview).toBe(STRATEGIES.length);
    expect(open.branches.every((b) => b.status === "awaiting-review")).toBe(true);
    // Nothing has an outcome yet — the simulation ran, but its result is only readable
    // once the branch's own gate is answered and the execution completes.
    expect(open.branches.every((b) => b.outcome === undefined)).toBe(true);

    // Each branch really is a separate, durably suspended execution.
    for (const b of open.branches) {
      const state = await app.missionRuntime.loadState(b.executionId as string);
      expect(state?.status).toBe("suspended");
    }

    // Parent untouched: `main` still names the gate at the fork point.
    const mainRef = open.refs.find((r) => r.name === "main");
    expect(mainRef?.executionId).toBe(parentId);
    expect(mainRef?.tip).toBe(forkPoint);
  }, 30000);

  it("a review addressed to another branch is ignored, and that branch keeps waiting", async () => {
    // `ResumeEvent` is `{ eventType, payload }` — a ResumeAuthenticator never sees WHICH
    // execution it is approving, so a sibling's sign-off parses identically at this gate.
    // The address has to be in the payload, and the flow has to check it.
    void app.orchestrator.run(REPLICA_GOAL);
    await reachPhase("awaiting-branches");
    await app.orchestrator.exploreBranches();

    const [a, b] = app.orchestrator.branchSurface().branches;
    const target = a?.executionId as string;
    const foreign = b?.executionId as string;
    const before = await app.missionRuntime.loadState(target);

    // A well-formed review — but it names the OTHER branch.
    const handle = await app.missionRuntime.resume(target, {
      eventType: "SimulationReviewed",
      payload: {
        branchExecutionId: foreign,
        approved: true,
        reviewer: "wrong-owner",
      },
    });
    await handle.waitForSuspend();

    const after = await app.missionRuntime.loadState(target);
    expect(after?.status).toBe("suspended"); // re-parked, not settled
    expect(after?.sequence).toBeGreaterThan(before?.sequence as number); // the attempt IS in the log
    expect(app.orchestrator.branchSurface().awaitingReview).toBe(STRATEGIES.length);

    // And a review that names no branch at all is refused before it reaches the log.
    await expect(
      app.missionRuntime.resume(target, {
        eventType: "SimulationReviewed",
        payload: { approved: true, reviewer: "no-address" },
      })
    ).rejects.toThrow(/resumeSchemas/);
  }, 30000);

  it("promotes a cleared branch and RETRACTS the siblings still waiting", async () => {
    void app.orchestrator.run(REPLICA_GOAL);
    await reachPhase("awaiting-branches");
    await app.orchestrator.exploreBranches();

    // Only one reviewer has answered. The other two branches are still parked — and a
    // promotion must not leave them live, or a late answer would resume a loser and
    // apply it for real.
    await app.orchestrator.reviewBranch("scale-replicas", {
      approved: true,
      reviewer: "storage-owner",
      note: "cheapest safe fix",
    });
    const reviewed = app.orchestrator.branchSurface();
    expect(reviewed.awaitingReview).toBe(STRATEGIES.length - 1);
    const cleared = reviewed.branches.find((b) => b.strategy === "scale-replicas");
    expect(cleared?.status).toBe("simulated");
    expect(cleared?.review).toEqual({
      reviewer: "storage-owner",
      approved: true,
      note: "cheapest safe fix",
    });
    expect(cleared?.outcome?.simulated).toBe(true);

    const stillOpen = reviewed.branches.filter((b) => b.status === "awaiting-review");
    expect(stillOpen).toHaveLength(STRATEGIES.length - 1);

    await app.orchestrator.promoteBranch("scale-replicas");
    await reachPhase("resolved");

    const committed = app.orchestrator.branchSurface();
    const winner = committed.branches.find((b) => b.strategy === "scale-replicas");
    expect(winner?.status).toBe("committed");
    expect(winner?.outcome?.applied).toBe(true);
    expect(committed.awaitingReview).toBe(0);

    // The retracted branches are cancelled, not merely relabelled: their executions are
    // terminal, so a late review cannot resume them.
    for (const b of stillOpen) {
      const surfaceRow = committed.branches.find((x) => x.strategy === b.strategy);
      expect(surfaceRow?.status).toBe("cancelled");
      const state = await app.missionRuntime.loadState(b.executionId as string);
      expect(state?.status).toBe("cancelled");
      await expect(
        app.missionRuntime.resume(b.executionId as string, {
          eventType: "SimulationReviewed",
          payload: { branchExecutionId: b.executionId, approved: true, reviewer: "late" },
        })
      ).rejects.toThrow();
    }

    // `main` moved onto the real apply, and the committing execution recorded WHY:
    // the candidate set and the reason are in its log, not just in a UI.
    const finalMain = committed.refs.find((r) => r.name === "main");
    expect(finalMain?.executionId).not.toBe(committed.parentExecutionId);
    const commitEvents = await app.eventStore.read(finalMain?.executionId as string);
    const decision = commitEvents.find((e) => e.eventType === "DECISION_RECORDED");
    expect(decision).toBeDefined();
    const payload = decision?.payload as { choice?: unknown; alternatives?: unknown };
    expect(payload.choice).toBe("scale-replicas");
    expect(payload.alternatives).toEqual(["failover-primary", "throttle-writes"]);

    expect(telemetry().metrics.lagMs).toBe(180);
    expect(existsSync(join(dataDir, "events.db"))).toBe(true);
    expect(existsSync(join(dataDir, "branches.db"))).toBe(true);
  }, 30000);

  it("a promotion that lost the race changes nothing — not even the cohort", async () => {
    // Two operators, one War Room. Without a compare-and-set the second promotion lands
    // silently on top of the first and `main` names a strategy nobody picked second.
    void app.orchestrator.run(REPLICA_GOAL);
    await reachPhase("awaiting-branches");
    await app.orchestrator.exploreBranches();
    await app.orchestrator.reviewBranch("scale-replicas", {
      approved: true,
      reviewer: "storage-owner",
    });

    // Someone else moves `main` first — this is the race, made deterministic.
    const surface = app.orchestrator.branchSurface();
    await app.branchRegistry.putRef({
      name: "main",
      executionId: "someone-elses-promotion",
      tip: 99,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await expect(app.orchestrator.promoteBranch("scale-replicas")).rejects.toMatchObject({
      name: "BranchPromotionConflictError",
    });

    // Nothing moved: `main` is untouched, and — because the cohort is closed only AFTER the
    // guarded ref move — the branches still waiting were NOT cancelled for a promotion that
    // never happened.
    expect((await app.branchRegistry.getRef("main"))?.executionId).toBe("someone-elses-promotion");
    for (const b of surface.branches.filter((x) => x.status === "awaiting-review")) {
      const state = await app.missionRuntime.loadState(b.executionId as string);
      expect(state?.status).toBe("suspended");
    }
  }, 30000);

  it("declining every branch leaves nothing promotable", async () => {
    void app.orchestrator.run(REPLICA_GOAL);
    await reachPhase("awaiting-branches");
    await app.orchestrator.exploreBranches();

    for (const s of STRATEGIES) {
      await app.orchestrator.reviewBranch(s.id, { approved: false, reviewer: `${s.id}-owner` });
    }
    const surface = app.orchestrator.branchSurface();
    expect(surface.awaitingReview).toBe(0);
    expect(surface.phase).toBe("explored"); // the cohort closed…
    expect(surface.branches.every((b) => b.status === "declined")).toBe(true);

    // …but a declined branch is not a winner.
    await expect(app.orchestrator.promoteBranch("scale-replicas")).rejects.toThrow(
      /has not cleared it/
    );
  }, 30000);

  it("auto-remediates a low-risk CPU incident without branching", async () => {
    await app.orchestrator.run(CPU_GOAL);
    expect(mission().phase).toBe("resolved");
    // The CPU path never opens the War Room.
    expect(app.orchestrator.branchSurface().phase).toBe("idle");
  }, 30000);

  it("diagnoses through agentLoop$: one durable frame per model call and per tool call", async () => {
    const handle = await app.missionRuntime.start(
      DiagnoseCpuFlow,
      { target: "orders-db-primary" },
      { executionId: "diag-1" }
    );
    const state = await handle.waitForCompletion();
    expect((state.variables._output as { rootCause: string }).rootCause).toMatch(/pool/i);
    // The loop is a runner-body function: its frames are in THIS flow's own log, not
    // one opaque step. Two model calls and the metrics tool call between them.
    const stepIds = (await app.eventStore.read("diag-1"))
      .map((e) => (e.payload as { stepId?: string }).stepId)
      .filter((id): id is string => id !== undefined);
    expect(stepIds.some((id) => id.includes("#turn:0:tool:0"))).toBe(true);
    expect(stepIds.some((id) => id.includes("#turn:1"))).toBe(true);
  }, 30000);
});
