import { PromotionRefusedError, rolloutBucket } from "@loom/learning";
import { beforeAll, describe, expect, it } from "vitest";
import { BUCKET_SECRET, type Batch, Lab } from "../src/lab";
import { type TrialResult, armOf, evaluateCandidate, trial } from "../src/lifecycle";
import { POLICY_ID } from "../src/policies";

interface Stamp {
  version: string;
  rollout: { mode: string; shadow: { version: string; action: string } };
}

const stampsOf = async (lab: Lab, batch: Batch) =>
  Promise.all(
    batch.surfaces.map(async (s) => {
      const ev = (await lab.eventStore.read(s.executionId)).find(
        (e) =>
          e.eventType === "DECISION_RECORDED" &&
          (e.payload as { decisionId: string }).decisionId === "layout"
      );
      return { surface: s, payload: ev?.payload as { choice: string; policy: Stamp } };
    })
  );

describe("viewer votes (loom-ui U11)", () => {
  it("a vote without exposure is refused: nothing the server did not show can be rated", async () => {
    const lab = new Lab();
    await lab.bootstrap();
    const s = await lab.turn({ userId: "a@example.com", segment: "power" });

    const unseen = await lab.vote(s, "never-opened-it", 5);
    expect(unseen.accepted).toBe(0);
    expect(unseen.rejected.unexposed).toBeGreaterThan(0);
    expect((await lab.ledger.fold(s.ref)).summary.viewers).toBe(0);

    await lab.show(s, "opened-it");
    const seen = await lab.vote(s, "opened-it", 5);
    expect(seen.accepted).toBeGreaterThan(0);
    expect((await lab.ledger.fold(s.ref)).summary.viewers).toBe(1);

    // a viewer of another tenant cannot vote on this tenant's surface either
    const foreign = await lab.vote(s, "opened-it", 5, { tenant: "evil" });
    expect(foreign.refused).toBe("unknown-view");
  });

  it("one viewer is ONE bounded vote: a re-vote replaces, a replayed batch is refused, a flood is capped", async () => {
    const lab = new Lab({ maxBatchesPerViewer: 2 });
    await lab.bootstrap();
    const s = await lab.turn({ userId: "b@example.com", segment: "casual" });
    await lab.show(s, "v");
    await lab.vote(s, "v", 5, { batchId: "first" });
    expect((await lab.vote(s, "v", 5, { batchId: "first" })).refused).toBe("duplicate-batch");
    await lab.vote(s, "v", 1, { batchId: "second" });
    const flood = await lab.vote(s, "v", 5, { batchId: "third" });
    expect(flood.rejected["viewer-capacity"]).toBeGreaterThan(0);

    const { summary } = await lab.ledger.fold(s.ref);
    expect(summary.viewers).toBe(1);
    expect(summary.feedbackViewers).toBe(1);
    expect(summary.feedbackSum).toBe(0); // the latest rating (1 star) counts once, as (1-1)/4
  });

  it("settles ONE late reward per decision, once", async () => {
    const lab = new Lab();
    await lab.bootstrap();
    const batch = await lab.serve("one", 3, 1);
    expect((await lab.settle(batch)).appended).toBe(3);
    expect((await lab.settle(batch)).alreadySettled).toBe(3);
    for (const t of await lab.trajectories(batch)) {
      const step = t.steps[0];
      expect(step?.rewardSource).toBe("direct");
      expect(step?.reward).toBeGreaterThanOrEqual(0);
      expect(step?.reward).toBeLessThanOrEqual(1);
    }
  });

  it("is deterministic: the same users get the same layouts in a fresh lab", async () => {
    const mk = async () => {
      const l = new Lab();
      await l.bootstrap();
      return l.serve("det", 12, 1);
    };
    const a = await mk();
    const b = await mk();
    expect(a.surfaces.map((s) => s.served)).toEqual(b.surfaces.map((s) => s.served));
  });
});

describe("the R18 lifecycle", () => {
  const lab = new Lab();
  let base: Batch;
  let t2: TrialResult;
  let t3: TrialResult;

  beforeAll(async () => {
    await lab.bootstrap();
    base = await lab.serve("base", 120, 1);
    await lab.settle(base);
    const baseTrajs = await lab.trajectories(base);
    t2 = await trial(lab, "2", {
      evidence: baseTrajs,
      incumbent: "1",
      shadow: { users: 60, epoch: 1 },
      canary: { users: 90, epoch: 2, fraction: 0.3 },
    });
    const fresh = armOf(await lab.trajectories(t2.batches.canary as Batch), "1");
    t3 = await trial(lab, "3", {
      evidence: fresh,
      incumbent: "1",
      shadow: { users: 60, epoch: 2 },
      canary: { users: 90, epoch: 2, fraction: 0.3 },
    });
  }, 120_000);

  it("shadow never serves: the incumbent acts, the candidate is only recorded beside it", async () => {
    const stamps = await stampsOf(lab, t2.batches.shadow as Batch);
    expect(stamps).toHaveLength(60);
    let disagreed = 0;
    for (const { surface, payload } of stamps) {
      expect(payload.policy.rollout.mode).toBe("shadow");
      expect(payload.policy.version).toBe("1");
      expect(payload.policy.rollout.shadow.version).toBe("2");
      expect(surface.served).toBe(payload.choice); // what the viewer saw is the incumbent's choice
      if (payload.policy.rollout.shadow.action !== payload.choice) disagreed++;
    }
    expect(disagreed).toBeGreaterThan(0); // the shadow arm is not a copy: it WOULD have acted differently
  });

  it("canary serves only its slice: exactly the units whose stable bucket falls under the fraction", async () => {
    const stamps = await stampsOf(lab, t2.batches.canary as Batch);
    let onCandidate = 0;
    for (const { surface, payload } of stamps) {
      const inSlice = rolloutBucket(`${POLICY_ID}:2`, surface.unit, BUCKET_SECRET) < 0.3;
      expect(payload.policy.version).toBe(inSlice ? "2" : "1");
      expect(payload.policy.rollout.mode).toBe("canary");
      if (inSlice) onCandidate++;
    }
    expect(onCandidate).toBeGreaterThan(0);
    expect(onCandidate).toBeLessThan(stamps.length);
  });

  it("the gate lets the offline evidence through for v2, then refuses it on fresh traffic and rolls back", () => {
    expect(t2.reports.offline.lift).toBeGreaterThan(0);
    expect(t2.reports.shadow?.lift).toBeGreaterThan(0);
    expect(t2.reports.canary?.lift).toBeLessThan(0);
    expect(t2.outcome).toBe("rolled-back");
    expect(t2.reasons.join(" ")).toMatch(/lift/);
  });

  it("the gate promotes the better candidate (v3) to full", async () => {
    expect(t3.outcome).toBe("promoted");
    const state = await lab.registry.resolve(POLICY_ID);
    expect(state).toMatchObject({ mode: "full", incumbent: "3", previousIncumbent: "1" });
    // and it is better where it counts: its canary arm's viewers rated higher
    const trajs = await lab.trajectories(t3.batches.canary as Batch);
    const mean = (v: string) => {
      const r = armOf(trajs, v).flatMap((t) => t.steps.map((s) => s.reward ?? 0));
      return r.reduce((a, b) => a + b, 0) / r.length;
    };
    expect(mean("3")).toBeGreaterThan(mean("1"));
  });

  it("a rolled-back version can never be made live except through the gate", async () => {
    const hist = (await lab.registry.history(POLICY_ID)).map((e) => e.action);
    expect(hist).toContain("rollback");
    await expect(lab.registry.rollback({ id: POLICY_ID, to: "2", now: 0 })).rejects.toBeInstanceOf(
      PromotionRefusedError
    );
    const stale = evaluateCandidate(
      lab,
      armOf(await lab.trajectories(t3.batches.canary as Batch), "1"),
      "2"
    );
    await expect(
      lab.registry.promote({ id: POLICY_ID, version: "2", report: stale, mode: "full", now: 0 })
    ).rejects.toBeInstanceOf(PromotionRefusedError);
  });

  it("replay serves the recorded decision: no new decision, no planner model call, whatever the registry says now", async () => {
    const parked = await lab.parkedTurn({ userId: "replay@example.com", segment: "casual" });
    const log0 = await lab.eventStore.read(parked.executionId);
    const rec0 = log0.filter((e) => e.eventType === "DECISION_RECORDED");
    const choice = rec0.find((e) => (e.payload as { decisionId: string }).decisionId === "layout")
      ?.payload as {
      choice: string;
      policy: { version: string };
    };
    expect(choice.policy.version).toBe("3");

    await lab.registry.rollback({
      id: POLICY_ID,
      to: "1",
      now: 0,
      note: "registry moves under a parked run",
    });
    const modelCalls = lab.models.flat.calls + lab.models.tabs.calls;
    const resumed = await lab.runtime.resume(parked.executionId, {
      eventType: "ReplayGate",
      payload: {},
    });
    const final = await resumed.waitForCompletion();

    const rec1 = (await lab.eventStore.read(parked.executionId)).filter(
      (e) => e.eventType === "DECISION_RECORDED"
    );
    expect(rec1).toHaveLength(rec0.length);
    expect(lab.models.flat.calls + lab.models.tabs.calls).toBe(modelCalls);
    expect((final.variables._output as { layout: string }).layout).toBe(choice.choice);
  });
});
