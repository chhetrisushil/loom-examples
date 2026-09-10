import { describe, expect, it } from "vitest";
import { type ReleaseIn, type ReleaseOut, releaseFlow } from "../src/flows";
import { type ReleaseRuntime, awaitTerminal, buildRuntime } from "../src/runtime";

// Waits on the log, not on a clock: `@loom/live-query` folds the execution's state and
// pushes it again on every event, so this settles as soon as the supervisor finishes rather
// than on the next 5ms tick — and there is no iteration cap guessing how long that takes.
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

describe("release pipeline via child workflows", () => {
  it("clean release: awaitChildren builds all, awaitAll gate passes, awaitChild publishes", async () => {
    const rt = buildRuntime();
    const out = await runRelease(rt, "R1", {
      services: [{ name: "web" }, { name: "api" }, { name: "worker" }],
    });

    expect(out.built).toEqual(["web", "api", "worker"]);
    expect(out.buildFailures).toEqual([]);
    expect(out.smokeAbortedOn).toBeUndefined();
    expect(out.published).toEqual({ manifest: "web,api,worker", count: 3 });

    // Each service ran as its own durable child execution (own log, own output).
    const web = await rt.runtime.loadState("R1::build#0");
    expect(web?.status).toBe("completed");
    expect((web?.variables._output as { artifact: string }).artifact).toBe("web@1.0.0");
  }, 20000);

  it("awaitChildren tolerates a partial BUILD failure and proceeds with the rest", async () => {
    const rt = buildRuntime();
    const out = await runRelease(rt, "R2", {
      services: [{ name: "web" }, { name: "api", failBuild: true }, { name: "worker" }],
    });

    // `api` failed to build but did NOT sink the release — settled results let the parent
    // proceed with what built.
    expect(out.built).toEqual(["web", "worker"]);
    expect(out.buildFailures).toEqual(["api"]);
    expect(out.smokeAbortedOn).toBeUndefined();
    expect(out.published).toEqual({ manifest: "web,worker", count: 2 });

    // The failed build is durably recorded as a failed child execution.
    expect((await rt.runtime.loadState("R2::build#1"))?.status).toBe("failed");
  }, 20000);

  it("awaitAll aborts the release when any SMOKE test fails (all-or-nothing gate)", async () => {
    const rt = buildRuntime();
    const out = await runRelease(rt, "R3", {
      services: [{ name: "web" }, { name: "api" }, { name: "worker", failSmoke: true }],
    });

    // All three built, but `worker` fails smoke → awaitAll throws → parent aborts, no publish.
    expect(out.built).toEqual(["web", "api", "worker"]);
    expect(out.buildFailures).toEqual([]);
    expect(out.smokeAbortedOn).toBe("worker");
    expect(out.published).toBeUndefined();
  }, 20000);

  it("is replay-safe: the parent re-run does not spawn duplicate children", async () => {
    const rt = buildRuntime();
    await runRelease(rt, "R4", { services: [{ name: "web" }, { name: "api" }] });

    // Each child log holds exactly one EXECUTION_STARTED — every spawn was fixed by a
    // single ctx.decide, so recovery/replay never starts a second child.
    const store = rt.eventStore;
    for (const id of ["R4::build#0", "R4::build#1", "R4::smoke#0", "R4::smoke#1", "R4::publish"]) {
      const events = await store.read(id);
      expect(events.filter((e) => e.eventType === "EXECUTION_STARTED")).toHaveLength(1);
    }
  }, 20000);
});
