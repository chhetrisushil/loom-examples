import {
  type LlmCapabilities,
  type LlmContentPart,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolResultPart,
  OpenAiProvider,
  assertRequestSupported,
  textOf,
} from "@loom/llm";
import { readPng } from "./png";

// A scripted, deterministic "vision" model: offline, no key. It plans from the user's prompt, asks for
// swatches, then reads what the tool results actually CONTAINED in the request it was handed. By then
// loom has resolved each ref to inline base64 (the provider only ever sees `data` sources), so the
// description it writes is decoded from the bytes, not guessed. A text-only request gets the text
// description a tool returned instead - the model says so.

/**
 * What a shipped provider would DECLARE for `model` (and `baseUrl`): the allowlist table in
 * `@loom/llm`, read straight off a real provider instance. Nothing is sent; `complete` is never called.
 */
export function declaredCapabilities(model: string, baseUrl?: string): LlmCapabilities {
  return new OpenAiProvider({
    apiKey: "offline",
    model,
    ...(baseUrl !== undefined && { baseUrl }),
  }).capabilities;
}

const COLORS = ["red", "green", "blue"] as const;

export interface ScriptedVision extends LlmProvider {
  /** Every request, deep-copied as it arrived (so tests see exactly what the model saw). */
  readonly seen: LlmRequest[];
}

/** A scripted model that declares `capabilities` and refuses what it did not declare, like every shipped provider. */
export function scriptedVision(
  capabilities: LlmCapabilities,
  name = "ScriptedVision"
): ScriptedVision {
  const seen: LlmRequest[] = [];
  return {
    capabilities,
    seen,
    async complete(request): Promise<LlmResponse> {
      assertRequestSupported(request, capabilities, name); // the line every provider must carry (ADR 0120 D6)
      seen.push(JSON.parse(JSON.stringify(request)) as LlmRequest);
      const asked = request.messages.find((m) => m.role === "user");
      const prompt = textOf(asked?.content ?? "").toLowerCase();
      const answered = request.messages.filter((m) => m.role === "assistant").length;
      if (answered === 0) {
        const toolCalls = [
          ...COLORS.filter((c) => prompt.includes(c)).map((color) => ({
            id: `swatch-${color}`,
            name: "render_swatch",
            input: { color },
          })),
          ...(prompt.includes("attachment")
            ? [{ id: "attach-1", name: "open_attachment", input: { name: "passport-scan" } }]
            : []),
        ];
        return { content: "looking", toolCalls, stopReason: "tool_use" };
      }
      const results = request.messages
        .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
        .filter((p): p is LlmToolResultPart => p.type === "tool_result");
      return { content: describe(results), stopReason: "end_turn" };
    },
  };
}

function describe(results: readonly LlmToolResultPart[]): string {
  return results
    .map((r, i) => {
      const parts: LlmContentPart[] =
        typeof r.content === "string" ? [{ type: "text", text: r.content }] : r.content;
      const image = parts.find((p) => p.type === "image");
      if (image?.type === "image" && image.source.kind === "data") {
        const facts = readPng(Buffer.from(image.source.data, "base64"));
        return facts
          ? `#${i + 1}: I can see a ${facts.width}x${facts.height} image, rgb(${facts.rgb.join(",")})`
          : `#${i + 1}: an image I could not decode`;
      }
      if (r.isError === true) return `#${i + 1}: that attachment was unavailable to me`;
      return `#${i + 1}: (text only) ${textOf([r]).slice(0, 140)}`;
    })
    .join("; ");
}
