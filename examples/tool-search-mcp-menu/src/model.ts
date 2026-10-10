import { isTainted, unwrapTainted } from "@loom/classify";
import type { LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "@loom/llm";

/** Text of a tool_result body (a remote result arrives TAINTED, fenced as data). */
const textOf = (c: unknown): string => {
  const v = isTainted(c) ? unwrapTainted(c) : c;
  return typeof v === "string" ? v : JSON.stringify(v);
};

export interface SeenResult {
  tools?: { name: string; description: string; loaded: boolean }[];
  skills?: { kind: string; id: string; description: string }[];
  instructions?: string;
  note?: string;
  [k: string]: unknown;
}

/** The tool results at the tail of a request, parsed out of the loop's `{ tool, result }` envelope. */
export function resultsOf(
  request: LlmRequest
): { id: string; tool: string; tainted: boolean; result: SeenResult }[] {
  const last = request.messages[request.messages.length - 1];
  if (last === undefined || !Array.isArray(last.content)) return [];
  return last.content.flatMap((p) => {
    if (p.type !== "tool_result") return [];
    const raw = textOf(p.content);
    const fenced = /<untrusted-input[^>]*>([\s\S]*?)<\/untrusted-input>/.exec(raw);
    const env = JSON.parse(fenced?.[1] ?? raw) as { tool: string; result: SeenResult };
    return [
      {
        id: p.toolUseId,
        tool: env.tool,
        tainted: isTainted(p.content) || fenced !== null,
        result: env.result,
      },
    ];
  });
}

const call = (id: string, name: string, input: unknown): LlmToolCall => ({ id, name, input });

/**
 * The scripted "model". It is a function of the transcript only (never of a counter it owns), so a
 * resumed run asks it the same questions and gets the same answers. It READS the tool results it is
 * given: the tool it calls is the one the search returned, the skill it activates is the one the
 * search found. That is the point: the names are not hard-coded in the script.
 *
 *   turn 0  look the customer up (own tool) + search "bill the customer"
 *   turn 1  call the tool the search found + search "close the month ledger"
 *   turn 2  activate the skill the search found
 *   turn 3  call the skill's tool (it joined the menu with the activation)
 *   turn 4  answer
 */
export const scriptedModel: LlmProvider = {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const turn = request.messages.filter((m) => m.role === "assistant").length;
    const seen = resultsOf(request).map((r) => r.result);
    const found = seen.find((r) => r.tools !== undefined && r.tools.length > 0)?.tools?.[0]?.name;
    const skill = seen.find((r) => r.skills !== undefined && r.skills.length > 0)?.skills?.[0]?.id;
    const activated = seen.find((r) => r.instructions !== undefined);
    const toolCalls: LlmToolCall[] | undefined =
      turn === 0
        ? [
            call("t0a", "lookup_customer", { name: "Acme" }),
            call("t0b", "search_tools", { query: "bill the customer" }),
          ]
        : turn === 1 && found !== undefined
          ? [
              call("t1a", found, { customer: "cus_acme", amount: 1200, detail: "March invoice" }),
              call("t1b", "search_tools", { query: "close the month ledger" }),
            ]
          : turn === 2 && skill !== undefined
            ? [call("t2a", "activate_skill", { name: skill })]
            : turn === 3 && activated !== undefined
              ? [call("t3a", "post_ledger_entry", { invoice: "2026-03", amount: 1200 })]
              : undefined;
    return toolCalls === undefined
      ? { content: "Acme is billed for March and the month is closed.", stopReason: "end_turn" }
      : { content: `turn ${turn}`, toolCalls, stopReason: "tool_use" };
  },
};
