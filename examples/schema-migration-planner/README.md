# Schema Migration Planner — git-style branching on Loom

An engineer needs to add a `NOT NULL region` column to the **40M-row `orders` table** under active writes.
There is more than one defensible way to do it, and the options are **mutually exclusive** — you run one
migration, not half an online-DDL and half a dual-write. So at the approval gate, instead of a blind
approve/reject, the engineer **branches**: fork the suspended execution once per candidate strategy,
**simulate** each against a shadow schema (watching live backfill progress), **compare** the projected
lock time / duration / reversibility / risk, and **promote** the winner — which then applies for real.
Rejected plans survive as immutable lineage: the *alternatives-considered* audit trail.

This is the **second** example of Loom's git-style branching (`fork → simulate → compare → promote`,
branch-only, **no merge**) — a sibling to [`incident-war-room`](../incident-war-room/README.md). It proves
the branching pattern is domain-agnostic: the entire `BranchOrchestrator` seam and branch UI are reused
verbatim; only the *domain* (strategies, agents, projected outcomes) changes. It also adds **live
per-branch simulation progress** — three shadow-migrations backfilling concurrently — which the incident
example (instant simulations) didn't exercise.

```
pnpm --filter @loom/schema-migration-planner dev     # client :5173  +  server :8787
# then open http://localhost:5173
```

Fully offline (deterministic `DemoLlmProvider`). `dev` runs both processes; or run
`dev:server` (Node runtime, :8787) and `dev:client` (Vite, proxies `/api`) separately.

## The loop

1. **Analyze** — state the goal ("add a NOT NULL region column to the 40M-row orders table"). `IntentRuntime`
   routes it; `PlannerRuntime` composes *diagnose-schema → assess-migration → plan-migration*. The Schema
   Inspector agent runs a real ReAct loop over an `inspect-table` tool (40M rows, 48 GB, 3 indexes, ~1200 writes/s).
2. **Gate** — the mutating migration flow suspends at a durable `ctx.suspend`. `main` points at it. The UI
   jumps to the **Migration Board** tab.
3. **Explore** — the server forks one child per strategy (*online-ddl*, *shadow-copy*, *dual-write*) and
   drives each **in `simulate` mode**, concurrently (`@loom/scheduler` `parallelLimit`). Each runs against a
   **shadow schema**, **streaming live backfill progress**. The parent log is never touched (copy-on-write).
   With a branch worker configured, each one is **dispatched to its own compute** rather than run inside the
   web server — see *Branch compute* below.
3b. **Verify** — a shadow migration does not end when the backfill does: someone compares row counts and
   signs the branch off. Each branch therefore **parks on its own `ctx.suspend`** with a 12-hour deadline,
   and `exploreBranches()` returns while all three are suspended. This is what makes a branch *long-running*
   rather than merely slow — the compute that ran the backfill is finished and released, and the execution
   is parked in storage until a human answers.
4. **Compare** — three progress bars advance at once, then a side-by-side diff. No dominant option:

   | strategy | lock time | duration | rows | reversible | risk |
   |---|---|---|---|---|---|
   | online-ddl | 3 s | 22 min | 40M | yes | medium |
   | shadow-copy | 8 s | 14 min | 40M | **no** | low |
   | dual-write | 0 s | 40 min | 40M | yes | high |

5. **Promote** — pick a winner → `promote(branch, "main")`, fork a commit branch, resume `simulate:false` to
   apply for real. Losing plans remain immutable lineage. **There is no merge.**

A contrasting **simple goal** ("add a nullable notes column; apply automatically if low risk") is
metadata-only and **auto-applies without branching**.

## Branch compute (`src/compute/`)

A simulated migration clones a table and backfills 40M rows. Running three of those inside the web server
is the demo's convenient lie; this example can stop telling it.

```sh
pnpm --filter @loom/schema-migration-planner dev:worker          # a branch worker on :7071
BRANCH_WORKER_URL=http://localhost:7071 pnpm --filter @loom/schema-migration-planner dev
```

The worker is **not a different program**: the same flow registered on a `WorkflowRuntime` over the **same**
SQLite files. That is the placement seam — an `ExecutionPackage` carries identity and resume coordinates,
never code or state, so the worker reconstructs the branch from the shared log. `PlacementDispatcher` routes
the `branch` lane to it (`RemoteWorkerRuntime` → `POST /execute`) and everything else stays local.

Three things this surfaces that the in-process version cannot:

- **A worker that omits a `TimerStore` silently discards every deadline.** A runtime derives a suspension's
  `wakeAt` from its `timeout` *only when a TimerStore is wired* — unwired, the condition is committed without
  one, byte-identically. Split your compute and every runtime that can suspend needs the store; only one of
  them needs the `TimerService`. `loom verify`'s `suspension-safety` rule catches this, so **run verify
  against the worker's composition, not just the coordinator's.**
- **A wake goes back to where the branch belongs** — and did not, until
  [loom#392](https://github.com/chhetrisushil/loom/issues/392). Placement used to be a caller-side struct
  mapped to `DispatchMetadata` at dispatch time, so `TimerService` resumed a parked branch on whatever
  runtime it held. Passing a target per dispatch is not enough: it lives in one process's memory, so the
  first dispatch lands on the worker and every later wake lands in the web server. The branch is now
  **placed at fork** (`fork(…, { computeTarget })`), the lane is recorded on its anchor, and the timer
  service dispatches the wake back to it. `pnpm demo:placement` shows the round trip; `test/compute.test.ts`
  asserts it — that test spent its first life asserting the opposite.
- **`progressHub` does not cross a process.** The live backfill bars are an in-process transient sink, so a
  branch running on a real worker reports nothing to the coordinator's surface. (The tests run both sides in
  one process, so the bars still work *there* — that is an artifact of the test topology, not a property.)
  Durable progress would have to be events; see [loom#394](https://github.com/chhetrisushil/loom/issues/394).

## Why "no merge" is the honest model

You can apply only **one** of these migrations. Branching lets you *explore* several and *commit* one; the
DAG of what you rejected is a first-class artifact (`BranchRegistry` lineage), not a lost draft. Two
divergent `ExecutionState`s have no principled join, so `promote()` is a pointer move — the entire "merge"
replacement. (See `docs/architecture.md` → "Why branching, not merge/rebase?")

## What's reused vs. new (sibling of incident-war-room)

**Reused verbatim** (domain-agnostic): `src/branching/BranchOrchestrator.ts` (the fork/simulate/promote
seam — only the flow id and resume event type differ), the `branch` A2UI surface + `BranchGraph` /
`BranchDiff` / `BranchControls` Web Components, `src/wire.ts`, the server/client SSE plumbing, and the
`Orchestrator`'s branch-lifecycle structure.

**New / retargeted** (the domain): `src/warroom/strategies.ts` (migration strategies + outcome fields),
`src/capabilities/flows.ts` (`MigrationExecutionFlow` with the streaming `MigrationStep`), the
schema-inspector / risk-assessor / migration-executor agents + mock tools, the catalog, and the
`DemoLlmProvider`. The **live progress** differentiator adds a `progress` field to `BranchView`, a numeric
`reportProgress`/`onProgress` channel on `progressHub`, and a per-branch progress bar in `BranchGraph`.

## Wire protocol (`src/wire.ts`)

- `POST /api/missions {goal}` → start (or restart) the mission.
- `GET  /api/missions/:id/stream` → **SSE**: a `snapshot` on connect, then one `patch` per `A2UI_PATCH`
  (including the live progress patches).
- `POST /api/missions/:id/branches` → **fork + simulate** every candidate strategy.
- `GET  /api/missions/:id/branches` → the current branch surface.
- `POST /api/missions/:id/promote {strategy}` → **pick a winner** and apply it for real.

## Verify

- `pnpm --filter @loom/schema-migration-planner demo:fork` — narrated headless fork → simulate → compare →
  promote (source: `src/scripts/speculativeFork.ts`).
- `pnpm --filter @loom/schema-migration-planner test` — headless e2e over SQLite: the gate forks into N
  strategy branches, each yields a **distinct** projected outcome with **progress reaching 100%**, the parent
  stays suspended, `promote` moves `main` off the parent onto the real apply, lineage records every fork, and
  the simple goal auto-applies without branching.
- `pnpm --filter @loom/schema-migration-planner demo:placement` — narrated headless: branches dispatched to a
  real worker, parked for verification with the coordinator idle, then the wake landing in the wrong process
  (source: `src/scripts/branchPlacement.ts`).
- `test/compute.test.ts` — asserts every branch was advanced by the **worker's** runtime and never by the
  coordinator's, and pins the loom#392 gap. When that fix lands, the second test should fail and its
  expectation flips — it is not a test to delete.
- Live: `pnpm ... dev`, run the complex goal, click **Explore branches**, watch three progress bars advance,
  then **Promote** a strategy.

## Out of scope (not built)

- **Server-restart resume of an in-flight mission** (the event log, snapshots, and branch refs persist, but
  the `Orchestrator`'s in-memory model is not rehydrated on a full restart).
- **Cross-process A2A** (the agents run in-process via `InProcessA2ABus`). Branch *execution* does cross a
  process when a worker is configured; the agent mesh does not.
- **Multi-node branch compute.** Shared SQLite (WAL) is honest for one host. Two nodes would want Postgres,
  where `acquireFence` keeps a partitioned zombie worker from writing.
- **Real DDL** — migrations are mocked deterministically; `projectOutcome` stands in for a gh-ost `--dry-run`
  or a shadow apply.
