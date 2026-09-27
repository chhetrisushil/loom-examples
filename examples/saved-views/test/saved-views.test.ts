import type { EventEnvelope } from "@loom/core";
import { isClaimCheck } from "@loom/middleware";
import { InMemoryContentStore, sweepUnpinnedContent } from "@loom/plugin-content";
import type { ContentStore } from "@loom/plugin-content";
import { beforeEach, describe, expect, it } from "vitest";
import { type SavedViewsApp, buildApp } from "../src/app";
import { CATALOG_ID } from "../src/catalogue";
import { composeOffCatalogue, composeSpendView } from "../src/compose";
import { BLUEPRINT_COMPOSED, type PromoteOutput, VIEW_DRAFTED, openView } from "../src/flow";
import {
  INCIDENT_OPENED,
  SPEND_SAMPLED,
  incidents,
  spendMonthToDate,
  spendRolling7d,
} from "../src/projections";

// The recipe is `loom/docs/composed-surfaces.md`; these are the properties it claims, as
// assertions. Two of them are negative cases, because "validated" and "recorded" look
// identical in a green suite unless something proves the bad blueprint stayed out of the log.

const SAMPLES = [
  { daysAgo: 1, thisMonth: true, amount: 400 },
  { daysAgo: 5, thisMonth: true, amount: 350 },
  { daysAgo: 20, thisMonth: true, amount: 900 },
];

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
  for (const s of SAMPLES) bundle.app.projectionRuntime.handleEvent(envelope(SPEND_SAMPLED, s));
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

const INTENT = "what are we spending, and is anything on fire?";

describe("promotion — an artifact, and what the log holds", () => {
  let content: ContentStore;
  let before: SavedViewsApp;

  beforeEach(() => {
    content = new InMemoryContentStore();
    before = buildApp(content, [spendRolling7d, incidents], (intent, pins) =>
      composeSpendView({ intent, pins })
    );
    seed(before);
  });

  it("records the ADDRESS, never the tree", async () => {
    const saved = await promote(before, INTENT);
    const log = await before.app.stores.eventStore.read(saved.executionId);
    const composed = log.find((e) => e.eventType === BLUEPRINT_COMPOSED);

    expect(composed).toBeDefined();
    const payload = composed?.payload as { ref: { __loomContent: string }; catalogId: string };
    expect(payload.ref.__loomContent).toBe(saved.ref);
    // The widgets are in the content store. A log that carried the tree would grow with
    // every re-composition and would hold a copy of one viewer's arrangement forever.
    expect(JSON.stringify(payload)).not.toContain("MetricCard");
  });

  it("two identical compositions collapse to one address", async () => {
    const first = await promote(before, INTENT);
    const second = await promote(before, INTENT);
    expect(second.ref).toBe(first.ref);
  });

  it("an off-catalogue component reaches NOTHING — not the store, not the log", async () => {
    const offCatalogue = buildApp(content, [spendRolling7d, incidents], (intent, pins) =>
      composeOffCatalogue({ intent, pins })
    );
    const degraded = await promote(offCatalogue, "names a component nobody audited");

    expect(degraded.ref).toBeNull();
    expect(degraded.findings).toEqual(["unknown-kind:spend-timeline"]);
    // Asserted on the emitted stream, not on the return value: a recorded blueprint is
    // durable, and every replay would reproduce it.
    const log = await offCatalogue.app.stores.eventStore.read(degraded.executionId);
    expect(log.filter((e) => e.eventType === BLUEPRINT_COMPOSED)).toEqual([]);
    expect(log.filter((e) => e.eventType === VIEW_DRAFTED)).toEqual([]);
  });
});

describe("re-opening — the question a content address cannot answer", () => {
  it("an unchanged fold is a pass, and the report says how much it compared", async () => {
    const content = new InMemoryContentStore();
    const before = buildApp(content, [spendRolling7d, incidents], (intent, pins) =>
      composeSpendView({ intent, pins })
    );
    seed(before);
    const saved = await promote(before, INTENT);

    const opened = await openView({ __loomContent: saved.ref as string }, content, before.pins());

    expect(opened.pinned.ok).toBe(true);
    expect(opened.pinned.compared).toBe(2);
    expect(opened.pinned.findings).toEqual([]);
  });

  it("a deploy that changes ONE fold is a drift finding on ONE binding", async () => {
    const content = new InMemoryContentStore();
    const before = buildApp(content, [spendRolling7d, incidents], (intent, pins) =>
      composeSpendView({ intent, pins })
    );
    seed(before);
    const saved = await promote(before, INTENT);
    const ref = { __loomContent: saved.ref as string };

    // The deploy: same id, same widgets, same address — a different window.
    const after = buildApp(content, [spendMonthToDate, incidents], (intent, pins) =>
      composeSpendView({ intent, pins })
    );
    seed(after);

    // The rendered number really does move, which is what makes the silence dangerous.
    expect(
      (before.app.projectionRuntime.getState("spend", "seed") as { total: number }).total
    ).toBe(750);
    expect((after.app.projectionRuntime.getState("spend", "seed") as { total: number }).total).toBe(
      1650
    );

    const opened = await openView(ref, content, after.pins());
    expect(opened.view.id).toBe("spend-and-incidents"); // byte-identical structure
    expect(opened.pinned.ok).toBe(false);
    expect(opened.pinned.findings).toHaveLength(1);
    expect(opened.pinned.findings[0]).toMatchObject({
      code: "drift",
      severity: "error",
      id: "spend",
      recorded: "1",
      current: "2",
    });
    // `incidents` did not move, so it is not in the findings — a report that flagged the
    // whole view would be as useless as one that flagged nothing.
    expect(opened.pinned.compared).toBe(2);
  });

  it("a view promoted before the pin existed is REPORTED, not read as unchanged", async () => {
    const content = new InMemoryContentStore();
    const legacy = buildApp(content, [spendRolling7d, incidents], (intent) =>
      composeSpendView({ intent, pins: {} })
    );
    seed(legacy);
    const saved = await promote(legacy, "last quarter's view");

    const opened = await openView({ __loomContent: saved.ref as string }, content, legacy.pins());

    // ok: true and compared: 0 together mean "nothing was checked" — and the findings are
    // what stop a caller reading the first half without the second.
    expect(opened.pinned.compared).toBe(0);
    expect(opened.pinned.findings.map((f) => [f.id, f.code])).toEqual([
      ["spend", "unpinned"],
      ["incidents", "unpinned"],
    ]);
  });
});

describe("pinning — promotion is what survives the sweep", () => {
  it("reclaims the draft and keeps the promoted view", async () => {
    const content = new InMemoryContentStore();
    const app = buildApp(content, [spendRolling7d, incidents], (intent, pins) =>
      composeSpendView({ intent, pins })
    );
    seed(app);
    const saved = await promote(app, INTENT);
    const draft = await promote(app, "a question I asked once", { promote: false });
    expect(draft.ref).not.toBe(saved.ref);

    // The draft's ref must be cited as a REAL claim-check envelope (ADR 0054's shape,
    // `@loom/middleware`'s `isClaimCheck`), not a vendored look-alike — that's the one form
    // ADR 0055 D4 still lets the sweep reclaim.
    const draftLog = await app.app.stores.eventStore.read(draft.executionId);
    const drafted = draftLog.find((e) => e.eventType === VIEW_DRAFTED);
    expect(isClaimCheck((drafted?.payload as { ref: unknown } | undefined)?.ref)).toBe(true);

    // A TTL of 0 means "untouched since strictly before the sweep started". Since ContentStore SPI
    // 1.3.0 the sweep only erases a blob whose touch time is older than that cutoff (ADR 0055
    // D5), so a draft put in the same millisecond is correctly kept. Let the clock move past it.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const report = await sweepUnpinnedContent({
      eventStores: [app.app.stores.eventStore],
      contentStore: content,
      pinnedEventTypes: [BLUEPRINT_COMPOSED],
      olderThanMs: 0,
      now: Date.now(),
    });

    expect(report.refsSeen).toBe(2);
    expect(report.refsPinned).toBe(1);
    // The promoted ref is cited bare, so it is load-bearing too (ADR 0055 D4) — that is
    // belt-and-braces here since BLUEPRINT_COMPOSED already pins it. The draft's ref is
    // NOT load-bearing: VIEW_DRAFTED cites it only inside a claim-check envelope, the one
    // form D4 still lets the sweep reclaim once nothing pins it.
    expect(report.refsLoadBearing).toBe(1);
    expect(report.reclaimed).toEqual([draft.ref]);
    expect(await content.get({ __loomContent: saved.ref as string })).not.toBeNull();
    expect(await content.get({ __loomContent: draft.ref as string })).toBeNull();
  });

  it("a draft cited BARE would never be reclaimed, regardless of TTL (ADR 0055 D4)", async () => {
    // The regression this whole example is one call from re-introducing: if VIEW_DRAFTED
    // cited its ref the same way BLUEPRINT_COMPOSED does — bare — the draft would be
    // load-bearing forever and "pin it, or the sweep reclaims it" would be false. Proven
    // directly against the sweep with a synthetic bare-cited event, since the flow's whole
    // point (after this fix) is that it never produces one.
    const content = new InMemoryContentStore();
    const ref = await content.put(new TextEncoder().encode(JSON.stringify({ some: "draft" })));
    const bareDrafted: EventEnvelope = {
      id: "bare-draft-0",
      workflowId: "bare-draft",
      executionId: "bare-draft",
      eventType: VIEW_DRAFTED,
      sequence: 0,
      timestamp: Date.now() - 1_000,
      payload: { ref, catalogId: CATALOG_ID, intent: "a question I asked once" },
    };

    const report = await sweepUnpinnedContent({
      eventStores: [
        {
          listExecutions: async () => ["bare-draft"],
          read: async () => [bareDrafted],
        },
      ],
      contentStore: content,
      pinnedEventTypes: [BLUEPRINT_COMPOSED],
      olderThanMs: 0,
      now: Date.now(),
    });

    expect(report.refsLoadBearing).toBe(1);
    expect(report.reclaimed).toEqual([]);
    expect(await content.get(ref)).not.toBeNull();
  });
});
