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
| `blueprint-status` | Blueprint IR 2.0.0 on plain loom: widgets bind a value AND a status channel in the app's own projection, spans ride in grid cells, a degraded widget carries `source`, and the app's value contract sits in the terminal renderer's `check` seam — the canonical status matrix walked from real projection state (ADR 0097) |
| `experience-recompose` | loom-ui slice 6a: an agent revision lands while the user types — `renderBlueprintDom`'s `handle.update` reconciles the revised Blueprint by widget id, the focused `<textarea>` keeps text/caret/focus, the kept metric keeps its Lit element and is relabelled through `DomWidgetHandle.patch`, the report is loom's identity report plus `remounted`/`rebound`/`findings` |
| `experience-kinds` | loom-ui's framework kinds in an unrelated domain (a warehouse board): `Kpi` with a change badge, a columnar `Table` with per-column formats, a `StatusCard` with a polite live region, a localized `Note` via `textProps`, and a dual-axis `TimeSeries` — one Experience compiled for web (Lit, viewer's locale) and terminal (en-US) |
| `experience-layout` | loom-ui placement and section titles (Blueprint IR 2.1.0) in an unrelated domain (a branch-library board): nodes on explicit grid lines (`row` / `rowSpan` / `column` beside `span`), titled sections as `LocalizedText` resolved at compile, `<section aria-label><h2>` on the web and underlined headings in reading order in the terminal, and a revision that moves widgets by restyling them in place; gap G1: `DomRenderOptions.title: "none"` mounts no Blueprint `<h1>` for a host page that renders its own page header, whose mount region is named from it via `aria-labelledby` |
| `experience-stepped` | loom-ui's container-renderer seam (Blueprint IR 2.2.0 `Layout.role`, loom ADR 0099) in an unrelated domain (a bike-share rider onboarding): the app registers its own `stepped` renderer on `DomRenderOptions.containers` for `role: "stepped"` — Back/Next chrome and step visibility are the app's, mount/reconcile/subscriptions/focus-pin stay the adapter's; `setRole` toggles chrome in and out with a reported remount, a step title patches the chrome with none, appending a step remounts nothing existing, a throwing renderer falls back to plain, and the terminal prints every step with the role ignored |
| `experience-board-edit` | loom-ui operations and planner accounting on a greenhouse board: a widget resized through `setPlacement`, the board titled through `setTitle`, a provider that cannot be retired while bound (nor ever from a widget), the reference planner retiring the provider its own removal orphaned, and `PlanReport.usage` served from the recorded decision on replay; gap G4: a SECOND, multi-step provider (an inlined upstream "station read" step, then the node's own terminal "trend" step) whose tool drifts — `executeProvider`'s `DriftRecord` keys on the TERMINAL step, never `executionGraph[0]`, and the reference planner's `reviseForDrift` repairs it from a sample attached to that step's own tool, leaving the untouched upstream capability's sample alone |
| `split-hydration` | loom-ui split hydration in an unrelated domain (a weather-station board): the browser gets a Blueprint and a handle inventory, never a provider; a `SplitHydrationController` loads through a JSON `HandleLoader`; the server answers with `serveHandle`/`serveHandles` — `$now` tokens on an injected clock, overridable station/time-range params, `Named` reshapers, contract-checked output (an empty alert log is healthy), report-and-proceed for a read-only viewer, and two widgets sharing one upstream reading making exactly ONE upstream call through the batch; gap G3: the browser side imports ONLY the browser-safe `@loom-ui/hydration/client` subpath — bundled with esbuild (platform browser), its graph reaches no `.wasm`, no node builtin and none of the sandbox/MCP/effect-runtime server plane |
| `order-lines` | loom-ui's empty binding state (loom ADR 0100, gap G5) on an order-detail board: a DEPENDENT widget ("the top order's lines") whose own step chains off an upstream "top orders" step by a `{{steps.…}}` template; no top order at all indexes past the end of a real (empty) array and the handle publishes `empty` — "No data" on both surfaces (web `role="status"`, terminal's `○ …` row), never an error, never cached, never repaired — while a genuinely bad template KEY, on a non-empty upstream, still errors |
| `incident-war-room` | Git-style execution branching (fork / simulate / promote) |
| `schema-migration-planner` | Branching + live per-branch progress |
| `agent-swarm` | Dynamic agent swarm wired from user intent |
| `compute-cloudrun` | One flow across in-process / remote / Cloud Run backends |
| `db-command-center` (+ `-server`, `-wc`) | intent → planner → A2A agentic app + UI surfaces |
| `cloud-command-center` | Command-center with the `@loom/compiler` `loomPlugin()` |
| `db-sentinel` | Perpetual-agent / sentinel pattern, plus a runbook corpus that is EDITED mid-year: guidance retrieved and recorded per wake, a revision that supersedes the old procedure, and a month-3 finding that replays to month-3's advice after the corpus is emptied |
| `child-orchestration` | Parent/child executions — `spawn` + durable await, built from `ctx.decide` + `ctx.suspend`; waits on the log via `@loom/live-query` rather than polling for a terminal state |
| `a2a-mesh`, `agent-network` | Agent-to-agent mesh / networking |
| `a2ui-dashboard`, `angular-command-center` | UI / renderer surface variants |
| `a2ui-egress` | Project a surface onto the Google A2UI wire protocol (`@loom/plugin-a2ui`) |
| `a2ui-callfunction` | A2UI `callFunction` bidirectional RPC — two grains + crash→in-doubt recovery |
| `mcp-app-release-approval` | Serve a surface as an MCP App (SEP-1865) — pinned template, ambient cursor polling, and decision provenance across a long-held gate (`@loom/plugin-mcp-app`), over a hash-chained log so an approval that was accepted can be shown afterwards to be the one still recorded (`@loom/plugin-audit-chain`) |
| `runbook-recall` | Retrieval-augmented generation from parts that exist for other reasons: the `semantic` memory tier as the corpus, `MemoryStore.search` as the retriever, `@loom/knowledge` for the document→passage mapping, `ctx.decide` so the retrieval is a recorded fact (the suite deletes the corpus and replays to the same answer), ADR 0085 taint so a passage somebody edited into the wiki cannot reach an instruction position, and `assertGrounded` so a citation to a document that was never retrieved fails the flow |
| `saved-views` | A composed surface as a logged artifact: validate before recording, store the tree by `sha256:` ref, and let the EVENT that cites it decide whether it survives the content sweep — then re-open it after a deploy moves the fold behind one binding from a rolling week to a calendar month, and get a `drift` finding instead of a number that quietly changed by $900 |
| `learning-router` | The continuous-learning loop end to end: `decideWithPolicy` → `trajectories` → SNIPS off-policy evaluation → `promotionGate`, with a 3P LinUCB policy (`@loom/learning` + `loom-plugin-linucb`) |
| `appgen-brownfield`, `appgen-models` | AI-driven app generation |

See `loom/docs/examples.md` for the long-form catalogue with the APIs/ADRs each
example exercises.

## License

Apache-2.0.
