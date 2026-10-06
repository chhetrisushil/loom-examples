import { seenToState } from "@loom-ui/core";
import { seenKeySubject, seenStreamKey } from "@loom-ui/lineage";
import { describe, expect, it } from "vitest";
import {
  EXPERIENCE_ID,
  SUMMARY,
  SUMMARY_LITE,
  exposureCap,
  handleFor,
  incidents,
  pager,
} from "../src/board";
import {
  DANA,
  LEE,
  MAX_VIEWS,
  RAW_ID,
  addressOf,
  composeBoard,
  createRig,
  editThenRevert,
  explain,
  headOf,
  holds,
  lineageBlobs,
  must,
  openBoard,
  setWorld,
  storeUnclassifiedExposure,
  sweep,
  viewsOf,
} from "../src/scenario";

const OPEN = handleFor(incidents, "open");
const ONCALL = handleFor(pager, "primary");
const EXPOSURE = handleFor(exposureCap, "accounts");

/** The day up to step 4: composed, edited and reverted, three views recorded over changing data. */
async function dayOfViews() {
  const rig = createRig();
  const planned = await composeBoard(rig);
  const edit = await editThenRevert(rig, planned.version);
  const d1 = { open: 7, primary: "Dana Ruiz", accounts: 1200 };
  setWorld(rig, d1);
  const danaV1 = await openBoard(rig, DANA); // dana approves on THIS view
  const leeV1 = await openBoard(rig, LEE);
  setWorld(rig, { open: 5 });
  const leeV2 = await openBoard(rig, LEE); // only lee ever sees open = 5
  setWorld(rig, { open: 3 });
  const danaV3 = await openBoard(rig, DANA);
  return { rig, planned, edit, danaV1, leeV1, leeV2, danaV3 };
}

describe("1. compose with the reference planner, stamped with its decision", () => {
  it("the ops carry the planner's provenance and the line verifies", async () => {
    const rig = createRig();
    const { composed, by } = await composeBoard(rig);
    expect(by).toMatchObject({
      source: "agent",
      modelId: "scripted-triage",
      decisionId: composed.report.decisionId,
    });
    expect(composed.report.decisionId).toBeTruthy();
    const e = await explain(rig, "open_incidents", DANA.viewer);
    expect(e).toMatchObject({
      available: true,
      type: "Metric",
      source: { kind: "provider", tools: ["incidents.open"] },
      created: { op: "insertNode", by: { decisionId: composed.report.decisionId } },
      changes: 0,
    });
    expect(await rig.lineage.verify(EXPERIENCE_ID)).toEqual([]);
  });

  it("the model's summary is untrusted text, and the planner classed it secret", async () => {
    const rig = createRig();
    const { composed } = await composeBoard(rig);
    expect(composed.summaryClass).toBe("secret"); // the strictest class of any offered capability
    const e = await explain(rig, "oncall", DANA.viewer);
    expect(e).toMatchObject({ available: true, why: { untrusted: true, text: SUMMARY } });
  });
});

describe("2. a hand edit, then a revert", () => {
  it("the edit is attributed to the person; the revert restores the ledger of the restored version", async () => {
    const rig = createRig();
    const { version } = await composeBoard(rig);
    const { edited, reverted } = await editThenRevert(rig, version);

    const during = await explain(rig, "open_incidents", DANA.viewer, { versionHash: edited });
    expect(during).toMatchObject({
      available: true,
      changes: 1,
      changed: { op: "setProps", by: { source: "user", agentId: "dana" } },
      // the creator is still the planner: an edit does not rewrite who made the card
      created: { by: { source: "agent" } },
    });

    const after = await explain(rig, "open_incidents", DANA.viewer); // head = the revert
    expect(after).toMatchObject({ available: true, changes: 0 });
    expect("changed" in after).toBe(false);

    // the revert is a NEW version (nothing rewritten), and it restores the composed content
    const versions = must(await rig.lineage.versions(EXPERIENCE_ID));
    expect(versions).toHaveLength(4); // genesis, planner compose, hand edit, revert
    expect(versions.at(-1)?.kind).toBe("reverted");
    expect(versions.at(-1)?.versionHash).toBe(reverted);
    const head = await headOf(rig);
    expect(JSON.stringify(head.root)).toContain('"unit":"incidents"');
    expect(await rig.lineage.verify(EXPERIENCE_ID)).toEqual([]);
  });
});

describe("3. explain, for a cleared viewer and a low-clearance one", () => {
  it("the restricted card is bare unavailable, identical to an id that does not exist", async () => {
    const rig = createRig();
    await composeBoard(rig);
    const hidden = await explain(rig, "customer_exposure", LEE.viewer);
    const unknown = await explain(rig, "no_such_card", LEE.viewer);
    expect(hidden).toEqual({ available: false });
    expect(unknown).toEqual({ available: false });
    // the same card, for the cleared on-call viewer
    expect(await explain(rig, "customer_exposure", DANA.viewer)).toMatchObject({
      available: true,
      source: { tools: ["legal.exposure"] },
    });
  });

  it("a classified card raises the floor: the words are withheld from a viewer who may see the other cards", async () => {
    const rig = createRig();
    await composeBoard(rig);
    const low = await explain(rig, "open_incidents", LEE.viewer);
    expect(low).toMatchObject({ available: true, created: { op: "insertNode" } });
    expect("why" in low).toBe(false); // the version holds a secret card; so lee gets no prose
    expect(JSON.stringify(low)).not.toContain(SUMMARY);
    expect(await explain(rig, "open_incidents", DANA.viewer)).toMatchObject({
      why: { text: SUMMARY },
    });
  });

  it("the same viewer reads the words on a board with no classified card", async () => {
    const rig = createRig();
    await composeBoard(rig, { experienceId: "incident-board-lite", withExposure: false });
    const e = await explain(rig, "open_incidents", LEE.viewer, {
      experienceId: "incident-board-lite",
    });
    expect(e).toMatchObject({ available: true, why: { untrusted: true, text: SUMMARY_LITE } });
  });
});

describe("3b. the class is the capability's, not the model's", () => {
  for (const [name, proposal] of [
    ["omits a class", undefined],
    ["proposes a LOWER class", "internal"],
  ] as const) {
    it(`a model that ${name} cannot open the classified card to a low viewer`, async () => {
      const rig = createRig();
      const { composed } = await composeBoard(rig, { ...(proposal && { proposal }) });
      expect(composed.summaryClass).toBe("secret");
      // the planner floors the node at the capability's class: the card is stored as secret
      const head = await headOf(rig);
      expect(JSON.stringify(head.root)).toContain('"sensitivity":"secret"');
      expect(await explain(rig, "customer_exposure", LEE.viewer)).toEqual({ available: false });
      expect(await explain(rig, "customer_exposure", DANA.viewer)).toMatchObject({
        available: true,
      });
      // and it is never fetched for the low viewer
      await openBoard(rig, LEE);
      expect(rig.invoker.calls).not.toContain("legal.exposure");
    });
  }

  it("a stored node with NO class of its own on that tool is hidden at read time by the bound policy", async () => {
    const rig = createRig();
    await storeUnclassifiedExposure(rig);
    const stored = must(await rig.lineage.resolveLatest(RAW_ID));
    const raw = JSON.stringify(stored.root).split('"id":"raw_exposure"')[1];
    expect(raw).toBeDefined();
    expect(raw).not.toContain("sensitivity"); // nobody classified it
    // the policy classes the TOOL: lee gets bare unavailable, identical to an unknown id ...
    const opts = { experienceId: RAW_ID };
    expect(await explain(rig, "raw_exposure", LEE.viewer, opts)).toEqual({ available: false });
    expect(await explain(rig, "raw_exposure", DANA.viewer, opts)).toMatchObject({
      available: true,
    });
    // ... the provider is never invoked for lee, and his recorded snapshot says it was restricted
    const seen = await openBoard(rig, LEE, RAW_ID);
    expect(rig.invoker.calls).not.toContain("legal.exposure");
    expect(JSON.stringify(seen.snapshot)).not.toContain("1200");
    // control: the SAME stored node with no policy bound is open to lee (the policy is what holds it)
    const open = createRig({ readPolicy: null });
    await storeUnclassifiedExposure(open);
    expect(await explain(open, "raw_exposure", LEE.viewer, opts)).toMatchObject({
      available: true,
    });
  });

  it("the words are withheld by the class FLOOR, not by the summary's class", async () => {
    const rig = createRig();
    await storeUnclassifiedExposure(rig); // summary is of an internal class (lite board)
    const opts = { experienceId: RAW_ID };
    const stored = must(await rig.lineage.versions(RAW_ID));
    expect(stored.length).toBeGreaterThan(1);
    const low = await explain(rig, "open_incidents", LEE.viewer, opts);
    expect(low).toMatchObject({ available: true });
    expect("why" in low).toBe(false); // a secret card raises the floor
    expect(JSON.stringify(low)).not.toContain(SUMMARY_LITE);
    // control: with no policy bound the floor is internal, and lee reads the same words
    const open = createRig({ readPolicy: null });
    await storeUnclassifiedExposure(open);
    expect(await explain(open, "open_incidents", LEE.viewer, opts)).toMatchObject({
      why: { text: SUMMARY_LITE },
    });
  });
});

describe("4. what each viewer was shown", () => {
  it("hydrates per viewer, and the classified provider is never invoked for the low viewer", async () => {
    const rig = createRig();
    await composeBoard(rig);
    await openBoard(rig, LEE);
    expect(rig.invoker.calls.sort()).toEqual(["incidents.open", "pager.oncall"]);
  });

  it("records the delivered values; the low viewer's snapshot only says something was restricted", async () => {
    const { danaV1, leeV1 } = await dayOfViews();
    const byHandle = (s: typeof danaV1.snapshot) =>
      Object.fromEntries(
        s.entries.map((e) => [e.source.kind === "handle" ? e.source.handle : "?", e.value])
      );
    expect(byHandle(danaV1.snapshot)).toEqual({
      [OPEN]: 7,
      [ONCALL]: "Dana Ruiz",
      [EXPOSURE]: 1200,
    });
    expect(danaV1.snapshot.entries.find((e) => e.value === 1200)?.class).toBe("secret");
    expect(byHandle(leeV1.snapshot)).toEqual({ [OPEN]: 7, [ONCALL]: "Dana Ruiz" });
    expect(leeV1.snapshot.restricted).toBe(true);
    expect(danaV1.snapshot.restricted).toBe(false);
  });

  it("the stream holds no readable address or value: refs are sealed under a per-viewer key", async () => {
    const { rig } = await dayOfViews();
    const raw = JSON.stringify(await rig.seenEvents.read(seenStreamKey(EXPERIENCE_ID, "dana")));
    expect(raw).toContain("VIEW_RECORDED");
    expect(raw).not.toContain(addressOf(7).slice("sha256:".length));
    expect(raw).not.toContain(addressOf(1200).slice("sha256:".length));
    expect(raw).not.toContain("Dana Ruiz");
  });

  it("the same value is one blob however many viewers saw it", async () => {
    const { rig } = await dayOfViews();
    // dana and lee both saw 7; the store keeps ONE content-addressed copy
    expect(await holds(rig, 7)).toBe(true);
    const page = await rig.content.listPage?.({ limit: 1000 });
    const addresses = (page?.entries ?? []).map((e) => e.address);
    expect(addresses.filter((a) => a === addressOf(7))).toHaveLength(1);
  });
});

describe("5. replay what they saw when they approved", () => {
  it("`until` returns the view as of the approval, and seenToState rebuilds the store shape", async () => {
    const { rig, danaV1 } = await dayOfViews();
    const asOfApproval = await viewsOf(rig, "dana", { until: danaV1.at });
    expect(asOfApproval.views).toHaveLength(1);
    const state = seenToState(asOfApproval.views[0]!.entries);
    expect(state.values).toEqual({ [OPEN]: 7, [ONCALL]: "Dana Ruiz", [EXPOSURE]: 1200 });
    expect(state.status[OPEN]).toBe("ready");

    // the data has moved on: the NEWEST view is not what was approved
    const latest = await viewsOf(rig, "dana");
    expect(latest.views).toHaveLength(2);
    expect(seenToState(latest.views[0]!.entries).values[OPEN]).toBe(3);
    expect(rig.world.open).toBe(3);
  });

  it("the READER is redacted too: a low-clearance reader never gets the classified entry", async () => {
    const { rig } = await dayOfViews();
    const asLee = await viewsOf(rig, "dana", { reader: LEE.viewer });
    const state = seenToState(asLee.views.at(-1)!.entries);
    expect(state.values).toEqual({ [OPEN]: 7, [ONCALL]: "Dana Ruiz" });
    expect(asLee.views.at(-1)?.restricted).toBe(true);
  });
});

describe("6. erase a viewer, collect garbage, roll off old views", () => {
  it("eraseViewer is crypto-shredding: reads say erased, record refuses, the key is gone", async () => {
    const { rig } = await dayOfViews();
    must(await rig.log.eraseViewer({ experienceId: EXPERIENCE_ID, viewerId: "lee" }));
    expect(await viewsOf(rig, "lee")).toMatchObject({ erased: true, views: [] });
    // the viewer's key is destroyed ...
    expect(await rig.keys.get(seenKeySubject(seenStreamKey(EXPERIENCE_ID, "lee")))).toBeFalsy();
    expect(await rig.keys.get(seenKeySubject(seenStreamKey(EXPERIENCE_ID, "dana")))).toBeTruthy();
    // ... the history stays: events are there, as ciphertext, with the erasure marker
    const raw = JSON.stringify(await rig.seenEvents.read(seenStreamKey(EXPERIENCE_ID, "lee")));
    expect(raw).toContain("VIEWER_ERASED");
    expect(raw).toContain("VIEW_RECORDED");
    expect(raw).not.toContain(addressOf(5).slice("sha256:".length));
    expect(raw).not.toContain("Dana Ruiz");
    const again = await openBoard(rig, LEE).then(
      () => "recorded",
      (e: Error) => e.message
    );
    expect(again).toContain("seen-viewer-erased");
    // the other viewer is untouched
    expect((await viewsOf(rig, "dana")).views).toHaveLength(2);
  });

  it("a sweep BEFORE the erasure deletes nothing; the erased viewer's blob is in the store until the next one", async () => {
    const { rig } = await dayOfViews();
    expect((await sweep(rig)).deleted).toBe(0); // every blob is rooted by a live view: control
    expect(await holds(rig, 5)).toBe(true);
    must(await rig.log.eraseViewer({ experienceId: EXPERIENCE_ID, viewerId: "lee" }));
    expect(await holds(rig, 5)).toBe(true); // shredding hides it; it does not delete it
  });

  it("the sweep reclaims the erased viewer's unique blob; shared and lineage blobs survive", async () => {
    const { rig } = await dayOfViews();
    expect((await sweep(rig)).deleted).toBe(0); // control: nothing is garbage before the erasure
    must(await rig.log.eraseViewer({ experienceId: EXPERIENCE_ID, viewerId: "lee" }));
    const cited = await lineageBlobs(rig);
    expect(cited.length).toBeGreaterThan(0);

    const report = await sweep(rig);
    expect(report.deleted).toBe(1);
    expect(await holds(rig, 5)).toBe(false); // seen only by lee
    expect(await holds(rig, 7)).toBe(true); // lee saw it too, but dana's view roots it
    expect(await holds(rig, "Dana Ruiz")).toBe(true);
    expect(await holds(rig, 1200)).toBe(true);
    for (const a of cited) expect(await rig.content.get({ __loomContent: a })).not.toBeNull();
    // ... and dana's view of the shared value still reads back
    const dana = await viewsOf(rig, "dana");
    expect(dana.views.at(-1)?.entries.find((e) => e.state === "seen")?.value).toBeDefined();
    expect(seenToState(dana.views.at(-1)!.entries).values[OPEN]).toBe(7);
    // idempotent
    expect((await sweep(rig)).deleted).toBe(0);
  });

  it(`retention rolls off, it does not refuse: past maxViews=${MAX_VIEWS} the oldest view falls out and its blobs are reclaimed`, async () => {
    const { rig } = await dayOfViews();
    must(await rig.log.eraseViewer({ experienceId: EXPERIENCE_ID, viewerId: "lee" }));
    await sweep(rig);
    setWorld(rig, { open: 2 });
    const v4 = await openBoard(rig, DANA);
    setWorld(rig, { open: 1, accounts: 900 });
    const v5 = await openBoard(rig, DANA);
    expect(v4.recorded && v5.recorded).toBe(true); // a new view ALWAYS records

    const kept = await viewsOf(rig, "dana");
    expect(kept.views).toHaveLength(MAX_VIEWS);
    expect(kept.views.map((v) => seenToState(v.entries).values[OPEN])).toEqual([1, 2, 3]);

    // the first view (open = 7) is out of the window: unrooted, so the next sweep reclaims it
    expect(await holds(rig, 7)).toBe(true);
    const report = await sweep(rig);
    expect(report.deleted).toBe(1); // open = 7: no kept view and no lineage artifact names it
    expect(await holds(rig, 7)).toBe(false);
    expect(await holds(rig, 3)).toBe(true);
    expect(await holds(rig, 1200)).toBe(true); // views 3 and 4 still saw it
    expect(await holds(rig, "Dana Ruiz")).toBe(true); // still in every kept view
    expect(await rig.lineage.verify(EXPERIENCE_ID)).toEqual([]);
  });
});
