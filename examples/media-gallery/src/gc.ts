import type { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { type ContentSweepReport, sweepUnpinnedContent } from "@loom/plugin-content";
import type { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import type { MediaVault } from "./vault";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reclaim media nobody cites any more. The mark phase reads the LOG: a blob cited as a media source
 * (`{ kind: "ref", ref: { address } }`) anywhere in a scanned execution is pinned. Everything else older than
 * the TTL (a `put` whose append never landed, a deleted run's leftovers) is an orphan and is erased.
 * `now` is LOG time; the store stamps touch times on its own clock, so the cutoff is derived from that.
 */
export function sweepMedia(
  vault: MediaVault,
  stores: { eventStore: InMemoryAsyncEventStore; snapshotStore: InMemoryAsyncSnapshotStore },
  options: {
    now: number;
    olderThanMs?: number;
    eventStores?: readonly InMemoryAsyncEventStore[];
    /** Addresses held OUTSIDE any log (an app table such as a photo library): pinned through both passes. */
    roots?: () => AsyncIterable<string>;
  }
): Promise<ContentSweepReport> {
  return sweepUnpinnedContent({
    eventStores: options.eventStores ?? [stores.eventStore],
    snapshotStores: [stores.snapshotStore],
    contentStore: vault.store,
    pinnedEventTypes: [],
    olderThanMs: options.olderThanMs ?? 7 * DAY_MS,
    now: options.now,
    reclaimOrphans: true,
    ...(options.roots !== undefined && { roots: options.roots }),
  });
}
