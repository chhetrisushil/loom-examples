import { describe, expect, it } from "vitest";
import { SESSION_STARTED, baselineReport, ttmRegressed } from "../src/metrics";
import { createProfileService } from "../src/profileService";
import { createSessionRecorder } from "../src/sessions";

// ── Phase 0: the baseline ────────────────────────────────────────────────────
//
// Every assertion here is about a way a metric can be WRONG while looking healthy. That
// is the whole content of this phase: the numbers are trivial, and the ways they lie are
// not. Four in particular:
//
//   • speed measured over everyone scores abandonment as the best outcome in the product;
//   • a rate over nobody reads as zero rather than as "no evidence";
//   • "first use in the window" counts habitual users as discoverers whenever the window
//     moves, so the counter-metric rises while nothing changed;
//   • a guardrail that clears on thin evidence is not a guardrail.

const base = { tenant: "acme", topic: "cpu" as const };

describe("task success is explicit, and speed is conditioned on it", () => {
  it("does not count a session that ended without a success event", async () => {
    const sessions = createSessionRecorder();
    await sessions.start({ ...base, sessionId: "s1", operator: "ana", adaptive: false });
    await sessions.ended("s1");

    const report = baselineReport(await sessions.log());
    expect(report.taskSuccess).toMatchObject({ numerator: 0, denominator: 1, rate: 0 });
  });

  it("measures time-to-success over successes ONLY", async () => {
    const sessions = createSessionRecorder();
    // One quick abandonment and one slower success. Averaging duration over BOTH would
    // report the abandonment as the product's best moment — the fastest session in any
    // log is someone opening the console, seeing nothing useful, and closing it.
    await sessions.start({ ...base, sessionId: "quick", operator: "ana", adaptive: false });
    await sessions.ended("quick");
    await sessions.start({ ...base, sessionId: "slow", operator: "bo", adaptive: false });
    await sessions.succeeded("slow", "plan.exported");

    const report = baselineReport(await sessions.log());
    expect(report.taskSuccess.rate).toBe(0.5);
    expect(report.timeToSuccess.n).toBe(1); // the abandonment contributes nothing
  });
});

describe("a rate over nobody is not zero", () => {
  it("reports null, and the denominator that made it null", () => {
    const report = baselineReport([]);
    expect(report.taskSuccess).toEqual({ rate: null, numerator: 0, denominator: 0 });
    expect(report.escapeHatch.rate).toBeNull();
    expect(report.timeToSuccess).toEqual({ n: 0, meanMs: null, p50Ms: null });
    // "Nobody succeeded" and "nobody tried" are different findings, and a dashboard that
    // renders them identically will be read as the first.
    expect(report.sessions).toBe(0);
  });
});

describe("discovery counts first use EVER, not first use in the window", () => {
  // Hand-built, with explicit timestamps: "long before the window" is the whole point of
  // this case, and a recorder driven by the wall clock writes everything inside one
  // millisecond, where the distinction cannot be expressed at all.
  const ev = (eventType: string, payload: unknown, timestamp: number, n: number) => ({
    id: `e-${n}`,
    workflowId: "wf",
    executionId: `x-${n}`,
    eventType,
    sequence: 0,
    timestamp,
    payload,
  });
  const LAST_YEAR = Date.UTC(2025, 0, 1);
  const WINDOW = { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 8, 30) };
  const midWindow = Date.UTC(2026, 8, 15);
  const act = (operator: string, at: number, n: number) =>
    ev("OPERATOR_ACTION", { tenant: "acme", operator, action: "open.queries.slow" }, at, n);
  const session = (sessionId: string, operator: string, at: number, n: number) =>
    ev(SESSION_STARTED, { ...base, sessionId, operator, adaptive: false }, at, n);

  it("does not count a habitual user as a discoverer when the window moves", () => {
    const report = baselineReport(
      [
        act("ana", LAST_YEAR, 1), // ana has been doing this for a year
        act("ana", midWindow, 2),
        act("bo", midWindow, 3), // bo's first time ever, inside the window
        session("s1", "ana", midWindow, 4),
        session("s2", "bo", midWindow, 5),
      ],
      WINDOW
    );

    // Two operators active, ONE genuine discovery. Asking "was this their first use
    // inside the window" would score ana too, so the counter-metric would rise whenever
    // the window moved and nothing about the product had changed.
    expect(report.discovery["open.queries.slow"]).toMatchObject({
      numerator: 1,
      denominator: 2,
    });
  });

  it("counts nobody when everyone active is a returning user", () => {
    const report = baselineReport(
      [act("ana", LAST_YEAR, 1), act("ana", midWindow, 2), session("s1", "ana", midWindow, 3)],
      WINDOW
    );
    expect(report.discovery["open.queries.slow"]).toMatchObject({ numerator: 0, denominator: 1 });
  });
});

describe("the counter-metrics", () => {
  it("measures the escape hatch against sessions, not against itself", async () => {
    const profiles = createProfileService();
    const sessions = createSessionRecorder();
    await sessions.start({ ...base, sessionId: "s1", operator: "ana", adaptive: true });
    await sessions.start({ ...base, sessionId: "s2", operator: "bo", adaptive: true });
    await profiles.observe("acme", "ana", "escape.canonical");

    const log = [...(await sessions.log()), ...(await profiles.allEvents())].sort(
      (a, b) => a.timestamp - b.timestamp
    );
    const report = baselineReport(log);
    expect(report.escapeHatch).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
  });

  it("measures whether operators stayed canonical after the incident", async () => {
    const sessions = createSessionRecorder();
    await sessions.start({
      ...base,
      sessionId: "s1",
      operator: "ana",
      adaptive: false,
      canonicalReason: "page fired",
    });
    await sessions.ended("s1", true); // left it in the canonical view
    await sessions.start({ ...base, sessionId: "s2", operator: "bo", adaptive: true });
    await sessions.ended("s2", false);

    const report = baselineReport(await sessions.log());
    expect(report.canonicalPreference).toMatchObject({ numerator: 1, denominator: 2 });
  });
});

describe("the guardrail is segmented, and fails closed", () => {
  it("keeps the adaptive and canonical arms apart", async () => {
    const sessions = createSessionRecorder();
    await sessions.incidentOpened("i1", "orders-prod", true);
    await sessions.incidentMitigated("i1", "orders-prod", true);
    await sessions.incidentOpened("i2", "orders-prod", false);
    await sessions.incidentMitigated("i2", "orders-prod", false);

    const report = baselineReport(await sessions.log());
    // Pooling them would let a regression in one arm hide inside the other's numbers,
    // which is the one thing this metric exists to catch.
    expect(report.incidentTimeToMitigate.adaptive.n).toBe(1);
    expect(report.incidentTimeToMitigate.canonical.n).toBe(1);
  });

  it("blocks on no baseline and on no measured incidents", () => {
    const empty = { n: 0, meanMs: null, p50Ms: null };
    expect(ttmRegressed(null, { n: 5, meanMs: 100, p50Ms: 100 }).blocked).toBe(true);
    // "We could not tell" must not read as "no regression" on the one metric allowed to
    // block a release.
    expect(ttmRegressed(100, empty).blocked).toBe(true);
    expect(ttmRegressed(100, empty).reason).toMatch(/no incidents/);
  });

  it("blocks a real regression and clears a tolerable one", () => {
    expect(ttmRegressed(100, { n: 3, meanMs: 150, p50Ms: 150 })).toMatchObject({ blocked: true });
    expect(ttmRegressed(100, { n: 3, meanMs: 105, p50Ms: 105 })).toMatchObject({ blocked: false });
  });
});
