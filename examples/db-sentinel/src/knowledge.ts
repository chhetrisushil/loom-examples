import { openKnowledgeBase } from "@loom/knowledge";
import type { KnowledgeBase, KnowledgeDoc } from "@loom/knowledge";
import { InMemoryMemoryStore } from "@loom/memory";

// ── The runbook corpus: the half of a sentinel's knowledge that CHANGES ───────
//
// A sentinel runs for a year. Over that year the telemetry it reads changes every
// wake — that is what carry state and claim-checked evidence are for — and so does
// the operational guidance it attaches to a finding, on a completely different
// clock: somebody edits a wiki page.
//
// That is the case a one-shot RAG example cannot exercise and this one is built
// around. `runbook-recall` ingests a fixed array at startup and answers questions
// about it; nothing in it can tell an append-only corpus from an upsertable one.
// Here the corpus is revised mid-year while the agent is running, which makes three
// things observable that were not:
//
//   1. a revised runbook must SUPERSEDE its old passages, not sit beside them —
//      otherwise a wake in month 7 cites both the current procedure and the one it
//      replaced, with nothing in the finding saying which is live;
//   2. a runbook retired upstream must stop being cited (`sync` removes it);
//   3. a finding recorded in month 3 must still replay to the month-3 guidance,
//      because the retrieval was recorded — a year-old incident review reads the
//      advice that was actually given, not the advice that would be given today.

export const RUNBOOK_SCOPE = "pg-runbooks";

/** The corpus as it stands at the start of the simulated year. */
export const RUNBOOKS_V1: KnowledgeDoc[] = [
  {
    id: "RB-101",
    title: "Replication lag",
    text: `Replication lag is the delay between the primary WAL position and the replica
replay position. Page when lag exceeds the threshold for two consecutive checks.

The usual cause is a long-running query on the replica holding back replay. Cancel the
blocking query before touching any replication setting.`,
  },
  {
    id: "RB-204",
    title: "Connection pool exhaustion",
    text: `The checkout API times out while the database itself is idle: the pool is
saturated and clients queue for a connection that never frees.

Recycle the pool first — it is graceful and reversible. Raise the ceiling only after
confirming the leak is in demand, not in a connection that is never returned.`,
  },
  {
    id: "RB-777",
    title: "Manual failover drill",
    text: `Quarterly drill: promote the standby by hand and time the cutover. Superseded
by the automated drill once the operator tooling ships.`,
  },
];

/**
 * The corpus after the mid-year edit — one revision and one retirement:
 *
 *  - RB-101's remedy CHANGES (cancel the query → drain and let autovacuum finish). Its
 *    old text must stop retrieving, which is exactly what an append-only corpus cannot do.
 *  - RB-777 is RETIRED. `sync` removes what the source no longer lists, so a runbook
 *    deleted from the wiki stops being cited without anybody deleting the corpus.
 *  - RB-204 is BYTE-IDENTICAL, and therefore must not be rewritten at all.
 */
export const RUNBOOKS_MIDYEAR: KnowledgeDoc[] = [
  {
    id: "RB-101",
    title: "Replication lag",
    text: `Replication lag is the delay between the primary WAL position and the replica
replay position. Page when lag exceeds the threshold for two consecutive checks.

As of the July change: drain the replica's read traffic and let autovacuum finish. Do
NOT cancel the blocking query — cancelling it was found to restart the replay from the
last checkpoint and make the lag worse.`,
  },
  RUNBOOKS_V1[1] as KnowledgeDoc,
];

/**
 * Open the corpus. A `semantic` tier — the one that never evicts — over the default
 * in-memory store, because this example is offline and deterministic; in a deployment
 * this is a `SqliteMemoryStore` pointed at the same file as the event log, and nothing
 * above it changes.
 */
export function openRunbooks(): KnowledgeBase {
  return openKnowledgeBase(new InMemoryMemoryStore(), { scope: RUNBOOK_SCOPE });
}
