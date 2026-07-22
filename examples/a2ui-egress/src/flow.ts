import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ── An expense-approval flow that drives an agent surface ─────────────────────
//
// The point of this example is NOT the domain — it is the surface. Every
// `ctx.ui.*` call below emits one durable, replayable `SURFACE_PATCH` event as a
// *delta* (set / merge / append / increment). `@loom/plugin-a2ui` folds that same
// event stream into the Google A2UI wire protocol, where the semantics are
// *absolute* value-replacement. The driver (src/main.ts) prints both sides.

const expenseInput = z.object({ expenseId: z.string(), title: z.string() });
const expenseOutput = z.object({
  expenseId: z.string(),
  summary: z.string(),
  applied: z.boolean(),
});

export type ExpenseInput = z.infer<typeof expenseInput>;
export type ExpenseOutput = z.infer<typeof expenseOutput>;

// ── Steps ─────────────────────────────────────────────────────────────────────

export const FetchExpenseStep = step$({
  id: "fetch-expense",
  inputSchema: z.object({ expenseId: z.string() }),
  outputSchema: z.object({ lineItems: z.number(), category: z.string() }),
  handler: handler$(async (input: { expenseId: string }) => {
    // Deterministic (no RNG) so the demo output is stable and replay-safe.
    const lineItems = (input.expenseId.length % 4) + 3;
    return { lineItems, category: "travel" };
  }),
});

export const TotalExpenseStep = step$({
  id: "total-expense",
  inputSchema: z.object({ lineItems: z.number() }),
  outputSchema: z.object({ amount: z.number() }),
  handler: handler$(async (input: { lineItems: number }) => {
    return { amount: input.lineItems * 128 };
  }),
});

export const ReimburseStep = step$({
  id: "reimburse",
  inputSchema: z.object({ expenseId: z.string(), amount: z.number() }),
  outputSchema: z.object({ summary: z.string(), applied: z.boolean() }),
  handler: handler$(async (input: { expenseId: string; amount: number }) => ({
    summary: `Reimbursed ${input.expenseId} for $${input.amount}`,
    applied: true,
  })),
});

// ── Flow definition ─────────────────────────────────────────────────────────

export const ExpenseFlow = flow$({
  id: "expense-approval",
  name: "Expense Approval",
  version: "1.0.0",
  inputSchema: expenseInput,
  outputSchema: expenseOutput,
  steps: [FetchExpenseStep, TotalExpenseStep, ReimburseStep],
});

// ── Runner ────────────────────────────────────────────────────────────────────

const runner: FlowRunner<ExpenseInput, ExpenseOutput> = async (ctx, input) => {
  // Seed the surface. `set` replaces a path; `append` pushes onto an array.
  ctx.ui.set("title", input.title);
  ctx.ui.set("status", "fetching");
  ctx.ui.append("progressLog", `Fetching ${input.expenseId}`);

  const fetched = await ctx.run(FetchExpenseStep, { expenseId: input.expenseId });
  ctx.ui.merge("stats", { lineItems: fetched.lineItems, category: fetched.category });
  ctx.ui.increment("stepsCompleted");
  ctx.ui.set("status", "totalling");
  ctx.ui.append("progressLog", `${fetched.lineItems} line items (${fetched.category})`);

  const totalled = await ctx.run(TotalExpenseStep, { lineItems: fetched.lineItems });
  ctx.ui.merge("stats", { amount: totalled.amount });
  ctx.ui.increment("stepsCompleted");
  ctx.ui.append("progressLog", `Total $${totalled.amount}`);

  // Suspend for human approval — resumed when an "ExpenseApproved" event arrives.
  // In this example that event is raised by an inbound A2UI `action` (see main.ts).
  ctx.ui.set("status", "awaiting-approval");
  await ctx.suspend({ on: "ExpenseApproved", correlationKey: input.expenseId });

  ctx.ui.set("status", "reimbursing");
  const done = await ctx.run(ReimburseStep, {
    expenseId: input.expenseId,
    amount: totalled.amount,
  });
  ctx.ui.increment("stepsCompleted");
  ctx.ui.set("status", "done");
  ctx.ui.append("progressLog", done.summary);

  return { expenseId: input.expenseId, summary: done.summary, applied: done.applied };
};

export const RegisteredExpenseFlow: RegisteredFlow = {
  definition: ExpenseFlow,
  runner: runner as FlowRunner<unknown, unknown>,
};
