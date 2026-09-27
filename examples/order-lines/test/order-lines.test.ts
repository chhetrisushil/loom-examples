import { executeProvider } from "@loom-ui/hydration";
import { describe, expect, it } from "vitest";
import { createBoard } from "../src/app";
import { orderLinesSpec } from "../src/board";
import { OrdersTools } from "../src/tools";

type LitEl = HTMLElement & { updateComplete: Promise<unknown> };

describe("order-lines: the empty binding state (loom ADR 0100, gap G5)", () => {
  it("a real top order: its lines execute both steps and render normally", async () => {
    const board = createBoard({ topOrders: [{ orderId: "o-1", total: 500 }] });
    await board.settle();
    expect(board.store.status("order_lines")?.state).toBe("ready");
    expect(board.store.value("order_lines")).toEqual([
      { sku: "SKU-1", qty: 2 },
      { sku: "SKU-2", qty: 1 },
    ]);
    expect(board.invoker.calls).toEqual(["orders.top", "orders.lines"]);
  });

  it("no top order at all: the dependent widget shows No data on both surfaces — never an error, never repaired", async () => {
    const board = createBoard({ topOrders: [] });
    await board.settle();
    const status = board.store.status("order_lines");
    expect(status?.state).toBe("empty");
    expect(status?.finding?.code).toBe("upstream-empty");
    expect(status?.finding?.message).toBe(
      'step "order-lines" references "top-orders" at path "rows[0].orderId": the upstream has no such row'
    );
    // ADR 0100: a producer MUST clear the value beside `empty` — no stale value survives under it.
    expect(board.store.value("order_lines")).toBeUndefined();
    // The dependent step's own tool was never called: there was no row to ask about.
    expect(board.invoker.calls).toEqual(["orders.top"]);

    const { host, dispose } = board.mount();
    try {
      const el = host.querySelector("[data-widget-id='lines'] lu-data-table") as LitEl;
      await el.updateComplete;
      const region = el.shadowRoot?.querySelector('[role="status"]') as HTMLElement;
      expect(region).toBeTruthy();
      expect(region.dataset.state).toBe("empty");
      expect(region.textContent?.trim()).toBe("Order lines: No data");
      // The reason lives in `title` (in-process: the full hydration message), never in the
      // "No data" text itself — the Lit base always says the same thing, unlike the terminal row.
      expect(region.getAttribute("title")).toBe(status?.finding?.message);
      // Never the error/alert styling: "No data" is a result, not a failure.
      expect(el.shadowRoot?.querySelector('[role="group"][data-state="error"]')).toBeNull();
    } finally {
      dispose();
    }

    const frame = board.terminalFrame();
    expect(frame).toContain(`○ Order lines: ${status?.finding?.message}`);
    expect(frame).not.toContain("error");

    // Loading it again asks the same question and gets the same answer — never cached (there is
    // no value to cache), never drift, never a repair to wait for.
    await board.settle();
    expect(board.store.status("order_lines")?.state).toBe("empty");
  });

  it("a genuinely bad template path still errors — even with a real top order to read", async () => {
    const board = createBoard({
      topOrders: [{ orderId: "o-1", total: 500 }],
      topOrderPath: "rows[0].orderIdTypo",
    });
    await board.settle();
    const status = board.store.status("order_lines");
    expect(status?.state).toBe("error");
    // Never mistaken for "no data": the argument never resolved, so the dependent tool is still
    // never called — but the REASON, and so the rendered state, is a different one entirely.
    expect(board.invoker.calls).toEqual(["orders.top"]);

    // The underlying reason a bad KEY differs from an out-of-range INDEX — what tells "error"
    // apart from "empty" in the first place — is `executeProvider`'s own per-step finding.
    const outcome = await executeProvider(orderLinesSpec("rows[0].orderIdTypo"), {
      invoker: new OrdersTools([{ orderId: "o-1", total: 500 }]),
    });
    if (outcome.ok) throw new Error("expected the bad path to fail the step");
    const stepFinding = outcome.findings.find((f) => f.code === "unresolved-step-reference");
    expect(stepFinding?.message).toBe(
      'step "order-lines" references "top-orders" at path "rows[0].orderIdTypo", which resolves to nothing'
    );

    const { host, dispose } = board.mount();
    try {
      const el = host.querySelector("[data-widget-id='lines'] lu-data-table") as LitEl;
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('[role="status"][data-state="empty"]')).toBeNull();
      const region = el.shadowRoot?.querySelector('[data-state="error"]') as HTMLElement;
      expect(region).toBeTruthy();
      expect(region.getAttribute("role")).toBe("group"); // never role="status" — this IS a failure
    } finally {
      dispose();
    }

    const frame = board.terminalFrame();
    expect(frame).not.toContain("○ Order lines"); // the empty marker, specifically, never appears
  });
});
