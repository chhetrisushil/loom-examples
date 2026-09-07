# loom-examples

Runnable examples for the [Loom](../loom) framework — one package per
`examples/<name>`, each demonstrating a usage pattern. Extracted from the main
`loom` repo to keep the framework/kernel repo lean; the catalogue of what each
example teaches lives in `loom/docs/examples.md` and `loom/AGENTS.md`.

## Setup

Loom is **not published** — examples consume it from a sibling `../loom` checkout
via `link:` (see [AGENTS.md](./AGENTS.md) for the full rationale). Lay the repos
out as siblings:

```
workspace/
├── loom/            # git clone the framework, then:  pnpm install && pnpm build
├── loom-plugins/    # 3P plugins — only `learning-router` needs this one
└── loom-examples/   # this repo, then:                pnpm install
```

```bash
# from loom-examples/, with ../loom installed + built:
pnpm install
pnpm -r build
pnpm -r test
pnpm --filter @loom/db-observability start   # run one end-to-end
```

## Examples

| Package | Demonstrates |
|---|---|
| `loom-starter` | Minimal flow + human-in-the-loop approval |
| `db-observability` | Transient hydration → durable repair (GenUI dashboards) |
| `incident-war-room` | Git-style execution branching (fork / simulate / promote) |
| `schema-migration-planner` | Branching + live per-branch progress |
| `agent-swarm` | Dynamic agent swarm wired from user intent |
| `compute-cloudrun` | One flow across in-process / remote / Cloud Run backends |
| `db-command-center` (+ `-server`, `-wc`) | intent → planner → A2A agentic app + UI surfaces |
| `cloud-command-center` | Command-center with the `@loom/compiler` `loomPlugin()` |
| `db-sentinel` | Perpetual-agent / sentinel pattern, plus a runbook corpus that is EDITED mid-year: guidance retrieved and recorded per wake, a revision that supersedes the old procedure, and a month-3 finding that replays to month-3's advice after the corpus is emptied |
| `child-orchestration` | Parent/child executions — `spawn` + durable await, built from `ctx.decide` + `ctx.suspend` |
| `a2a-mesh`, `agent-network` | Agent-to-agent mesh / networking |
| `a2ui-dashboard`, `angular-command-center` | UI / renderer surface variants |
| `a2ui-egress` | Project a surface onto the Google A2UI wire protocol (`@loom/plugin-a2ui`) |
| `a2ui-callfunction` | A2UI `callFunction` bidirectional RPC — two grains + crash→in-doubt recovery |
| `mcp-app-release-approval` | Serve a surface as an MCP App (SEP-1865) — pinned template, ambient cursor polling, and decision provenance across a long-held gate (`@loom/plugin-mcp-app`) |
| `runbook-recall` | Retrieval-augmented generation from parts that exist for other reasons: the `semantic` memory tier as the corpus, `MemoryStore.search` as the retriever, `@loom/knowledge` for the document→passage mapping, `ctx.decide` so the retrieval is a recorded fact (the suite deletes the corpus and replays to the same answer), ADR 0085 taint so a passage somebody edited into the wiki cannot reach an instruction position, and `assertGrounded` so a citation to a document that was never retrieved fails the flow |
| `learning-router` | The continuous-learning loop end to end: `decideWithPolicy` → `trajectories` → SNIPS off-policy evaluation → `promotionGate`, with a 3P LinUCB policy (`@loom/learning` + `loom-plugin-linucb`) |
| `appgen-brownfield`, `appgen-models` | AI-driven app generation |

See `loom/docs/examples.md` for the long-form catalogue with the APIs/ADRs each
example exercises.

## License

Apache-2.0.
