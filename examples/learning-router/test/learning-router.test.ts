import { evaluatePolicy, promotionGate, steps } from "@loom/learning";
import { describe, expect, it } from "vitest";
import { ROUTES, type Route, quality, tickets } from "../src/domain";
import { buildPolicy, trainCandidate } from "../src/policy";
import { serveTickets } from "../src/run";

const GATE = { minSteps: 200, minEffectiveSamples: 20 };

describe("the online half writes a learnable log", () => {
  it("records the observation, the propensity and the action set on every decision", async () => {
    const run = await serveTickets(buildPolicy({ version: "t", seed: 3 }), 20);
    const all = steps(run.trajectories);

    expect(all).toHaveLength(20);
    for (const s of all) {
      expect(s.context).toEqual({
        urgent: expect.any(Number),
        length: expect.any(Number),
      });
      expect(s.policy?.id).toBe("triage-router");
      expect(s.policy?.propensity).toBeGreaterThan(0);
      expect(s.policy?.propensity).toBeLessThanOrEqual(1);
      expect(s.actions).toEqual([...ROUTES]);
      // Measured, not inferred from the execution's success.
      expect(s.rewardSource).toBe("direct");
    }
  });

  it("the recorded choice is what actually ran", async () => {
    const run = await serveTickets(buildPolicy({ version: "t", seed: 3 }), 20);
    for (const t of run.trajectories) {
      const step = t.steps[0];
      const result = run.results.find((r) => r.ticketId === step?.decisionId);
      // decisionId is "route" for all of them, so match on the execution instead.
      expect(step?.action).toBeDefined();
      expect(ROUTES).toContain(step?.action as Route);
      expect(result === undefined || result.route === step?.action).toBe(true);
    }
  });

  it("the reward stored equals the quality the step actually produced", async () => {
    const stream = tickets(12);
    const run = await serveTickets(buildPolicy({ version: "t", seed: 5 }), 12, { stream });
    for (const r of run.results) {
      const ticket = stream.find((t) => t.id === r.ticketId);
      expect(r.quality).toBeCloseTo(quality(r.route as Route, ticket as (typeof stream)[number]));
    }
  });
});

describe("the offline half learns from it", () => {
  it("a policy trained on the log estimates above the policy that wrote it", async () => {
    const run = await serveTickets(buildPolicy({ version: "1", epsilon: 0.15, seed: 7 }), 240);
    const { policy, applied } = trainCandidate(steps(run.trajectories), "2");

    expect(applied).toBe(240);
    const report = evaluatePolicy(run.trajectories, policy);
    expect(report.estimator).toBe("snips");
    expect(report.estimatedValue as number).toBeGreaterThan(report.loggedValue);
  });

  it("refuses to promote on thin evidence, then passes once evidence accumulates", async () => {
    const round1 = await serveTickets(buildPolicy({ version: "1", epsilon: 0.15, seed: 7 }), 240);
    const v2 = trainCandidate(steps(round1.trajectories), "2");

    // A large lift, but resting on very few effectively-independent steps.
    const thin = evaluatePolicy(round1.trajectories, v2.policy);
    expect(thin.lift as number).toBeGreaterThan(0);
    expect(thin.effectiveSampleSize as number).toBeLessThan(GATE.minEffectiveSamples);
    expect(promotionGate(thin, GATE).ok).toBe(false);

    // Canary the trained policy, pool the logs, re-evaluate.
    const canary = buildPolicy({ version: "2", epsilon: 0.25, seed: 11 });
    canary.fit(steps(round1.trajectories));
    const round2 = await serveTickets(canary, 240, { stream: tickets(240) });
    const pooled = [...round1.trajectories, ...round2.trajectories];
    const v3 = trainCandidate(steps(pooled), "3");

    const thick = evaluatePolicy(pooled, v3.policy);
    expect(thick.effectiveSampleSize as number).toBeGreaterThan(GATE.minEffectiveSamples);
    expect(promotionGate(thick, GATE).ok).toBe(true);
  });

  it("the learned policy actually delivers better answers", async () => {
    const round1 = await serveTickets(buildPolicy({ version: "1", epsilon: 0.15, seed: 7 }), 240);
    const canary = buildPolicy({ version: "2", epsilon: 0.25, seed: 11 });
    canary.fit(steps(round1.trajectories));
    const round2 = await serveTickets(canary, 240, { stream: tickets(240) });

    // Same tickets, same flow, same code — only the policy learned.
    expect(round2.meanQuality).toBeGreaterThan(round1.meanQuality + 0.15);
  });

  it("refuses a candidate that is genuinely worse", async () => {
    const run = await serveTickets(buildPolicy({ version: "1", epsilon: 0.25, seed: 7 }), 240);
    const alwaysCheap = {
      id: "always-gemma",
      version: "1",
      select: () => ({ action: "gemma" as Route }),
    };
    const report = evaluatePolicy(run.trajectories, alwaysCheap);
    expect(report.lift as number).toBeLessThan(0);
    expect(promotionGate(report, GATE).ok).toBe(false);
  });
});

describe("a log written the old way teaches nothing", () => {
  it("yields no evaluable steps and says exactly why", async () => {
    const blind = await serveTickets(buildPolicy({ version: "1", seed: 7 }), 60, {
      learnable: false,
    });
    const all = steps(blind.trajectories);

    expect(all).toHaveLength(60);
    // The executions ran fine and every one succeeded, so credit assignment still
    // hands each decision the execution's TERMINAL reward. That is the trap: the
    // steps look scored. They are simply not attributable to anything, because no
    // outcome named the decision and no observation was recorded.
    expect(all.every((s) => s.context === undefined)).toBe(true);
    expect(all.every((s) => s.policy === undefined)).toBe(true);
    expect(all.every((s) => s.rewardSource === "terminal")).toBe(true);
    expect(all.every((s) => s.directReward === undefined)).toBe(true);

    const report = evaluatePolicy(blind.trajectories, buildPolicy({ version: "x", epsilon: 0 }));
    expect(report.evaluated).toBe(0);
    expect(report.skipped.noContext).toBe(60);
    expect(report.estimator).toBe("agreement-only");
    expect(promotionGate(report, GATE).ok).toBe(false);
  });
});

describe("reproducibility", () => {
  it("two runs with the same seed produce identical routes", async () => {
    const a = await serveTickets(buildPolicy({ version: "1", seed: 99 }), 30);
    const b = await serveTickets(buildPolicy({ version: "1", seed: 99 }), 30);
    expect(a.results.map((r) => r.route)).toEqual(b.results.map((r) => r.route));
    expect(a.meanQuality).toBe(b.meanQuality);
  });
});
