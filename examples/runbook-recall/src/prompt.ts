import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import type { LlmRequestInput } from "@loom/llm";
import type { StoredChunk } from "./knowledge";

export interface AnswerCall {
  question: string;
  chunks: StoredChunk[];
}

const OPERATOR_INSTRUCTIONS = [
  "You are an on-call assistant. Answer strictly from the runbook passages provided.",
  "Cite the runbook id you used. If the passages do not answer the question, say so.",
  UNTRUSTED_CONTENT_SYSTEM_NOTE,
].join(" ");

/**
 * The correct shape: retrieved passages go in `user` messages, one per chunk, each
 * still carrying the taint it was ingested with. `guardRequest` fences them and
 * labels them with their origin before any provider sees them.
 *
 * One message per chunk rather than one joined string, because taint is attached to
 * a VALUE: joining the texts would mean unwrapping them first, and provenance would
 * stop travelling exactly where it matters.
 */
export function buildAnswerRequest(call: AnswerCall): LlmRequestInput {
  return {
    system: OPERATOR_INSTRUCTIONS,
    messages: [
      ...call.chunks.map((c) => ({ role: "user" as const, content: c.text })),
      { role: "user" as const, content: `Question: ${call.question}` },
    ],
    maxTokens: 400,
  };
}

/**
 * The shape almost every RAG tutorial writes — retrieved context in the SYSTEM prompt,
 * under a "here is the relevant documentation" header.
 *
 * It is REFUSED (`UntrustedContentError`), and that refusal is the whole reason this
 * example exists: the system prompt is the operator's voice, and a corpus anyone can
 * edit is not the operator. Kept here, and exercised in the tests, because the failure
 * mode is invisible until someone writes a line into a wiki page.
 *
 * Note what you CANNOT do accidentally: you cannot interpolate a passage into a header
 * string, because the tainted value is an object and `${…}` yields "[object Object]".
 * Getting the text out takes an explicit `unwrapTainted`, which is where provenance
 * stops travelling — deliberately a visible call and not a silent coercion.
 */
export function buildNaiveRequest(call: AnswerCall): LlmRequestInput {
  const passage = call.chunks[0]?.text;
  return {
    ...(passage !== undefined && { system: passage }),
    messages: [{ role: "user", content: `Question: ${call.question}` }],
  };
}
