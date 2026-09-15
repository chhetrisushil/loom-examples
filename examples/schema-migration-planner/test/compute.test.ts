import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTimerStore } from "@loom/plugin-sqlite";
import { createWorkerServer } from "@loom/plugin-worker-server";
import type { WorkerServer } from "@loom/plugin-worker-server";
import { waitForPhase } from "@loom/testing";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { TimerService } from "@loom/workflow-runtime";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBranchWorkerRuntime } from "../src/compute/worker";
import { type ServerApp, createApp } from "../src/server/app";
import { STRATEGIES } from "../src/warroom/strategies";

// ── Branch simulations run on their own compute ───────────────────────────────
//
// A shadow migration clones a table and backfills it. Running three of those inside the
// web server is the demo's convenient lie; the seam that fixes it already exists, so this
// suite wires it and checks the two things that are only true once it is wired.
//
// The worker here is a second WorkflowRuntime over the SAME SQLite files (WAL, so two
// holders on one host is fine). It is deliberately NOT the coordinator's runtime: every
// assertion below is about WHICH runtime advanced the branch.

const GOAL =
  "Plan the migration for the orders table and pick the safest strategy before applying it.";

describe("branch simulations run on their own compute", () => {
  let dataDir: string;
  let app: ServerApp;
  let worker: WorkerServer;
  let workerRuntime: WorkflowRuntime;
  let workerResumes: string[];
  let coordinatorResumes: string[];

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "smp-compute-"));

    // The branch worker: its own runtime, the same durable stores.
    workerRuntime = buildBranchWorkerRuntime(dataDir);
    workerResumes = [];
    const realWorkerResume = workerRuntime.resume.bind(workerRuntime);
    vi.spyOn(workerRuntime, "resume").mockImplementation((id, evt, opts) => {
      workerResumes.push(id);
      return realWorkerResume(id, evt, opts);
    });
    worker = createWorkerServer(new LocalWorkerRuntime(workerRuntime), { port: 0 });
    await worker.start();

    app = createApp({ dataDir, missionId: "m-compute", branchWorkerUrl: worker.url });
    coordinatorResumes = [];
    const realCoordResume = app.missionRuntime.resume.bind(app.missionRuntime);
    vi.spyOn(app.missionRuntime, "resume").mockImplementation((id, evt, opts) => {
      coordinatorResumes.push(id);
      return realCoordResume(id, evt, opts);
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    app.close();
    await worker.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const reachPhase = (phase: string) =>
    waitForPhase(app.projectionRuntime, "mission", "m-compute", phase, {
      timeoutMs: 15000,
      intervalMs: 25,
    });

  it("dispatches every branch to the worker — the coordinator never runs a backfill", async () => {
    void app.orchestrator.run(GOAL);
    await reachPhase("awaiting-branches");
    await app.orchestrator.exploreBranches();

    const surface = app.orchestrator.branchSurface();
    const branchIds = surface.branches.map((b) => b.executionId as string);
    expect(branchIds).toHaveLength(STRATEGIES.length);

    // Every branch was advanced by the WORKER's runtime…
    for (const id of branchIds) expect(workerResumes).toContain(id);
    // …and by the coordinator's, never. The package crossed a process boundary and the
    // branch was rebuilt from the shared log on the other side.
    for (const id of branchIds) expect(coordinatorResumes).not.toContain(id);

    // Each branch is parked for shadow verification rather than finished — the expensive
    // compute is released while a human is the bottleneck.
    expect(surface.branches.every((b) => b.status === "awaiting-verification")).toBe(true);
    for (const id of branchIds) {
      expect((await app.missionRuntime.loadState(id))?.status).toBe("suspended");
    }
  }, 30000);

  it("a timer wake resumes the branch on the WORKER it was placed on (loom#392)", async () => {
    // This test spent its first life asserting the opposite, under the name
    // `KNOWN GAP (loom#392)`: placement was never persisted — `ExecutionPolicy` is a
    // caller-side struct mapped to DispatchMetadata at dispatch time — so `TimerService`
    // resumed a parked branch on whatever runtime it held, and a branch sized for a cloned
    // database woke up inside the web server.
    //
    // Now the lane is recorded on the execution's anchor and the wake is dispatched back to
    // it. The assertion is inverted rather than deleted, because the inversion IS the fix.
    void app.orchestrator.run(GOAL);
    await reachPhase("awaiting-branches");
    await app.orchestrator.exploreBranches();

    const parked = app.orchestrator.branchSurface().branches[0];
    const parkedId = parked?.executionId as string;
    const state = await app.missionRuntime.loadState(parkedId);
    const wakeAt = state?.suspendedOn?.wakeAt as number;
    expect(wakeAt).toBeDefined(); // the fork carried its deadline (loom#388)

    workerResumes.length = 0;
    coordinatorResumes.length = 0;

    const timers = new SqliteTimerStore(join(dataDir, "timers.db"));
    const service = new TimerService(app.missionRuntime, timers, {
      dispatcher: app.branchDispatcher,
    });
    await service.tick(wakeAt + 1000);

    expect(workerResumes).toContain(parkedId); // ← the fix
    expect(coordinatorResumes).not.toContain(parkedId);
    await timers.close();
  }, 30000);
});
