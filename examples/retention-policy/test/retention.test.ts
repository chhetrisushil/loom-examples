import { sweepUnpinnedContent } from "@loom/plugin-content";
import { RetentionPolicyError, retentionPolicy } from "@loom/workflow-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDS, type Name, blobOf, buildHistory, snapshotSequences } from "../src/history";
import { applyAll, evaluateAll, sweep } from "../src/passes";
import { DAY, retention } from "../src/retention";
import { type World, newWorld } from "../src/world";

// Every number below is a day on the simulated clock (day 0 = 2026-01-01); nothing waits in real time.
// The timeline (src/history.ts): early ends d0 | longrun cites d0 and ENDS d60 | finding records a
// FindingRecorded d1 | reopened cites d2, ends d70, is RE-OPENED d80 | ledger (retained blob) ends d2 |
// parked starts d40 and never finishes | recent ends d95.

let w: World;
let blobs: Record<Name, string>;
const sorted = (xs: readonly string[]): string[] => [...xs].sort();
const refsOf = (...names: Name[]): string[] => sorted(names.map((n) => blobs[n]));
const resolves = async (name: Name): Promise<boolean> =>
  (await w.contentStore.get({ __loomContent: blobs[name] })) !== null;

beforeEach(async () => {
  w = newWorld();
  await buildHistory(w);
  blobs = {} as Record<Name, string>;
  for (const n of Object.keys(IDS) as Name[]) blobs[n] = await blobOf(w, n);
});
afterEach(async () => {
  await w.close();
});

describe("1. the policy is an app-owned, frozen value", () => {
  it("carries exactly the three rules, deeply frozen", () => {
    expect(retention).toEqual({
      terminalTtlMs: 90 * DAY,
      snapshots: { keepLatest: 1 },
      content: { unpinnedAfterMs: 90 * DAY },
    });
    expect(Object.isFrozen(retention)).toBe(true);
    expect(Object.isFrozen(retention.snapshots)).toBe(true);
    expect(Object.isFrozen(retention.content)).toBe(true);
  });
});

describe("2. the history", () => {
  it("ends, parks and re-opens executions on the days it says", async () => {
    const status = async (n: Name) => (await w.runtime.loadState(IDS[n]))?.status;
    expect(await status("early")).toBe("completed");
    expect(await status("longrun")).toBe("completed");
    expect(await status("parked")).toBe("suspended");
    expect(await status("reopened")).toBe("suspended"); // ended d70, brought back d80
    const ended = async (n: Name) =>
      (await w.eventStore.read(IDS[n]))
        .filter((e) => e.eventType === "EXECUTION_COMPLETED")
        .map((e) => e.timestamp / DAY);
    expect(await ended("early")).toEqual([0]);
    expect(await ended("longrun")).toEqual([60]);
    expect(await ended("reopened")).toEqual([70]);
    expect(await ended("recent")).toEqual([95]);
  });
});

describe("3. retention dry run, then apply (archive first)", () => {
  it("dry run names each outcome and changes nothing", async () => {
    w.clock.set(100);
    const liveBefore = await w.eventStore.read(IDS.early);
    expect(await evaluateAll(w, retention, w.clock.now())).toEqual({
      early: "reclaimable",
      longrun: "kept", // ended d60: 40 days old
      finding: "pinned", // holds a FindingRecorded event
      reopened: "not-terminal", // re-opened on d80
      ledger: "reclaimable",
      parked: "not-terminal", // suspended, never ended
      recent: "kept",
    });
    expect(await w.eventStore.read(IDS.early)).toEqual(liveBefore);
    expect(await w.archive.eventStore.read(IDS.early)).toEqual([]);
  });

  it("apply copies to the archive BEFORE deleting from the live store", async () => {
    w.clock.set(100);
    const before = {
      early: await w.eventStore.read(IDS.early),
      ledger: await w.eventStore.read(IDS.ledger),
    };
    expect(await applyAll(w, retention, w.clock.now())).toEqual({
      early: "reclaimed",
      longrun: "kept",
      finding: "pinned",
      reopened: "not-terminal",
      ledger: "reclaimed",
      parked: "not-terminal",
      recent: "kept",
    });
    for (const n of ["early", "ledger"] as const) {
      expect(await w.eventStore.read(IDS[n])).toEqual([]);
      expect(await w.archive.eventStore.read(IDS[n])).toEqual(before[n]); // byte-for-byte
    }
    // the kept, pinned and live executions were not touched
    for (const n of ["longrun", "finding", "reopened", "parked", "recent"] as const) {
      expect((await w.eventStore.read(IDS[n])).length).toBeGreaterThan(0);
      expect(await w.archive.eventStore.read(IDS[n])).toEqual([]);
    }
  });

  it("the boundary is inclusive: an execution ended on d60 becomes reclaimable on d150, not d149", async () => {
    expect((await evaluateAll(w, retention, 149 * DAY)).longrun).toBe("kept");
    expect((await evaluateAll(w, retention, 150 * DAY)).longrun).toBe("reclaimable");
  });
});

describe("4. snapshot pruning driven by the policy", () => {
  it("keeps policy.snapshots.keepLatest (1): the suspend snapshot at #3 goes, the re-open one stays", async () => {
    expect(await snapshotSequences(w, "reopened")).toEqual([3, 10]);
    expect(await w.lifecycle.pruneSnapshots(IDS.reopened, { policy: retention })).toBe(1);
    expect(await snapshotSequences(w, "reopened")).toEqual([10]);
    // idempotent: nothing left to prune
    expect(await w.lifecycle.pruneSnapshots(IDS.reopened, { policy: retention })).toBe(0);
  });

  it("an explicit keepLatest wins over the policy", async () => {
    expect(
      await w.lifecycle.pruneSnapshots(IDS.reopened, { policy: retention, keepLatest: 2 })
    ).toBe(0);
    expect(await snapshotSequences(w, "reopened")).toEqual([3, 10]);
  });
});

describe("5. the content sweep and the end clock (ADR 0146)", () => {
  it("day 100: longrun's blob (cited d0, run ended d60) is held; the dry run says so", async () => {
    w.clock.set(100);
    const report = await sweep(w, w.clock.now(), { policy: retention }, true);
    // early: cited and ended d0 -> 100d old. reopened: re-opened, so it keeps the CITATION clock (d2).
    expect(sorted(report.reclaimed)).toEqual(refsOf("early", "reopened"));
    // The citation clock alone (d0 -> 100d) WOULD have erased it; the end clock (d60 -> 40d) keeps it.
    expect(report.heldByEndClock).toEqual([blobs.longrun]);
    expect(report.refsAgedByEnd).toBe(1);
    expect(report.refsPinned).toBe(1); // the finding's evidence
    // a dry run erases nothing
    for (const n of Object.keys(IDS) as Name[]) expect(await resolves(n)).toBe(true);
  });

  it("apply at day 100 erases only the two, and longrun's blob survives", async () => {
    w.clock.set(100);
    const applied = await sweep(w, w.clock.now(), { policy: retention }, false);
    expect(sorted(applied.reclaimed)).toEqual(refsOf("early", "reopened"));
    expect(await resolves("early")).toBe(false);
    expect(await resolves("reopened")).toBe(false);
    for (const n of ["longrun", "finding", "ledger", "parked", "recent"] as const) {
      expect(await resolves(n)).toBe(true);
    }
  });

  it("longrun's blob is reclaimable exactly 90 days after the run ENDED (d150, not d149)", async () => {
    expect((await sweep(w, 149 * DAY, { policy: retention }, true)).reclaimed).not.toContain(
      blobs.longrun
    );
    const at150 = await sweep(w, 150 * DAY, { policy: retention }, true);
    expect(at150.reclaimed).toContain(blobs.longrun);
    expect(at150.heldByEndClock).toEqual([]);
  });

  it("day 150 after day 100: longrun and parked go; pinned evidence, the retained ledger blob and recent stay", async () => {
    w.clock.set(100);
    await sweep(w, w.clock.now(), { policy: retention }, false);
    w.clock.set(150);
    const later = await sweep(w, w.clock.now(), { policy: retention }, false);
    // parked never ended, so it keeps the citation clock: cited d40 -> 110d old.
    expect(sorted(later.reclaimed)).toEqual(refsOf("longrun", "parked"));
    expect(await resolves("finding")).toBe(true); // pinned by a FindingRecorded event
    expect(await resolves("ledger")).toBe(true); // retained envelope: no TTL reclaims it
    expect(await resolves("recent")).toBe(true); // ended d95: 55 days old
  });

  it("a retained blob is never TTL-reclaimed, however old", async () => {
    const far = await sweep(w, 100_000 * DAY, { policy: retention }, true);
    expect(far.reclaimed).not.toContain(blobs.ledger);
    expect(far.reclaimed).not.toContain(blobs.finding);
  });

  it("the policy and the retention pass agree: a blob and its log become eligible on the same day", async () => {
    // longrun: log eligible at d150 (section 3) and its blob at d150 (above). One policy, one date.
    expect((await evaluateAll(w, retention, 150 * DAY)).longrun).toBe("reclaimable");
    expect((await sweep(w, 150 * DAY, { policy: retention }, true)).reclaimed).toContain(
      blobs.longrun
    );
  });
});

describe("6. a rejected policy", () => {
  it("content.unpinnedAfterMs < terminalTtlMs throws RetentionPolicyError at construction", () => {
    const build = () =>
      retentionPolicy({ terminalTtlMs: 90 * DAY, content: { unpinnedAfterMs: 30 * DAY } });
    expect(build).toThrow(RetentionPolicyError);
    expect(build).toThrow(RangeError);
    expect(build).toThrow(
      /content\.unpinnedAfterMs \(2592000000\) must be >= terminalTtlMs \(7776000000\)/
    );
  });

  it("a typo'd key and a keepLatest of 0 are refused too", () => {
    expect(() =>
      retentionPolicy({ terminalTtlMs: DAY, snapshot: { keepLatest: 1 } } as never)
    ).toThrow(/unknown key "snapshot"/);
    expect(() => retentionPolicy({ terminalTtlMs: DAY, snapshots: { keepLatest: 0 } })).toThrow(
      /snapshots\.keepLatest must be an integer >= 1/
    );
  });

  it("every consumer re-validates: a plain object that skipped retentionPolicy() is still refused", async () => {
    const bad = { terminalTtlMs: 90 * DAY, content: { unpinnedAfterMs: 30 * DAY } };
    await expect(w.lifecycle.evaluate(IDS.early, bad, 100 * DAY)).rejects.toThrow(
      RetentionPolicyError
    );
    await expect(w.lifecycle.pruneSnapshots(IDS.reopened, { policy: bad })).rejects.toThrow(
      RetentionPolicyError
    );
    await expect(sweep(w, 100 * DAY, { policy: bad }, true)).rejects.toThrow(/unpinnedAfterMs/);
  });

  it("the sweep takes exactly one of policy / olderThanMs, and a policy with no content section is an error", async () => {
    const both = {
      eventStores: [w.eventStore],
      contentStore: w.contentStore,
      pinnedEventTypes: [],
      now: 0,
      dryRun: true as const,
    };
    await expect(
      sweepUnpinnedContent({ ...both, policy: retention, olderThanMs: 1 })
    ).rejects.toThrow(TypeError);
    await expect(sweepUnpinnedContent({ ...both })).rejects.toThrow(TypeError);
    await expect(sweepUnpinnedContent({ ...both, policy: { terminalTtlMs: DAY } })).rejects.toThrow(
      TypeError
    );
  });
});

describe("7. the opt-in point: with no policy, the explicit numbers give the same answers", () => {
  it("evaluate with a bare { terminalTtlMs } equals evaluate with the policy", async () => {
    const now = 100 * DAY;
    expect(await evaluateAll(w, { terminalTtlMs: 90 * DAY }, now)).toEqual(
      await evaluateAll(w, retention, now)
    );
  });

  it("sweep with olderThanMs equals sweep with the policy (reclaimed and held lists)", async () => {
    w.clock.set(100);
    const viaPolicy = await sweep(w, w.clock.now(), { policy: retention }, true);
    const viaFlag = await sweep(w, w.clock.now(), { olderThanMs: 90 * DAY }, true);
    expect(sorted(viaFlag.reclaimed)).toEqual(sorted(viaPolicy.reclaimed));
    expect(viaFlag.heldByEndClock).toEqual(viaPolicy.heldByEndClock);
    expect(viaFlag.refsAgedByEnd).toBe(viaPolicy.refsAgedByEnd);
  });

  it("applying with the bare number archives the same executions as applying with the policy", async () => {
    w.clock.set(100);
    const viaFlag = await applyAll(w, { terminalTtlMs: 90 * DAY }, w.clock.now());
    const second = newWorld();
    try {
      await buildHistory(second);
      second.clock.set(100);
      expect(await applyAll(second, retention, second.clock.now())).toEqual(viaFlag);
    } finally {
      await second.close();
    }
  });
});
