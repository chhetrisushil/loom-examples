import { type LoomApp, type StorageConfig, defineConfig } from "@loom/app";
import { registerA2UICallFunction } from "@loom/plugin-a2ui";
import type { A2UICallFunctionTransport } from "@loom/plugin-a2ui";
import { RegisteredCheckoutFlow } from "./flow";

// ── Composition root ──────────────────────────────────────────────────────────
//
// `surfaces: ["ui"]` registers the native agent surface the flow drives via
// `ctx.ui.*` (also what the A2UISurfaceBridge bridges by default). The
// `execution.registerEffects` hook wires the grain-B `a2ui.callFunction` effect to an
// injected transport — the plugin stays transport-agnostic, the app chooses the
// wire (here an in-process client; in production a WebSocket).
//
// `storage` is a parameter so the crash-recovery test can share one set of
// stores across two app instances (a fresh runtime resuming over the same event
// log — the real proof of restart survival), exactly as production would.
export function buildApp(
  transport: A2UICallFunctionTransport,
  storage: StorageConfig = { kind: "memory" }
): LoomApp {
  return defineConfig({
    storage,
    flows: [RegisteredCheckoutFlow],
    surfaces: ["ui"],
    execution: { registerEffects: (fx) => registerA2UICallFunction(fx, transport) },
  });
}
