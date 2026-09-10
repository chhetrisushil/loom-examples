import { blueprintNodeIds, preservesNodes } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { ExplorationFloor, NO_EXPLORATION, explorationActions } from "../src/exploration";
import { FLAG_CATALOGUE } from "../src/flags";
import { NO_PREFERENCES } from "../src/preferences";
import type { OperatorProfile } from "../src/profile";
import { createProfileService } from "../src/profileService";
import { buildCore } from "../src/wiring";

// ── Phase 2b: exploration, canonical mode, and the operator's own word ───────

const scope = { tenant: "acme", operator: "ana", topic: "cpu" };
const QUESTION = "Why is the CPU utilization high?";
const AVAILABLE = ["connections.saturation", "queries.slow", "cpu.trend"];
const held = (...flags: string[]): OperatorProfile => ({
  subject: "acme:ana",
  flags,
  catalogueVersion: 1,
  detail: flags.map((id) => ({ id, evidence: [1], lastEvidencedAt: 1, source: "observed" })),
});

/** A policy whose draw is fixed, so a test can assert the arm rather than the dice. */
const always = (value: number) => new ExplorationFloor(0.5, () => value);

describe("what exploration may surface", () => {
  it("offers only capabilities the operator does NOT hold", () => {
    // A wider surface than the CPU topic actually shows, so both candidates are in play
    // and the filter under test is the HELD one rather than the available one.
    const wide = [...AVAILABLE, "connections.waiting"];
    expect(explorationActions(null, wide)).toEqual(
      expect.arrayContaining(["reads_query_plans", "inspects_connections"])
    );

    const some = explorationActions(held("reads_query_plans"), wide);
    expect(some).not.toContain("reads_query_plans");
    expect(some).toContain("inspects_connections");
  });

  it("offers nothing this surface cannot show", () => {
    // A capability the operator was never offered must not collect an outcome.
    const actions = explorationActions(null, ["cpu.trend"]);
    expect(actions).toEqual([NO_EXPLORATION]);
  });
});

describe("the propensity is the probability of the action taken", () => {
  it("is 1 - rate when it declines to explore", () => {
    const choice = always(0.99).select({}, explorationActions(null, AVAILABLE));
    expect(choice.action).toBe(NO_EXPLORATION);
    expect(choice.propensity).toBeCloseTo(0.5);
  });

  it("is the rate spread over the candidates when it does", () => {
    const actions = explorationActions(null, AVAILABLE);
    const candidates = actions.length - 1;
    const choice = always(0).select({}, actions);
    expect(choice.action).not.toBe(NO_EXPLORATION);
    // Not `rate` — the probability of THIS action. An estimator handed the probability of
    // *exploring at all* would weight every arm identically and quietly mis-score them.
    expect(choice.propensity).toBeCloseTo(0.5 / candidates);
  });

  it("is 1, honestly, when there was nothing to choose between", () => {
    const choice = always(0).select({}, [NO_EXPLORATION]);
    expect(choice.action).toBe(NO_EXPLORATION);
    expect(choice.propensity).toBe(1);
  });

  it("refuses a rate that is not a probability", () => {
    expect(() => new ExplorationFloor(1)).toThrow(RangeError);
  });
});

describe("a session records the draw so it can be evaluated later", () => {
  it("journals context, alternatives and propensity on the decision", async () => {
    const profiles = createProfileService(always(0));
    const session = await profiles.open(scope, "s-1", { available: AVAILABLE });
    expect(session.surfaced).not.toBeNull();

    const decision = (await profiles.events("s-1")).find(
      (e) =>
        e.eventType === "DECISION_RECORDED" &&
        (e.payload as { decisionId: string }).decisionId.startsWith("explore:")
    );
    const payload = decision?.payload as {
      policy?: { id: string; propensity?: number };
      context?: Record<string, unknown>;
      alternatives?: unknown;
    };
    // The three fields off-policy evaluation needs, none of which can be reconstructed
    // afterwards: without the propensity `evaluatePolicy` reports `agreement-only` and
    // refuses a value estimate, and nothing downstream notices until someone tries.
    expect(payload.policy?.id).toBe("exploration-floor");
    expect(payload.policy?.propensity).toBeGreaterThan(0);
    expect(payload.context).toMatchObject({ subject: "acme:ana", topic: "cpu" });
    expect(payload.alternatives).toBeDefined();
  });

  it("records non-use as a zero, not as an absence", async () => {
    const profiles = createProfileService(always(0));
    const session = await profiles.open(scope, "s-2", { available: AVAILABLE });
    await profiles.scoreExploration(session.explorationId as string, "s-2-outcome", false);

    const outcome = (await profiles.events("s-2-outcome")).find(
      (e) => e.eventType === "OUTCOME_RECORDED"
    );
    // An absent outcome is SKIPPED by credit assignment; a zero is evidence. Scoring only
    // the successes is what makes an assessed level inflate monotonically.
    expect((outcome?.payload as { score: number }).score).toBe(0);
    expect((outcome?.payload as { decisionId: string }).decisionId).toBe(session.explorationId);
  });

  it("has nothing to score when it surfaced nothing", async () => {
    const profiles = createProfileService(always(0.99));
    const session = await profiles.open(scope, "s-3", { available: AVAILABLE });
    expect(session.surfaced).toBeNull();
    // Recording an outcome here would score the absence of an experiment as its result.
    expect(session.explorationId).toBeNull();
  });

  it("serves the same draw on replay", async () => {
    // The draw is random ONCE. A replay that re-drew would make a recorded session
    // unreproducible and its outcome unattributable to the arm that produced it.
    let n = 0;
    const drifting = new ExplorationFloor(0.5, () => (n++ === 0 ? 0 : 0.99));
    const profiles = createProfileService(drifting);
    const first = await profiles.open(scope, "s-4", { available: AVAILABLE });
    expect(first.surfaced).not.toBeNull();
    expect((await profiles.replay("s-4")).surfaced).toBe(first.surfaced);
  });
});

describe("canonical mode", () => {
  it("zeroes the profile and suppresses the draw", async () => {
    const profiles = createProfileService(always(0)); // would always explore
    for (let i = 0; i < 3; i++) await profiles.observe("acme", "ana", "open.queries.slow");

    const session = await profiles.open(scope, "s-5", {
      available: AVAILABLE,
      canonical: { active: true, reason: "page fired on orders-prod" },
    });

    expect(session.profile.flags).toEqual([]); // the shared reference frame
    expect(session.surfaced).toBeNull(); // an incident is not a place to experiment
    // The transition has to be attributable: silently rearranging someone's console the
    // moment an incident starts is the same failure this mode exists to prevent.
    expect(session.canonical.reason).toBe("page fired on orders-prod");
  });

  it("records no exploration decision at all", async () => {
    const profiles = createProfileService(always(0));
    await profiles.open(scope, "s-6", {
      available: AVAILABLE,
      canonical: { active: true, reason: "incident" },
    });
    const explored = (await profiles.events("s-6")).some(
      (e) =>
        e.eventType === "DECISION_RECORDED" &&
        (e.payload as { decisionId: string }).decisionId.startsWith("explore:")
    );
    expect(explored).toBe(false);
  });
});

describe("the operator's own word (C7)", () => {
  it("a declared flag is set with no evidence at all", async () => {
    const profiles = createProfileService();
    await profiles.declare("acme", "ana", "reads_query_plans", true);
    const profile = await profiles.derive("acme", "ana");
    expect(profile.flags).toEqual(["reads_query_plans"]);
    expect(profile.detail[0]?.source).toBe("declared");
  });

  it("a cleared flag stays cleared, however much evidence arrives afterwards", async () => {
    // The property that makes correction worth offering. If the next three observations
    // set it again, the correction was theatre and the operator will stop making them.
    const profiles = createProfileService();
    for (let i = 0; i < 3; i++) await profiles.observe("acme", "ana", "open.queries.slow");
    expect((await profiles.derive("acme", "ana")).flags).toEqual(["reads_query_plans"]);

    await profiles.declare("acme", "ana", "reads_query_plans", false);
    for (let i = 0; i < 5; i++) await profiles.observe("acme", "ana", "open.queries.slow");
    expect((await profiles.derive("acme", "ana")).flags).toEqual([]);
  });

  it("never expires", async () => {
    const profiles = createProfileService();
    await profiles.declare("acme", "ana", "tracks_replication", true);
    const far = Date.now() + 10_000 * 24 * 60 * 60 * 1000;
    // Expiry exists to stop an INFERENCE outliving its evidence; a statement has none.
    expect(await profiles.expire("acme", "ana", far)).toBe(0);
    expect((await profiles.derive("acme", "ana")).flags).toEqual(["tracks_replication"]);
  });

  it("refuses a flag outside the catalogue", async () => {
    const profiles = createProfileService();
    // An operator may correct the system; they may not extend the vocabulary it reasons in.
    await expect(profiles.declare("acme", "ana", "senior_engineer", true)).rejects.toThrow(
      /no flag/
    );
  });
});

describe("a surfaced capability reaches the surface", () => {
  it("leads the WHY section, and still drops nothing", async () => {
    const { composer } = buildCore();
    const canonical = await composer.answer(QUESTION);
    const explored = await composer.answer(QUESTION, NO_PREFERENCES, null, "queries.slow");

    expect(blueprintNodeIds(explored.blueprint)).not.toEqual(blueprintNodeIds(canonical.blueprint));
    // The floor may only REARRANGE what the agent chose. An exploration that added a
    // widget would be surfacing something the composition never selected, and one that
    // dropped a widget would be the capability trap wearing an experiment's clothes.
    const report = preservesNodes(
      blueprintNodeIds(canonical.blueprint),
      blueprintNodeIds(explored.blueprint)
    );
    expect(report.ok).toBe(true);
    expect(report.added).toEqual([]);
  });

  it("yields to a stated preference — an experiment is not a licence", async () => {
    const { composer } = buildCore();
    const stated = { ...NO_PREFERENCES, pinnedWhyWidget: "cpu.trend" };
    const view = await composer.answer(QUESTION, stated, null, "queries.slow");
    const pinnedFirst = await composer.answer(QUESTION, stated, null, null);
    expect(blueprintNodeIds(view.blueprint)).toEqual(blueprintNodeIds(pinnedFirst.blueprint));
  });

  it("canonical mode composes exactly the canonical surface", async () => {
    // §5.4 — canonical is the same call with everything zeroed, not a second code path,
    // so it cannot drift from the adaptive one. Identical, not merely equivalent.
    const { composer } = buildCore();
    const baseline = await composer.answer(QUESTION);
    const underIncident = await composer.answer(QUESTION, NO_PREFERENCES, null, null);
    expect(underIncident.blueprint).toEqual(baseline.blueprint);
  });
});

describe("the escape hatch is measured, not inferred", () => {
  it("is recorded, and sets no flag", async () => {
    const profiles = createProfileService();
    for (let i = 0; i < 5; i++) await profiles.observe("acme", "ana", "escape.canonical");
    // Its rate is the cheapest corrective signal in the system — how often adaptation was
    // wrong — and it is deliberately not evidence OF anything: no catalogue flag takes it,
    // so reaching for the canonical view can never make the system more confident.
    expect((await profiles.derive("acme", "ana")).flags).toEqual([]);
    expect(FLAG_CATALOGUE.some((f) => f.evidencedBy === "escape.canonical")).toBe(false);
  });
});
