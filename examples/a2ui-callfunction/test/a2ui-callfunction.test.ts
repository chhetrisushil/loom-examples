import type { EventEnvelope } from "@loom/core";
import type { A2UICallFunctionTransport, FunctionResponsePayload } from "@loom/plugin-a2ui";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { answerClientFunction, inProcessTransport } from "../src/client";
import type { CheckoutInput, CheckoutOutput } from "../src/flow";
import { RegisteredCheckoutFlow } from "../src/flow";

// Wrap a transport to count how many times the client function is actually called.
function counting(inner: A2UICallFunctionTransport) {
  let calls = 0;
  const transport: A2UICallFunctionTransport = {
    call: (req, signal) => {
      calls += 1;
      return inner.call(req, signal);
    },
  };
  return { transport, calls: () => calls };
}

describe("a2ui-callfunction example", () => {
  it("grain A (read) + grain B (side effect) round-trip reaches done; grain B fires once and is folded", async () => {
    const executionId = "cart-happy";
    const input: CheckoutInput = { cartId: executionId, amount: 240 };
    const client = counting(inProcessTransport());
    const app = buildApp(client.transport);

    try {
      const handle = await app.runtime.start(RegisteredCheckoutFlow, input, { executionId });
      await handle.waitForSuspend();

      // ── Grain A: the flow announced a pending client call and suspended. ──
      const surface = app.projectionRuntime.getState("ui", executionId) as {
        pendingCall?: { callId: string; name: string; args?: unknown };
      };
      expect(surface.pendingCall).toMatchObject({
        name: "getLocale",
        callId: `${executionId}:getLocale#1`, // deterministic AND call-site-unique
      });
      expect(client.calls()).toBe(0); // grain-B effect has NOT fired yet

      // The client answers the read; the app resumes the gate with the result.
      const localeResp = answerClientFunction({
        surfaceId: `ui:${executionId}`,
        callId: surface.pendingCall!.callId,
        name: "getLocale",
      });
      const resumed = await app.runtime.resume(executionId, {
        eventType: "A2UIFunctionResult",
        payload: localeResp,
      });
      const result = await resumed.waitForCompletion();

      expect(result.status).toBe("completed");
      // ── Grain B fired exactly once, keyed by executionId:stepId. ──
      expect(client.calls()).toBe(1);
      const out = result.variables._output as CheckoutOutput;
      expect(out.locale).toBe("en-GB");
      expect(out.submitted).toBe(true);
      expect(out.confirmationId).toBe(`cf-${executionId}:confirm-submit`);
      // The client's answer is folded into the step frame (served from the log on replay).
      expect(result.frames["confirm-submit"]?.output).toMatchObject({ submitted: true });
    } finally {
      await app.close();
    }
  });

  it("grain B: a crash mid-call parks at EFFECT_INDOUBT; an operator verdict completes it without re-firing", async () => {
    const executionId = "cart-indoubt";
    const input: CheckoutInput = { cartId: executionId, amount: 100 };

    // App A — the client hangs, so confirm-submit is left durably `running`.
    let callsA = 0;
    const appA = buildApp({
      call: () => {
        callsA += 1;
        return new Promise<FunctionResponsePayload>(() => {}); // never resolves = the crash
      },
    });

    // Resolve once confirm-submit's STEP_STARTED is durable.
    const confirmStarted = new Promise<void>((resolve) => {
      void appA.stores.eventStore.subscribe(executionId, (e: EventEnvelope) => {
        if (
          e.eventType === "STEP_STARTED" &&
          (e.payload as { stepId?: string }).stepId === "confirm-submit"
        ) {
          resolve();
        }
      });
    });

    const handle = await appA.runtime.start(RegisteredCheckoutFlow, input, { executionId });
    await handle.waitForSuspend(); // grain-A gate

    // Drive grain A directly (no bridge needed) so the flow advances to grain B.
    await appA.runtime.resume(executionId, {
      eventType: "A2UIFunctionResult",
      payload: { result: { locale: "en-GB" } },
    });
    await confirmStarted; // confirm-submit is now `running`, its client call hung
    expect(callsA).toBe(1);

    // ── Crash: abandon appA (do NOT close — keep the shared stores) and boot a
    //    fresh app over the SAME event + snapshot stores. ──
    let callsB = 0;
    const appB = buildApp(
      {
        call: async () => {
          callsB += 1;
          return { surfaceId: "", callId: "", name: "", result: null };
        },
      },
      {
        kind: "custom",
        eventStore: appA.stores.eventStore,
        snapshotStore: appA.stores.snapshotStore,
      }
    );

    // Re-dispatch the crashed execution. Recovery re-runs the flow; confirm-submit's
    // frame is `running` and the effect is idempotent:false, so the kernel parks at
    // EFFECT_INDOUBT instead of re-invoking the client.
    const recovered = await appB.runtime.resume(executionId, {
      eventType: "EXECUTION_RECOVERED",
      payload: {},
    });
    await recovered.waitForSuspend();
    expect(callsB).toBe(0); // appB's client was NEVER called

    const events = await appB.stores.eventStore.read(executionId);
    expect(events.some((e) => e.eventType === "EFFECT_INDOUBT")).toBe(true);

    // ── Operator verdict: the effect DID take place on the client — adopt its
    //    result durably without re-running the tool. ──
    const settled = await appB.runtime.resume(executionId, {
      eventType: "EFFECT_INDOUBT_RESOLVED",
      payload: {
        stepId: "confirm-submit",
        resolution: "completed-with-result",
        output: { confirmationId: "cf-operator", submitted: true },
      },
    });
    const done = await settled.waitForCompletion();

    expect(done.status).toBe("completed");
    expect(callsB).toBe(0); // still never re-fired
    expect((done.variables._output as CheckoutOutput).confirmationId).toBe("cf-operator");

    await appA.close(); // tears down the shared stores
  });
});
