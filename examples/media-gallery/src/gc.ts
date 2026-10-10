import type { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { type ContentSweepReport, sweepUnpinnedContent } from "@loom/plugin-content";
import type { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { MediaVault } from "./vault";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reclaim media nobody cites any more. The mark phase reads the LOG: a blob cited as a media source
 * (`{ kind: "ref", ref: { address } }`) anywhere in a scanned execution is pinned. Everything else older than
 * the TTL (a `put` whose append never landed, a deleted run's leftovers) is an orphan and is erased.
 * `reclaimOrphans` is always on, so the scan must be COMPLETE: a blob cited only by a store you did not pass is
 * an orphan and is erased. Pass every event store, every snapshot store and every external root; try `dryRun` first.
 * `now` is LOG time; the store stamps touch times on its own clock, so the cutoff is derived from that.
 */
export function sweepMedia(
  vault: MediaVault,
  stores: { eventStore: InMemoryAsyncEventStore; snapshotStore: InMemoryAsyncSnapshotStore },
  options: {
    now: number;
    olderThanMs?: number;
    /** EVERY event store that may cite a blob. Default: just `stores.eventStore`. Omitting one DELETES what only it cites. */
    eventStores?: readonly InMemoryAsyncEventStore[];
    /** EVERY snapshot store (a compacted prefix's refs live only there). Default: just `stores.snapshotStore`. */
    snapshotStores?: readonly InMemoryAsyncSnapshotStore[];
    /** Report what WOULD be reclaimed, deleting nothing. Run this first. */
    dryRun?: boolean;
    /** Addresses held OUTSIDE any log (an app table such as a photo library): pinned through both passes. */
    roots?: () => AsyncIterable<string>;
  }
): Promise<ContentSweepReport> {
  return sweepUnpinnedContent({
    eventStores: options.eventStores ?? [stores.eventStore],
    snapshotStores: options.snapshotStores ?? [stores.snapshotStore],
    contentStore: vault.store,
    pinnedEventTypes: [],
    olderThanMs: options.olderThanMs ?? 7 * DAY_MS,
    now: options.now,
    reclaimOrphans: true,
    ...(options.dryRun === true && { dryRun: true }),
    ...(options.roots !== undefined && { roots: options.roots }),
  });
}
