import {
  type AgentLoopConfig,
  type ToolRanker,
  agentLoop$,
  createAgentModelEffect,
} from "@loom/agent";
import type { EventEnvelope, FlowDefinition, ToolDefinition } from "@loom/core";
import { agent$ } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import type { MappedMcpTool } from "@loom/plugin-mcp";
import { ReplayVM } from "@loom/replay-vm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";
import { ANNOTATIONS } from "./catalog";
import { scriptedModel } from "./model";
import { buildRegistry, buildSkills, lookupCustomer } from "./skills";

export const AGENT_ID = "ops";
export const EXECUTION_ID = "bill-and-close";

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "ops-assistant",
  name: "ops-assistant",
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};

export interface WorldOptions {
  /** The 64 MCP tools, mapped by `@loom/plugin-mcp` (`origin: "remote"`). */
  mcp: MappedMcpTool[];
  /** A custom ranker for tools: switches search into two-ranker mode. Absent: built-in BM25F. */
  ranker?: ToolRanker;
  /** Host vocabulary for the MCP tools. Default: the example's `ANNOTATIONS`. */
  annotations?: Readonly<Record<string, { tags?: readonly string[]; aliases?: readonly string[] }>>;
  /** A log to continue (a crashed run's prefix). Absent: a fresh one. */
  store?: InMemoryAsyncEventStore;
}

/** Everything the host hands the model: what it saw on the wire, and what ran. */
export interface World {
  readonly runtime: WorkflowRuntime;
  readonly store: InMemoryAsyncEventStore;
  readonly requests: LlmRequest[];
  readonly toolRuns: string[];
  readonly warnings: string[];
  readonly catalog: readonly ToolDefinition[];
}

export function buildWorld(o: WorldOptions): World {
  const requests: LlmRequest[] = [];
  const toolRuns: string[] = [];
  const warnings: string[] = [];
  const provider: LlmProvider = {
    async complete(request): Promise<LlmResponse> {
      requests.push(request);
      return scriptedModel.complete(request);
    },
  };

  const skills = buildSkills();
  const effects = new EffectRuntime([], {});
  effects.register("model", createAgentModelEffect(provider));
  const own = [lookupCustomer, ...skills.flatMap((s) => s.tools ?? [])];
  for (const t of own) {
    effects.register(
      t.id,
      new ToolEffect(async (input) => {
        toolRuns.push(t.id);
        return { ran: t.id, input };
      })
    );
  }
  for (const m of o.mcp) effects.register(m.definition.id, m.effect);

  const store = o.store ?? new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore: store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail",
    onWarn: (m) => warnings.push(m),
    scopes: true,
  });

  const catalog = o.mcp.map((m) => m.definition);
  const config: AgentLoopConfig = {
    definition: agent$({ id: AGENT_ID, name: "Ops", tools: [lookupCustomer] }),
    modelToolId: "model",
    systemPrompt: "You are an operations assistant.",
    maxIterations: 8,
    skills: buildRegistry(skills),
    skillSelector: { select: async () => [] }, // nothing preloaded: skills are found, not injected
    skillActivation: { discovery: "search" },
    toolSearch: {
      catalog,
      annotations: o.annotations ?? ANNOTATIONS,
      ...(o.ranker !== undefined && { ranker: o.ranker }),
    },
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx) =>
    agentLoop$(ctx, config, { prompt: "Bill Acme for the March invoice, then close the month." });
  runtime.registerFlow(flowDef, runner);
  return { runtime, store, requests, toolRuns, warnings, catalog };
}

export async function run(w: World) {
  return (await w.runtime.start(flowDef, {}, { executionId: EXECUTION_ID })).waitForCompletion();
}

/** Resume from a crashed log: the runtime re-folds it and continues. */
export async function resume(w: World, prefix: readonly EventEnvelope[]) {
  const folded = new ReplayVM([...prefix], {
    executionId: EXECUTION_ID,
    workflowId: flowDef.id,
    workflowVersion: flowDef.version,
  }).getState();
  return (await w.runtime.restoreFromState(folded)).waitForCompletion();
}

/** The log as it stood just before the step/decision whose id starts with `at` (a crash there). */
export async function crashBefore(
  full: readonly EventEnvelope[],
  at: string
): Promise<InMemoryAsyncEventStore> {
  const cut = full.findIndex((e) => {
    const p = e.payload as { stepId?: string; decisionId?: string };
    return String(p.stepId ?? p.decisionId ?? "").startsWith(at);
  });
  if (cut <= 0) throw new Error(`no event for ${at} in the log`);
  const crashed = new InMemoryAsyncEventStore();
  for (const e of full.slice(0, cut)) await crashed.append(e);
  return crashed;
}

export const decisionsOf = (events: readonly EventEnvelope[]) =>
  events
    .filter((e) => e.eventType === "DECISION_RECORDED")
    .map((e) => e.payload as { decisionId: string; source?: string; choice: unknown });
