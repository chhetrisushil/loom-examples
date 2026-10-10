# agent-network — the full agentic pipeline, end to end (offline)

A single server-side showcase of Loom's agentic surface, wired together and running **fully offline**
(a `ScriptedLlmProvider` stands in for a real model — swap in `AnthropicProvider` / `OpenAiProvider` /
`GeminiProvider` and nothing downstream changes). One file, `src/main.ts`, walks through eight things:

1. **Configurable LLM** — one swappable `LlmProvider` dependency.
2. **Bring-your-own agent** — `agent$()` + the `agentLoop$` ReAct loop (one durable frame per model and tool call) over your tools. It runs from a script, so `runAgentOnce` (`@loom/app`) builds the throwaway in-memory app and one-off flow for each run (scripts and tests only; production puts `agentLoop$` in a registered flow). `selectedSkillsOf` (`@loom/agent`) reads which skills the loop selected from the recorded events.
3. **MCP servers/tools** — `McpClient` discovers tools and registers them as effects.
4. **A2A out of the box** — expose a flow as an A2A agent (`createA2AServer` + `toAgentCard`, with an `authenticate` that names the caller), then call it as a client (`createA2AClientEffect`, sending the credential in `headers`).
5. **Capabilities + Intent** — a `CapabilityCatalog`, routed to by **intent** (not URLs).
6. **Planner** — turn a goal into an ordered capability plan (`PlannerRuntime`).
7. **Agent memory** — an agent that recalls prior turns (`TieredMemory` + `InMemoryMemoryStore`, written back through the effect ring via `memoryWriteBackEffect`).
8. **Multi-surface rendering** — render one blueprint to the terminal surface.

## Run it

```sh
pnpm --filter @loom/agent-network start   # prints each stage to the terminal
pnpm --filter @loom/agent-network test
```

Everything is deterministic and offline — no API key, no network. To go live, replace
`ScriptedLlmProvider` (`src/ScriptedLlmProvider.ts`) with a hosted `@loom/llm` provider; the ReAct
loop, MCP wiring, A2A endpoints, capabilities, planner, and memory are unchanged.

## Where to look

- `src/main.ts` — the eight stages, in order, with section headers.
- `src/capabilities.ts` — the capability catalog + the blueprint rendered at the end.
- `src/ScriptedLlmProvider.ts` — the offline model stand-in (the one thing you swap to go live).
- `src/fakeMcpServer.ts` — an in-process MCP server so tool discovery runs without external processes.

See `loom/docs/user-guide.md` for the concepts and [`agent-swarm`](../agent-swarm)
for a fleet dynamically wired from intent with `policy$` enforcement.
