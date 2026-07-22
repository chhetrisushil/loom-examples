import type { EventEnvelope } from "@loom/core";
import { A2UISurfaceBridge, A2UI_VERSION } from "@loom/plugin-a2ui";
import type { A2UIServerMessage } from "@loom/plugin-a2ui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import type { ExpenseInput } from "../src/flow";
import { RegisteredExpenseFlow } from "../src/flow";
import { a2uiKind } from "../src/render";
import { EXPENSE_VIEW } from "../src/view";

const input: ExpenseInput = { expenseId: "exp-test", title: "Unit test expense" };
const executionId = "exp-test";

function collect(bridge: A2UISurfaceBridge, sink: A2UIServerMessage[]) {
  return (event: EventEnvelope) => {
    for (const msg of bridge.handleEvent(event)) sink.push(msg);
  };
}

describe("a2ui-egress example", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("opens the session with a createSurface carrying the tree + folded data model", async () => {
    const bridge = new A2UISurfaceBridge({ executionId, components: EXPENSE_VIEW });
    const messages: A2UIServerMessage[] = [];
    const unsub = await app.stores.eventStore.subscribe(executionId, collect(bridge, messages));

    const handle = await app.runtime.start(RegisteredExpenseFlow, input, { executionId });
    await handle.waitForSuspend();
    unsub();

    const first = messages[0] as unknown as { createSurface: Record<string, unknown> };
    expect(a2uiKind(messages[0]!)).toBe("createSurface");
    expect(first.createSurface.surfaceId).toBe(`ui:${executionId}`);
    expect(first.createSurface.catalogId).toBe("loom.core.v1");
    expect(first.createSurface.components).toEqual(EXPENSE_VIEW);
    // The initial data model already carries the folded value of the first patch.
    expect(first.createSurface.dataModel).toMatchObject({ title: input.title });
  });

  it("translates Loom delta patches into absolute updateDataModel values", async () => {
    const bridge = new A2UISurfaceBridge({ executionId, components: EXPENSE_VIEW });
    const messages: A2UIServerMessage[] = [];
    const unsub = await app.stores.eventStore.subscribe(executionId, collect(bridge, messages));

    const handle = await app.runtime.start(RegisteredExpenseFlow, input, { executionId });
    await handle.waitForSuspend();
    unsub();

    const updates = messages.filter((m) => a2uiKind(m) === "updateDataModel") as {
      updateDataModel: { path: string; contents: unknown };
    }[];

    // `increment("stepsCompleted")` fires twice pre-suspend; A2UI never sends "+1",
    // it sends the concrete post-fold value — so the last such update is 2.
    const steps = updates.filter((u) => u.updateDataModel.path === "/stepsCompleted");
    expect(steps.at(-1)?.updateDataModel.contents).toBe(2);

    // `append("progressLog", …)` sends the WHOLE array each time (absolute), not the
    // appended element — the second append yields a 2-element array.
    const logAppends = updates.filter((u) => u.updateDataModel.path === "/progressLog");
    expect(Array.isArray(logAppends.at(-1)?.updateDataModel.contents)).toBe(true);
    expect((logAppends.at(-1)?.updateDataModel.contents as unknown[]).length).toBeGreaterThan(1);

    // Dot-paths become RFC 6901 JSON Pointers, and a merge touches its parent path:
    // merge("stats", …) → one update at "/stats" carrying the whole merged object.
    const statsUpdate = updates.filter((u) => u.updateDataModel.path === "/stats").at(-1);
    expect(statsUpdate?.updateDataModel.contents).toMatchObject({ amount: expect.any(Number) });
  });

  it("ingests an inbound action only when it targets this surface", () => {
    const bridge = new A2UISurfaceBridge({ executionId, components: EXPENSE_VIEW });

    const mine = bridge.ingestAction({
      version: A2UI_VERSION,
      action: { surfaceId: bridge.surfaceId, action: "approve" },
    });
    expect(mine?.action).toBe("approve");

    const other = bridge.ingestAction({
      version: A2UI_VERSION,
      action: { surfaceId: "ui:someone-else", action: "approve" },
    });
    expect(other).toBeNull();

    const notAnAction = bridge.ingestAction({ version: A2UI_VERSION, error: "boom" });
    expect(notAnAction).toBeNull();
  });

  it("drives the approval gate through the inbound action and reaches status=done", async () => {
    const bridge = new A2UISurfaceBridge({ executionId, components: EXPENSE_VIEW });
    const messages: A2UIServerMessage[] = [];
    const unsub = await app.stores.eventStore.subscribe(executionId, collect(bridge, messages));

    const handle = await app.runtime.start(RegisteredExpenseFlow, input, { executionId });
    await handle.waitForSuspend();

    const action = bridge.ingestAction({
      version: A2UI_VERSION,
      action: { surfaceId: bridge.surfaceId, action: "approve" },
    });
    expect(action).not.toBeNull();

    const resumed = await app.runtime.resume(executionId, {
      eventType: "ExpenseApproved",
      payload: { approvedBy: "a2ui-client", a2ui: action },
    });
    const result = await resumed.waitForCompletion();
    unsub();

    expect(result.status).toBe("completed");

    // The final status update reached the client as an absolute value.
    const statusUpdates = messages
      .map((m) => m as { updateDataModel?: { path: string; contents: unknown } })
      .filter((m) => m.updateDataModel?.path === "/status");
    expect(statusUpdates.at(-1)?.updateDataModel?.contents).toBe("done");

    // close() tears the surface down.
    const closing = bridge.close();
    expect(a2uiKind(closing[0]!)).toBe("deleteSurface");
  });
});
