import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTimerStore } from "@loom/plugin-sqlite";
import { createWorkerServer } from "@loom/plugin-worker-server";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { TimerService } from "@loom/workflow-runtime";
import { buildBranchWorkerRuntime } from "../compute/worker";
import { createApp } from "../server/app";
import { STRATEGIES } from "../warroom/strategies";

// ── Where does a branch actually run? ─────────────────────────────────────────
//
// `pnpm demo:placement` — narrated, headless. Starts a branch worker over the same
// durable stores, forks three shadow migrations onto it, shows them parked for
// verification with the coordinator idle, and then shows the gap: the thing that wakes
// a parked branch has no idea where that branch belongs.

const line = (s = ""): void => {
  process.stdout.write(`${s}\n`);
};
const rule = (): void => line("─".repeat(78));

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "smp-placement-"));
  const workerRuntime = buildBranchWorkerRuntime(dataDir);
  const ranOnWorker: string[] = [];
  const realResume = workerRuntime.resume.bind(workerRuntime);
  workerRuntime.resume = (id, evt, opts) => {
    ranOnWorker.push(id);
    return realResume(id, evt, opts);
  };
  const worker = createWorkerServer(new LocalWorkerRuntime(workerRuntime), { port: 0 });
  await worker.start();

  const app = createApp({ dataDir, missionId: "m-placement", branchWorkerUrl: worker.url });
  try {
    rule();
    line("① Branch worker up — a second runtime over the SAME durable stores");
    rule();
    line(`   ${worker.url}   stores: ${dataDir}`);
    line("   Same flow, same log. An ExecutionPackage carries identity + resume");
    line("   coordinates, never code or state, so the worker rebuilds the branch.");

    void app.orchestrator.run(
      "Plan the migration for the orders table and pick the safest strategy before applying it."
    );
    while (app.orchestrator.branchSurface().forkPoint === null)
      await new Promise((r) => setTimeout(r, 50));

    rule();
    line(`② Fork ${STRATEGIES.length} shadow migrations and dispatch each to the worker`);
    rule();
    await app.orchestrator.exploreBranches();
    for (const b of app.orchestrator.branchSurface().branches) {
      const where = ranOnWorker.includes(b.executionId ?? "") ? "worker" : "COORDINATOR";
      line(`   ${b.strategy.padEnd(14)} ${String(b.status).padEnd(22)} ran on: ${where}`);
    }
    line("   The web server never ran a backfill — that is the whole point.");

    rule();
    line("③ Every branch is parked for shadow verification");
    rule();
    for (const b of app.orchestrator.branchSurface().branches) {
      const st = await app.missionRuntime.loadState(b.executionId as string);
      line(
        `   ${b.strategy.padEnd(14)} ${st?.status}  awaiting "${st?.suspendedOn?.on}"  ` +
          `deadline in ${Math.round(((st?.suspendedOn?.wakeAt ?? 0) - Date.now()) / 3_600_000)}h`
      );
    }
    line("   The expensive compute is released. The branch is just storage now.");

    rule();
    line("④ Fire the deadline — and watch the wake go back to the worker (loom#392)");
    rule();
    const parked = app.orchestrator.branchSurface().branches[0];
    const st = await app.missionRuntime.loadState(parked?.executionId as string);
    ranOnWorker.length = 0;
    const timers = new SqliteTimerStore(join(dataDir, "timers.db"));
    await new TimerService(app.missionRuntime, timers, {
      ...(app.branchDispatcher !== undefined && { dispatcher: app.branchDispatcher }),
    }).tick((st?.suspendedOn?.wakeAt ?? 0) + 1000);
    await timers.close();
    const wokeOnWorker = ranOnWorker.includes(parked?.executionId as string);
    line(`   woke "${parked?.strategy}" on: ${wokeOnWorker ? "worker" : "COORDINATOR"}`);
    line("   The lane is recorded on the branch's anchor at fork time, so the timer service");
    line("   dispatches the wake back to it. Placing a branch per DISPATCH was not enough:");
    line("   that lives in one process's memory and is gone by the first suspension.");
    rule();
    line("✓ Branches have their own compute — and so do their wakes.");
  } finally {
    app.close();
    await worker.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

void main();
