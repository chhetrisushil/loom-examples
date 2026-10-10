import {
  type AgentLoopConfig,
  agentLoop$,
  memoryWriteBackEffect,
  registerReasoningRoutes,
} from "@loom/agent";
import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmRequest } from "@loom/llm";
import { InMemoryMemoryStore, TieredMemory } from "@loom/memory";
import { QuotaExceededError } from "@loom/middleware";
import { ReasoningRuntime } from "@loom/reasoning";
import type { ReasoningCache } from "@loom/reasoning";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, answerApproval } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";
import { DEEP, FAST, routeProvider, triageRouter } from "./model";

const mk = (id: string, description: string) =>
  tool$({
    id,
    name: id,
    description,
    kind: "tool",
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
  });

export const TOOLS = [
  mk("lookup_customer", "Find the customer record"),
  mk("lookup_order", "Find an order"),
  mk("carrier_status", "Ask the carrier's tracking API (flaky)"),
  mk("check_refund_budget", "Check today's refund budget"),
  mk("issue_refund", "Refund an order (destructive: needs a human)"),
] as const;

export const FLOW_ID = "triage";
export const MEMORY_SCOPE = "customer:ada"; // memory is per CUSTOMER, so ticket 2 sees ticket 1
export const MEMORY_TOOL = "memwrite";

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: FLOW_ID,
  name: FLOW_ID,
  version: "1.0.0",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  steps: [],
};

/**
 * Everything OUTSIDE the agent, which survives a process restart: the downstream systems (with
 * their call counters), the event log, and the memory store. A "process" is a `boot()` over this.
 */
export class Backend {
  readonly store: InMemoryAsyncEventStore;
  constructor(store: InMemoryAsyncEventStore = new InMemoryAsyncEventStore()) {
    this.store = store;
  }
  readonly memory = new TieredMemory({
    store: new InMemoryMemoryStore(),
    tiers: { working: { maxEntries: 100 } },
  });
  /** Live executions of each tool, across every process. */
  readonly runs: Record<string, number> = {};
  /** Model calls that reached each route's provider, across every process. */
  readonly modelCalls: Record<string, number> = {};
  /** The carrier API fails this many more times, then recovers (a transient fault). */
  carrierFailures = 1;
  /** Records the refunds actually issued. */
  readonly refunds: unknown[] = [];
}

export interface BootOptions {
  backend: Backend;
  /** The ticket text. */
  prompt: string;
  /** Overrides on the agent config (a config-error act replaces `writeBack`, adds a cache, ...). */
  config?: Partial<AgentLoopConfig>;
  /** Route model calls through the ring. Default true; false = the direct (un-ringed) path. */
  ring?: boolean;
  /** Tool ids the flow is granted. Default: every tool, both models and the memory write. */
  grants?: string[];
  /** A response cache for the DIRECT path (needs `cacheScope`). */
  cache?: ReasoningCache;
  /** Simulate a fork / simulation: the default `writeBack.unless` returns true (skip the write). */
  fork?: boolean;
  /** Pre-ringed memory write-back is the default; `none` leaves `writeBack` unset. */
  writeBack?: AgentLoopConfig["writeBack"];
}

export interface Process {
  readonly runtime: WorkflowRuntime;
  readonly requests: LlmRequest[];
  /** Tools executed live by THIS process. */
  readonly toolRuns: string[];
  readonly warnings: string[];
  /** Set when `agentLoop$` rejected its own configuration. */
  readonly configErrors: Error[];
}

export const MODEL_GRANTS = [`model:${FAST}`, `model:${DEEP}`];
export const ALL_GRANTS = [...TOOLS.map((t) => t.id), ...MODEL_GRANTS, MEMORY_TOOL];

/** One process: a fresh runtime and effect registry over the shared backend. */
export function boot(o: BootOptions): Process {
  const b = o.backend;
  const requests: LlmRequest[] = [];
  const toolRuns: string[] = [];
  const warnings: string[] = [];
  const configErrors: Error[] = [];

  const traced = (id: string) => routeProvider(id, b.modelCalls);
  const wrap = (id: string) => {
    const p = traced(id);
    return {
      ...p,
      async complete(r: LlmRequest) {
        requests.push(r);
        return p.complete(r);
      },
    };
  };
  const reasoning = new ReasoningRuntime({
    routes: [
      { id: FAST, provider: wrap(FAST), tier: 0 },
      { id: DEEP, provider: wrap(DEEP), tier: 2 },
    ],
    router: triageRouter,
    ...(o.cache !== undefined && { cache: o.cache }),
  });

  const effects = new EffectRuntime([], {
    authorizer: new GrantTable({ [FLOW_ID]: o.grants ?? ALL_GRANTS }),
  });
  const toolIdFor = registerReasoningRoutes(effects, reasoning); // model:<route id>
  const impl: Record<string, (input: unknown) => Promise<unknown>> = {
    lookup_customer: async () => ({ id: "cus_ada", name: "Ada", plan: "pro" }),
    lookup_order: async () => ({ order: 1042, item: "desk lamp", price: 49, status: "delivered" }),
    carrier_status: async () => {
      if (b.carrierFailures > 0) {
        b.carrierFailures--;
        throw new Error("503 from the carrier tracking API");
      }
      return { order: 1042, scan: "delivered, box crushed" };
    },
    check_refund_budget: async () => {
      throw new QuotaExceededError("daily refund budget exhausted (50 requested, 10 left)");
    },
    issue_refund: async (input) => {
      b.refunds.push(input);
      return { refunded: true, ...(input as object) };
    },
  };
  for (const t of TOOLS) {
    effects.register(
      t.id,
      new ToolEffect(async (input) => {
        toolRuns.push(t.id);
        b.runs[t.id] = (b.runs[t.id] ?? 0) + 1;
        return (impl[t.id] as (i: unknown) => Promise<unknown>)(input);
      })
    );
  }
  effects.register(MEMORY_TOOL, memoryWriteBackEffect(b.memory));

  const runtime = new WorkflowRuntime({
    eventStore: b.store,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    divergence: "fail", // a resume that re-asks anything it should have served is a loud error
    onWarn: (m) => warnings.push(m),
    scopes: true, // parallelTools runs in a ctx.parallel scope
  });

  const ring = o.ring !== false;
  const config: AgentLoopConfig = {
    definition: agent$({ id: "triage-agent", name: "Triage", tools: [...TOOLS] }),
    reasoning,
    ...(ring && { reasoningToolId: toolIdFor }),
    systemPrompt: "You triage support tickets. Look the order up before you refund it.",
    maxIterations: 6,
    parallelTools: true,
    // The policy answers "may this call proceed on its own?": `false` PARKS for a human. (Despite
    // the name `requireApproval`, returning `true` means NO approval is required.)
    requireApproval: (c) => c.name !== "issue_refund",
    memory: b.memory,
    memoryScope: MEMORY_SCOPE,
    // ADR 0121 D4: through the ring (`toolId`) so the write is authorized and journaled, and
    // `unless` so a forked / simulated execution does not write. (`allowDirect: true` is the
    // explicit opt-out for a single-tenant host that wants neither.)
    writeBack: o.writeBack ?? { toolId: MEMORY_TOOL, unless: () => o.fork === true },
    ...o.config,
  };
  const runner: FlowRunner<unknown, unknown> = async (ctx) => {
    try {
      return await agentLoop$(ctx, config, { prompt: o.prompt });
    } catch (e) {
      if (e instanceof Error && e.name === "AgentLoopConfigError") {
        configErrors.push(e);
        return { configError: e.message };
      }
      throw e;
    }
  };
  runtime.registerFlow(flowDef, runner);
  return { runtime, requests, toolRuns, warnings, configErrors };
}

export interface RunOutput {
  content?: string;
  toolCallLog?: { toolName: string; toolOutput: unknown }[];
  configError?: string;
}
export const outputOf = (state: { variables: Record<string, unknown> }) =>
  state.variables._output as RunOutput;

export async function start(p: Process, executionId: string) {
  return p.runtime.start(flowDef, {}, { executionId });
}

export interface SettledOptions {
  /** Give up after this long (default 10 s). A stuck execution must fail loudly, not hang. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll until `executionId` has left `running` (a failure is flushed asynchronously). Bounded: on
 * the deadline or an abort it throws, naming the execution's status.
 */
export async function settled(p: Process, executionId: string, opts: SettledOptions = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const s = await p.runtime.loadState(executionId);
    if (s !== null && s.status !== "running") return s;
    const why =
      opts.signal?.aborted === true
        ? "aborted"
        : Date.now() >= deadline
          ? `not settled within ${opts.timeoutMs ?? 10_000}ms`
          : undefined;
    if (why !== undefined) {
      throw new Error(`execution ${executionId} ${why} (status: ${s?.status ?? "no state"})`);
    }
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A ticket from start to end (or to its failure). */
export async function runTicket(p: Process, executionId: string) {
  await start(p, executionId);
  return settled(p, executionId);
}

/** Resume a parked execution with an approval, in whatever process `p` is. */
export async function approve(p: Process, executionId: string, approved = true) {
  const parked = await p.runtime.loadState(executionId);
  if (parked === null) throw new Error(`no state for ${executionId}`);
  const handle = await p.runtime.resume(executionId, answerApproval(parked, { approved }));
  return handle.waitForCompletion();
}

export const decisionsOf = (events: readonly EventEnvelope[]) =>
  events
    .filter((e) => e.eventType === "DECISION_RECORDED")
    .map((e) => e.payload as { decisionId: string; source?: string; choice: unknown });
