import { type LoomApp, defineConfig } from "@loom/app";
import { createLlmEffect } from "@loom/llm";
import type { LlmProvider } from "@loom/llm";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import type { AnswerCall } from "./prompt";
import { buildAnswerRequest } from "./prompt";

// ── Composition root ─────────────────────────────────────────────────────────
//
// Note what is absent: no retriever, no embedding provider, no `rag:` key, and no
// knowledge base HERE — the `KnowledgeBase` is a value the flow closes over, exactly
// like the memory it sits on. The only wiring is the model effect, and it is the same
// one any LLM app registers.
export function buildApp(
  flow: RegisteredFlow,
  provider: LlmProvider,
  buildRequest: (call: AnswerCall) => ReturnType<typeof buildAnswerRequest> = buildAnswerRequest
): LoomApp {
  return defineConfig({
    storage: { kind: "memory" },
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
