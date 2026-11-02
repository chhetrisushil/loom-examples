// The app-owned retention policy (loom ADR 0145).
//
// One validated, frozen VALUE the app keeps in its own module. It is deliberately NOT part of
// `defineConfig`: configuration says how the app is composed, not what an operator may destroy and
// when. The cron job, the CLI (`loom retention run --policy ./src/retention.ts`) and the app's own
// code all read this same value, so the numbers are stated once and checked once.
import { retentionPolicy } from "@loom/workflow-runtime";

export const DAY = 24 * 60 * 60 * 1000;

export const retention = retentionPolicy({
  // Keep a finished execution for 90 days after it ENDED, then archive-and-delete it.
  terminalTtlMs: 90 * DAY,
  // Pruning keeps the newest snapshot. There is no age clock on snapshots: the latest one is state.
  snapshots: { keepLatest: 1 },
  // A reclaimable (telemetry) blob is erasable 90 days after the citing run ended - never before
  // the log that cites it could itself be deleted (ADR 0146). Must be >= terminalTtlMs.
  content: { unpinnedAfterMs: 90 * DAY },
});
