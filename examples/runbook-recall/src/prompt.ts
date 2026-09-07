import type { Passage } from "@loom/knowledge";
import { groundedRequest } from "@loom/knowledge";
import type { LlmRequestInput } from "@loom/llm";

export interface AnswerCall {
  question: string;
  passages: Passage[];
}

const OPERATOR_INSTRUCTIONS = [
  "You are an on-call assistant. Answer strictly from the runbook passages provided.",
  "Cite the runbook id you used. If the passages do not answer the question, say so.",
].join(" ");

/**
 * The correct shape, and now one call: retrieved passages go in `user` messages, one
 * per passage, each still carrying the taint it was ingested with. `guardRequest`
 * fences them and labels them with their origin before any provider sees them.
 *
 * `groundedRequest` appends the untrusted-content note to the instructions and never
 * lets a passage into the system slot — its `instructions` parameter is typed `string`,
 * so the mistake below does not type-check when written through it.
 */
export function buildAnswerRequest(call: AnswerCall): LlmRequestInput {
  return groundedRequest({
    instructions: OPERATOR_INSTRUCTIONS,
    question: `Question: ${call.question}`,
    passages: call.passages,
    maxTokens: 400,
  });
}

/**
 * The shape almost every RAG tutorial writes — retrieved context in the SYSTEM prompt,
 * under a "here is the relevant documentation" header.
 *
 * It is REFUSED (`UntrustedContentError`), and that refusal is half the reason this
 * example exists: the system prompt is the operator's voice, and a corpus anyone can
 * edit is not the operator. Kept here, and exercised in the tests, because the failure
 * mode is invisible until someone writes a line into a wiki page. It has to be built by
 * hand precisely BECAUSE `groundedRequest` will not build it.
 *
 * Note what you CANNOT do accidentally: you cannot interpolate a passage into a header
 * string, because the tainted value is an object and `${…}` yields "[object Object]".
 * Getting the text out takes an explicit `unwrapTainted`, which is where provenance
 * stops travelling — deliberately a visible call and not a silent coercion.
 */
export function buildNaiveRequest(call: AnswerCall): LlmRequestInput {
  const passage = call.passages[0]?.text;
  return {
    ...(passage !== undefined && { system: passage }),
    messages: [{ role: "user", content: `Question: ${call.question}` }],
  };
}
