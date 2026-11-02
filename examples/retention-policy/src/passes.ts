import { type ContentSweepReport, sweepUnpinnedContent } from "@loom/plugin-content";
// The three retention passes, each taking the app's policy VALUE. These are thin on purpose: the
// point of ADR 0145 is that the numbers live in `retention.ts`, and every pass just receives them.
import type { RetentionOutcome, RetentionPolicy, RetentionVerdict } from "@loom/workflow-runtime";
import { IDS, NAMES, type Name } from "./history";
import type { World } from "./world";

export type Outcomes = Record<Name, RetentionVerdict>;

/** Dry run: what would `applyRetention` do to each execution at `now`? Nothing is touched. */
export async function evaluateAll(
  w: World,
  policy: Pick<RetentionPolicy, "terminalTtlMs">,
  now: number
): Promise<Outcomes> {
  const out = {} as Outcomes;
  for (const name of NAMES) out[name] = await w.lifecycle.evaluate(IDS[name], policy, now);
  return out;
}

/** Apply retention: archive-first, then delete from the live store. */
export async function applyAll(
  w: World,
  policy: Pick<RetentionPolicy, "terminalTtlMs">,
  now: number
): Promise<Record<Name, RetentionOutcome>> {
  const out = {} as Record<Name, RetentionOutcome>;
  for (const name of NAMES) out[name] = await w.lifecycle.applyRetention(IDS[name], policy, now);
  return out;
}

/**
 * The content sweep. Live store BEFORE its archive (retention moves a log between them), pinned kinds
 * read from the lifecycle (`lifecycle.pinnedEventTypes`, so they cannot drift from what retention pins), and either the policy OR an explicit `olderThanMs` - exactly one of the two.
 */
export function sweep(
  w: World,
  now: number,
  how:
    | { policy: NonNullable<Parameters<typeof sweepUnpinnedContent>[0]["policy"]> }
    | { olderThanMs: number },
  dryRun: boolean
): Promise<ContentSweepReport> {
  return sweepUnpinnedContent({
    eventStores: [w.eventStore, w.archive.eventStore],
    contentStore: w.contentStore,
    pinnedEventTypes: w.lifecycle.pinnedEventTypes,
    ...how,
    now,
    dryRun,
  });
}
