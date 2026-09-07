# db-sentinel — the perpetual-agent pattern, proven over a simulated year

The reference example for the perpetual-agents series (ADR 0051–0056; requirements in
`docs/requirements/2026-07-15-perpetual-agents-sentinel-workloads.md`): a database
replication-lag **sentinel** that "runs forever" — without a perpetual execution.

## The pattern (requirements §2, one line each)

| Requirement | Here |
| --- | --- |
| **P-1** sentinel = `schedule$` over bounded runs | `SENTINEL_SCHEDULE` (6-hour cron); every wake is a new execution with T1's deterministic `pg-sentinel@<occurrence>` id — no rotation, no perpetual log |
| **DS-1..5** typed carry state | `sentinelState(...)` in `src/sentinel.ts`: load → validated/migrated, save → CAS with the loaded revision; contracts v1→v2→v3 with registered migrations |
| **CC-1..4** claim-checked telemetry | `claimCheckMiddleware` (4 KiB cap): the log records `{ ref, size, digest }`; the flow branches ONLY on the declared digest |
| **P-2** findings = domain events | `ctx.emit(FINDING_RECORDED, …)` with an app-owned Zod schema, citing evidence by content hash |
| **P-3** staleness, never a hang | outage reads return `{ stale: true, asOf }` — small, inline, recorded |
| **K10.1 + K10.6** retention | archive runs at 60d; `sweepUnpinnedContent` reclaims telemetry blobs at 30d — evidence cited by findings is pinned forever, across archival |
| **ADR 0051 D7** boundary validation | `validateInput: true` — schedule inputs parse the declared contract (defaults applied) |

## What the acceptance suite proves (`pnpm test`)

Twelve simulated months at 6-hour cadence (1,460 wakes — the cadence is one constant;
the properties are cadence-independent), everything a pure function of virtual time:

1. Every wake stays within its event budget; every non-stale telemetry read is recorded
   **by reference** — no over-cap payload ever enters the log.
2. Findings match the anomaly model exactly, across a **mid-year contract deploy**
   (v1 → v2): the first v2 wake's recorded load carries `migrated: { from: 1, to: 2 }`;
   zero manual intervention.
3. Carry state advances one CAS revision per wake (1,460 exactly).
4. A 24-hour ingestion outage produces stale-marked, completed wakes — zero stuck runs.
5. Re-firing an occurrence (crash recovery / cross-node race) is a **no-op** — T1's
   idempotent-start discipline.
6. Archive everything older than 60 days, reclaim telemetry blobs older than 30 days:
   **every finding's evidence — including month 1, in archived runs — still resolves and
   hash-verifies**; disposable telemetry is gone.
7. Replay of any wake folds in well under a second and never touches the content store.
8. A v3 deploy **without** a migration path stalls loudly (`no-migration-path` in the
   recorded failure); registering the migration resumes cleanly on the next wake.
9. `TimerService` fires the cron deterministically and idempotently under `@loom/dst`'s
   virtual clock.
10. Evidence is readable outside the determinism boundary via `resolveClaimCheck`
    (CC-4); erased telemetry reads `null`, replay unaffected.

## The corpus a sentinel reads is edited while it runs

The findings above say *what happened*. Attaching *what to do about it* means reading a
runbook corpus — and over a simulated year that corpus is edited on the operators' clock,
not the agent's. That makes db-sentinel the second consumer of `@loom/knowledge`
(loom ADR 0091), and deliberately unlike the first: `runbook-recall` ingests once and asks
once, where an append-only corpus and an upsertable one behave identically.

| Property | Where |
| --- | --- |
| guidance is retrieved and RECORDED at the wake | `deps.knowledge.retrieve(..., { decide: ctx.decide, decisionKey: \`runbooks:${t}\` })` — keyed by occurrence, because two wakes asking the same question of a corpus that changed between them are two decisions |
| a July revision supersedes the old procedure | `sync(RUNBOOKS_MIDYEAR)` returns `{ written: [RB-101], unchanged: [RB-204], removed: [RB-777] }`; the withdrawn "cancel the blocking query" step stops retrieving entirely |
| a retired runbook stops being cited | RB-777 is dropped from the source and `sync` removes it — no corpus rebuild |
| a March finding replays to MARCH's guidance | the corpus is emptied outright, the wake is replayed, and the finding is byte-identical — reconstructed from the recorded decision |
| the corpus is optional | a sentinel with no knowledge base still emits findings, with `guidance: []` |

The last row matters as much as the others: knowledge is an input to the conclusion, not a
dependency of the loop.

### …and the sentinel writes back what it learned

A finding says what happened. The sentinel also records it as a DOCUMENT in the same corpus it
reads from — the second kind of knowledge: not a runbook somebody authored, but a fact the agent
produced.

That is only safe because the two halves have different **writers** (loom ADR 0091 follow-on).
`sync` is a destructive reconcile, so without ownership the next run of the wiki job would delete
every learning — they are not in the set the wiki produced, and never will be. The wiki syncs as
`source: "wiki"`, the sentinel writes as `source: "sentinel"`, and the July reconcile reports the
sentinel's documents as `retained` rather than removing them.

Two details the suite pins: the write is a journaled `ctx.execute` effect keyed by the
observation's timestamp, so **re-firing a wake does not write a second learning**; and the
learning is **tainted like any other passage**, because a fact derived from an execution that read
a database is third-party content by the same rule as a wiki page.

## Run

```sh
pnpm test        # the 12-month acceptance suite + the knowledge suite
pnpm start       # 3 simulated days, printed (findings, offloads, carry state)
```

## Layout

```
src/domain.ts     Finding schema (incl. recorded guidance) + carry-state contracts + migrations
src/knowledge.ts  the runbook corpus, and its mid-year revision
src/substrate.ts  deterministic pg_stat substrate (anomalies on the 7th; outage windows)
src/sentinel.ts   the flow, schedule, digest declaration, per-version deployment
src/harness.ts    shared stores + per-deploy runtimes + T1 idempotent occurrence firing
src/main.ts       headless demo driver
test/             the acceptance suite
```

Offline and deterministic end to end: no database, no network, no wall clock.

> This example is the **de-composed** version of the pattern — every seam visible. For the
> one-declaration form, see `sentinelPreset()` in `@loom/plugin-sentinel` (or scaffold a
> starter with `loom new sentinel <name>`).
