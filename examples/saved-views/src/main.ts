import type { EventEnvelope } from "@loom/core";
import { InMemoryContentStore, sweepUnpinnedContent } from "@loom/plugin-content";
import type { ContentStore } from "@loom/plugin-content";
import { type SavedViewsApp, buildApp } from "./app";
import { composeOffCatalogue, composeSpendView } from "./compose";
import { BLUEPRINT_COMPOSED, type PromoteOutput, openView } from "./flow";
import {
  INCIDENT_OPENED,
  SPEND_SAMPLED,
  incidents,
  spendMonthToDate,
  spendRolling7d,
} from "./projections";

/**
 * Saved Views — a composed surface as a logged artifact, and what happens to it afterwards.
 *
 *   compose   → from a CLOSED catalogue, validated before anything is recorded
 *   record    → the tree by `sha256:` ref; the log holds the address, not the widgets
 *   promote   → which EVENT cites the ref is the difference between saved and ephemeral
 *   re-open   → a read, not a generation: no model between the click and the pixels
 *   check     → and the one question an address cannot answer: does it still MEAN this?
 *
 * The last step is why the example exists. Halfway through, the fold behind `spend` changes
 * from a rolling week to a calendar month — a deploy, not an edit to any view — and every
 * saved view bound to it renders a different number under an unchanged hash.
 *
 * Run with:  pnpm --filter @loom/saved-views start
 */

function section(title: string): void {
  console.log(`\n${"─".repeat(72)}\n  ${title}\n${"─".repeat(72)}`);
}

const SAMPLES = [
  { daysAgo: 1, thisMonth: true, amount: 400 },
  { daysAgo: 5, thisMonth: true, amount: 350 },
  // Outside the rolling week, inside the calendar month — the sample the two folds
  // disagree about, and the entire difference between $750 and $1,650.
  { daysAgo: 20, thisMonth: true, amount: 900 },
];

/** Feed the projections directly: where the telemetry comes from is not this example's
 *  subject, and a seeded fold keeps every number below reproducible. */
function seed(bundle: SavedViewsApp): void {
  let sequence = 0;
  const envelope = (eventType: string, payload: unknown): EventEnvelope => ({
    id: `seed-${sequence}`,
    workflowId: "seed",
    executionId: "seed",
    eventType,
    sequence: sequence++,
    timestamp: 1_700_000_000_000 + sequence,
    payload,
  });
  for (const sample of SAMPLES) {
    bundle.app.projectionRuntime.handleEvent(envelope(SPEND_SAMPLED, sample));
  }
  bundle.app.projectionRuntime.handleEvent(envelope(INCIDENT_OPENED, {}));
}

async function promote(
  bundle: SavedViewsApp,
  intent: string,
  options: { promote?: boolean } = {}
): Promise<PromoteOutput & { executionId: string }> {
  const handle = await bundle.app.runtime.start(bundle.flow, { intent, ...options });
  const state = await handle.waitForCompletion();
  return { ...(state.variables._output as PromoteOutput), executionId: handle.executionId };
}

function spendOf(bundle: SavedViewsApp): number {
  return (bundle.app.projectionRuntime.getState("spend", "seed") as { total: number }).total;
}

async function main(): Promise<void> {
  const content: ContentStore = new InMemoryContentStore();

  // ── Before the deploy: `spend` means a rolling 7-day window ─────────────────
  const before = buildApp(content, [spendRolling7d, incidents], (intent, pins) =>
    composeSpendView({ intent, pins })
  );
  seed(before);

  section("1. Compose and promote — validate BEFORE anything is recorded");
  const intent = "what are we spending, and is anything on fire?";
  const saved = await promote(before, intent);
  console.log(`validated ${saved.widgets} widgets, 0 findings`);
  console.log(`stored at ${saved.ref}`);
  console.log(`the fold behind "spend" declares version ${before.pins().spend}`);

  section("2. What the log holds — an address, never the tree");
  const log = await before.app.stores.eventStore.read(saved.executionId);
  const composed = log.find((e) => e.eventType === BLUEPRINT_COMPOSED);
  console.log(JSON.stringify(composed?.payload));
  console.log(`payload bytes: ${JSON.stringify(composed?.payload).length} — the tree is elsewhere`);

  section("3. Re-open it — a read, and the pin says it still means what it meant");
  const ref = { __loomContent: saved.ref as string };
  const first = await openView(ref, content, before.pins());
  console.log(`spend = $${spendOf(before)} (rolling 7 days)`);
  console.log(
    `pins: ok=${first.pinned.ok} compared=${first.pinned.compared} findings=${first.pinned.findings.length}`
  );

  section("4. A deploy changes the fold behind `spend` — nothing about the view changes");
  const after = buildApp(content, [spendMonthToDate, incidents], (intent2, pins) =>
    composeSpendView({ intent: intent2, pins })
  );
  seed(after);
  console.log(`same view, same hash, same widgets. spend = $${spendOf(after)} (month to date)`);

  const reopened = await openView(ref, content, after.pins());
  console.log(`pins: ok=${reopened.pinned.ok} compared=${reopened.pinned.compared}`);
  for (const finding of reopened.pinned.findings) {
    console.log(`  ${finding.severity}: ${finding.message}`);
  }
  console.log("\nThe number moved by $900 and every other check in the system is green.");

  section("5. A view promoted before the pin existed — reported, never a silent pass");
  const legacy = buildApp(content, [spendMonthToDate, incidents], (intent3) =>
    // Composed with NO pins: the artifact predates the mechanism.
    composeSpendView({ intent: intent3, pins: {} })
  );
  seed(legacy);
  const legacySaved = await promote(legacy, "last quarter's saved view");
  const legacyOpened = await openView(
    { __loomContent: legacySaved.ref as string },
    content,
    legacy.pins()
  );
  console.log(
    `compared=${legacyOpened.pinned.compared} — nothing was checked, and the report says so:`
  );
  for (const finding of legacyOpened.pinned.findings)
    console.log(`  ${finding.code}: ${finding.id}`);

  section("6. An off-catalogue component never reaches the log");
  const offCatalogue = buildApp(content, [spendRolling7d, incidents], (intent4, pins) =>
    composeOffCatalogue({ intent: intent4, pins })
  );
  const degraded = await promote(offCatalogue, "a view naming a component nobody audited");
  console.log(`ref=${degraded.ref} findings=${degraded.findings.join(", ")}`);
  const offLog = await offCatalogue.app.stores.eventStore.read(degraded.executionId);
  console.log(
    `events carrying a blueprint: ${offLog.filter((e) => "ref" in (e.payload as object)).length}`
  );

  section("7. Pin it, or the sweep reclaims it");
  const draft = await promote(before, "a question I asked once", { promote: false });
  const report = await sweepUnpinnedContent({
    eventStores: [before.app.stores.eventStore],
    contentStore: content,
    pinnedEventTypes: [BLUEPRINT_COMPOSED],
    olderThanMs: 0,
    now: Date.now(),
  });
  console.log(`refs seen ${report.refsSeen}, pinned ${report.refsPinned}`);
  console.log(`reclaimed the draft: ${report.reclaimed.includes(draft.ref as string)}`);
  console.log(`the promoted view survives: ${(await content.get(ref)) !== null}`);

  await before.app.close();
  await after.app.close();
  await legacy.app.close();
  await offCatalogue.app.close();
}

void main();
