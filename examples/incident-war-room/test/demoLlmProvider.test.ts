import type { LlmRequest } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { DemoLlmProvider } from "../src/runtime/DemoLlmProvider";

// R5 (ADR 0120): `LlmMessage.content` is `string | parts`. A provider that joins
// `m.content` directly reads "[object Object]" for a parts message and silently
// classifies off nothing; `textOf` is the reader that works for both.
describe("DemoLlmProvider reads message content through textOf", () => {
  const ask = (content: LlmRequest["messages"][number]["content"]) =>
    new DemoLlmProvider().complete({
      system: "You route requests.",
      messages: [{ role: "user", content }],
    });

  it("routes a goal given as a plain string", async () => {
    expect((await ask("Request: investigate the replica lag")).content).toBe(
      "diagnose-replica-lag"
    );
  });

  it("routes the same goal given as text parts", async () => {
    const parts = [{ type: "text" as const, text: "Request: investigate the replica lag" }];
    expect((await ask(parts)).content).toBe("diagnose-replica-lag");
  });
});
