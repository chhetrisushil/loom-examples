import { blueprintNodeIds } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import type { Topic } from "../src/catalogue";
import {
  COHORT_MODEL_VERSION,
  COHORT_RULES,
  type CohortId,
  HYSTERESIS_WINDOWS,
  INITIAL_COHORT_STATE,
  assignCohort,
  describeTransition,
  nextCohortState,
} from "../src/cohorts";
import { FLAG_CATALOGUE_VERSION } from "../src/flags";
import { checkFloor, floorFor } from "../src/floor";
import type { OperatorProfile } from "../src/profile";
import { buildCore } from "../src/wiring";

// ── Phase 3: cohorts ─────────────────────────────────────────────────────────
//
// This is the first phase that changes what a blueprint CONTAINS rather than how it is
// ordered, so it is the first that can take something away. The floor is what stops it,
// and most of this file is the floor being held to that.

const QUESTIONS: Record<Topic, string> = {
  cpu: "Why is the CPU utilization high?",
  connections: "What is the connection saturation level?",
  replication: "Is replica lag a problem right now?",
  queries: "Which slow queries are hurting us?",
};

const withFlags = (...flags: string[]): OperatorProfile => ({
  subject: "acme:ana",
  flags,
  catalogueVersion: FLAG_CATALOGUE_VERSION,
  detail: flags.map((id) => ({ id, evidence: [1], lastEvidencedAt: 1, source: "observed" })),
});

describe("cohorts are assigned by rule", () => {
  it("assigns by what the operator does, and is total", () => {
    expect(assignCohort(withFlags("reads_query_plans"))).toBe("relational_deep");
    expect(assignCohort(withFlags("tracks_replication"))).toBe("infra_deep");
    // The last rule matches everything, so there is no operator the model cannot place.
    expect(assignCohort(withFlags("some_future_flag"))).toBe("shallow");
  });

  it("distinguishes 'we have seen nothing' from 'we have seen enough'", () => {
    // They render identically and mean different things, and only one of them is a
    // judgment about the person.
    expect(assignCohort(null)).toBe("unassigned");
    expect(assignCohort(withFlags())).toBe("unassigned");
  });
});

describe("the floor holds for every cohort, on every topic", () => {
  // The presubmit assertion, run as a test: the guarantee is that NO cohort's composition
  // is missing anything its intent declares, and the only way to know is to compose them
  // all and check.
  const cohorts: CohortId[] = ["unassigned", "shallow", "relational_deep", "infra_deep"];

  for (const topic of Object.keys(QUESTIONS) as Topic[]) {
    for (const cohort of cohorts) {
      it(`${topic} / ${cohort}`, async () => {
        const { composer } = buildCore();
        const result = await composer.answer(QUESTIONS[topic], undefined, null, null, cohort);
        expect(result.floor.missing).toEqual([]);
        expect(result.floor.ok).toBe(true);
      });
    }
  }

  it("a cohort may ADD above the floor, and what it added is named", async () => {
    const { composer } = buildCore();
    const base = await composer.answer(QUESTIONS.cpu, undefined, null, null, "shallow");
    const deep = await composer.answer(QUESTIONS.cpu, undefined, null, null, "relational_deep");

    const baseIds = blueprintNodeIds(base.blueprint);
    const deepIds = blueprintNodeIds(deep.blueprint);
    // Strictly more: every node the shallow surface has, plus the cohort's additions.
    for (const id of baseIds) expect(deepIds).toContain(id);
    expect(deepIds.length).toBeGreaterThan(baseIds.length);
  });

  it("a cohort cannot subtract, even if its rule says nothing about a floor widget", async () => {
    const { composer } = buildCore();
    const shallow = await composer.answer(QUESTIONS.queries, undefined, null, null, "shallow");
    for (const id of floorFor("queries")) {
      expect(blueprintNodeIds(shallow.blueprint)).toContain(id);
    }
  });

  it("catches a floor violation rather than rendering it", async () => {
    // The negative case: a floor naming something no composition contains must FAIL,
    // otherwise this whole suite passes vacuously over a check that cannot fail.
    const { composer } = buildCore();
    const result = await composer.answer(QUESTIONS.cpu, undefined, null, null, "shallow");
    const report = checkFloor(result.blueprint, "cpu");
    expect(report.ok).toBe(true);

    const withGhost = {
      ...result.blueprint,
      layout: { type: "stack" as const, children: [] },
    };
    expect(checkFloor(withGhost, "cpu").ok).toBe(false);
    expect(checkFloor(withGhost, "cpu").missing.length).toBeGreaterThan(0);
  });
});

describe("the cohort is part of blueprint identity", () => {
  it("two cohorts produce two different artifacts, visibly", async () => {
    const { composer } = buildCore();
    const shallow = await composer.answer(QUESTIONS.cpu, undefined, null, null, "shallow");
    const deep = await composer.answer(QUESTIONS.cpu, undefined, null, null, "relational_deep");

    // Not one artifact that quietly means different things to different people: a pinned
    // view or a postmortem reference resolving to one tree must never resolve to the other.
    expect(shallow.blueprint.id).not.toBe(deep.blueprint.id);
    expect(deep.blueprint.id).toContain("relational_deep");
    expect(deep.blueprint.id).toContain(`v${COHORT_MODEL_VERSION}`);
    expect(deep.cohort).toEqual({ id: "relational_deep", modelVersion: COHORT_MODEL_VERSION });
  });

  it("floor nodes keep their identity across cohorts", async () => {
    // The property explicit ids exist for. With derived ids these would be equal only
    // while the props matched byte for byte, and the floor would stop being a floor the
    // first time a cohort's generator varied a title.
    const { composer } = buildCore();
    const shallow = await composer.answer(QUESTIONS.cpu, undefined, null, null, "shallow");
    const deep = await composer.answer(QUESTIONS.cpu, undefined, null, null, "infra_deep");
    for (const id of floorFor("cpu")) {
      expect(blueprintNodeIds(shallow.blueprint)).toContain(id);
      expect(blueprintNodeIds(deep.blueprint)).toContain(id);
    }
  });
});

describe("hysteresis", () => {
  it("requires the predicate to hold across consecutive windows", () => {
    let state = INITIAL_COHORT_STATE;
    const first = nextCohortState(state, "relational_deep");
    state = first.state;
    expect(first.transition?.applied).toBe(false);
    expect(state.current).toBe("unassigned"); // nothing has changed yet

    const second = nextCohortState(state, "relational_deep");
    state = second.state;
    expect(second.transition?.applied).toBe(true);
    expect(state.current).toBe("relational_deep");
  });

  it("resets rather than decrements when a proposal lapses", () => {
    // Two windows on, one off, two on is NOT four windows of evidence. Treating it as
    // such is how a damper ends up ratifying the oscillation it was added to prevent.
    let state = INITIAL_COHORT_STATE;
    state = nextCohortState(state, "relational_deep").state;
    state = nextCohortState(state, "unassigned").state;
    expect(state.current).toBe("unassigned");
    expect(state.windows).toBe(0);

    const resumed = nextCohortState(state, "relational_deep");
    expect(resumed.transition?.applied).toBe(false); // back to the start of the count
  });

  it("holds a flapping operator steady", () => {
    let state = INITIAL_COHORT_STATE;
    for (const proposed of ["relational_deep", "shallow", "relational_deep", "shallow"] as const) {
      state = nextCohortState(state, proposed).state;
    }
    // A cohort that oscillates weekly is worse than one that is slightly wrong and stable,
    // because every change re-composes and invalidates what was composed before it.
    expect(state.current).toBe("unassigned");
  });

  it("tells the operator, and says nothing is gone", () => {
    const message = describeTransition({ from: "shallow", to: "relational_deep", applied: true });
    expect(message).toContain("relational_deep");
    // C2: a reassignment they did not ask for is announced, and the announcement carries
    // the guarantee — nothing they could see before has been taken away.
    expect(message).toMatch(/still there/);
    expect(HYSTERESIS_WINDOWS).toBeGreaterThan(1);
  });
});

describe("a cohort rule must actually add something", () => {
  it("no rule's additions are entirely inside the floor it sits above", () => {
    // Found by a failing test rather than by reading: `relational_deep` originally added
    // `queries.slow` on the cpu topic, which that topic's floor already contains — so the
    // rule composed an identical tree while reading, in review, as adaptation. A rule that
    // cannot change anything is the same defect as a check that cannot fail.
    for (const rule of COHORT_RULES) {
      for (const [topic, additions] of Object.entries(rule.adds)) {
        const floor = new Set(floorFor(topic as Topic));
        const genuine = (additions as string[]).filter((id) => !floor.has(id));
        expect(
          genuine.length,
          `cohort "${rule.id}" adds nothing above the floor on "${topic}"`
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("the rules are reviewable", () => {
  it("every rule explains itself in the product's own words", () => {
    for (const rule of COHORT_RULES) {
      expect(rule.describes.length).toBeGreaterThan(10);
      // Named for what someone DOES, never for who they are: there is no rule here a
      // title, a tenure or a demographic could satisfy.
      expect(rule.describes).not.toMatch(/senior|junior|manager|years/i);
    }
  });
});
