import { type LoomApp, defineConfig } from "@loom/app";
import { createLlmEffect } from "@loom/llm";
import type { LlmProvider } from "@loom/llm";
import type { MemoryStore } from "@loom/memory";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import type { AnswerCall } from "./prompt";
import { buildAnswerRequest } from "./prompt";

// ── Composition root ─────────────────────────────────────────────────────────
//
// Note what is absent: no retriever, no embedding provider, no `rag:` key. The flow
// closes over a `KnowledgeBase` value, the way it would over any other dependency —
// `app.knowledge(scope)` cannot serve that, because the flow is declared BEFORE the app
// exists (declare it after and it misses defineConfig's boot-time verification). What
// `memoryStore` buys is that both routes reach one corpus: the flow's, and the app's.
export function buildApp(
  flow: RegisteredFlow,
  provider: LlmProvider,
  memoryStore: MemoryStore,
  buildRequest: (call: AnswerCall) => ReturnType<typeof buildAnswerRequest> = buildAnswerRequest
): LoomApp {
  return defineConfig({
    storage: { kind: "memory" },
    // The corpus's store, so `app.knowledge("runbooks")` addresses the SAME corpus the
    // flow closes over — and `loom knowledge sync/list/search` can operate it against
    // this very config module.
    memoryStore,
    flows: [flow],
    execution: {
      registerEffects: (effects) => {
        effects.register(
          "answer-model",
          createLlmEffect<AnswerCall, string>({
            provider,
            // The prompt boundary. `createLlmEffect` runs `guardRequest` over whatever
            // this returns, so a passage in an instruction position fails the effect
            // rather than reaching the model.
            buildRequest: (call) => buildRequest(call),
          })
        );
      },
    },
  });
}
