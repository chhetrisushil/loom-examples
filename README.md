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
| `db-sentinel` | Perpetual-agent / sentinel pattern |
| `a2a-mesh`, `agent-network` | Agent-to-agent mesh / networking |
| `a2ui-dashboard`, `angular-command-center` | UI / renderer surface variants |
| `appgen-brownfield`, `appgen-models` | AI-driven app generation |

See `loom/docs/examples.md` for the long-form catalogue with the APIs/ADRs each
example exercises.

## License

Apache-2.0.
