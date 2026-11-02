import { RetentionPolicyError, retentionPolicy } from "@loom/workflow-runtime";
import { IDS, NAMES, type Name, blobOf, buildHistory, snapshotSequences } from "./history";
import { applyAll, evaluateAll, sweep } from "./passes";
// Narrated demo: `pnpm start`. Offline, SQLite in a temp dir, a simulated clock - no real waits.
import { DAY } from "./retention";
import { retention } from "./retention";
import { PINNED_KINDS, type World, newWorld } from "./world";

const short = (ref: string): string => `${ref.slice(0, 15)}...`;

async function main(): Promise<void> {
  const w = newWorld();
  try {
    console.log("== 1. The policy is a value the app owns (retention.ts), not defineConfig ==");
    console.log(JSON.stringify(retention), "(frozen:", Object.isFrozen(retention), ")");

    console.log("\n== 2. Seven executions across 95 simulated days ==");
    await buildHistory(w);
    for (const name of NAMES) {
      const state = await w.runtime.loadState(IDS[name]);
      console.log(`  ${name.padEnd(9)} ${state?.status}`);
    }
    const blobs = await blobsOf(w);

    w.clock.set(100);
    const now = w.clock.now();
    console.log(`\n== 3. Day ${w.clock.day}: retention DRY RUN (nothing changes) ==`);
    console.log(" ", JSON.stringify(await evaluateAll(w, retention, now)));
    console.log(
      "  same answer with the bare number (no policy):",
      JSON.stringify(await evaluateAll(w, { terminalTtlMs: 90 * DAY }, now)) ===
        JSON.stringify(await evaluateAll(w, retention, now))
    );

    console.log(
      "\n== 4. Snapshot pruning, driven by the policy (keepLatest from retention.snapshots) =="
    );
    const before = await snapshotSequences(w, "reopened"); // listSequences: one index scan
    const preview = await w.lifecycle.pruneSnapshots(IDS.reopened, {
      policy: retention,
      dryRun: true,
    });
    console.log(`  reopened snapshots ${JSON.stringify(before)}; dry run would prune ${preview}`);
    const pruned = await w.lifecycle.pruneSnapshots(IDS.reopened, { policy: retention });
    console.log(
      `  real prune removed ${pruned} (preview == actual: ${preview === pruned}) ->`,
      JSON.stringify(await snapshotSequences(w, "reopened"))
    );

    console.log("\n== 5. Retention APPLY: archive first, then delete from the live store ==");
    console.log(" ", JSON.stringify(await applyAll(w, retention, now)));
    for (const name of ["early", "ledger"] as const) {
      console.log(
        `  ${name}: live events ${(await w.eventStore.read(IDS[name])).length}, archived events ${(await w.archive.eventStore.read(IDS[name])).length}`
      );
    }

    console.log(
      `\n== 6. Content sweep at day ${w.clock.day} (policy.content.unpinnedAfterMs = 90d) ==`
    );
    console.log(
      "  pinned kinds, one source:",
      JSON.stringify(w.lifecycle.pinnedEventTypes),
      "(LogLifecycle option -> lifecycle.pinnedEventTypes -> the sweep; same as PINNED_KINDS:",
      JSON.stringify(w.lifecycle.pinnedEventTypes) === JSON.stringify(PINNED_KINDS),
      ")"
    );
    const dry = await sweep(w, now, { policy: retention }, true);
    console.log(
      "  dry run would reclaim:",
      dry.reclaimed.map((r) => nameOf(blobs, r))
    );
    console.log(
      "  heldByEndClock       :",
      (dry.heldByEndClock ?? []).map((r) => nameOf(blobs, r)),
      "(the citation clock alone would have erased these)"
    );
    console.log(
      `  refsPinned ${dry.refsPinned}, refsLoadBearing ${dry.refsLoadBearing}, refsAgedByEnd ${dry.refsAgedByEnd}`
    );
    console.log(
      "  (refsLoadBearing 2 = the retained ledger blob + the finding's evidence, which the `finding`",
      "event records as a BARE ref (ADR 0055 D4); that one is also pinned, so the counts overlap)"
    );
    console.log(
      `  refsOfReopened ${dry.refsOfReopened}, reclaimedWhileReopened:`,
      (dry.reclaimedWhileReopened ?? []).map((r) => nameOf(blobs, r)),
      "(re-opened after it ended: ages on the citation clock, so its blob goes while its log is kept)"
    );
    const applied = await sweep(w, now, { policy: retention }, false);
    console.log(
      "  applied, reclaimed   :",
      applied.reclaimed.map((r) => nameOf(blobs, r))
    );
    console.log(
      "  longrun blob still resolves:",
      (await w.contentStore.get({ __loomContent: blobs.longrun })) !== null
    );

    w.clock.set(150);
    console.log(
      `\n== 7. Day ${w.clock.day}: longrun ended on day 60, so its blob is now 90 days past its END ==`
    );
    const later = await sweep(w, w.clock.now(), { policy: retention }, false);
    console.log(
      "  reclaimed:",
      later.reclaimed.map((r) => nameOf(blobs, r))
    );
    console.log(
      "  never reclaimed (pinned finding evidence, retained ledger):",
      (await w.contentStore.get({ __loomContent: blobs.finding })) !== null,
      (await w.contentStore.get({ __loomContent: blobs.ledger })) !== null
    );

    console.log("\n== 8. Two clocks in a sweep (loom docs/usage-cli.md, 'Clocks in a sweep') ==");
    const skewed = newWorld({ contentClock: () => 10_000 * DAY }); // the store's clock runs far ahead
    try {
      await buildHistory(skewed);
      skewed.clock.set(100);
      const skewedBlobs = await blobsOf(skewed);
      const skewedDry = await sweep(skewed, skewed.clock.now(), { policy: retention }, true);
      const skewedApply = await sweep(skewed, skewed.clock.now(), { policy: retention }, false);
      console.log(
        "  store clock != log clock: dry run lists",
        skewedDry.reclaimed.map((r) => nameOf(skewedBlobs, r)),
        `but apply reclaimed ${JSON.stringify(skewedApply.reclaimed)}, keptByTouch ${skewedApply.keptByTouch}`
      );
      console.log(
        `  touchCutoff ${skewedApply.touchCutoff! / DAY}d on the store's clock; its blobs were stamped 10000d`
      );
    } finally {
      await skewed.close();
    }
    console.log(
      `  shared SimClock (this world, section 6): apply reclaimed ${applied.reclaimed.length}, keptByTouch ${applied.keptByTouch}`
    );

    console.log("\n== 9. A policy that breaks the rule is refused at construction ==");
    try {
      retentionPolicy({ terminalTtlMs: 90 * DAY, content: { unpinnedAfterMs: 30 * DAY } });
    } catch (e) {
      console.log(
        `  ${e instanceof RetentionPolicyError ? "RetentionPolicyError" : "?"}: ${(e as Error).message.slice(0, 110)}...`
      );
    }
  } finally {
    await w.close();
  }
}

async function blobsOf(world: World): Promise<Record<Name, string>> {
  return Object.fromEntries(
    await Promise.all(NAMES.map(async (n) => [n, await blobOf(world, n)] as const))
  ) as Record<Name, string>;
}

function nameOf(blobs: Record<Name, string>, ref: string): string {
  const hit = NAMES.find((n) => blobs[n] === ref);
  return hit ?? short(ref);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
