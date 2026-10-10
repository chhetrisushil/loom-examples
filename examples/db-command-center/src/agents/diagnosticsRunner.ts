import { agentLoop$, createAgentModelEffect } from "@loom/agent";
import { type EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { type LlmProvider, type LlmRequest, type LlmResponse, textOf, toParts } from "@loom/llm";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { DiagnosticsAgent } from "./definitions";
import { fetchMetrics } from "./tools";

// A scripted provider that drives a real two-turn ReAct loop: first the model
// asks to call the db-metrics tool, then it reasons over the result and answers.
// Isolated here so the loop is deterministic while still exercising the genuine
// agentLoop$ code path (one durable frame per model call and per tool call).
//
// STATELESS on purpose. The loop is replayed from the event log, and the model
// effect may be re-invoked after a recovery, so the script decides its turn from
// the transcript it is handed (is the LAST message a tool_result?) rather than from
// a counter on the instance, which would drift across executions and replays.
class DiagnosticsScript implements LlmProvider {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const last = request.messages[request.messages.length - 1];
    const sawToolResult =
      last !== undefined && toParts(last.content).some((p) => p.type === "tool_result");
    if (!sawToolResult) {
      const target = readTarget(request);
      return {
        content: "Pulling live metrics before I commit to a root cause.",
        toolCalls: [{ id: "call-1", name: "db-metrics", input: { target } }],
        stopReason: "tool_use",
      };
    }
    return {
      content:
        "CPU is pinned at 91% with the connection pool fully saturated (200/200). Queued " +
        "queries are spinning on lock acquisition — classic connection-pool starvation. " +
        "Recommend recycling the pool and raising its ceiling.",
      stopReason: "end_turn",
    };
  }
}

function readTarget(request: LlmRequest): string {
  const match = /target[^a-z0-9]*([a-z0-9-]+)/i.exec(
    request.messages.map((m) => textOf(m.content)).join(" ")
  );
  return match?.[1] ?? "prod-postgres";
}

/** Effect id the loop's model call resolves to (the protection ring covers it). */
export const DIAGNOSTICS_MODEL_ID = "diagnostics-model";

// agentLoop$ resolves the model call and every tool call through the flow's OWN
// EffectRuntime (one journaled frame each), so the app registers them there at
// composition time: `defineConfig({ registerEffects: registerDiagnosticsEffects })`.
export function registerDiagnosticsEffects(effects: EffectRuntime): void {
  effects.register(DIAGNOSTICS_MODEL_ID, createAgentModelEffect(new DiagnosticsScript()));
  effects.register(
    "db-metrics",
    new ToolEffect(async (input: unknown) => fetchMetrics((input as { target: string }).target))
  );
}

export interface DiagnosticsResult {
  rootCause: string;
  metrics: { cpuPct: number; memPct: number; poolUsed: number; poolMax: number; qps: number };
  iterations: number;
  toolCalls: number;
}

// Runs the diagnostics agent's ReAct loop for a target, FROM a flow's runner body.
// Each model call and tool call is a durable frame in the flow's own log, so a crash
// mid-loop resumes at the next turn instead of re-running the whole agent.
export async function runDiagnosticsAgent(
  target: string,
  ctx: ExecutionContext
): Promise<DiagnosticsResult> {
  const output = await agentLoop$(
    ctx,
    {
      definition: DiagnosticsAgent,
      modelToolId: DIAGNOSTICS_MODEL_ID,
      systemPrompt:
        "You are a senior database SRE. Use the metrics tool, then give a crisp root cause.",
    },
    { prompt: `Diagnose the performance incident on target ${target}.` }
  );
  const metricsCall = output.toolCallLog.find((t) => t.toolName === "db-metrics");
  const metrics =
    (metricsCall?.toolOutput as DiagnosticsResult["metrics"] | undefined) ?? fetchMetrics(target);
  return {
    rootCause: output.content,
    metrics,
    iterations: output.iterations,
    toolCalls: output.toolCallLog.length,
  };
}
