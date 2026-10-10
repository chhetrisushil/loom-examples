import type { LlmMessageInput, LlmProvider, LlmRequest, LlmResponse, LlmToolCall } from "@loom/llm";
import { textOf } from "@loom/llm";
import type { ModelRoute, ReasoningRequest, Router } from "@loom/reasoning";

export const FAST = "triage-fast";
export const DEEP = "triage-deep";

export const TICKET_A = "Order 1042 arrived broken. Please refund it.";
export const TICKET_B = "Any update on my broken order?";
export const TICKET_C = "Refund all fifty of my orders.";

/** Did any tool in the transcript fail? (An `isError` tool_result is what the model is shown.) */
export function sawToolError(messages: readonly LlmMessageInput[]): boolean {
  return messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === "tool_result" && p.isError)
  );
}

/**
 * The capability ring picks the model. The Router is consulted by the ReasoningRuntime and its
 * choice is a RECORDED decision; the call then runs as the effect `model:<route id>`, which the
 * flow must be granted. Cheap-first: the fast model, until a tool has failed (then the model has to
 * reason about a gap in the evidence, which is what the deep model is for).
 */
export const triageRouter: Router = {
  select(req: ReasoningRequest, routes: ModelRoute[]): ModelRoute {
    const want = sawToolError(req.messages) ? DEEP : FAST;
    const route = routes.find((r) => r.id === want) ?? routes[0];
    if (route === undefined) throw new Error("no routes");
    return route;
  },
};

const call = (id: string, name: string, input: unknown): LlmToolCall => ({ id, name, input });
const transcript = (request: LlmRequest): string =>
  request.messages.map((m) => textOf(m.content)).join("\n");

/**
 * The scripted "model": a pure function of the transcript (never of a counter it owns), so a
 * resumed run asks it the same questions. It READS the transcript (`textOf`): it refunds only
 * after it has seen the order, and it answers ticket B from what an earlier ticket wrote to memory.
 */
export function triageScript(request: LlmRequest): LlmResponse {
  const turn = request.messages.filter((m) => m.role === "assistant").length;
  const text = transcript(request);
  const lastUser = request.messages[request.messages.length - 1];
  const prompt = text.includes(TICKET_C) ? TICKET_C : text.includes(TICKET_B) ? TICKET_B : TICKET_A;

  if (prompt === TICKET_C) {
    return turn === 0
      ? {
          content: "checking the refund budget",
          toolCalls: [call("c0", "check_refund_budget", { orders: 50 })],
          stopReason: "tool_use",
        }
      : { content: "unreachable: a quota stop is never fed back", stopReason: "end_turn" };
  }
  if (prompt === TICKET_B) {
    // Recalled memory (the first ticket's write-back) arrives as earlier messages.
    return text.includes("Refunded order 1042")
      ? {
          content:
            "Your refund for order 1042 was issued on your earlier ticket; nothing more is due.",
          stopReason: "end_turn",
        }
      : {
          content: "I have no record of an earlier ticket.",
          stopReason: "end_turn",
        };
  }
  if (turn === 0) {
    return {
      content: "gathering evidence",
      toolCalls: [
        call("a0", "lookup_customer", { email: "ada@acme.test" }),
        call("a1", "lookup_order", { order: 1042 }),
        call("a2", "carrier_status", { order: 1042 }),
      ],
      stopReason: "tool_use",
    };
  }
  if (turn === 1) {
    return {
      content: "the carrier is unreachable but the order is confirmed damaged; refunding",
      toolCalls: [call("a3", "issue_refund", { order: 1042, amount: 49 })],
      stopReason: "tool_use",
    };
  }
  void lastUser;
  return {
    content:
      "Refunded order 1042 ($49). The carrier lookup failed, so delivery was not verified; the refund rests on the order record.",
    stopReason: "end_turn",
  };
}

/** A provider for one route: counts its own calls, answers from the shared script. */
export function routeProvider(id: string, calls: Record<string, number>): LlmProvider {
  return {
    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls[id] = (calls[id] ?? 0) + 1;
      return triageScript(request);
    },
  };
}
