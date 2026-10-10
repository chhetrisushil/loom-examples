import {
  type AgentOutput,
  SkillRegistry,
  agentLoop$,
  createAgentModelEffect,
  memoryWriteBackEffect,
} from "@loom/agent";
import { defineConfig } from "@loom/app";
import { CapabilityCatalog } from "@loom/capability";
import { agent$, flow$, handler$, instructions$, skill$, step$ } from "@loom/core";
import { IntentRuntime } from "@loom/intent";
import { InMemoryMemoryStore, TieredMemory } from "@loom/memory";
import { PlannerRuntime } from "@loom/planner";
import { createA2AClientEffect, createA2AServer, toAgentCard } from "@loom/plugin-a2a";
import { McpClient } from "@loom/plugin-mcp";
import { TerminalRenderer } from "@loom/plugin-renderer-terminal";
import { AgentRegistry } from "@loom/registry";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
/**
 * Agent Network — a server-side showcase of Loom's agentic capabilities.
 *
 * Demonstrates, end to end and fully offline:
 *   1. Configurable LLM      — swap ScriptedLlmProvider for AnthropicProvider/OpenAiProvider
 *   2. Bring-your-own agent  — agent$() + agentLoop$ ReAct loop over your tools
 *   3. MCP servers/tools     — McpClient discovers tools and registers them as effects
 *   4. A2A out of the box    — expose a flow as an A2A agent, then call it as a client
 *   5. Capabilities + Intent — a catalog of capabilities, routed to by intent (not routes)
 *   6. Planner               — turn a goal into an ordered capability plan
 *   7. Agent memory          — an agent that recalls prior turns
 *   8. Multi-surface         — render one blueprint to the terminal surface
 *
 * Run with:  pnpm --filter @loom/agent-network start
 */
import { z } from "zod";
import { ScriptedLlmProvider, plainUserMessages } from "./ScriptedLlmProvider";
import { incidentBlueprint, investigateCapability, scaleCapability } from "./capabilities";
import { startFakeMcpServer } from "./fakeMcpServer";

/** Demo-only shared secret for the inbound A2A server; a real deployment verifies a signed token. */
const DEMO_TOKEN = "demo-a2a-token";

function section(title: string): void {
  console.log(`\n${"─".repeat(64)}\n  ${title}\n${"─".repeat(64)}`);
}

async function main(): Promise<void> {
  // The agent loop (agentLoop$) runs FROM a flow's runner body, so it needs a WorkflowRuntime;
  // its model call and every tool call (the MCP tools below) resolve through this app's
  // EffectRuntime, one journaled frame each. The A2A-fronted service and the capability app
  // further down are separate defineConfig roots.
  const agentApp = defineConfig({ storage: { kind: "memory" } });
  const effectRuntime = agentApp.effectRuntime;

  // ══ 1. Configurable LLM ═════════════════════════════════════════════════════
  // The provider is the only place the model is chosen. Everything else is
  // provider-agnostic. Here we script it so the demo is deterministic; in
  // production this line becomes `new AnthropicProvider({ model: "claude-opus-4-8" })`.
  section("1. Configurable LLM provider");
  const provider = new ScriptedLlmProvider([
    {
      content: "I'll consult the runbook for the CPU spike.",
      toolCalls: [{ id: "c1", name: "kb-lookup", input: { topic: "database CPU spike" } }],
      stopReason: "tool_use",
    },
    {
      content:
        "Per runbook RB-204, restart the pod and scale the connection pool. " +
        "Root cause is connection-pool starvation.",
      stopReason: "end_turn",
    },
  ]);
  console.log("Provider ready (ScriptedLlmProvider — swap for AnthropicProvider to go live).");

  // ══ 3. MCP servers/tools ════════════════════════════════════════════════════
  // Connect to an MCP server, discover its tools, and register them as effects.
  // The agent can then call them by name like any other tool.
  section("3. MCP tool discovery");
  const mcp = await startFakeMcpServer();
  const mcpClient = new McpClient({ transport: "http", url: mcp.url });
  await mcpClient.connect();
  const mcpDefs = await mcpClient.registerInto(effectRuntime);
  console.log(`Discovered ${mcpDefs.length} MCP tool(s):`, mcpDefs.map((d) => d.id).join(", "));

  // ══ 2. Bring-your-own agent ═════════════════════════════════════════════════
  // Define an agent over the discovered tools and run the ReAct loop. The agent
  // reasons, calls the MCP tool, then produces a final answer.
  section("2. Agent ReAct loop (LLM + MCP tools)");
  // Card metadata (version/capabilities/skills) lives on the agent$ definition,
  // so the AgentCard is derived — not hand-authored — via toAgentCard below.
  const opsAgent = agent$({
    id: "ops-agent",
    name: "Ops Triage Agent",
    description: "Triages infrastructure incidents using runbooks",
    tools: mcpDefs,
    version: "1.0.0",
    capabilities: { streaming: false },
    skills: [{ id: "triage", name: "Incident Triage" }],
  });

  const registry = new AgentRegistry();
  registry.register(opsAgent, toAgentCard(opsAgent));

  // Skills — progressively-disclosed expertise. Only the description sits in
  // context by default; the runbook body is loaded on demand when the incident
  // prompt selects it (deterministic selection here → replay-safe). The
  // instructions$ marker is what the @loom/compiler would extract into a lazy
  // chunk; run under tsx it stays inline, and loadInstructions resolves either.
  const skills = new SkillRegistry().register(
    skill$({
      id: "cpu-saturation-runbook",
      name: "CPU Saturation Runbook",
      description: "Resolve database CPU saturation and connection-pool exhaustion",
      tags: ["cpu", "connections", "pool", "database"],
      instructions: instructions$(
        [
          "CPU Saturation Runbook:",
          "1. Confirm CPU% and pool utilisation via the metrics tool before acting.",
          "2. If the pool is exhausted, recycle it and raise the ceiling — graceful and reversible.",
          "3. Only scale replicas if CPU stays high after the pool recovers.",
        ].join("\n")
      ),
    })
  );

  effectRuntime.register("ops-model", createAgentModelEffect(provider));
  const opsFlow = flow$({
    id: "ops-agent-run",
    name: "Ops agent run",
    version: "1.0.0",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ content: z.string() }).passthrough(),
    steps: [],
  });
  agentApp.runtime.registerFlow(opsFlow, (async (ctx, input: { prompt: string }) =>
    agentLoop$(
      ctx,
      {
        definition: opsAgent,
        modelToolId: "ops-model",
        systemPrompt: "You are an SRE. Use the runbook tools to resolve incidents.",
        skills,
      },
      { prompt: input.prompt }
    )) as FlowRunner<unknown, unknown>);

  const opsRun = await agentApp.runtime.start(
    opsFlow,
    { prompt: "The primary database is at 87% CPU and connections are exhausted. What do I do?" },
    { executionId: "demo" }
  );
  const agentOutput = (await opsRun.waitForCompletion()).variables._output as AgentOutput;
  // agentLoop$ emits no SKILLS_SELECTED event: the selection is a recorded decision in the log.
  const selectedSkills = (await agentApp.stores.eventStore.read("demo"))
    .filter((e) => e.eventType === "DECISION_RECORDED")
    .map((e) => e.payload as { decisionId: string; choice: unknown })
    .filter((d) => d.decisionId.endsWith("#skills"))
    .flatMap((d) => d.choice as string[]);
  console.log(`Skills loaded on demand: ${selectedSkills.join(", ") || "(none)"}`);
  console.log(
    `Agent used ${agentOutput.toolCallLog.length} tool call(s) over ${agentOutput.iterations} iteration(s).`
  );
  console.log("Agent answer:", agentOutput.content);

  // ══ 4. A2A out of the box ═══════════════════════════════════════════════════
  // Expose a Loom flow as an A2A agent, then call it from a client effect. This
  // is how two Loom services (or a Loom service and any A2A-compatible agent)
  // talk to each other over the wire.
  section("4. A2A server + client");

  const triageStep = step$({
    id: "triage",
    name: "Triage",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    handler: handler$(async (input: { prompt: string }) => ({
      reply: `Triage complete for: "${input.prompt}". Recommended: restart pod, scale pool.`,
    })),
  });
  const triageRunner: FlowRunner<{ prompt: string }, { reply: string }> = (ctx, input) =>
    ctx.run(triageStep, { prompt: input.prompt });
  const triageFlow: RegisteredFlow = {
    definition: flow$({
      id: "triage-flow",
      name: "Triage Flow",
      version: "1.0.0",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ reply: z.string() }),
      steps: [triageStep],
    }),
    runner: triageRunner as FlowRunner<unknown, unknown>,
  };

  // Composition root for the A2A-fronted service: defineConfig assembles the
  // in-memory stores, an EffectRuntime, a projection runtime, and the
  // WorkflowRuntime, and registers the triage flow declaratively.
  const serverApp = defineConfig({
    storage: { kind: "memory" },
    flows: [triageFlow],
  });

  // The A2A-fronted agent is a first-class agent$ too; toAgentCard derives its
  // card and createA2AServer overwrites url with the bound address.
  const triageAgent = agent$({
    id: "triage-agent",
    name: "Triage Agent",
    description: "Exposes the triage flow over A2A",
    tools: [],
    version: "1.0.0",
    capabilities: { streaming: false },
    skills: [{ id: "triage", name: "Incident Triage" }],
  });
  const server = createA2AServer(serverApp.runtime, triageFlow, toAgentCard(triageAgent), {
    port: 0,
    // R12: a server refuses to start unauthenticated. `authenticate` both admits the caller and
    // says WHO it is (the principal's `actor` scopes task ownership). A real deployment verifies
    // a signed token or mTLS peer; this demo accepts one shared bearer token.
    authenticate: (req) =>
      req.headers.authorization === `Bearer ${DEMO_TOKEN}` ? { actor: "demo-client" } : undefined,
  });
  await server.start();
  console.log(`A2A agent card: ${server.url}/.well-known/agent.json`);

  // The client is just another effect — call the remote agent by URL.
  const a2aEffect = createA2AClientEffect(server.url, {
    pollIntervalMs: 50,
    headers: { authorization: `Bearer ${DEMO_TOKEN}` },
  });
  const result = await a2aEffect.execute(
    { id: "task-1", message: { role: "user", parts: [{ type: "text", text: "DB at 87% CPU" }] } },
    { executionId: "demo", stepId: "call", workflowId: "demo", attempt: 1, emit: () => {} }
  );
  console.log(`A2A task status: ${result.status}`);
  console.log("A2A reply:", result.artifacts?.[0]?.parts[0]?.text);

  // ══ 5. Capabilities + Intent (Intent Over Routes) ═══════════════════════════
  // Build a catalog of capabilities, then let the Intent Runtime route a plain
  // English request to the right one — no routes, no switch statements.
  section("5. Capability catalog + Intent routing");
  const catalog = new CapabilityCatalog().register(investigateCapability).register(scaleCapability);

  // Composition root for the app: defineConfig registers the catalog's flows,
  // stands up the "ui" A2UI surface on its projection runtime, and wires
  // onEvent → projection folding for us (no manual handleEvent plumbing).
  const app = defineConfig({
    storage: { kind: "memory" },
    catalog,
    surfaces: ["ui"],
  });

  // No provider passed → deterministic keyword routing (works fully offline).
  const intent = new IntentRuntime({ catalog, workflowRuntime: app.runtime });
  const request = "the prod-postgres database has high CPU, please investigate";
  const route = await intent.route(request);
  console.log(`Request: "${request}"`);
  console.log(`Routed to capability: ${route?.capability.id} (${route?.rationale})`);

  const handle = await intent.run(request, { target: "prod-postgres" });
  await handle.waitForCompletion();
  console.log("Capability executed via IntentRuntime.run().");

  // ══ 6. Planner (goal → ordered capability plan) ═════════════════════════════
  section("6. Planner");
  const planner = new PlannerRuntime({ catalog });
  const plan = await planner.plan("investigate the incident then scale the cluster");
  console.log("Goal:", plan.goal);
  for (const [i, planStep] of plan.steps.entries()) {
    console.log(`  ${i + 1}. ${planStep.capabilityId} — ${planStep.rationale}`);
  }

  // ══ 7. Agent memory (recall across turns) ═══════════════════════════════════
  section("7. Agent memory");
  const memory = new TieredMemory({
    store: new InMemoryMemoryStore(),
    tiers: { chat: { maxEntries: 20 } },
  });
  const chatAgent = agent$({ id: "chat-agent", name: "Chat Agent", tools: [] });
  const chatProvider = new ScriptedLlmProvider(
    [
      { content: "Noted — your cluster is prod-postgres.", stopReason: "end_turn" },
      { content: "Your cluster is prod-postgres.", stopReason: "end_turn" },
    ], // Shared by two executions: the second one's transcript carries the recalled first turn.
    (request) => (plainUserMessages(request) > 1 ? 1 : 0)
  );
  effectRuntime.register("chat-model", createAgentModelEffect(chatProvider));
  const MEMORY_WRITE_BACK_ID = "memory-write-back";
  agentApp.effectRuntime.register(MEMORY_WRITE_BACK_ID, memoryWriteBackEffect(memory));
  const chatFlow = flow$({
    id: "chat-agent-run",
    name: "Chat agent run",
    version: "1.0.0",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ content: z.string() }).passthrough(),
    steps: [],
  });
  agentApp.runtime.registerFlow(chatFlow, (async (ctx, input: { prompt: string }) =>
    agentLoop$(
      ctx,
      {
        definition: chatAgent,
        modelToolId: "chat-model",
        // Recall the user's prior turns from the "chat" tier, and write this turn back to it.
        // Two EXECUTIONS share one scope ("user-1"), so the second run remembers the first.
        memory,
        memoryTier: "chat",
        memoryScope: "user-1",
        // The write-back goes through the effect ring (ADR 0121 D4): it is a journaled
        // ctx.execute against memoryWriteBackEffect(memory), registered above, so authorization,
        // tenant checks and the kill switch apply and a replay serves the write.
        writeBack: { toolId: MEMORY_WRITE_BACK_ID },
      },
      { prompt: input.prompt }
    )) as FlowRunner<unknown, unknown>);
  const chatTurn = async (id: string, prompt: string): Promise<AgentOutput> => {
    const run = await agentApp.runtime.start(chatFlow, { prompt }, { executionId: id });
    return (await run.waitForCompletion()).variables._output as AgentOutput;
  };
  await chatTurn("chat-1", "My cluster is prod-postgres");
  const recalled = await chatTurn("chat-2", "Which cluster did I mention?");
  console.log("Second-turn answer (with recall):", recalled.content);
  console.log("Remembered turns:", (await memory.recall("chat", "user-1")).length);

  // ══ 8. Multi-surface (render the same blueprint to the terminal) ════════════
  section("8. Terminal surface");
  const terminal = new TerminalRenderer(app.projectionRuntime);
  console.log(terminal.render(incidentBlueprint, handle.executionId));

  // ══ Cleanup ═════════════════════════════════════════════════════════════════
  await server.stop();
  await mcpClient.disconnect();
  await mcp.close();
  await serverApp.close();
  await app.close();
  await agentApp.close();
  section("Done — full agentic pipeline demonstrated offline.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
