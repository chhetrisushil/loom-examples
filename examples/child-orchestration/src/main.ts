import type { ExecutionState } from "@loom/core";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { type ReleaseIn, type ReleaseOut, releaseFlow } from "./flows";
import { buildRuntime } from "./runtime";

// Poll for a terminal state (the supervisor drives children + resumes off the event loop).
async function runRelease(
  runtime: WorkflowRuntime,
  executionId: string,
  input: ReleaseIn
): Promise<ReleaseOut> {
  await runtime.start(releaseFlow, input, { executionId });
  for (let i = 0; i < 400; i++) {
    const state: ExecutionState | null = await runtime.loadState(executionId);
    if (state?.status === "completed") return state.variables._output as ReleaseOut;
    if (state?.status === "failed") throw new Error(`release ${executionId} failed`);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`release ${executionId} did not finish`);
}

function report(title: string, out: ReleaseOut): void {
  console.log(`\n── ${title} ──`);
  console.log(`  built:         [${out.built.join(", ")}]`);
  console.log(`  buildFailures: [${out.buildFailures.join(", ")}]`);
  if (out.smokeAbortedOn !== undefined) {
    console.log(`  smoke gate:    ABORTED on "${out.smokeAbortedOn}" (awaitAll threw childFailed)`);
    console.log("  published:     — (release aborted before publish)");
  } else {
    console.log("  smoke gate:    passed (awaitAll: all built services green)");
    console.log(`  published:     ${out.published?.manifest} (${out.published?.count} services)`);
  }
}

async function main(): Promise<void> {
  console.log("Release pipeline via child workflows (awaitChildren → awaitAll → awaitChild)\n");

  // Scenario A — happy path: everything builds and passes smoke, then publishes.
  const a = await runRelease(buildRuntime(), "release-happy", {
    services: [{ name: "web" }, { name: "api" }, { name: "worker" }],
  });
  report("Scenario A · clean release", a);

  // Scenario B — degraded: `api` fails to BUILD (tolerated, partial), and `worker` fails
  // its SMOKE test (aborts the all-or-nothing gate before publish).
  const b = await runRelease(buildRuntime(), "release-degraded", {
    services: [
      { name: "web" },
      { name: "api", failBuild: true },
      { name: "worker", failSmoke: true },
    ],
  });
  report("Scenario B · flaky build + failing smoke", b);

  console.log("\nEach service ran as its OWN durable child execution:");
  console.log("  release-happy::build#0/#1/#2   → concurrent builds (awaitChildren, settled)");
  console.log("  release-happy::smoke#0/#1/#2   → all-or-nothing gate (awaitAll)");
  console.log("  release-happy::publish         → single downstream child (awaitChild)");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
