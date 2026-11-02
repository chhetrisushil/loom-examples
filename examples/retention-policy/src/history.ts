// The history the demo and the tests both replay: seven executions finishing on different simulated
// days. Every claim in the README is about THIS timeline.
import type { ContentRef } from "@loom/plugin-content";
import { LEDGER_TOOL, type World } from "./world";

/** The executions, named for what they teach. */
export const IDS = {
  /** Ends on day 0: far past the TTL by day 100. */
  early: "early",
  /** Cites its blob on day 0, parks, and only ENDS on day 60. The ADR 0146 case. */
  longrun: "longrun",
  /** Records a FindingRecorded event (a pinned kind). */
  finding: "finding",
  /** Cites on day 2, ends on day 70, then is RE-OPENED on day 80 (ADR 0104 `resumeAs`). */
  reopened: "reopened",
  /** Reads a RETAINED (load-bearing) blob; never TTL-reclaimed. */
  ledger: "ledger",
  /** Starts on day 40 and is still suspended at the end. */
  parked: "parked",
  /** Ends on day 95: well inside the TTL. */
  recent: "recent",
} as const;
export type Name = keyof typeof IDS;
export const NAMES = Object.keys(IDS) as Name[];

/** Run the whole timeline. Leaves the simulated clock on day 95. */
export async function buildHistory(w: World): Promise<void> {
  const { clock } = w;
  clock.set(0);
  await w.run(IDS.early, { label: "early" });
  await w.run(IDS.longrun, { label: "longrun", pause: true });
  clock.set(1);
  await w.run(IDS.finding, { label: "finding", finding: true });
  clock.set(2);
  await w.run(IDS.reopened, { label: "reopened", pause: true });
  await w.run(IDS.ledger, { label: "ledger", tool: LEDGER_TOOL });
  clock.set(40);
  await w.run(IDS.parked, { label: "parked", pause: true });
  clock.set(60);
  await w.continueRun(IDS.longrun); // longrun ENDS on day 60
  clock.set(70);
  await w.continueRun(IDS.reopened); // reopened ENDS on day 70 ...
  clock.set(80);
  await w.reopen(IDS.reopened); // ... and is brought back to life on day 80
  clock.set(95);
  await w.run(IDS.recent, { label: "recent" });
}

/**
 * The blob address an execution cited, read from its recorded read step (live store first, then the
 * retention archive, because retention MOVES a log there).
 */
export async function blobOf(w: World, name: Name): Promise<string> {
  const id = IDS[name];
  for (const store of [w.eventStore, w.archive.eventStore]) {
    for (const e of await store.read(id)) {
      if (e.eventType !== "STEP_COMPLETED") continue;
      const output = (e.payload as { output?: { ref?: ContentRef } }).output;
      if (output?.ref?.__loomContent !== undefined) return output.ref.__loomContent;
    }
  }
  throw new Error(`execution ${id} cited no blob`);
}

/** Snapshot sequences an execution holds (the store has no list call: probe each log sequence). */
export async function snapshotSequences(
  w: Pick<World, "snapshotStore" | "eventStore">,
  name: Name
): Promise<number[]> {
  const id = IDS[name];
  const tip = (await w.eventStore.read(id)).length;
  const found: number[] = [];
  for (let seq = 0; seq <= tip; seq++) {
    if ((await w.snapshotStore.loadAt(id, seq)) !== null) found.push(seq);
  }
  return found;
}
