# task-authority-digest

Task-scoped authority ([ADR 0150](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0150-task-scoped-authority.md)
slices 1 and 2, ADR 0152) as an ops team's nightly incident-digest agent would use it. Everything is
in-memory and offline: the model is a scripted function (`src/model.ts`), so no API key is needed.

A valid credential does not say whose work is being done. A **task grant** names the effects one
execution may run, gives side-effect **leases**, scopes **reads**, and rides on the run's principal.

```bash
pnpm --filter @loomwork/task-authority-digest start   # prints every beat
pnpm --filter @loomwork/task-authority-digest test
```

| Beat | What it shows | ADR 0150 |
| --- | --- | --- |
| 1 | `reachOf` (`@loomwork/app`) lists the effects the flow can reach; `deriveGrant` makes a mint request from it, narrowed by the operator (no pager); the `task-grant-reach` verify rule warns on a hand-written template naming an effect the flow cannot reach | D9 |
| 2 | Leases (`email.send` capped at two) and signed `reads`: the agent recalls its own team's memory scope, and a recall of another scope is denied `task-grant:read-scope` before the store is read | D8 |
| 3 | `agentLoop$({ authority: { onDenied: "reason" } })`: the model is shown the refusal as an `isError` result and the run continues; the default `"fail"` is terminal | D11 |
| 4 | Provenance: task A writes back a note tagged with its verified lineage; task B (a different root grant) recalls it, so its `email.send` is parked by `directedBy` (`action: "park"`). The operator declining the lineage fails the run with no email; approving it (the broker's `approveCrossLineage`, recorded as `approvedLineages` on the signed grant) lets a fresh B through | D7 |
| 5 | A scheduled agent: one `requestScheduleApproval` run, answered with `answerScheduleApproval` (`expect.issuedTo` and `tenant` required); a `TimerService` with `principalFor: schedulePrincipalFor(...)` runs each occurrence as `<schedule>@<occurrence>`; `settleScheduledTick` refunds unused lease; a tick over the schedule's headroom is skipped and reported (`SchedulePrincipalError`), never run anonymously | D12, ADR 0152 |

Files: `src/world.ts` (one deployment: runtime, broker, effects, memory, a controllable clock),
`src/beats.ts` (one function per beat, returning the evidence), `src/main.ts` (prints it),
`test/` (asserts it; each assertion can fail: handler call counts, run status, exact reason prefix).
