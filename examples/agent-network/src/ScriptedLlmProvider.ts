import { type LlmProvider, type LlmRequest, type LlmResponse, toParts } from "@loom/llm";

// A deterministic provider that returns a fixed queue of responses, so the
// ReAct loop is reproducible offline. In production you would use:
//
//   import { AnthropicProvider } from "@loom/llm";
//   const provider = new AnthropicProvider({ model: "claude-opus-4-8" });
//
// or OpenAiProvider, or any object implementing LlmProvider — the choice of
// model is pure configuration.
//
// STATELESS: the response is picked from the transcript it is handed, not from a counter, so
// one provider can serve many executions and survive a replay. By default the turn is the number
// of tool-result messages AFTER the last plain user message (the current prompt). Pass `pick` to
// choose differently (e.g. the chat demo picks by whether earlier turns were recalled).
const isToolResult = (m: LlmRequest["messages"][number]): boolean =>
  toParts(m.content).some((p) => p.type === "tool_result");

export function currentTurn(request: LlmRequest): number {
  const msgs = request.messages;
  let start = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m !== undefined && m.role === "user" && !isToolResult(m)) {
      start = i;
      break;
    }
  }
  return msgs.slice(start + 1).filter(isToolResult).length;
}

export function plainUserMessages(request: LlmRequest): number {
  return request.messages.filter((m) => m.role === "user" && !isToolResult(m)).length;
}

export class ScriptedLlmProvider implements LlmProvider {
  constructor(
    private readonly responses: LlmResponse[],
    private readonly pick: (request: LlmRequest) => number = currentTurn
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    return this.responses[this.pick(request)] ?? { content: "(done)", stopReason: "end_turn" };
  }
}
