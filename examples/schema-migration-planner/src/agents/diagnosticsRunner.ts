import { agentLoop$, createAgentModelEffect } from "@loom/agent";
import { type EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { type LlmProvider, type LlmRequest, type LlmResponse, textOf, toParts } from "@loom/llm";
import type { ExecutionContext } from "@loom/workflow-runtime";
import { SchemaInspectorAgent } from "./definitions";
import { inspectTable } from "./tools";

// A scripted provider that drives a real two-turn ReAct loop: first the model
// asks to call the inspect-table tool, then it reasons over the result and
// answers. Isolated here so the loop is deterministic while still exercising the
// genuine agentLoop$ code path (one durable frame per model call and per tool call).
//
// STATELESS on purpose. The loop is replayed from the event log, and the model
// effect may be re-invoked after a recovery, so the script decides its turn from
// the transcript it is handed (is the LAST message a tool_result?) rather than from
// a counter on the instance, which would drift across executions and replays.
class SchemaInspectorScript implements LlmProvider {
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const last = request.messages[request.messages.length - 1];
    const sawToolResult =
      last !== undefined && toParts(last.content).some((p) => p.type === "tool_result");
    if (!sawToolResult) {
      const target = readTarget(request);
      return {
        content: "Inspecting the table before I recommend a migration approach.",
        toolCalls: [{ id: "call-1", name: "inspect-table", input: { target } }],
        stopReason: "tool_use",
      };
    }
    return {
      content:
        "The orders table holds ~40M rows (48 GB) with 3 indexes and 2 FK constraints, under " +
        "~1200 writes/sec. A blocking ALTER would hold a write lock for the full rewrite (~7 min) " +
        "— unacceptable on a hot table. This needs an online, chunked, or dual-write strategy.",
      stopReason: "end_turn",
    };
  }
}

function readTarget(request: LlmRequest): string {
  const match = /target[^a-z0-9]*([a-z0-9-]+)/i.exec(
    request.messages.map((m) => textOf(m.content)).join(" ")
  );
  return match?.[1] ?? "orders";
}

/** Effect id the loop's model call resolves to (the protection ring covers it). */
export const SCHEMA_INSPECTOR_MODEL_ID = "schema-inspector-model";

// agentLoop$ resolves the model call and every tool call through the flow's OWN
// EffectRuntime (one journaled frame each), so the app registers them there at
// composition time: `defineConfig({ registerEffects: registerSchemaInspectorEffects })`.
export function registerSchemaInspectorEffects(effects: EffectRuntime): void {
  effects.register(SCHEMA_INSPECTOR_MODEL_ID, createAgentModelEffect(new SchemaInspectorScript()));
  effects.register(
    "inspect-table",
    new ToolEffect(async (input: unknown) => inspectTable((input as { target: string }).target))
  );
}

export interface SchemaAnalysis {
  summary: string;
  stats: {
    rowCount: number;
    sizeGb: number;
    indexes: number;
    fkConstraints: number;
    writeQps: number;
  };
  iterations: number;
  toolCalls: number;
}

// Runs the schema-inspector agent's ReAct loop for a target table, FROM a flow's runner
// body. Each model call and tool call is a durable frame in the flow's own log, so a
// crash mid-loop resumes at the next turn instead of re-running the whole agent.
export async function runSchemaInspectorAgent(
  target: string,
  ctx: ExecutionContext
): Promise<SchemaAnalysis> {
  const output = await agentLoop$(
    ctx,
    {
      definition: SchemaInspectorAgent,
      modelToolId: SCHEMA_INSPECTOR_MODEL_ID,
      systemPrompt:
        "You are a senior database engineer. Inspect the table, then give a crisp migration analysis.",
    },
    { prompt: `Analyze the schema-migration target table ${target}.` }
  );
  const call = output.toolCallLog.find((t) => t.toolName === "inspect-table");
  const stats = (call?.toolOutput as SchemaAnalysis["stats"] | undefined) ?? inspectTable(target);
  return {
    summary: output.content,
    stats,
    iterations: output.iterations,
    toolCalls: output.toolCallLog.length,
  };
}
