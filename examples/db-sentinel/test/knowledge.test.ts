import { isTainted, unwrapTainted } from "@loom/classify";
import { virtualClock } from "@loom/dst";
import type { KnowledgeBase } from "@loom/knowledge";
import { describe, expect, it } from "vitest";
import { FINDING_RECORDED, type Finding } from "../src/domain";
import { deploySentinel, fireOccurrence, newWorld } from "../src/harness";
import { RUNBOOKS_MIDYEAR, RUNBOOKS_V1, openRunbooks } from "../src/knowledge";
import { LEARNED_PREFIX, SENTINEL_SOURCE, occurrenceId } from "../src/sentinel";
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
    await knowledge.sync(RUNBOOKS_V1, { source: "wiki" });
    const [finding] = await fireAnomaly(newWorld(), knowledge, EARLY_WAKE);
    expect(finding?.guidance.map((g) => g.docId)).toContain("RB-101");
    expect(finding?.guidance[0]?.title).toBe("Replication lag");
  });

  it("a July edit changes what later wakes retrieve, and the OLD remedy stops retrieving", async () => {
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1, { source: "wiki" });
    await fireAnomaly(newWorld(), knowledge, EARLY_WAKE);

    const result = await knowledge.sync(RUNBOOKS_MIDYEAR, { source: "wiki" });
    // One revision, one retirement, one document untouched — the reason `sync` is runnable
    // on a schedule rather than being a corpus rebuild — and the sentinel's own document
    // retained, because the wiki does not own it.
    expect({ ...result, retained: [] }).toEqual({
      written: ["RB-101"],
      unchanged: ["RB-204"],
      removed: ["RB-777"],
      retained: [],
    });
    expect(result.retained.every((id) => id.startsWith(LEARNED_PREFIX))).toBe(true);

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
    await knowledge.sync(RUNBOOKS_V1, { source: "wiki" });
    expect((await knowledge.listDocs()).map((d) => d.docId)).toContain("RB-777");

    await knowledge.sync(RUNBOOKS_MIDYEAR, { source: "wiki" });
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
    await knowledge.sync(RUNBOOKS_V1, { source: "wiki" });

    // What each run of the wake RETRIEVED — the value the finding's guidance is built from.
    // A replay no longer re-appends the finding (loom ADR 0102: a flow-level emit appends once
    // per execution), so the reconstruction is observed where it happens: at the retrieval.
    const retrieved: string[][] = [];
    const observed = new Proxy(knowledge, {
      get(target, prop, receiver) {
        if (prop !== "retrieve") return Reflect.get(target, prop, receiver);
        return async (...args: Parameters<KnowledgeBase["retrieve"]>) => {
          const passages = await target.retrieve(...args);
          retrieved.push(passages.map((p) => p.docId));
          return passages;
        };
      },
    });

    const clock = virtualClock(EARLY_WAKE);
    const deploy = deploySentinel(world, 1, { knowledge: observed }, () => clock.now());
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
    await knowledge.sync(RUNBOOKS_MIDYEAR, { source: "wiki" });
    // Emptied means emptied: each writer retires its OWN documents, which is the same
    // property stated from the other side.
    await knowledge.sync([], { source: "wiki" });
    await knowledge.sync([], { source: SENTINEL_SOURCE });
    expect(
      await knowledge.retrieve("replication lag", { decide: async (_k, compute) => compute() })
    ).toEqual([]);
    const before = retrieved.length;

    const restored = await deploy.runtime.restoreFromState(
      (await deploy.runtime.loadState(occurrenceId(EARLY_WAKE))) ?? state
    );
    await restored.waitForCompletion();
    // The replay re-ran the wake and retrieved again — and got the MARCH passages, served
    // from the recorded decision, over a corpus that no longer contains a single document.
    expect(retrieved.length).toBe(before + 1);
    expect(retrieved.at(-1)).toEqual(retrieved[0]);
    expect(retrieved.at(-1)).toContain("RB-101");
    // …and the finding it rebuilt is the one already in the log: served, not appended again.
    const findings = (await world.eventStore.read(occurrenceId(EARLY_WAKE)))
      .filter((e) => e.eventType === FINDING_RECORDED)
      .map((e) => e.payload as unknown as Finding);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.guidance.map((g) => g.docId)).toEqual([...new Set(retrieved[0])]);
  });

  it("writes back what it learned, and the wiki reconcile does not delete it", async () => {
    // The second kind of knowledge: not a runbook somebody authored, but a fact the agent
    // produced. It lives in the same corpus it reads from — which is only safe because the
    // two halves have different writers. Without that, the next reconcile of the authored
    // half deletes every learning, since they are not in the set the wiki produced.
    const world = newWorld();
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1, { source: "wiki" });
    await fireAnomaly(world, knowledge, EARLY_WAKE);

    const learned = (await knowledge.listDocs()).filter((d) => d.docId.startsWith(LEARNED_PREFIX));
    expect(learned).toHaveLength(1);
    expect(learned[0]?.source).toBe(SENTINEL_SOURCE);

    // July: the wiki is edited and re-synced. The sentinel's document is not in that set.
    const result = await knowledge.sync(RUNBOOKS_MIDYEAR, { source: "wiki" });
    expect(result.removed).toEqual(["RB-777"]);
    expect(result.retained).toEqual(learned.map((d) => d.docId));
    expect((await knowledge.listDocs()).map((d) => d.docId)).toContain(learned[0]?.docId);
  });

  it("the learning is retrievable beside the runbooks, and is TAINTED like everything else", async () => {
    // A learning is derived from an execution that read a database — third-party content by
    // the same rule as a wiki page, so it must not reach an instruction position either.
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1, { source: "wiki" });
    await fireAnomaly(newWorld(), knowledge, EARLY_WAKE);

    const hits = await knowledge.retrieve("replication lag on orders reached", {
      decide: async (_k, compute) => compute(),
      limit: 5,
    });
    const learned = hits.find((p) => p.docId.startsWith(LEARNED_PREFIX));
    expect(learned).toBeDefined();
    expect(isTainted(learned?.text)).toBe(true);
  });

  it("re-firing a wake does not write a second learning", async () => {
    // The write is a journaled effect and the document id is derived from the observation,
    // so a replay serves it from the log and an upsert keyed by that id cannot double it.
    const world = newWorld();
    const knowledge = openRunbooks();
    await knowledge.sync(RUNBOOKS_V1, { source: "wiki" });
    await fireAnomaly(world, knowledge, EARLY_WAKE);
    await fireAnomaly(world, knowledge, EARLY_WAKE); // idempotent occurrence — a no-op start
    expect(
      (await knowledge.listDocs()).filter((d) => d.docId.startsWith(LEARNED_PREFIX))
    ).toHaveLength(1);
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
