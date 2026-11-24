import type { LlmRequest, LlmResponse } from "@loomwork/llm";
import { textOf } from "@loomwork/llm";

/** The ids of the effects the digest agent can call. A tool id IS an effect id, and a grant names effect ids. */
export const MODEL = "model";
export const INCIDENTS = "incidents.list";
export const EMAIL = "email.send";
export const PAGER = "pager.page";
export const RECALL = "memory.recall";
export const WRITE = "memory.write";

/** The prompts select the scripted behaviour. */
export const P_DIGEST = "Send tonight's incident digest.";
export const P_PAGE = "Send tonight's digest, and page the on-call if anything is red.";

/** The text of the `isError` tool results the model was shown in a request. */
export function errorsSeen(request: LlmRequest): string[] {
  return request.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.flatMap((p) =>
          p.type === "tool_result" && p.isError ? [JSON.stringify(p.content)] : []
        )
      : []
  );
}

/**
 * The scripted "model": a pure function of the transcript, never of a counter it owns, so a resumed
 * run asks it the same questions. It picks a plan from the prompt, calls one tool per turn, then answers.
 */
export function digestScript(request: LlmRequest): LlmResponse {
  const turn = request.messages.filter((m) => m.role === "assistant").length;
  const text = request.messages.map((m) => textOf(m.content)).join("\n");
  const plan = text.includes(P_PAGE)
    ? [PAGER, EMAIL]
    : text.includes(P_DIGEST)
      ? [INCIDENTS, EMAIL]
      : [EMAIL];
  const tool = plan[turn];
  if (tool !== undefined) {
    return {
      content: `calling ${tool}`,
      toolCalls: [
        { id: `c${turn}`, name: tool, input: { to: "ops@acme.test", body: "3 incidents, 1 red" } },
      ],
      stopReason: "tool_use",
    };
  }
  const refused =
    errorsSeen(request).length > 0 ? " (one tool was refused; carried on without it)" : "";
  return { content: `Digest sent.${refused}`, stopReason: "end_turn" };
}
