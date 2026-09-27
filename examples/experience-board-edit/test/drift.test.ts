import { isContainer, replay } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import {
  GreenhouseSensor,
  STATION_STEP,
  TREND_STEP,
  capabilities,
  catalog,
  driftCapabilities,
  driftRequest,
  executeProvider,
  repairPlanner,
  repairReplyFor,
  reviseForDrift,
  trend,
  trendBoard,
  trendProviderSpec,
} from "../src/drift";

describe("a multi-step provider's drift keys and repairs on its OWN terminal step (gap G4)", () => {
  it("a steady reading executes cleanly through both steps, upstream first", async () => {
    const sensor = new GreenhouseSensor();
    const outcome = await executeProvider(trendProviderSpec(), { invoker: sensor });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value).toBe(3.2);
    expect(sensor.calls).toEqual(["greenhouse.station", "greenhouse.trend"]);
  });

  it("the trend tool's own reshape drifts; the record keys on the TERMINAL step, not executionGraph[0] (the upstream)", async () => {
    const board = trendBoard();
    const spec = board.providers[trend.handle];
    if (spec === undefined) throw new Error("trend provider missing");
    expect(spec.executionGraph[0]?.stepId).toBe(STATION_STEP); // the unrelated upstream IS first
    const sensor = new GreenhouseSensor({ garbleTrend: true });
    const outcome = await executeProvider(spec, { invoker: sensor, captureSample: true });
    if (outcome.ok) throw new Error("expected the pinned output shape to drift");
    expect(outcome.drift).toHaveLength(1);
    const d = outcome.drift[0];
    if (d === undefined) throw new Error("expected a drift record");
    expect(d.stepId).toBe(TREND_STEP); // never STATION_STEP, even though it ran first
    expect(d.observedRawShape).toEqual({ trend: { pct: { value: "number" } } });
  });

  it("driftCapabilities attaches the observed sample to the TERMINAL step's own tool — the inlined upstream capability is untouched", async () => {
    const board = trendBoard();
    const spec = board.providers[trend.handle];
    if (spec === undefined) throw new Error("trend provider missing");
    const sensor = new GreenhouseSensor({ garbleTrend: true });
    const outcome = await executeProvider(spec, { invoker: sensor, captureSample: true });
    if (outcome.ok) throw new Error("expected drift");
    const swapped = driftCapabilities(capabilities, board, outcome.drift);
    expect(swapped.find((c) => c.handle === "trend_now")?.sampleOutput).toEqual({
      trend: { pct: { value: 3.2 } },
    });
    // Never handed the drifted sample: keying on executionGraph[0] would have attached it here.
    expect(swapped.find((c) => c.handle === "station_now")?.sampleOutput).toEqual({
      raw: { c: 24.5 },
    });
  });

  it("driftRequest scopes the revision to the bound node and names the handle, never a raw shape", async () => {
    const board = trendBoard();
    const spec = board.providers[trend.handle];
    if (spec === undefined) throw new Error("trend provider missing");
    const outcome = await executeProvider(spec, {
      invoker: new GreenhouseSensor({ garbleTrend: true }),
      captureSample: true,
    });
    if (outcome.ok) throw new Error("expected drift");
    const req = driftRequest(board, outcome.drift);
    expect(req.scopeNodeIds).toEqual(["trend"]);
    expect(req.text).toContain(trend.handle);
    expect(req.text).not.toContain('"pct"');
  });

  it("the reference planner's revise repairs the drift end to end: the new pin is taken from the TERMINAL step's own sample, and the repaired provider now executes cleanly against the SAME (still-garbled) tool", async () => {
    const board = trendBoard();
    const spec = board.providers[trend.handle];
    if (spec === undefined) throw new Error("trend provider missing");
    const sensor = new GreenhouseSensor({ garbleTrend: true });
    const outcome = await executeProvider(spec, { invoker: sensor, captureSample: true });
    if (outcome.ok) throw new Error("expected drift");

    const { planner, ctx } = repairPlanner(repairReplyFor(board));
    const result = await reviseForDrift(
      planner,
      { experience: board, drift: outcome.drift, catalog, capabilities },
      ctx
    );
    expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(result.ops).toHaveLength(1);
    const op = result.ops[0];
    if (op?.type !== "prompt") throw new Error("expected exactly one prompt op");
    expect(op.materialized.map((o) => o.type)).toEqual([
      "remapProvider",
      "bindProvider",
      "removeProvider",
    ]);
    // The old, drifted provider is retired by the SAME repair that replaces it.
    expect(op.materialized[2]).toMatchObject({ type: "removeProvider", handle: trend.handle });

    const repaired = replay(board, result.ops);
    if (!repaired.ok) throw new Error(repaired.finding.message);
    const node = isContainer(repaired.value.root) ? repaired.value.root.children[0] : undefined;
    if (node === undefined || node.kind !== "semantic" || node.binding === undefined) {
      throw new Error("expected the repaired node to still be bound");
    }
    const newSpec = repaired.value.providers[node.binding.handle];
    if (newSpec === undefined) throw new Error("repaired provider missing");
    expect(trend.handle in repaired.value.providers).toBe(false); // the drifted spec is gone

    // The repaired provider, executed against the SAME sensor (still returning the nested
    // shape — a tool that drifted does not drift back), now succeeds: the path was re-authored
    // one level deeper, exactly matching what the tool now actually returns.
    const rerun = await executeProvider(newSpec, { invoker: sensor });
    expect(rerun.ok).toBe(true);
    expect(rerun.ok && rerun.value).toBe(3.2);
  });
});
