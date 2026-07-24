import { flow$, handler$, step$ } from "@loom/core";
import type { ExecutableTask } from "@loom/core";
import { A2UI_CALL_FUNCTION_TOOL_ID } from "@loom/plugin-a2ui";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ── A checkout flow that calls two client-side functions ──────────────────────
//
// The point is the two *grains* of A2UI `callFunction`, not the domain:
//
//   Grain A (read / idempotent) — `getLocale`. The flow announces the pending
//     call on its surface and SUSPENDS on "A2UIFunctionResult"; the driver emits
//     the A2UI request, the client answers, and the driver resumes with the
//     result. No live socket, reuses the same machinery as an inbound action.
//
//   Grain B (side effect / non-idempotent) — `confirmSubmit`. The flow calls it
//     as a delegated effect via `ctx.execute`, routed to the `a2ui.callFunction`
//     effect (declared `idempotent: false`). The client's answer is recorded as
//     the step's STEP_COMPLETED output; a crash mid-call parks at EFFECT_INDOUBT.

const checkoutInput = z.object({ cartId: z.string(), amount: z.number() });
const checkoutOutput = z.object({
  cartId: z.string(),
  locale: z.string(),
  confirmationId: z.string(),
  submitted: z.boolean(),
});

export type CheckoutInput = z.infer<typeof checkoutInput>;
export type CheckoutOutput = z.infer<typeof checkoutOutput>;

// Grain B: a task whose own step id is "confirm-submit" but which resolves to the
// shared `a2ui.callFunction` effect (`toolId`). Keeping a distinct step id gives
// the call its own durable frame + idempotency key (`executionId:confirm-submit`).
const ConfirmSubmitTask: ExecutableTask<
  { surfaceId: string; name: string; args?: unknown },
  { confirmationId: string; submitted: boolean }
> = {
  _tag: "TaskDefinition",
  kind: "tool",
  id: "confirm-submit",
  toolId: A2UI_CALL_FUNCTION_TOOL_ID,
};

export const PriceStep = step$({
  id: "price",
  inputSchema: z.object({ amount: z.number() }),
  outputSchema: z.object({ total: z.number() }),
  // Deterministic (no RNG) so the demo output is stable and replay-safe.
  handler: handler$(async (input: { amount: number }) => ({ total: input.amount })),
});

export const CheckoutFlow = flow$({
  id: "a2ui-checkout",
  name: "A2UI Checkout",
  version: "1.0.0",
  inputSchema: checkoutInput,
  outputSchema: checkoutOutput,
  steps: [PriceStep],
});

const runner: FlowRunner<CheckoutInput, CheckoutOutput> = async (ctx, input) => {
  ctx.ui.set("cartId", input.cartId);
  ctx.ui.set("status", "pricing");
  const priced = await ctx.run(PriceStep, { amount: input.amount });
  ctx.ui.merge("summary", { total: priced.total });

  // ── Grain A — read a client value through a suspend/resume gate ──────────────
  // The callId must be both deterministic (never random, so a crash-recovered
  // re-issue reuses it) AND call-site-unique — a suspend gate has no step id to
  // key on, so two calls of the same function would collide their request/response
  // correlation. We tag this single call site with `#1` (mirroring the
  // step-identity rule, ADR 0061). Grain B below gets uniqueness for free via
  // ctx.idempotencyKey (= executionId:stepId).
  const localeCallId = `${ctx.executionId}:getLocale#1`;
  ctx.ui.set("status", "awaiting-locale");
  // Announce the pending call so the driver knows what to ask the client.
  ctx.ui.set("pendingCall", { callId: localeCallId, name: "getLocale", args: {} });
  const localePayload = (await ctx.suspend({
    on: "A2UIFunctionResult",
    correlationKey: localeCallId,
  })) as unknown as { result?: { locale?: string } };
  const locale = localePayload.result?.locale ?? "en-US";
  ctx.ui.remove("pendingCall");
  ctx.ui.merge("summary", { locale });

  // ── Grain B — side-effecting client call through a delegated effect ──────────
  ctx.ui.set("status", "confirming");
  const submit = await ctx.execute(ConfirmSubmitTask, {
    surfaceId: `ui:${ctx.executionId}`,
    name: "confirmSubmit",
    args: { total: priced.total, locale },
  });

  ctx.ui.set("status", "done");
  ctx.ui.merge("summary", { confirmationId: submit.confirmationId });

  return {
    cartId: input.cartId,
    locale,
    confirmationId: submit.confirmationId,
    submitted: submit.submitted,
  };
};

export const RegisteredCheckoutFlow: RegisteredFlow = {
  definition: CheckoutFlow,
  runner: runner as FlowRunner<unknown, unknown>,
};
