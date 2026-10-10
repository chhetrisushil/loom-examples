import { type LlmProvider, type LlmRequest, type LlmStreamChunk, textOf } from "@loom/llm";

/** What the user typed, out of the untrusted-input fence the conversation layer wraps it in. */
export function userTextOf(request: LlmRequest): string {
  const last = request.messages[request.messages.length - 1];
  const raw = last === undefined ? "" : textOf(last.content);
  return (/<untrusted-input[^>]*>([\s\S]*?)<\/untrusted-input>/.exec(raw)?.[1] ?? raw).trim();
}

/** Every character the model is shown in one request: the thing the token window must bound. */
export function promptChars(request: LlmRequest): number {
  return request.messages.reduce((n, m) => n + textOf(m.content).length, 0);
}

export const LONG_OPENING = "Once upon a time, ";

export interface ScriptedModel {
  provider: LlmProvider;
  /** Every request the model was shown. */
  requests: LlmRequest[];
  /** How many model calls were made (a replay after a restart makes none). */
  calls: number;
  /** How many "write ..." answers have begun streaming and are now waiting to be interrupted. */
  longStarted: number;
  /** How many of those were cut by the abort signal (the generation itself stopped). */
  longAborted: number;
}

/**
 * A deterministic, offline "LLM". An ordinary question gets `re <n>: <question>` streamed word by word.
 * A question starting with "write" streams an opening and then NEVER finishes on its own: it only ends
 * when the request's abort signal fires (a barge-in), which is exactly what the conversation layer does.
 */
export function scriptedModel(): ScriptedModel {
  const m: ScriptedModel = {
    requests: [],
    calls: 0,
    longStarted: 0,
    longAborted: 0,
    provider: {
      async complete(request) {
        m.calls++;
        m.requests.push(request);
        return { content: `re ${m.calls}: ${userTextOf(request)}`, stopReason: "end_turn" };
      },
      stream(request) {
        m.calls++;
        m.requests.push(request);
        return script(request, m.calls);
      },
    },
  };
  async function* script(request: LlmRequest, nth: number): AsyncGenerator<LlmStreamChunk> {
    const text = userTextOf(request);
    if (text.startsWith("write")) {
      yield { delta: LONG_OPENING, done: false };
      m.longStarted++;
      await new Promise<never>((_, reject) => {
        const stop = () => {
          m.longAborted++;
          reject(new Error("aborted"));
        };
        if (request.signal?.aborted) stop();
        else request.signal?.addEventListener("abort", stop, { once: true });
      });
    }
    for (const word of `re ${nth}: ${text}`.split(" ")) yield { delta: `${word} `, done: false };
    yield { delta: "", done: true, stopReason: "end_turn" };
  }
  return m;
}
