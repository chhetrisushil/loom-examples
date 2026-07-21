# child-orchestration

A **release pipeline built from child workflows** — the smallest example that exercises
Loom's cross-execution orchestration API end to end. A parent `release` flow spawns
**separate child executions** (each with its own durable log and replay) and durably
awaits them three different ways:

| Step | Primitive | Semantics |
| --- | --- | --- |
| Build every service concurrently | `awaitChildren` | **Wait-all, settled.** Returns `ChildResult[]` in input order; a flaky build settles as `failed` and the release proceeds with what built. |
| Smoke-test the built services | `awaitAll` | **All-or-nothing.** Unwraps the outputs, or throws `childFailed` (first failure) — the parent catches it and aborts before publishing. |
| Publish one manifest | `awaitChild` | **One child.** Awaited for its output; throws `childFailed` if it fails. |

All three are composed from `ctx.decide` / `ctx.suspend` / `ctx.resume` plus a
`superviseChildren` supervisor wired into the runtime's `onEvent` — **no new syscall, no
new event type**. Each await rides ONE suspend/resume cycle, every spawn is fixed by a
single `ctx.decide`, and child ids are deterministic (`<parent>::<key>#<i>`), so the whole
pipeline is replay-safe and crash-recoverable frame by frame.

## Run it

```bash
pnpm --filter @loom/example-child-orchestration start   # narrated two-scenario demo
pnpm --filter @loom/example-child-orchestration test    # asserts the outcomes
```

Scenario A ships cleanly; Scenario B has a service that fails to **build** (tolerated —
partial rollout) and another that fails its **smoke test** (aborts the all-or-nothing gate
before publish), so you can see both `awaitChildren`'s settled tolerance and `awaitAll`'s
strict gate in one run.

## Where the pieces live

- `src/flows.ts` — the child flows (`build`, `smoke`, `publish`) and the `release` parent
  that composes the three primitives.
- `src/runtime.ts` — wiring `superviseChildren` into `WorkflowRuntime.onEvent`.
- `src/main.ts` — the runnable narration.
- `test/child-orchestration.test.ts` — clean release, partial-build tolerance, smoke-gate
  abort, and replay-safety (one `EXECUTION_STARTED` per child).

This example is headless and offline — the child "work" is deterministic, so the point is
the **orchestration shape**, not the payloads. Swap the runner bodies for real build/deploy
effects and the parent flow is unchanged.
