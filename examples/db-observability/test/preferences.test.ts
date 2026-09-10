import { blueprintNodeIds, preservesNodes } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { FLAG_CATALOGUE_VERSION } from "../src/flags";
import { createPreferenceService } from "../src/preferenceService";
import {
  NO_PREFERENCES,
  type PreferenceScope,
  arrangeWhyWidgets,
  gapFor,
  preferenceKey,
} from "../src/preferences";
import type { OperatorProfile } from "../src/profile";
import { suggestedLead } from "../src/suggest";
import { buildCore } from "../src/wiring";

// ── Phase 1: stated preferences ──────────────────────────────────────────────
//
// Two families of assertion here, and the second family is the one that matters.
//
// The first is that a stated choice survives a round trip and is scoped to the operator
// who stated it. The second is the pair of INVARIANTS the whole adaptation programme
// rests on, asserted at the point where it is still cheap to hold them: an unstated
// profile yields the canonical surface through the same code path (so the control arm is
// free and cannot drift), and an arrangement never removes a node (so the worst case is a
// worse layout, never a missing capability).

const QUESTION = "Why is the CPU utilization high?";
const scope = (over: Partial<PreferenceScope> = {}): PreferenceScope => ({
  tenant: "acme",
  operator: "ana",
  topic: "cpu",
  ...over,
});

describe("preference scope", () => {
  it("keys by tenant, operator and resource", () => {
    expect(preferenceKey(scope())).toBe("acme/ana/cpu");
  });

  it("refuses a separator in a part rather than escaping it", () => {
    // `tenant: "acme/ana"` would address acme's operator ana — a cross-tenant read
    // produced by nothing more exotic than a permissive id field.
    expect(() => preferenceKey(scope({ tenant: "acme/ana" }))).toThrow(/must not contain/);
    expect(() => preferenceKey(scope({ operator: "" }))).toThrow(/must not be empty/);
  });
});

describe("arrangement is pure rearrangement", () => {
  const ids = ["connections.saturation", "queries.slow", "cpu.trend"];

  it("a pinned widget leads, and the set is unchanged", () => {
    const arranged = arrangeWhyWidgets(ids, {
      ...NO_PREFERENCES,
      pinnedWhyWidget: "queries.slow",
    });
    expect(arranged[0]).toBe("queries.slow");
    expect([...arranged].sort()).toEqual([...ids].sort());
  });

  it("a pin for a widget this topic does not show is a no-op, not an error", () => {
    // Preferences are scoped per topic, but a stale or copied one is ordinary. Refusing
    // to render would turn a meaningless preference into an outage.
    const arranged = arrangeWhyWidgets(ids, {
      ...NO_PREFERENCES,
      pinnedWhyWidget: "replication.lag",
    });
    expect(arranged).toEqual(ids);
  });

  it("density changes spacing and nothing else", () => {
    expect(gapFor({ ...NO_PREFERENCES, density: "compact" })).toBeLessThan(
      gapFor({ ...NO_PREFERENCES, density: "comfortable" })
    );
  });
});

describe("the two invariants", () => {
  it("an unstated profile yields the canonical surface, through the same method", async () => {
    const { composer } = buildCore();
    const implicit = await composer.answer(QUESTION);
    const explicit = await composer.answer(QUESTION, NO_PREFERENCES);
    // Not "equivalent" — identical. Canonical mode is this call with the profile zeroed,
    // which is what makes a holdout free and stops the two paths drifting apart.
    expect(explicit.blueprint).toEqual(implicit.blueprint);
  });

  it("no arrangement removes a node the canonical surface has", async () => {
    const { composer } = buildCore();
    const canonical = await composer.answer(QUESTION);
    const arranged = await composer.answer(QUESTION, {
      density: "compact",
      pinnedWhyWidget: "queries.slow",
    });

    const report = preservesNodes(
      blueprintNodeIds(canonical.blueprint),
      blueprintNodeIds(arranged.blueprint)
    );
    expect(report.ok).toBe(true);
    // Nothing added either: a rearrangement is a permutation, so an `added` id would mean
    // a node was re-identified — which is what a prop edit does to a derived id.
    expect(report.added).toEqual([]);
    expect(report.compared).toBeGreaterThan(0); // the denominator: ok over nothing proves nothing
  });

  it("the arrangement is visible — the pin actually leads", async () => {
    // Paired with the invariant above deliberately: a projection that changed NOTHING
    // would satisfy every assertion in the previous test.
    const { composer } = buildCore();
    const canonical = await composer.answer(QUESTION);
    const arranged = await composer.answer(QUESTION, {
      density: "compact",
      pinnedWhyWidget: "queries.slow",
    });
    expect(blueprintNodeIds(arranged.blueprint)).not.toEqual(blueprintNodeIds(canonical.blueprint));
  });
});

describe("a derived profile can suggest, and a stated one overrides it", () => {
  const WITH_FLAG: OperatorProfile = {
    subject: "acme:ana",
    flags: ["reads_query_plans"],
    catalogueVersion: FLAG_CATALOGUE_VERSION,
    detail: [{ id: "reads_query_plans", evidence: [1, 2, 3], lastEvidencedAt: 3 }],
  };
  const ids = ["connections.saturation", "queries.slow", "cpu.trend"];

  it("suggests the widget its evidence points at", () => {
    expect(suggestedLead(WITH_FLAG, ids)).toBe("queries.slow");
    expect(arrangeWhyWidgets(ids, NO_PREFERENCES, suggestedLead(WITH_FLAG, ids))[0]).toBe(
      "queries.slow"
    );
  });

  it("suggests nothing when the flag's widget is not on this surface", () => {
    expect(suggestedLead(WITH_FLAG, ["cpu.trend"])).toBeNull();
    expect(suggestedLead(null, ids)).toBeNull();
  });

  it("a STATED pin outranks the inference — C7, and without a tie-break", () => {
    const stated = { ...NO_PREFERENCES, pinnedWhyWidget: "cpu.trend" };
    expect(arrangeWhyWidgets(ids, stated, suggestedLead(WITH_FLAG, ids))[0]).toBe("cpu.trend");
  });

  it("a stated pin that does not apply here does not hand the decision back to the inference", () => {
    // The subtle one. "My pin is irrelevant on this topic" is not "so guess for me": the
    // person already said what they wanted, and falling through would let a system
    // preference win on a surface where a human one existed.
    const stated = { ...NO_PREFERENCES, pinnedWhyWidget: "replication.lag" };
    expect(arrangeWhyWidgets(ids, stated, suggestedLead(WITH_FLAG, ids))).toEqual(ids);
  });

  it("a profile-arranged surface still drops nothing", async () => {
    const { composer } = buildCore();
    const canonical = await composer.answer(QUESTION);
    const arranged = await composer.answer(QUESTION, NO_PREFERENCES, WITH_FLAG);
    const report = preservesNodes(
      blueprintNodeIds(canonical.blueprint),
      blueprintNodeIds(arranged.blueprint)
    );
    expect(report.ok).toBe(true);
    expect(report.added).toEqual([]);
  });
});

describe("stating a choice", () => {
  it("round-trips, and merges rather than overwriting the rest", async () => {
    const prefs = createPreferenceService();
    await prefs.state(scope(), { density: "compact" });
    await prefs.state(scope(), { pinnedWhyWidget: "queries.slow" });

    // The second statement said nothing about density, so density survives it. A
    // whole-object write here would silently reset a choice made last week.
    expect(await prefs.resolve(scope())).toEqual({
      density: "compact",
      pinnedWhyWidget: "queries.slow",
    });
  });

  it("an operator who has stated nothing resolves to the canonical defaults", async () => {
    const prefs = createPreferenceService();
    expect(await prefs.resolve(scope({ operator: "bo" }))).toEqual(NO_PREFERENCES);
  });

  it("puts the value the run used in the run's own log", async () => {
    // Worth nothing in Phase 1 and everything later. Today the preference is something
    // the operator typed, so the log is a convenience; at the point the input becomes
    // something the SYSTEM derived, "which profile did this run see" stops being
    // answerable from the store, because the store has moved on since.
    const prefs = createPreferenceService();
    await prefs.state(scope(), { density: "compact" });
    await prefs.resolve(scope());

    const journal = await prefs.events("resolve-2");
    const load = journal.find(
      (e) =>
        e.eventType === "STEP_COMPLETED" &&
        (e.payload as { stepId?: string }).stepId === "operator-preferences.load"
    );
    expect(load).toBeDefined();
    expect((load?.payload as { output: { value: unknown } }).output.value).toEqual({
      density: "compact",
      pinnedWhyWidget: null,
    });
  });

  it("is scoped: another operator, tenant or topic is untouched", async () => {
    const prefs = createPreferenceService();
    await prefs.state(scope(), { density: "compact" });

    expect((await prefs.resolve(scope({ operator: "bo" }))).density).toBe("comfortable");
    expect((await prefs.resolve(scope({ tenant: "globex" }))).density).toBe("comfortable");
    expect((await prefs.resolve(scope({ topic: "replication" }))).density).toBe("comfortable");
  });
});
