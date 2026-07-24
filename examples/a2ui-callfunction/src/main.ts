import type { SurfaceState } from "@loom/agent-surface";
import type { EventEnvelope } from "@loom/core";
import { A2UISurfaceBridge, A2UI_VERSION } from "@loom/plugin-a2ui";
import type { A2UICallFunctionTransport, CallFunctionPayload } from "@loom/plugin-a2ui";
import { buildApp } from "./app";
import { answerClientFunction } from "./client";
import type { CheckoutInput } from "./flow";
import { RegisteredCheckoutFlow } from "./flow";
import { CHECKOUT_VIEW } from "./view";

// A headless driver for A2UI `callFunction` (bidirectional RPC) over two grains:
//   • Grain A (read)        — getLocale, via a suspend/resume gate.
//   • Grain B (side effect) — confirmSubmit, via a delegated effect.
// Both call a client-side function and fold its answer back into the log; on
// replay the answer is served from the log and the client is never re-invoked.
async function main(): Promise<void> {
  // Grain-B transport: the in-process client, with logging so the RPC is visible.
  const transport: A2UICallFunctionTransport = {
    call: async (req: CallFunctionPayload) => {
      console.log(
        `  → callFunction  ${req.name}(${JSON.stringify(req.args ?? {})})  callId=${req.callId}`
      );
      const resp = answerClientFunction(req);
      console.log(`  ← functionResponse  result=${JSON.stringify(resp.result)}`);
      return resp;
    },
  };

  const app = buildApp(transport);
  const eventStore = app.stores.eventStore;

  const input: CheckoutInput = { cartId: "cart-77", amount: 240 };
  const executionId = "cart-77";

  const bridge = new A2UISurfaceBridge({
    executionId,
    components: CHECKOUT_VIEW,
    surfaceProperties: { agentDisplayName: "Checkout" },
  });

  console.log(
    `\n⧖  A2UI callFunction — execution ${executionId} (surfaceId=${bridge.surfaceId})\n`
  );
  console.log("── Egress: surface → A2UI wire (server → client) ────────────────");
  const unsubscribe = await eventStore.subscribe(executionId, (event: EventEnvelope) => {
    for (const msg of bridge.handleEvent(event)) {
      const kind = Object.keys(msg).find((k) => k !== "version");
      console.log(`  ${kind}`);
    }
  });

  // Start; the flow prices the cart, announces the getLocale call, and suspends.
  const handle = await app.runtime.start(RegisteredCheckoutFlow, input, { executionId });
  await handle.waitForSuspend();

  // ── Grain A — read via a suspend/resume gate ─────────────────────────────────
  console.log("\n── Grain A: getLocale (read) via suspend/resume gate ────────────");
  const surface = app.projectionRuntime.getState<SurfaceState>("ui", executionId);
  const pending = (surface as { pendingCall?: { callId: string; name: string; args?: unknown } })
    .pendingCall;
  if (pending === undefined) throw new Error("flow did not announce a pending call");

  // The agent asks the client to run the function; the bridge builds the request.
  const request = bridge.callFunction(pending.name, pending.args, { callId: pending.callId });
  const cf = (request as { callFunction: CallFunctionPayload }).callFunction;
  console.log(`  → callFunction  ${cf.name}()  callId=${cf.callId}`);

  // The client answers; the bridge normalizes the reply for THIS surface, and the
  // app turns it into the resume that satisfies the gate.
  const clientReply = { version: A2UI_VERSION, functionResponse: answerClientFunction(cf) };
  const answer = bridge.ingestFunctionResponse(clientReply);
  if (answer === null) throw new Error("functionResponse was not accepted for this surface");
  console.log(`  ← functionResponse  result=${JSON.stringify(answer.result)}  → resume gate`);

  // ── Grain B runs inline on resume (delegated effect via the transport) ────────
  console.log("\n── Grain B: confirmSubmit (side effect) via delegated effect ────");
  const resumed = await app.runtime.resume(executionId, {
    eventType: "A2UIFunctionResult",
    payload: answer,
  });
  const result = await resumed.waitForCompletion();

  console.log("\n── Result ───────────────────────────────────────────────────────");
  console.log(`  status=${result.status}`);
  const finalSurface = app.projectionRuntime.getState<SurfaceState>("ui", executionId);
  console.log(`  surface=${JSON.stringify(finalSurface)}`);

  for (const msg of bridge.close()) {
    const kind = Object.keys(msg).find((k) => k !== "version");
    console.log(`  ${kind}`);
  }

  unsubscribe();
  await app.close();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
