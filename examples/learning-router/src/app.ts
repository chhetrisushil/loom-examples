import { type LoomApp, defineConfig } from "@loom/app";
import type { RegisteredFlow } from "@loom/workflow-runtime";

// ── Composition root ──────────────────────────────────────────────────────────
//
// Note what is absent: there is no `learning:` key, no policy registry, no
// training scheduler. The policy is a constructor argument to the flow runner
// and nothing more — loom does not know it exists. Everything the learning loop
// needs, it reads back out of the event log afterwards.
export function buildApp(flow: RegisteredFlow): LoomApp {
  return defineConfig({
    storage: { kind: "memory" },
    flows: [flow],
  });
}
