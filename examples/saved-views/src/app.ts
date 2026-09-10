import { type LoomApp, defineConfig } from "@loom/app";
import type { Blueprint, VersionPins } from "@loom/blueprint-runtime";
import type { AnyProjectionDefinition } from "@loom/core";
import type { ContentStore } from "@loom/plugin-content";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import { registerPromoteFlow } from "./flow";

// ── Composition root ─────────────────────────────────────────────────────────
//
// Two apps are built over the course of the demo, differing in ONE thing: which fold is
// registered under the id `spend`. That is the deploy this example is about, and building it
// as two apps rather than a mutable registry is deliberate — a projection id resolves to
// exactly one fold per process, which is exactly why the change is invisible without a
// declared version.
//
// `app.projectionRuntime.pins()` is the source of the recorded pin. It reports only what a
// projection DECLARES: one that declares nothing is absent rather than present-and-empty, so
// two silent folds cannot compare equal and read as a verified match.

export interface SavedViewsApp {
  app: LoomApp;
  flow: RegisteredFlow;
  pins(): VersionPins;
}

export function buildApp(
  content: ContentStore,
  projections: AnyProjectionDefinition[],
  compose: (intent: string, pins: VersionPins) => Blueprint
): SavedViewsApp {
  const pins = (): VersionPins => app.projectionRuntime.pins?.() ?? {};
  const flow = registerPromoteFlow(content, compose, pins);
  const app = defineConfig({
    storage: { kind: "memory" },
    projections,
    flows: [flow],
  });
  return { app, flow, pins };
}
