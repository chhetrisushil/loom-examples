import { type ReleaseIn, type ReleaseOut, releaseFlow } from "./flows";
import { type ReleaseRuntime, awaitTerminal, buildRuntime } from "./runtime";

// Wait on the LOG, not a clock: the supervisor drives children + resumes off the event
// loop, so a live query over the same store says when the release is done (@loom/live-query).
async function runRelease(
  bundle: ReleaseRuntime,
  executionId: string,
  input: ReleaseIn
): Promise<ReleaseOut> {
  await bundle.runtime.start(releaseFlow, input, { executionId });
  const state = await awaitTerminal(bundle.live, executionId);
  if (state.status === "failed") throw new Error(`release ${executionId} failed`);
  return state.variables._output as ReleaseOut;
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
