import type { TransientInvoker } from "@loom-ui/hydration";

export interface TopOrder {
  readonly orderId: string;
  readonly total: number;
}

export interface OrderLine {
  readonly sku: string;
  readonly qty: number;
}

/** Fixed line items per order — a real tool would look these up; the id is all this example varies. */
const LINES: Record<string, readonly OrderLine[]> = {
  "o-1": [
    { sku: "SKU-1", qty: 2 },
    { sku: "SKU-2", qty: 1 },
  ],
  "o-2": [{ sku: "SKU-9", qty: 5 }],
};

/**
 * `orders.top` answers with however many top orders the caller seeded (zero, in the empty-upstream
 * scenario); `orders.lines` answers with a real order's line items. `executeProvider` routes every
 * step through loom's MCP invoke tool with `{ toolName, args }` as input.
 */
export class OrdersTools implements TransientInvoker {
  readonly calls: string[] = [];
  constructor(private readonly topOrders: readonly TopOrder[]) {}

  async invokeTransient<TIn, TOut>(_toolId: string, input: TIn): Promise<TOut> {
    const { toolName, args } = input as { toolName: string; args: Record<string, unknown> };
    this.calls.push(toolName);
    if (toolName === "orders.top") return { rows: this.topOrders } as unknown as TOut;
    if (toolName === "orders.lines") {
      const orderId = args.orderId;
      const lines = typeof orderId === "string" ? LINES[orderId] : undefined;
      if (lines === undefined) throw new Error(`no fake lines for order "${String(orderId)}"`);
      return lines as unknown as TOut;
    }
    throw new Error(`no fake tool "${toolName}"`);
  }
}
