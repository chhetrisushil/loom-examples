import type { FlowDefinition } from "@loom/core";
import type { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryDurableStateStore, durableState } from "@loom/plugin-durable-state";
import type { DurableStateHandle } from "@loom/plugin-durable-state";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";

// ── Phase 1 — stated preferences, and nothing else ───────────────────────────
//
// The Operator Profile has three parts with different epistemic status: recorded fact
// (capability flags), stated choice (this file), and derived summary (cohorts). This is
// the FIRST of them, deliberately alone, because it is the part with no inference in it:
// a preference is written when the operator states a choice and read when the surface is
// composed. It is a key-value store, and it is expected to deliver a large share of the
// total benefit — which is what makes it the honest thing to measure the rest against.
//
// So: no flags, no evidence, no expiry, no cohorts, and no projection logic beyond
// replaying what the operator said. In particular there is no DISCLOSURE preference here
// even though the design lists one, because collapsing a pane needs a container this
// catalogue does not have — that is Phase 2's projection, and inventing half of it here
// would be exactly the sequencing the plan exists to prevent.
//
// What IS here changes the composed surface visibly and needs no new vocabulary:
// density (how tightly the WHY grid packs) and a pinned WHY widget (which one leads).
// Both are pure arrangement, which is why the invariant in the test suite holds: the
// arranged blueprint contains every node id the canonical one does. Adaptation
// rearranges; it never withholds.

/** A stated choice. Everything here was typed or clicked by the operator. */
export const preferencesSchema = z.object({
  /** How tightly the WHY grid packs. */
  density: z.enum(["comfortable", "compact"]),
  /**
   * A WHY widget the operator pinned to lead the section, by catalogue id.
   * `null` is "no opinion" — the topic model's own order stands.
   */
  pinnedWhyWidget: z.string().nullable(),
});

export type OperatorPreferences = z.infer<typeof preferencesSchema>;

/**
 * What an operator who has stated nothing gets — and, per the design's §5.4, exactly what
 * the canonical surface is. There is no second code path for "no preferences": it is this
 * value through the same composer, which is what makes the control arm free and stops the
 * canonical view drifting from the adaptive one.
 */
export const NO_PREFERENCES: OperatorPreferences = {
  density: "comfortable",
  pinnedWhyWidget: null,
};

// ── Scope ────────────────────────────────────────────────────────────────────

/**
 * Preferences are scoped, because competence and taste are not uniform across a
 * portfolio: how someone wants replication lag laid out says little about how they want
 * slow queries laid out. And they are per-TENANT as well as per-operator — one
 * organisation's operational posture must not shape another's defaults through a
 * consultant who works in both.
 */
export interface PreferenceScope {
  tenant: string;
  operator: string;
  /** The resource class in view — here, the dashboard topic. */
  topic: string;
}

const SEPARATOR = "/";

/**
 * The storage key for one scope.
 *
 * A part containing the separator is REFUSED rather than escaped. A tenant id of
 * `"acme/ana"` would otherwise address `acme`'s operator `ana`, which is a cross-tenant
 * read produced by nothing more exotic than a permissive id field — the same
 * key-injection shape `childIdFor` refuses in `@loom/orchestration`.
 */
export function preferenceKey(scope: PreferenceScope): string {
  for (const [field, value] of Object.entries(scope)) {
    if (value.length === 0) {
      throw new TypeError(`preferenceKey: ${field} must not be empty`);
    }
    if (value.includes(SEPARATOR)) {
      throw new TypeError(
        `preferenceKey: ${field} must not contain "${SEPARATOR}" (got "${value}") — a separator in a part addresses another scope`
      );
    }
  }
  return [scope.tenant, scope.operator, scope.topic].join(SEPARATOR);
}

// ── The store ────────────────────────────────────────────────────────────────

/**
 * A keyed CAS store with a versioned contract and migrations, rather than a bare map.
 *
 * The contract is the reason. A preference set outlives the code that wrote it: this
 * schema will grow a field, and a v1 record read by v2 code must be migrated loudly
 * rather than silently read as a partial object. `durableState` also makes both the read
 * and the write RECORDED steps, so the preferences a given run used are in that run's
 * log — which is the property the later phases build on when the input stops being a
 * value the operator typed and starts being one the system derived.
 */
export function createPreferenceState(): DurableStateHandle<OperatorPreferences> {
  return durableState({
    id: "operator-preferences",
    version: 1,
    schema: preferencesSchema,
    store: new InMemoryDurableStateStore(),
  });
}

// ── The flows: state a choice, resolve the effective set ─────────────────────

export interface RecordInput {
  scope: PreferenceScope;
  /** The fields the operator just stated. Absent fields keep their stored value. */
  stated: Partial<OperatorPreferences>;
}

const scopeSchema = z.object({
  tenant: z.string(),
  operator: z.string(),
  topic: z.string(),
});

export const RECORD_FLOW_ID = "record-preference";
export const RESOLVE_FLOW_ID = "resolve-preferences";

export const recordFlowDef: FlowDefinition<RecordInput, OperatorPreferences> = {
  _tag: "FlowDefinition",
  id: RECORD_FLOW_ID,
  name: "Record a stated preference",
  version: "1.0.0",
  inputSchema: z.object({
    scope: scopeSchema,
    stated: preferencesSchema.partial(),
  }) as unknown as z.ZodSchema<RecordInput>,
  outputSchema: preferencesSchema as z.ZodSchema<OperatorPreferences>,
  steps: [],
};

export const resolveFlowDef: FlowDefinition<PreferenceScope, OperatorPreferences> = {
  _tag: "FlowDefinition",
  id: RESOLVE_FLOW_ID,
  name: "Resolve effective preferences",
  version: "1.0.0",
  inputSchema: scopeSchema as unknown as z.ZodSchema<PreferenceScope>,
  outputSchema: preferencesSchema as z.ZodSchema<OperatorPreferences>,
  steps: [],
};

/**
 * Load-merge-save under compare-and-swap. The merge is over STATED fields only, so
 * stating a density does not silently reset a pin someone set last week — the failure a
 * whole-object write has, and the reason `stated` is a partial rather than the full set.
 */
export function recordRunner(
  state: DurableStateHandle<OperatorPreferences>
): FlowRunner<RecordInput, OperatorPreferences> {
  return async (ctx, { scope, stated }) => {
    const key = preferenceKey(scope);
    const current = await state.load(ctx, key);
    const next: OperatorPreferences = { ...(current.value ?? NO_PREFERENCES), ...stated };
    await state.save(ctx, key, next, current.revision);
    return next;
  };
}

/** The effective set for a scope: what was stated, else the canonical defaults. */
export function resolveRunner(
  state: DurableStateHandle<OperatorPreferences>
): FlowRunner<PreferenceScope, OperatorPreferences> {
  return async (ctx, scope) => {
    const loaded = await state.load(ctx, preferenceKey(scope));
    return loaded.value ?? NO_PREFERENCES;
  };
}

/** Register the store's effects on the runtime that will run these flows. */
export function registerPreferenceEffects(
  state: DurableStateHandle<OperatorPreferences>,
  effects: EffectRuntime
): void {
  state.register(effects);
}

// ── Applying them: pure arrangement ──────────────────────────────────────────

/** Grid gap, in the units the browser renderer reads. The terminal renderer ignores it. */
export function gapFor(preferences: OperatorPreferences): number {
  return preferences.density === "compact" ? 4 : 16;
}

/**
 * Order the WHY widgets: a pinned one leads, the rest keep the topic model's order.
 *
 * Two properties this must have, and a test for each. It returns the SAME SET it was
 * given — a pin reorders, it never promotes one widget by dropping another — and a pin
 * naming a widget this topic does not show is a no-op rather than an error, because a
 * preference stated against `cpu` is legitimately meaningless on `replication` and
 * refusing to render would turn a stale preference into an outage.
 */
export function arrangeWhyWidgets(
  ids: readonly string[],
  preferences: OperatorPreferences
): string[] {
  const pinned = preferences.pinnedWhyWidget;
  if (pinned === null || !ids.includes(pinned)) return [...ids];
  return [pinned, ...ids.filter((id) => id !== pinned)];
}
