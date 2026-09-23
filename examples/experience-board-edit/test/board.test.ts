import { type Operation, apply, findNode, genesis, replay } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { EXPERIENCE_OP_ACTION, interpretAction } from "@loom-ui/planner";
import { describe, expect, it } from "vitest";
import { USAGE, composeBoard, handleFor, intent, meta } from "../src/board";

const must = <T>(r: { ok: true; value: T } | { ok: false; finding: { message: string } }): T => {
  if (!r.ok) throw new Error(r.finding.message);
  return r.value;
};
const widgetAction = (payload: unknown) => ({
  type: EXPERIENCE_OP_ACTION,
  widgetId: "board",
  payload,
});

describe("a greenhouse board, edited by its user and by a planner", () => {
  it("compose binds three widgets to three providers and reports the model's tokens", async () => {
    const { board, composed } = await composeBoard();
    expect(Object.keys(board.providers).sort()).toEqual(
      [handleFor("airC"), handleFor("humidityPct"), handleFor("log")].sort()
    );
    expect(composed.report.usage).toEqual(USAGE.compose);
  });

  it("a user resizes and re-places a widget; null clears the placement again", async () => {
    const { board } = await composeBoard();
    const act = interpretAction(
      board,
      widgetAction({ type: "setPlacement", nodeId: "temperature", span: 6, row: 1, column: 1 })
    );
    if (act.kind !== "experience") throw new Error(`refused: ${JSON.stringify(act)}`);
    const resized = must(apply(board, act.op));
    expect(findNode(resized.root, "temperature")).toMatchObject({ span: 6, row: 1, column: 1 });
    const cleared = must(
      apply(resized, { type: "setPlacement", nodeId: "temperature", row: null, column: null })
    );
    const t = findNode(cleared.root, "temperature");
    expect(t && "row" in t).toBe(false);
    expect(t?.span).toBe(6);
  });

  it("a provider is never retired from a widget, nor while a widget still binds it", async () => {
    const { board } = await composeBoard();
    const handle = handleFor("humidityPct");
    const fromWidget = interpretAction(board, widgetAction({ type: "removeProvider", handle }));
    expect(fromWidget.kind === "refused" && fromWidget.finding.code).toBe(
      "provider-op-not-interactive"
    );
    const stillBound = apply(board, { type: "removeProvider", handle });
    expect(!stillBound.ok && stillBound.finding).toMatchObject({
      code: "provider-still-bound",
      nodeId: "humidity",
    });
    const retired = must(
      replay(board, [
        { type: "removeNode", nodeId: "humidity" },
        { type: "removeProvider", handle },
      ])
    );
    expect(handle in retired.providers).toBe(false);
    expect(findNode(retired.root, "humidity")).toBeUndefined();
  });

  it("the planner retires the provider its own removal orphaned, inside the prompt op", async () => {
    const { board, planner, input, ctx } = await composeBoard();
    const edited = seal(
      must(
        replay(board, [
          { type: "setPlacement", nodeId: "temperature", span: 6 },
          { type: "removeNode", nodeId: "humidity" },
          { type: "removeProvider", handle: handleFor("humidityPct") },
        ])
      )
    );
    const revised = await planner.revise(
      { ...input, experience: edited, request: { text: "drop the watering log" } },
      ctx
    );
    expect(revised.findings.filter((f) => f.severity === "error")).toEqual([]);
    const prompt = revised.ops[0];
    if (prompt?.type !== "prompt") throw new Error("expected exactly one prompt op");
    // The draft keeps the user's span (6), so no setPlacement: only the removal and its provider.
    expect(prompt.materialized).toEqual([
      { type: "removeNode", nodeId: "watering" },
      { type: "removeProvider", handle: handleFor("log") },
    ]);
    const after = must(replay(edited, revised.ops));
    expect(Object.keys(after.providers)).toEqual([handleFor("airC")]);
    expect(revised.report.usage).toEqual(USAGE.revise);
  });

  it("the app titles the board; a widget may not, and a widget node has no title", async () => {
    const { board } = await composeBoard();
    const title = { key: "board.title", fallback: "Greenhouse" };
    const titled = must(apply(board, { type: "setTitle", nodeId: "root", title }));
    expect(titled.root).toMatchObject({ title });
    const fromWidget = interpretAction(
      titled,
      widgetAction({ type: "setTitle", nodeId: "root", title: null })
    );
    expect(fromWidget.kind === "refused" && fromWidget.finding.code).toBe("root-immutable");
    const onWidget = apply(titled, { type: "setTitle", nodeId: "temperature", title });
    expect(!onWidget.ok && onWidget.finding.code).toBe("not-container");
    const cleared = must(apply(titled, { type: "setTitle", nodeId: "root", title: null }));
    expect("title" in cleared.root).toBe(false);
  });

  it("planner usage survives replay: the second compose is served from the decision, tokens and all", async () => {
    const { planner, input, ctx, model, composed } = await composeBoard();
    const calls = model.calls;
    const again = await planner.compose(input, ctx);
    expect(model.calls).toBe(calls);
    expect(again.report.usage).toEqual(composed.report.usage);
    expect(again.ops).toEqual(composed.ops);
  });

  it("the whole lineage replays from genesis with no planner and no model", async () => {
    const { board, planner, input, ctx, composed, model } = await composeBoard();
    const userOps: Operation[] = [
      { type: "setPlacement", nodeId: "temperature", span: 6 },
      { type: "removeNode", nodeId: "humidity" },
      { type: "removeProvider", handle: handleFor("humidityPct") },
    ];
    const edited = seal(must(replay(board, userOps)));
    const revised = await planner.revise(
      { ...input, experience: edited, request: { text: "drop the watering log" } },
      ctx
    );
    const stepwise = must(replay(edited, revised.ops));
    const calls = model.calls;
    const folded = must(
      replay(genesis({ experienceId: "greenhouse", intent, meta }), [
        ...composed.ops,
        ...userOps,
        ...revised.ops,
      ])
    );
    expect(model.calls).toBe(calls);
    expect(folded.root).toEqual(stepwise.root);
    expect(folded.providers).toEqual(stepwise.providers);
  });
});
