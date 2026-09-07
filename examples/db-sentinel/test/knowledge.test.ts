import { unwrapTainted } from "@loom/classify";
import { virtualClock } from "@loom/dst";
import type { KnowledgeBase } from "@loom/knowledge";
import { describe, expect, it } from "vitest";
import { FINDING_RECORDED, type Finding } from "../src/domain";
import { deploySentinel, fireOccurrence, newWorld } from "../src/harness";
import { RUNBOOKS_MIDYEAR, RUNBOOKS_V1, openRunbooks } from "../src/knowledge";
import { occurrenceId } from "../src/sentinel";
import { DAY, HOUR, SIM_START, isAnomalyTime } from "../src/substrate";

// ── The corpus a perpetual agent reads is edited while it runs ────────────────
//
// db-sentinel is the second consumer of `@loom/knowledge` (loom ADR 0091/0083),
// and it is deliberately unlike the first: `runbook-recall` answers one question
// against a corpus ingested once, where an append-only store and an upsertable one
// are indistinguishable. A sentinel runs for a year, and somebody edits the wiki in
// July. Everything below is a property of THAT, not of retrieval.

const CADENCE = 6 * HOUR;
/** The first anomalous wake before and after the July corpus edit. */
const firstAnomalyFrom = (start: number): number => {
  for (let t = start; t < start + 40 * DAY; t += CADENCE) if (isAnomalyTime(t)) return t;
  throw new Error("no anomaly in the search window");
};

const MID = SIM_START + 182 * DAY;
const EARLY_WAKE = firstAnomalyFrom(SIM_START + 30 * DAY);
const LATE_WAKE = firstAnomalyFrom(MID + DAY);

async function fireAnomaly(
  world: ReturnType<typeof newWorld>,
  knowledge: KnowledgeBase,
  t: number
): Promise<Finding[]> {
  const clock = virtualClock(t);
  const deploy = deploySentinel(world, 1, { knowledge }, () => clock.now());
  const { state } = await fireOccurrence(deploy, t);
  expect(state.status).toBe("completed");
  const events = await world.eventStore.read(occurrenceId(t));
  return events
    .filter((e) => e.eventType === FINDING_RECORDED)
    .map((e) => e.payload as unknown as Finding);
}

describe("db-sentinel — guidance from a corpus that changes mid-year", () => {
  it("cites the runbooks that were live at the wake", async () => {
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1);
    const [finding] = await fireAnomaly(newWorld(), knowledge, EARLY_WAKE);
    expect(finding?.guidance.map((g) => g.docId)).toContain("RB-101");
    expect(finding?.guidance[0]?.title).toBe("Replication lag");
  });

  it("a July edit changes what later wakes retrieve, and the OLD remedy stops retrieving", async () => {
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1);
    await fireAnomaly(newWorld(), knowledge, EARLY_WAKE);

    const result = await knowledge.sync(RUNBOOKS_MIDYEAR);
    // One revision, one retirement, and one document untouched — the reason `sync` is
    // runnable on a schedule rather than being a corpus rebuild.
    expect(result).toEqual({ written: ["RB-101"], unchanged: ["RB-204"], removed: ["RB-777"] });

    const passages = await knowledge.retrieve("cancel the blocking query", {
      decide: async (_k, compute) => compute(),
    });
    const text = passages.map((p) => unwrapTainted(p.text)).join(" ");
    // The superseded procedure is GONE, not merely ranked lower. Ranked alongside, a
    // revised runbook is worse than a missing one: the finding would cite a real document
    // and quote a step that was withdrawn for making the incident worse.
    expect(text).toContain("Do NOT cancel the blocking query");
    expect(text).not.toContain("Cancel the blocking query before touching");
  });

  it("a retired runbook stops being cited without the corpus being rebuilt", async () => {
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1);
    expect((await knowledge.listDocs()).map((d) => d.docId)).toContain("RB-777");

    await knowledge.sync(RUNBOOKS_MIDYEAR);
    // Terms are OR-ed and there is no stopword list, so the query is deliberately made of
    // words only the retired runbook contains — "promote the standby" would still match
    // every document through "the", ranked to the bottom but present in the set.
    expect(
      await knowledge.retrieve("failover standby cutover", {
        decide: async (_k, compute) => compute(),
      })
    ).toEqual([]);
    // RB-204 was byte-identical across the edit and is still there: `sync` removed what
    // the source dropped, not everything it did not just write.
    expect((await knowledge.listDocs()).map((d) => d.docId).sort()).toEqual(["RB-101", "RB-204"]);
  });

  it("replays a month-3 finding to the month-3 guidance, after the corpus has moved on", async () => {
    // The sharpest property, and the one only a long-running agent can show. An incident
    // review in December re-runs a wake from March. A live retrieval would rank against
    // December's corpus and reconstruct advice that was never given; the recorded decision
    // reconstructs what the sentinel actually read.
    const world = newWorld();
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1);

    const clock = virtualClock(EARLY_WAKE);
    const deploy = deploySentinel(world, 1, { knowledge }, () => clock.now());
    const { state } = await fireOccurrence(deploy, EARLY_WAKE);
    expect(state.status).toBe("completed");

    const decisions = (await world.eventStore.read(occurrenceId(EARLY_WAKE))).filter(
      (e) => e.eventType === "DECISION_RECORDED"
    );
    expect(decisions).toHaveLength(1);
    // The PASSAGE TEXT is in the log, not just the ids: ids do not reconstruct a prompt
    // once the document behind them has been revised.
    expect(JSON.stringify(decisions[0]?.payload)).toContain("Cancel the blocking query");

    // July happens — and then the corpus is retired outright. Revising it is not enough
    // to make this test bite: `guidance` carries ids, and RB-101 survives the July edit,
    // so a LIVE retrieval would return the same ids from different text and the assertion
    // would pass either way. Emptied, a live retrieval can only return nothing.
    await knowledge.sync(RUNBOOKS_MIDYEAR);
    await knowledge.sync([]);
    expect(
      await knowledge.retrieve("replication lag", { decide: async (_k, compute) => compute() })
    ).toEqual([]);

    const restored = await deploy.runtime.restoreFromState(
      (await deploy.runtime.loadState(occurrenceId(EARLY_WAKE))) ?? state
    );
    await restored.waitForCompletion();
    const replayedFindings = (await world.eventStore.read(occurrenceId(EARLY_WAKE)))
      .filter((e) => e.eventType === FINDING_RECORDED)
      .map((e) => e.payload as unknown as Finding);
    // The replay re-emits the domain event onto the same log, so what matters is that the
    // later one is IDENTICAL to the first — reconstructed from the recorded decision, over
    // a corpus that no longer contains a single document.
    expect(replayedFindings.length).toBeGreaterThan(1);
    expect(replayedFindings.at(-1)).toEqual(replayedFindings[0]);
    expect(replayedFindings.at(-1)?.guidance.map((g) => g.docId)).toContain("RB-101");
  });

  it("still emits findings with no corpus wired at all", async () => {
    // The corpus is an input to the conclusion, not a dependency of the loop: a sentinel
    // deployed before anybody wrote a runbook must not stop reporting lag.
    const world = newWorld();
    const clock = virtualClock(LATE_WAKE);
    const deploy = deploySentinel(world, 1, {}, () => clock.now());
    const { state } = await fireOccurrence(deploy, LATE_WAKE);
    expect(state.status).toBe("completed");
    const findings = (await world.eventStore.read(occurrenceId(LATE_WAKE)))
      .filter((e) => e.eventType === FINDING_RECORDED)
      .map((e) => e.payload as unknown as Finding);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.guidance).toEqual([]);
  });
});
