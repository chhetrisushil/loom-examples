import { describe, expect, it } from "vitest";
import { FLAG_CATALOGUE_VERSION, flagDefinition } from "../src/flags";
import {
  EMPTY_PROFILE,
  type OperatorProfile,
  dueLapses,
  explainFlag,
  foldProfile,
  subjectOf,
} from "../src/profile";
import { createProfileService } from "../src/profileService";

// ── Phase 2a: the derived half of the Operator Profile ───────────────────────
//
// Three properties here are corrections to the design rather than implementations of it,
// and each is a test because each is invisible when wrong:
//
//   • the fold takes no clock, so the same rows answer the same way forever;
//   • a lapse is an appended EVENT, so expiry is a fact with a date rather than a
//     consequence of when someone happened to read;
//   • the resolved profile is journaled by VALUE, so a replay serves what the run used
//     even after the evidence and the catalogue have both moved on.

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1);
const scope = { tenant: "acme", operator: "ana", topic: "queries" };
const SUBJECT = subjectOf("acme", "ana");

/** Rows as the read model stores them — the fold's only input. */
const row = (action: string, timestamp: number, flag = "") => ({
  rowId: `${action}${flag}-${timestamp}`,
  executionId: "x",
  sequence: 0,
  timestamp,
  kind: flag === "" ? "OPERATOR_ACTION" : "FLAG_LAPSED",
  fields: { subject: SUBJECT, action, flag },
  value: {},
});

const openPlan = (at: number) => row("open.queries.slow", at);

describe("the flag catalogue is closed", () => {
  it("refuses an id it does not define", () => {
    // The closure property, enforced rather than assumed: a lookup that returned
    // `undefined` for "senior_engineer" would make the catalogue a convention.
    expect(() => flagDefinition("senior_engineer")).toThrow(/no flag/);
    expect(flagDefinition("reads_query_plans").topic).toBe("queries");
  });
});

describe("the fold is a function of the rows, and of nothing else", () => {
  it("sets a flag once the evidence reaches its threshold", () => {
    const definition = flagDefinition("reads_query_plans");
    const under = foldProfile(
      SUBJECT,
      Array.from({ length: definition.threshold - 1 }, (_, i) => openPlan(T0 + i))
    );
    expect(under.flags).toEqual([]); // one observation is a misclick, not a capability

    const at = foldProfile(
      SUBJECT,
      Array.from({ length: definition.threshold }, (_, i) => openPlan(T0 + i))
    );
    expect(at.flags).toEqual(["reads_query_plans"]);
    expect(at.catalogueVersion).toBe(FLAG_CATALOGUE_VERSION);
  });

  it("answers identically no matter when it is called", () => {
    // The correction. Expiry evaluated at READ time would make this fold a function of
    // (rows, now): the same history would answer differently tomorrow, silently, and the
    // profile a run journaled could never be reproduced.
    const rows = Array.from({ length: 3 }, (_, i) => openPlan(T0 + i));
    const early = foldProfile(SUBJECT, rows);
    const late = foldProfile(SUBJECT, rows); // a year later, by construction: no clock is read
    expect(late).toEqual(early);
    expect(late.flags).toEqual(["reads_query_plans"]);
  });

  it("stops counting evidence a lapse has spent, and keeps the rows", () => {
    const rows = [
      openPlan(T0),
      openPlan(T0 + 1),
      openPlan(T0 + 2),
      row("", T0 + 3, "reads_query_plans"), // the lapse
    ];
    expect(foldProfile(SUBJECT, rows).flags).toEqual([]);

    // Re-earned afterwards, from evidence the lapse did not reach.
    const reEarned = [...rows, openPlan(T0 + 10), openPlan(T0 + 11), openPlan(T0 + 12)];
    expect(foldProfile(SUBJECT, reEarned).flags).toEqual(["reads_query_plans"]);
  });

  it("keeps one subject's evidence out of another's", () => {
    const other = {
      ...openPlan(T0),
      fields: { subject: "acme:bo", action: "open.queries.slow", flag: "" },
    };
    expect(foldProfile(SUBJECT, [openPlan(T0), openPlan(T0 + 1), other]).flags).toEqual([]);
  });
});

describe("expiry is a scheduled evaluator whose output is events", () => {
  it("names what has outlived its horizon — and nothing before then", () => {
    const profile = foldProfile(SUBJECT, [openPlan(T0), openPlan(T0 + 1), openPlan(T0 + 2)]);
    const horizon = flagDefinition("reads_query_plans").horizonMs;

    expect(dueLapses(profile, T0 + horizon)).toEqual([]);
    const due = dueLapses(profile, T0 + horizon + 2 * DAY);
    expect(due).toHaveLength(1);
    expect(due[0]?.flag).toBe("reads_query_plans");
    // The lapse carries the evidence it expired, so the operator can be shown what
    // lapsed and when rather than watching a capability quietly disappear.
    expect(due[0]?.lastEvidencedAt).toBe(T0 + 2);
  });

  it("emits a lapse into the log, and the second pass emits nothing", async () => {
    const profile = createProfileService();
    for (let i = 0; i < 3; i++) await profile.observe("acme", "ana", "open.queries.slow");
    expect((await profile.derive("acme", "ana")).flags).toEqual(["reads_query_plans"]);

    const far = Date.now() + 400 * DAY;
    expect(await profile.expire("acme", "ana", far)).toBe(1);
    expect((await profile.derive("acme", "ana")).flags).toEqual([]);
    // Idempotent in effect: the flag is already gone, so there is nothing left to expire.
    expect(await profile.expire("acme", "ana", far)).toBe(0);
  });
});

describe("resolving a profile into a run", () => {
  it("journals the value, so a replay serves what the run used", async () => {
    const profile = createProfileService();
    for (let i = 0; i < 3; i++) await profile.observe("acme", "ana", "open.queries.slow");

    const resolved = await profile.resolve(scope, "session-1");
    expect(resolved.flags).toEqual(["reads_query_plans"]);

    // The world moves on: the flag lapses, so the DERIVED profile is now empty.
    await profile.expire("acme", "ana", Date.now() + 400 * DAY);
    expect((await profile.derive("acme", "ana")).flags).toEqual([]);

    // …and re-executing the run that already resolved still answers with what it was
    // arranged under. A journaled log OFFSET would re-derive here and return the empty
    // set — reproducing the events but not the fold, which is the substitution this
    // design refuses.
    const before = profile.derivations();
    const replayed = await profile.replay("session-1");
    expect(replayed.flags).toEqual(["reads_query_plans"]);
    // And the proof that it was SERVED rather than recomputed: the deriver was not called.
    expect(profile.derivations()).toBe(before);
  });

  it("records the decision with the catalogue version beside it", async () => {
    const profile = createProfileService();
    for (let i = 0; i < 3; i++) await profile.observe("acme", "ana", "open.queries.slow");
    await profile.resolve(scope, "session-2");

    const decision = (await profile.events("session-2")).find(
      (e) => e.eventType === "DECISION_RECORDED"
    );
    expect(decision).toBeDefined();
    const payload = decision?.payload as {
      choice: OperatorProfile;
      rationale: { catalogueVersion: number };
    };
    expect(payload.choice.flags).toEqual(["reads_query_plans"]);
    // Two runs that resolved the same flags under different catalogues did not resolve
    // the same profile, so the version travels with the value rather than beside it.
    expect(payload.rationale.catalogueVersion).toBe(FLAG_CATALOGUE_VERSION);
  });

  it("an operator with no history resolves to the empty profile", async () => {
    const profile = createProfileService();
    const resolved = await profile.resolve({ ...scope, operator: "bo" }, "session-3");
    expect(resolved).toEqual(EMPTY_PROFILE(subjectOf("acme", "bo")));
  });
});

describe("the operator can be told why", () => {
  it("cites the interaction, the count and the date", () => {
    const profile = foldProfile(SUBJECT, [openPlan(T0), openPlan(T0 + 1), openPlan(T0 + 2)]);
    const sentence = explainFlag(profile.detail[0] as never);
    expect(sentence).toContain("open.queries.slow");
    expect(sentence).toContain("3 times");
    expect(sentence).toContain("2026-09-01");
  });
});
