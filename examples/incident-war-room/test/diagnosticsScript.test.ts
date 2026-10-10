import type { LlmRequest } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { DiagnosticsScript } from "../src/agents/diagnosticsRunner";

// The scripted provider decides from the TRAILING message, not from "has any tool_result ever
// appeared", so a transcript that carries an earlier turn's tool result still gets its tool call.
describe("DiagnosticsScript turn detection", () => {
  const earlierTurn: LlmRequest["messages"] = [
    { role: "user", content: "Diagnose target old-db." },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call-0", name: "db-metrics", input: { target: "old-db" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "call-0", content: '{"cpuPct":50}' }],
    },
    { role: "assistant", content: "Earlier answer." },
  ];

  it("calls the tool when an older tool_result sits earlier in the transcript", async () => {
    const res = await new DiagnosticsScript().complete({
      messages: [...earlierTurn, { role: "user", content: "Diagnose target prod-postgres." }],
    });
    expect(res.toolCalls?.[0]?.name).toBe("db-metrics");
  });

  it("answers once the trailing message is the tool_result", async () => {
    const res = await new DiagnosticsScript().complete({
      messages: [
        { role: "user", content: "Diagnose target prod-postgres." },
        ...earlierTurn.slice(1, 3),
      ],
    });
    expect(res.toolCalls).toBeUndefined();
    expect(res.stopReason).toBe("end_turn");
  });
});
