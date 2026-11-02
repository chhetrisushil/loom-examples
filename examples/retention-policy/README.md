# retention-policy — one app-owned policy value, and the clock a blob ages by

Loom retention is a set of explicit passes (nothing runs on a timer): `LogLifecycle.applyRetention`
reclaims aged terminal executions, `LogLifecycle.pruneSnapshots` drops superseded snapshots, and
`sweepUnpinnedContent` erases unpinned blobs. This example shows them driven by **one validated value
the app owns** (loom ADR 0145) and the clock the content sweep measures a blob's age by (ADR 0146).

Offline, SQLite stores in a temp dir, a simulated clock (`SimClock`: whole days; nothing waits).

```bash
pnpm --filter @loom/retention-policy start    # the narrated run
pnpm --filter @loom/retention-policy test     # 20 tests, exact outcomes
```

## The policy (`src/retention.ts`)

```ts
export const retention = retentionPolicy({
  terminalTtlMs: 90 * DAY,
  snapshots: { keepLatest: 1 },
  content: { unpinnedAfterMs: 90 * DAY },   // must be >= terminalTtlMs
});
```

It is a plain, deeply frozen value in the app's own module - **not** a `defineConfig` field
(configuration says how the app is composed, not what an operator may destroy and when). Every consumer
re-validates what it receives, so a literal that skipped `retentionPolicy()` is still refused.

## The timeline (`src/history.ts`)

| execution | what happens | at day 100 |
| --- | --- | --- |
| `early` | cites a telemetry blob and ends on day 0 | log `reclaimed` (archived), blob erased |
| `longrun` | cites a blob on day 0, parks, **ends on day 60** | log `kept`; blob **held by the end clock** until day 150 |
| `finding` | records a `FindingRecorded` event (the app's pinned kind) | log `pinned`, evidence never erased |
| `reopened` | ends on day 70, **re-opened on day 80** (`resumeAs`), parked again | `not-terminal`; keeps the citation clock |
| `ledger` | reads a **retained** (`retain: true`) blob, ends day 2 | log `reclaimed`; blob never TTL-reclaimed |
| `parked` | starts on day 40, never finishes | `not-terminal` |
| `recent` | ends on day 95 | `kept` |

## What each step shows

1. **The value** - frozen, three rules, kept out of `defineConfig`.
2. **Dry run, then apply** - `lifecycle.evaluate(id, retention, now)` names each outcome
   (`reclaimable` / `kept` / `pinned` / `not-terminal`) and changes nothing; `applyRetention` then
   copies `early` and `ledger` to the archive and only then deletes them from the live store.
3. **Snapshot pruning** - `pruneSnapshots(id, { policy: retention })` takes `keepLatest` from the
   policy (an explicit `keepLatest` wins). There is deliberately no age clock on snapshots.
4. **The end clock (ADR 0146)** - `sweepUnpinnedContent({ policy: retention, now, dryRun: true })` at day
   100: `longrun`'s blob was cited on day 0 and would be 100 days old on the citation clock, but its run
   ended on day 60, so it is 40 days old by the end clock. The dry-run report lists it in `heldByEndClock`
   (`refsAgedByEnd: 1`) and the blob survives; it becomes reclaimable on day **150** (not 149) - the same
   day retention makes the `longrun` log eligible. A blob's log and its blob are now eligible together.
   Non-terminal executions (`parked`, the re-opened one) keep the citation clock so a perpetual
   sentinel's telemetry still ages. Retained and pinned blobs are never TTL-reclaimed.
5. **A rejected policy** - `content.unpinnedAfterMs < terminalTtlMs`, an unknown key, `keepLatest: 0`
   all throw `RetentionPolicyError` (a `RangeError`) at construction.
6. **The opt-in point** - with no policy, the explicit numbers are the old path and give identical
   answers: `evaluate(id, { terminalTtlMs })` and `sweepUnpinnedContent({ olderThanMs })`.

## The CLI form

The same module drives the operator commands (`--policy` loads the `retention` export, or the default
export, through the project's own `tsx`; `--ttl` overrides it and is re-validated):

```bash
# dry run first; --apply to act. Reads terminalTtlMs.
loom retention run --db .data/events.db --snap .data/snapshots.db --policy ./src/retention.ts
# reads content.unpinnedAfterMs; a policy with no `content` section is refused (exit 2)
loom sweep content --db .data/events.db --snap .data/snapshots.db --content .data/content.db \
  --pin FindingRecorded --policy ./src/retention.ts
```

`loom retention run` does not apply `snapshots` (pruning stays a `pruneSnapshots` call). Not run from
this example: the CLI needs a persistent `.data/` and the real clock; the library calls above are the
same code on a simulated one.

## Gotchas this example hit

- The content store must stamp touch times with the **simulated** clock (`new SqliteContentStore(path,
  { now })`), or the sweep's race guard sees every blob as freshly touched.
- List the live event store **before** its retention archive in `eventStores`.
- `LogLifecycle`'s `pinned` predicate and the sweep's `pinnedEventTypes` both name the app's pinned kind;
  the policy carries numbers only, so the kind is stated in both places.
- Snapshot stores have no list call; `snapshotSequences` probes `loadAt` per log sequence.
