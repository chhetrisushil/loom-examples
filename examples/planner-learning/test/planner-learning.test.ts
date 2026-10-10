import { snapshotSeen } from "@loom-ui/core";
import { SIGNAL_VERSION } from "@loom-ui/core/signals";
import { InMemoryVoteLog, SignalIngestor, VoteLedger, seenLogExposure } from "@loom-ui/learning";
import type { PlanVariantReport } from "@loom-ui/planner";
import { PromotionRefusedError, rolloutBucket } from "@loom/learning";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { BUCKET_SECRET, type Batch, KEY, Lab, type Surface } from "../src/lab";
import {
  type TrialOptions,
  type TrialResult,
  armOf,
  evaluateCandidate,
  trial,
} from "../src/lifecycle";
import { POLICY_ID, versionHash } from "../src/policies";
import { NODES, TENANT } from "../src/world";

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
          (e.payload as { decisionId: string }).decisionId === s.ref.decisionId
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

describe("exposure is node-level, not version-level", () => {
  // The server recorded the viewer seeing the surface VERSION, but no entry naming the voted node
  // (a snapshot with no data-bound entries). seenLogExposure's `versionIsEnough` decides whether that vouches.
  it("a version-only view is refused under versionIsEnough:false and accepted under true", async () => {
    const lab = new Lab();
    await lab.bootstrap();
    const s = await lab.turn({ userId: "vo@example.com", segment: "power" });
    const viewerId = "version-only-viewer";
    const exp = (await lab.lineage.get(s.experienceId, s.versionHash)) as {
      ok: true;
      value: Parameters<typeof snapshotSeen>[0];
    };
    const full = snapshotSeen(exp.value, {
      viewer: { clearance: "internal" },
      read: () => ({ found: true, value: 1, status: "ready" }),
    });
    expect(full.entries.length).toBeGreaterThan(0); // the real view names nodes; strip them to make it version-only
    const rec = await lab.seenLog.record({
      experienceId: s.experienceId,
      viewerId: `${TENANT}/${viewerId}`,
      snapshot: { ...full, entries: [] },
      viewer: { clearance: "internal" },
    });
    expect(rec.ok).toBe(true);

    // the lab's strict ingestor
    const strict = await lab.vote(s, viewerId, 5);
    // every NODE exposure is refused (the version view names no node); only the surface-level
    // feedback, which the version-level fact does vouch for, gets through
    expect(strict.rejected.unexposed).toBe(NODES.length);
    expect(strict.accepted).toBe(1);

    // the SAME vote through a lenient ingestor over the same links and the same seen log
    const ledger = new VoteLedger({
      log: new InMemoryVoteLog(),
      pseudonymKey: KEY,
      clock: () => Date.now(),
    });
    const lenient = new SignalIngestor({
      links: lab.links,
      ledger,
      clock: () => Date.now(),
      exposure: seenLogExposure(lab.seenLog, {
        versionIsEnough: true,
        viewerIdOf: ({ tenant, viewerId: v }) => `${tenant}/${v}`,
      }),
    });
    const ok = await lenient.ingest({
      viewer: { id: viewerId, tenant: TENANT },
      raw: {
        v: SIGNAL_VERSION,
        batchId: "lenient",
        view: { experienceId: s.experienceId, versionHash: s.versionHash },
        signals: [
          ...NODES.map((node) => ({ kind: "exposure" as const, node })),
          { kind: "feedback" as const, rating: 5 },
        ],
      },
    });
    expect(ok.rejected.unexposed).toBeUndefined();
    expect(ok.accepted).toBe(NODES.length + 1);
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

  it("replay serves the recorded decision: no new decision, no planner model call, no policy.select, whatever the registry says now", async () => {
    const parked = await lab.parkedTurn({ userId: "replay@example.com", segment: "casual" });
    const log0 = await lab.eventStore.read(parked.executionId);
    const rec0 = log0.filter((e) => e.eventType === "DECISION_RECORDED");
    const choice = rec0.find((e) =>
      (e.payload as { decisionId: string }).decisionId.startsWith("plan-variant:")
    )?.payload as {
      decisionId: string;
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
    const modelCalls = lab.model.calls;
    const selects = lab.policies.calls.length;
    const resumed = await lab.runtime.resume(parked.executionId, {
      eventType: "ReplayGate",
      payload: {},
    });
    const final = await resumed.waitForCompletion();

    const rec1 = (await lab.eventStore.read(parked.executionId)).filter(
      (e) => e.eventType === "DECISION_RECORDED"
    );
    expect(rec1).toHaveLength(rec0.length);
    expect(lab.model.calls).toBe(modelCalls);
    // loom #529: the registry read and select run inside ctx.decide, so a served decision consults no policy.
    expect(lab.policies.calls.length).toBe(selects);
    const out = final.variables._output as { layout: string; variant: PlanVariantReport };
    expect(out.layout).toBe(choice.choice);
    // the replayed report names the policy but NOT a version (the registry now says v1, the log says v3),
    // and claims no rollout stamp or propensity: the recorded DECISION_RECORDED stamp is the truth
    expect(out.variant.decisionId).toBe(choice.decisionId);
    expect(out.variant.policy).toEqual({ id: POLICY_ID });
    expect(out.variant.policy.version).toBeUndefined();
    expect(out.variant.rollout).toBeUndefined();
  });
});

describe("what a FRESH turn reports", () => {
  // loom-ui reads the rollout stamp after loom's decider returns (loom-ui #63), so a turn that ACTED
  // reports the acting version and the stamp; a replay reports neither (see the replay test).
  it("report.variant names the acting version and the rollout stamp", async () => {
    const lab = new Lab();
    await lab.bootstrap();
    const s = await lab.turn({ userId: "fresh@example.com", segment: "power" });
    expect(s.report.policy).toEqual({ id: POLICY_ID, version: "1" });
    expect(s.report.rollout?.mode).toBe("full");
  });

  // A fresh turn under a non-full rollout stamps the mode, the unit's bucket and the arm that did NOT act.
  describe("under a rollout", () => {
    const lab = new Lab();
    let salt = "";
    let base: Batch;

    // register v2 and walk it to `mode` with the offline report (the registry gate is the same at every step)
    beforeAll(async () => {
      await lab.bootstrap();
      base = await lab.serve("p3-base", 120, 1);
      await lab.settle(base);
      const report = evaluateCandidate(lab, await lab.trajectories(base), "2");
      const now = Date.parse(lab.iso());
      await lab.registry.register({
        id: POLICY_ID,
        version: "2",
        contentHash: versionHash("2"),
        now,
      });
      await lab.registry.promote({ id: POLICY_ID, version: "2", report, mode: "shadow", now });
      salt = (await lab.registry.resolve(POLICY_ID))?.salt ?? "";
    }, 120_000);

    const unitOf = (s: Surface) => rolloutBucket(salt, s.unit, BUCKET_SECRET);

    it("shadow: the report carries the mode and the shadow arm's version and choice; the incumbent acts", async () => {
      expect(salt).not.toBe("");
      const s = await lab.turn({ userId: "fresh-shadow@example.com", segment: "power" });
      const r = s.report;
      expect(r.policy).toEqual({ id: POLICY_ID, version: "1" });
      expect(r.rollout?.mode).toBe("shadow");
      expect(r.rollout?.bucket).toBeUndefined(); // loom buckets only a canary split; shadow has no slice
      expect(r.rollout?.acted).toEqual({ id: POLICY_ID, version: "1" });
      expect(r.rollout?.shadow).toMatchObject({ id: POLICY_ID, version: "2" });
      expect(typeof r.rollout?.shadow?.action).toBe("string");
      // the stamp on the report is the stamp in the log
      const [first] = await stampsOf(lab, { label: "x", epoch: 1, surfaces: [s] });
      const payload = first?.payload as NonNullable<typeof first>["payload"];
      expect(payload.policy.rollout.shadow).toMatchObject({
        version: "2",
        action: r.rollout?.shadow?.action,
      });
      expect(s.served).toBe(payload.choice);
    });

    it("canary: a unit inside the slice is acted on by the candidate, one outside by the incumbent", async () => {
      const now = Date.parse(lab.iso());
      const report = evaluateCandidate(lab, await lab.trajectories(base), "2");
      await lab.registry.promote({
        id: POLICY_ID,
        version: "2",
        report,
        mode: "canary",
        canaryFraction: 0.3,
        now,
      });
      const seen = {
        inside: undefined as Surface | undefined,
        outside: undefined as Surface | undefined,
      };
      for (let i = 0; i < 60 && (!seen.inside || !seen.outside); i++) {
        const s = await lab.turn({ userId: `fresh-canary-${i}@example.com`, segment: "casual" });
        const side = unitOf(s) < 0.3 ? "inside" : "outside";
        seen[side] ??= s;
      }
      const { inside, outside } = seen;
      if (!inside || !outside) throw new Error("no unit found on one side of the slice");
      for (const [s, acting, other] of [
        [inside, "2", "1"],
        [outside, "1", "2"],
      ] as const) {
        const r = s.report;
        expect(r.rollout?.mode).toBe("canary");
        expect(r.rollout?.bucket).toBe(unitOf(s));
        expect(r.policy).toEqual({ id: POLICY_ID, version: acting });
        expect(r.rollout?.acted).toEqual({ id: POLICY_ID, version: acting });
        expect(r.rollout?.shadow).toMatchObject({ version: other });
      }
      expect(inside.report.rollout?.armProbability).toBeCloseTo(0.3);
      expect(outside.report.rollout?.armProbability).toBeCloseTo(0.7);
    }, 60_000);
  });
});

describe("trial() error handling", () => {
  const opts = (evidence: Awaited<ReturnType<Lab["trajectories"]>>): TrialOptions => ({
    evidence,
    incumbent: "1",
    shadow: { users: 20, epoch: 1 },
    canary: { users: 20, epoch: 2, fraction: 0.3 },
  });

  it("a KV/IO failure is rethrown, not reported as a gate refusal, and no rollback is attempted", async () => {
    const lab = new Lab();
    await lab.bootstrap();
    const base = await lab.serve("base", 40, 1);
    await lab.settle(base);
    const evidence = await lab.trajectories(base);
    const boom = new Error("kv unavailable");
    const rollback = vi.spyOn(lab.registry, "rollback");
    vi.spyOn(lab.registry, "promote").mockRejectedValue(boom);
    await expect(trial(lab, "2", opts(evidence))).rejects.toBe(boom);
    expect(rollback).not.toHaveBeenCalled();
  }, 60_000);

  it("a real refusal at the offline gate is still reported as one", async () => {
    const lab = new Lab();
    await lab.bootstrap();
    const refused = new PromotionRefusedError("2", ["lift below floor"]);
    vi.spyOn(lab.registry, "promote").mockRejectedValue(refused);
    const r = await trial(lab, "2", opts([]));
    expect(r.outcome).toBe("refused-offline");
    expect(r.reasons).toEqual(["lift below floor"]);
  }, 60_000);
});
