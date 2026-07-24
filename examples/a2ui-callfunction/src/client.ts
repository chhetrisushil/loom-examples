import type {
  A2UICallFunctionTransport,
  CallFunctionPayload,
  FunctionResponsePayload,
} from "@loom/plugin-a2ui";

// ── An in-process A2UI "client" ────────────────────────────────────────────────
//
// In a real deployment the client is a browser reached over a WebSocket / SSE +
// POST pair; here it is a plain function so the demo runs fully offline. It
// answers a `callFunction` request by name and echoes the request's `callId` for
// correlation — exactly what a compliant client returns as `functionResponse`.
export function answerClientFunction(req: CallFunctionPayload): FunctionResponsePayload {
  const base = { surfaceId: req.surfaceId, callId: req.callId, name: req.name };
  switch (req.name) {
    case "getLocale":
      // A pure read — no side effect, safe to re-issue.
      return { ...base, result: { locale: "en-GB" } };
    case "confirmSubmit": {
      // A side effect — the confirmation id is derived from the deterministic
      // callId so a client that dedups a re-issue returns the SAME id.
      return { ...base, result: { confirmationId: `cf-${req.callId}`, submitted: true } };
    }
    default:
      return { ...base, error: `unknown client function: ${req.name}` };
  }
}

// Grain-B transport: a synchronous in-process client. A real transport carries
// the request over the wire and correlates the reply by `req.callId`; this one
// computes the reply directly.
export function inProcessTransport(): A2UICallFunctionTransport {
  return { call: async (req) => answerClientFunction(req) };
}

// A transport that never resolves — models a client (or network) that vanishes
// mid-call, so the effect's step is left durably `running` (an in-doubt attempt).
// Used by the crash-recovery test.
export function hangingTransport(): A2UICallFunctionTransport {
  return { call: () => new Promise<FunctionResponsePayload>(() => {}) };
}
