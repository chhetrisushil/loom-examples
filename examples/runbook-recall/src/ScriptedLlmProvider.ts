import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

/**
 * A deterministic provider, so the example is offline and its executions replay
 * byte-identically. It also KEEPS the last request it was handed — which is the
 * only way to assert what actually crossed the prompt boundary, as opposed to
 * what the application meant to send.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];

  constructor(private readonly answer: (request: LlmRequest) => string) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    return {
      content: this.answer(request),
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }

  get lastRequest(): LlmRequest | undefined {
    return this.requests[this.requests.length - 1];
  }
}

/** Cites whichever runbook ids appear in the fenced passages. Deterministic. */
export function citingAnswer(request: LlmRequest): string {
  const ids = new Set<string>();
  for (const message of request.messages) {
    for (const match of message.content.matchAll(/runbook:(RB-\d+)/g)) {
      ids.add(match[1] as string);
    }
  }
  return ids.size === 0
    ? "The runbooks provided do not answer that."
    : `Per ${[...ids].sort().join(", ")}: follow the graceful, reversible step first.`;
}
