import { toolSpecFor } from "@loom/agent";
import { defineConfig, runAgentOnce } from "@loom/app";
import { agent$, flow$, handler$, step$ } from "@loom/core";
import type { Effect, EffectRuntime } from "@loom/effect-runtime";
import { type LlmProvider, type LlmRequest, type LlmResponse, toParts } from "@loom/llm";
import {
  A2APeerClient,
  createA2AClientEffect,
  createA2AServer,
  toAgentCard,
} from "@loom/plugin-a2a";
import { AgentRegistry } from "@loom/registry";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { startMockExternalAgent } from "./mockExternalAgent";

/**
 * A2A Mesh — using external agent frameworks (Google ADK, LangGraph, CrewAI, …)
 * WITH Loom, as bidirectional peers over the open A2A protocol.
 *
 *   Outbound (Loom → external):  A2APeerClient discovers a remote agent's card
 *                                and registers it as a Loom tool. A Loom agent
 *                                then calls the external agent mid-reasoning.
 *   Inbound  (external → Loom):  createA2AServer exposes a Loom flow over A2A;
 *                                any A2A client (ADK, a LangGraph shim, another
 *                                Loom service) drives it. Here we loop back with
 *                                createA2AClientEffect to prove the contract.
 *
 * The external peer is a mock A2A server (see mockExternalAgent.ts) so the demo
 * runs fully offline; the README shows how to point it at a real ADK/LangGraph
 * endpoint — the Loom-side code does not change.
 *
 * Run with:  pnpm --filter @loom/plugin-a2a-mesh start
 */

/** Demo-only shared secret for the inbound A2A server; a real deployment verifies a signed token. */
const DEMO_TOKEN = "demo-a2a-token";

function section(title: string): void {
  console.log(`\n${"─".repeat(64)}\n  ${title}\n${"─".repeat(64)}`);
}

// Deterministic provider so the ReAct loop is reproducible offline. In
// production this becomes `new AnthropicProvider({ model: "claude-opus-4-8" })`
// (or OpenAiProvider) — the model is pure configuration.
class ScriptedLlmProvider implements LlmProvider {
  constructor(private readonly responses: LlmResponse[]) {}
  // Stateless: the turn is the number of tool-result messages after the last plain user prompt.
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const isResult = (m: LlmRequest["messages"][number]): boolean =>
      toParts(m.content).some((p) => p.type === "tool_result");
    const msgs = request.messages;
    let start = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m !== undefined && m.role === "user" && !isResult(m)) {
        start = i;
        break;
      }
    }
    const turn = msgs.slice(start + 1).filter(isResult).length;
    return this.responses[turn] ?? { content: "(done)", stopReason: "end_turn" };
  }
}

async function main(): Promise<void> {
  // The outbound side is a script-style run: `runAgentOnce` (@loom/app) builds the throwaway in-memory app
  // and one-off flow the agent loop needs, and the model call + every tool call resolve through its
  // EffectRuntime. The peer is discovered up front with `map()` and its effect handed over below.
  const registry = new AgentRegistry();

  // ── The "external" peer (ADK/LangGraph stand-in) ────────────────────────────
  const external = await startMockExternalAgent();
  console.log(`External A2A agent listening at ${external.url}`);

  // ══ Outbound: Loom calls the external agent ═════════════════════════════════
  // Discover the remote agent's card and register it as a first-class Loom tool.
  // Passing the registry also exposes it to the planner/intent layer.
  section("Outbound — Loom agent calls the external peer as a tool");
  const peer = new A2APeerClient({
    url: external.url,
    toolId: "remote-diagnostics",
    pollIntervalMs: 50,
  });
  // runAgentOnce owns the EffectRuntime, and discovery is async while `registerEffects` is sync, so the
  // peer registers into a small collector now and the effects are handed over below.
  const discovered: Array<[string, Effect]> = [];
  const collector = {
    register: (id: string, effect: Effect) => void discovered.push([id, effect]),
  };
  const remoteTool = await peer.registerInto(collector as unknown as EffectRuntime, registry);
  console.log(`Registered remote peer as tool "${remoteTool.id}" (kind: ${remoteTool.kind}).`);
  console.log(`Description the PEER advertised on its card: ${remoteTool.description}`);
  // That text is the peer's, not ours. A2A tools are third-party, so the model-facing spec withholds
  // it unless the operator vouches for the peer (ADR 0125 D14). This is what the model actually sees.
  console.log(`Description the MODEL sees (un-vouched):    ${toolSpecFor(remoteTool).description}`);

  // A peer WE operate ourselves can be vouched for: its card text then reaches the model.
  const vouchedPeer = new A2APeerClient({
    url: external.url,
    toolId: "remote-diagnostics-vouched",
    pollIntervalMs: 50,
    trustDescriptions: true,
  });
  const vouchedTool = (await vouchedPeer.map()).definition;
  console.log(
    `Description the MODEL sees (trustDescriptions: true): ${toolSpecFor(vouchedTool).description}`
  );

  // A local Loom agent whose toolbox includes the remote agent. The scripted
  // provider makes it call the remote tool, then summarize the result.
  const opsAgent = agent$({
    id: "ops-agent",
    name: "Ops Orchestrator",
    description: "Coordinates remediation, delegating diagnosis to a remote agent",
    tools: [remoteTool],
  });

  const provider = new ScriptedLlmProvider([
    {
      content: "This looks like a database incident — I'll ask the diagnostics agent.",
      toolCalls: [
        {
          id: "call-1",
          name: "remote-diagnostics",
          input: { prompt: "prod-postgres at 92% CPU, connections exhausted" },
        },
      ],
      stopReason: "tool_use",
    },
    {
      content:
        "The remote agent diagnosed connection-pool exhaustion. Recycling the pool " +
        "and raising its ceiling; will scale replicas only if CPU stays high.",
      stopReason: "end_turn",
    },
  ]);

  const ops = await runAgentOnce({
    agent: opsAgent,
    provider,
    registerEffects: (effects) => {
      for (const [id, effect] of discovered) effects.register(id, effect);
    },
    input: "prod-postgres is at 92% CPU and connections are exhausted. Remediate.",
    loop: { systemPrompt: "You are an SRE orchestrator. Delegate diagnosis to your tools." },
    executionId: "mesh-demo",
  });
  const agentOutput = ops.output;
  if (agentOutput === undefined) throw new Error(`ops agent did not complete (${ops.status})`);

  const remoteCall = agentOutput.toolCallLog.find((c) => c.toolName === "remote-diagnostics");
  console.log("\nRemote agent replied:");
  console.log(
    `  ${(remoteCall?.toolOutput as { content?: string } | undefined)?.content ?? "(none)"}`
  );
  console.log("\nLoom agent's final answer:");
  console.log(`  ${agentOutput.content}`);

  // ══ Inbound: the external world calls a Loom agent ══════════════════════════
  // Expose a Loom flow over A2A. Any A2A client — ADK, a LangGraph shim, or
  // another Loom service — can now drive it. We loop back with a client effect.
  section("Inbound — external client drives a Loom agent over A2A");

  const remediateStep = step$({
    id: "remediate",
    name: "Remediate",
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ reply: z.string() }),
    handler: handler$(async (input: { prompt: string }) => ({
      reply: `Loom remediation for "${input.prompt}": pool recycled, ceiling raised, incident resolved.`,
    })),
  });
  const remediateRunner: FlowRunner<{ prompt: string }, { reply: string }> = (ctx, input) =>
    ctx.run(remediateStep, { prompt: input.prompt });
  const remediateFlow: RegisteredFlow = {
    definition: flow$({
      id: "remediate-flow",
      name: "Remediate Flow",
      version: "1.0.0",
      inputSchema: z.object({ prompt: z.string() }),
      outputSchema: z.object({ reply: z.string() }),
      steps: [remediateStep],
    }),
    runner: remediateRunner as FlowRunner<unknown, unknown>,
  };

  // Composition root for the inbound A2A server: defineConfig assembles the
  // in-memory stores, EffectRuntime, projection runtime, and WorkflowRuntime,
  // and registers the remediation flow. It is a separate app from the outbound one above.
  const app = defineConfig({
    storage: { kind: "memory" },
    flows: [remediateFlow],
  });

  const remediateAgent = agent$({
    id: "remediation-agent",
    name: "Remediation Agent",
    description: "Exposes the Loom remediation flow over A2A",
    tools: [],
    version: "1.0.0",
    capabilities: { streaming: false },
    skills: [{ id: "remediate", name: "Remediate" }],
  });
  const server = createA2AServer(app.runtime, remediateFlow, toAgentCard(remediateAgent), {
    port: 0,
    // R12: a server refuses to start unauthenticated. `authenticate` both admits the caller and
    // says WHO it is (the principal's `actor` scopes task ownership). A real deployment verifies
    // a signed token or mTLS peer; this demo accepts one shared bearer token.
    authenticate: (req) =>
      req.headers.authorization === `Bearer ${DEMO_TOKEN}` ? { actor: "demo-client" } : undefined,
  });
  await server.start();
  console.log(`Loom agent card served at ${server.url}/.well-known/agent.json`);

  // The "external framework" calling in — here, a plain A2A client effect.
  const inbound = createA2AClientEffect(server.url, {
    pollIntervalMs: 50,
    headers: { authorization: `Bearer ${DEMO_TOKEN}` },
  });
  const result = await inbound.execute(
    {
      id: "task-in-1",
      message: { role: "user", parts: [{ type: "text", text: "connection-pool exhaustion" }] },
    },
    {
      executionId: "mesh-demo",
      stepId: "call-in",
      workflowId: "mesh-demo",
      attempt: 1,
      emit: () => {},
    }
  );
  console.log(`Inbound A2A task status: ${result.status}`);
  console.log(`Loom replied: ${result.artifacts?.[0]?.parts[0]?.text}`);

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  await server.stop();
  await external.close();
  await app.close();
  section("Done — bidirectional A2A mesh demonstrated offline.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
