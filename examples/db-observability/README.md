# db-observability — a dashboard generated dynamically from intent

Ask a database a question in plain language — *"Why is the CPU utilization high?"* or
*"What is the connection saturation level?"* — and the app **generates the dashboard
UI on the fly**. An agent analyses the question, categorises it, and produces two
things:

- **WHAT** — the direct answer to your question (the headline metric + a one-line answer).
- **WHY** — the supporting information that explains *why the WHAT is the way it is* (the
  causal signals: pool saturation, slow queries, CPU trend…).

The dashboard is a Loom **blueprint assembled at runtime** from an **available widget
catalogue**, bound to live telemetry projections. No dashboard is hand-authored — the UI
is a function of *intent × catalogue × telemetry*. The same blueprint renders on **two
surfaces**: a headless terminal (text) and a **React dashboard where the WHAT/WHY metrics
are drawn as visualisations** (a radial gauge, an area chart, a saturation bar, a table).

```
 question ─▶ agent.classifyIntent ─▶ { topic, kind }
                                         │
              ┌──────────────────────────┘
              ▼
   TOPIC_MODELS[topic]:  answer(telemetry) → WHAT     explanation(telemetry) → WHY
              │                    primaryWidget            whyWidgets[]
              ▼
   DashboardComposer  ── selects widgets from ──▶  WIDGET_CATALOGUE
              │                                          (MetricCard, ProgressBar,
              ▼                                           Timeline, DataTable, …)
   blueprint$(stack([ WHAT badge + metric,  WHY badge + causal widgets ]))
              │
              ▼
   TerminalRenderer.render(blueprint, executionId)   ← binds to cpu/connections/… projections
```

Telemetry itself is **hydrated by a transient interpreter** (the GenUI
blueprint-interpreter pattern, ADRs 0060/0061/0063/0064/0065): a *hydration plan* — one
node per projection, each naming an MCP tool, a **pinned input-schema hash**, and a
**content-addressed reshaping script** — is walked by plain code. Because hydration is the
hot read path (every dashboard open, every 50 ms batch) and mutates nothing, it is **not a
loom run** (ADR 0065 — "don't make it a run until something durable happens"): each effect
runs through `runtime.invokeTransient`, writing **zero events**.

```
 plan (immutable, content-addressed — never logged on the hot path)
   │  one node per projection: { toolName, schemaPin, scriptRef, shapePin }
   ▼
 invokeTransient("mcp.invoke", node)            ← transient, no events
   │  per call: verify schemaPin — mismatch ⇒ TYPED schemaDrift failure (ADR 0060/0063)
   ▼
 invokeTransient("sandbox.eval", …)             ← QuickJS sandbox: RAW → widget shape,
   │                                               output validated vs shapePin (ADR 0064)
   ▼
 { cpu, connections, replication, queries } → seeded into the projections
```

Midway through the demo a simulated **backend deploy changes `db.replication`'s input
schema**: the pinned hash no longer matches and the transient invoke fails on the **typed
`schemaDrift` channel**. *That* is the moment the determinism boundary is crossed — a
repair must be recorded — so hydration escalates to a **durable repair run**
(`start(repairFlow, …)`): it emits `SCHEMA_REPAIRED` (the forensic payload), re-walks the
plan under the observed pin, and re-runs the drifted node under a re-minted
`hydrate#2#repair` id (ADR 0061 — a deliberate retry is a NEW identity). The transient
failure itself is never a durable fact; only the repair outcome is. The MCP "backend" runs
in-process (`src/mcpServer.ts`) — still offline, still deterministic.

## How it works

- **Transient hydration + durable repair** (`src/hydration.ts` + `src/mcpServer.ts`) — the
  interpreter above: plain-code `invokeTransient` over `mcp.invoke` (`@loom/plugin-mcp`,
  schema pins from `listTools`) chained into `sandbox.eval` (`@loom/plugin-sandbox`,
  content-addressed scripts in a `ContentStore`), escalating to a durable repair flow
  (`fanout$` from `@loom/orchestration`) only on the typed drift→repair branch.
- **Telemetry projections** (`src/telemetry.ts`) — `cpu`, `connections`, `replication`,
  `queries` read-models, populated from the hydration flow's output (the browser build
  keeps the deterministic seeded scenario — hydration is the Node/terminal path),
  plus an `answer` projection the agent writes its WHAT/WHY text into.
- **Widget catalogue** (`src/catalogue.ts`) — the palette the UI is built from: each
  entry knows its topic + how to build a bound `Widget` (`MetricCard`, `ProgressBar`,
  `Timeline`, `DataTable`).
- **The agent** (`src/agent.ts`) — a deterministic offline `LlmProvider` classifies the
  question into `{ topic, kind }`; swap in `AnthropicProvider` and the classifier is
  unchanged.
- **Topic models** (`src/topics.ts`) — the causal map: per topic, the WHAT widget, the
  WHY widgets, and the two narrative strings derived from live telemetry.
- **The composer** (`src/composer.ts`) — ties it together: classify → reason (WHAT/WHY)
  → publish the answer → **assemble the blueprint from the catalogue** for that intent.
- **Stated preferences** (`src/preferences.ts` + `src/preferenceService.ts`) — Phase 1 of
  the adaptive Operator Profile: what the operator explicitly chose, scoped per
  `(tenant, operator, topic)`, stored as versioned durable state
  (`@loom/plugin-durable-state` — keyed CAS, so a load and a save are both recorded
  steps), read when the surface is composed. **No inference of any kind** — no flags, no
  evidence, no cohorts. See below.

Because `blueprint$`, `stack`, and the widget factories return plain data, the layout's
`children` array is assembled conditionally at runtime — a `cpu` question yields a
different dashboard than a `connections` one, all from the same catalogue.

## Adaptation, Phase 1: stated preferences

The same question composed for two operators differs only in **arrangement** — density,
and which WHY widget leads — because one of them said so and the other said nothing.

Two invariants hold this in place, and both are tests rather than intentions
(`test/preferences.test.ts`):

- **An unstated profile yields the canonical surface, through the same method.** Not an
  equivalent surface: an identical one. Canonical mode is `answer(q)` with the profile
  zeroed, so a holdout costs nothing and the canonical path cannot drift from the adaptive
  one — they are the same path.
- **No arrangement removes a node the canonical surface has.** Checked with
  `preservesNodes` from `@loom/blueprint-runtime`, which reports the node ids a structural
  change dropped. A preference reorders and re-spaces; the widget set is the agent's, and
  nothing an operator can state removes a widget from it. The worst case is a worse
  layout, never a missing capability.

That second test is deliberately paired with one asserting the arrangement is *visible* —
a projection that changed nothing at all would satisfy the invariant perfectly.

What is **not** here is as deliberate: no disclosure preference (collapsing a pane needs a
container this catalogue does not have — that is Phase 2's projection), no capability
flags, no cohorts, and nothing derived from behaviour. Phase 1 exists to be measured
first, because its effect is the bar every later phase has to clear.

## Adaptation, Phase 2a: a profile derived from what was recorded

Phase 1 stored what the operator said. Phase 2 stores **nothing**: a capability flag is a
fold over events that already exist, so there is no write path from a run into profile
state and replaying a run cannot mutate a profile.

Three mechanisms, each replacing something the original design specified differently:

| | Design said | Here, and why |
|---|---|---|
| Where the profile lives | a projection folded per run | a **read model** (`@loom/plugin-read-model`) over ordinary run logs — a projection has no snapshot anchor, so a run-start re-fold is *O(operator's lifetime)* |
| Expiry | a timestamp comparison at read time | an **event**. A read-time horizon makes the fold a function of `(events, now)`, so two reads of the same history disagree and pinning anything pins nothing. A scheduled evaluator observes the horizon and appends a lapse; the fold takes no clock |
| What a run journals | the log offset it read at | the **resolved profile**, through `ctx.decide`. An offset reproduces the events but not the *fold* — and the fold is a versioned catalogue plus this code, both of which change |

The last one has the sharpest test: resolve a profile, let the flag lapse so the derived
profile is empty, then re-execute the finished run. It still answers with the flags it was
arranged under — and the deriver is never called, which the test asserts by counting.

Other properties worth knowing:

- **The catalogue is closed and versioned.** Flags are added by review, in `src/flags.ts`;
  an unknown id is refused rather than returning `undefined`. Nothing here can encode a
  demographic, a title or a tenure — there is no flag such an attribute could set, which
  is what makes the exclusion enforceable rather than a policy statement.
- **A flag is citable.** `explainFlag` produces the sentence the product owes the
  operator: which interaction, how many times, most recently when.
- **Stated outranks inferred, without a tie-break** (the design's C7). A flag *suggests*
  which WHY widget leads; a stated pin overrides it. And a stated pin that does not apply
  to this topic does **not** hand the decision back to the inference — the person already
  said what they wanted.

## Adaptation, Phase 2b: exploration, canonical mode, and the operator's own word

**The exploration floor.** A system that only surfaces what it already believes someone
can use learns nothing it does not already believe: the capability is never shown, never
used, and the absence of use is read back as confirmation. So a fixed fraction of sessions
leads with exactly one capability *above* the operator's assessed level, drawn uniformly
from the ones this surface can actually show.

Two details are the difference between a measurement and a gesture, and both are easy to
omit without anything failing:

- **The propensity is recorded at the draw** — the probability of the action *taken*, not
  of exploring at all. It cannot be reconstructed afterwards, and without it
  `evaluatePolicy` refuses a value estimate and reports `agreement-only`. A log missing it
  looks perfectly healthy and is silently unevaluable.
- **Non-use is recorded as a zero, not an absence.** Credit assignment *skips* an absent
  outcome. Scoring only the successes is precisely what makes an assessed level inflate
  forever, which is the failure the floor exists to prevent.

**Canonical mode.** On an incident signal the profile is zeroed and the draw is suppressed
entirely — through the same resolution, not a branch around it, so the canonical surface
cannot drift from the adaptive one. The reason travels with the session, because silently
rearranging someone's console the moment an incident starts is the same failure inverted.

**The escape hatch** is recorded like any other interaction and is deliberately evidence
*of nothing*: no catalogue flag takes it, so reaching for the canonical view can never make
the system more confident. Its rate is the cheapest corrective signal available — a direct
measure of how often adaptation was wrong.

**C7 — the operator's own word.** A declared flag is set with no evidence, never expires,
and is never overwritten by inference; a cleared one stays cleared however much evidence
arrives afterwards. If the next three observations set it again, the correction was theatre
and people stop making them. Declaring a flag outside the catalogue is refused: an operator
may correct the system, not extend the vocabulary it reasons in.

Precedence, end to end: **stated preference → this session's experiment → the profile's own
habit**. An experiment outranks a habit because surfacing what someone already reaches for
teaches nothing; both yield to what the person actually said.

## Run it

**Visual dashboard (browser):**

```bash
pnpm --filter @loom/db-observability dev       # http://localhost:5173 — ask a question, watch the charts
pnpm --filter @loom/db-observability build:ui  # production bundle (dist/ui)
```

Ask *"Why is the CPU utilization high?"* and the **WHAT** renders as a radial **gauge**
(91 %, red zone) and the **WHY** as an area **chart** (CPU trend), a saturation **bar**
(98/100 pool), and a **table** of the top slow queries — the causal story, visualised.
Different questions generate different charts from the one catalogue. Toggle **Live** to
push deterministic samples so the gauge/area animate.

**Headless (terminal):**

```bash
pnpm --filter @loom/db-observability start   # hydrate via MCP+sandbox, ask 4 questions, drift+repair midway
pnpm --filter @loom/db-observability test    # classification, dynamic assembly, hydration + drift repair, registry
```

## One blueprint, two surfaces

The composer emits a **framework-agnostic `Blueprint`** — the intent→WHAT/WHY brain
(`agent`/`topics`/`catalogue`/`composer`) is shared verbatim. Only the *rendering* differs:
- **terminal** (`@loom/plugin-renderer-terminal`) prints each widget as `title: value`.
- **browser** (`@loom/plugin-renderer-react`) renders the *same* blueprint with a custom
  `RendererRegistry`: our Recharts renderers (`src/browser/renderers.tsx`) are registered
  under the standard widget-kind names and merged over the built-ins, so `MetricCard` →
  gauge, `Timeline` → area chart, `ProgressBar` → bar, `DataTable` → table. No catalogue
  change — the surface is a swap of the registry.

## Files

| Path | Purpose |
|------|---------|
| `src/hydration.ts` | The durable interpreter flow: plan builder + `fanout$` → `mcpInvoke$` → `sandboxEval$` + drift repair |
| `src/mcpServer.ts` | In-process MCP telemetry server (offline) + the `upgradeReplicationTool` drift trigger |
| `src/telemetry.ts` | Telemetry + answer projections, `applyHydratedStates`, seeded scenario (browser), live-sample helpers |
| `src/catalogue.ts` | The available widget catalogue (the palette) |
| `src/topics.ts` | Per-topic WHAT/WHY causal models |
| `src/agent.ts` | Offline intent classifier (`LlmProvider`) |
| `src/composer.ts` | Classify → reason → assemble the blueprint dynamically (arranged by stated preferences) |
| `src/preferences.ts` | Phase 1: the preference contract, scope key, the two durable flows, and the pure arrangement functions |
| `src/preferenceService.ts` | Runs those flows: state a choice, resolve the effective set |
| `src/flags.ts` | Phase 2: the closed, versioned capability-flag catalogue |
| `src/profile.ts` | The evidence read model, the clock-free fold, the lapse evaluator, and the `ctx.decide` resolve flow |
| `src/profileService.ts` | Runs it: observe, derive, expire, open a session (profile + draw), declare, score, replay |
| `src/suggest.ts` | The one thing a derived profile may do to a surface: suggest which WHY widget leads |
| `src/exploration.ts` | Phase 2b: the exploration floor — candidate capabilities, the draw, and the propensity of the action taken |
| `src/wiring.ts` | `buildCore` — surface-agnostic projections + composer (terminal-free) |
| `src/app.ts` / `src/main.ts` | Terminal wiring + headless driver |
| `src/browser/` | React dashboard: `renderers.tsx` (Recharts), `registry.ts`, `App.tsx`, `main.tsx` |
| `test/` | Classification, dynamic assembly, rendered output, browser registry, hydration + drift repair, preference scope + the two adaptation invariants, the flag fold + expiry + journaled profile |
