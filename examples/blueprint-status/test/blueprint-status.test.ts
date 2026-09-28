import {
  BLUEPRINT_IR_VERSION,
  type GridLayout,
  type Widget,
  blueprintIrVersion,
  builtinCatalog,
  isWidget,
  validateBlueprint,
} from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createBoard } from "../src/app";
import { HEALTH_PROJECTION_ID, healthEvent, scenario } from "../src/health";

const line = (frame: string, title: string): string | undefined =>
  frame.split("\n").find((l) => l.includes(title));

describe("blueprint-status — the Blueprint says everything the renderer needs", () => {
  it("is IR 2.x: spans ride in grid cells (never props), every channelled widget declares status.path, source names the degradation, and loom's validator accepts it", () => {
    const { blueprint } = createBoard();
    // Stamped with loom's CURRENT IR version — never a hand-copied literal, which went stale the
    // first time a minor bump landed (2.1–2.4 only added optional fields; ADRs 0098–0101). What
    // this board actually depends on is the MAJOR: grid cells, `status.path` and `source` are
    // IR 2 (ADR 0097), so a major bump must fail here and be reviewed, not pass silently.
    expect(blueprintIrVersion(blueprint)).toBe(BLUEPRINT_IR_VERSION);
    expect(BLUEPRINT_IR_VERSION.split(".")[0]).toBe("2");

    const grid = blueprint.layout as GridLayout;
    expect(grid.type).toBe("grid");
    expect(grid.columns).toBe(12);
    expect(grid.children.map((c) => c.span)).toEqual([4, 4, 4, 8, 4]);
    const widgets = grid.children.map((c) => c.node).filter(isWidget);
    expect(widgets).toHaveLength(5);
    for (const w of widgets) expect("span" in w.props).toBe(false);

    // Four widgets declare a status channel in the SAME projection state as their value; the
    // fifth (queue depth) deliberately does not — it is the control row of the matrix.
    const byId = new Map(widgets.map((w) => [w.id, w]));
    for (const id of ["latency", "ingest", "disk", "errors"]) {
      const w = byId.get(id) as Widget;
      expect(w.binding).toEqual({
        projectionId: HEALTH_PROJECTION_ID,
        path: `values.${id}`,
        status: { path: `status.${id}` },
      });
    }
    expect(byId.get("queue")?.binding).toEqual({
      projectionId: HEALTH_PROJECTION_ID,
      path: "values.queue",
    });

    // The table stands for a Trend the terminal cannot draw; the Blueprint says so.
    expect(byId.get("errors")?.source).toEqual({
      type: "Trend",
      version: "1.0.0",
      degradedFrom: [{ type: "Collection", version: "1.0.0" }],
    });

    const v = validateBlueprint(blueprint, builtinCatalog);
    expect(v.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("walks the canonical status matrix from real projection state — one row per delivery state, the check seam between error and stale, the no-channel widget untouched", () => {
    const board = createBoard();
    const at = (n: number): string => {
      board.apply(...scenario(board.executionId).slice(0, n));
      return board.render();
    };

    // Nothing delivered yet: a declared channel with no value is the LOADING row; the widget
    // with no channel renders exactly as it did under IR 1.0.0 (its kind renderer's own dash).
    let frame = board.render();
    expect(line(frame, "Latency p99")).toBe("⋯ Latency p99");
    expect(line(frame, "Queue depth")).toBe("Queue depth: —");

    frame = at(4); // latency, ingest, disk and errors delivered
    expect(line(frame, "Latency p99")).toBe("Latency p99: 412 ms");
    expect(line(frame, "Ingest")).toBe("Ingest: [ok]");
    expect(line(frame, "Disk")).toBe("Disk: [###############-----] 73%");
    expect(line(frame, "Top errors")).toBe("Top errors: (degraded from Collection@1.0.0)");
    expect(frame).toContain("code | count");

    frame = at(5); // the latency provider failed; its last value is RETAINED but not shown
    expect(line(frame, "Latency p99")).toBe("✗ Latency p99: latency probe timed out");

    frame = at(6); // the provider recovered but its output drifted: stale, last value shown
    expect(line(frame, "Latency p99")).toBe("~ Latency p99: 412 ms");

    frame = at(7); // a refresh is in flight: pending, last value shown
    expect(line(frame, "Latency p99")).toBe("⋯ Latency p99: 412 ms");

    frame = at(8); // it delivered a value that breaks the app's contract: the check seam speaks
    expect(line(frame, "Latency p99")).toBe(
      "✗ Latency p99: Latency p99 expects a number, got string"
    );

    frame = at(9); // a delivery ERROR outranks the contract violation
    expect(line(frame, "Latency p99")).toBe("✗ Latency p99: latency probe timed out");

    frame = at(11); // ready again; the no-channel widget just shows its value
    expect(line(frame, "Latency p99")).toBe("Latency p99: 398 ms");
    expect(line(frame, "Queue depth")).toBe("Queue depth: 17");
  });

  it("the status channel is the app's own projection — no side channel, no renderer knowledge of the fold", () => {
    const board = createBoard();
    board.apply(
      healthEvent(board.executionId, 1, "health.failed", {
        key: "disk",
        message: "df: no such volume",
      })
    );
    // The renderer read `status.disk` off the projection state at the path the Blueprint named.
    const state = board.runtime.getState<{ status: Record<string, { state: string }> }>(
      HEALTH_PROJECTION_ID,
      board.executionId
    );
    expect(state.status.disk?.state).toBe("error");
    expect(line(board.render(), "Disk")).toBe("✗ Disk: df: no such volume");
  });
});
