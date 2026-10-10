import { stableBucketPolicy } from "@loom-ui/planner";
import { type Policy, type PolicyChoice, type PolicyContext, contentHash } from "@loom/learning";
import type { Layout, Segment } from "./world";

// ── The policies ────────────────────────────────────────────────────────────────────────────
// ONE policy id ("layout"), several immutable versions. Training is out of band (ADR 0080): a
// candidate here is a plain rule standing for "whatever a trainer produced from the log", and its
// `contentHash` is what the registry pins - re-registering a version with other content throws.

export const POLICY_ID = "layout";

/** What a version IS, for the registry's content address. */
const RULES: Record<string, Record<string, unknown>> = {
  "1": { kind: "uniform", weights: { flat: 1, tabs: 1 } },
  "2": { kind: "by-segment", power: "tabs", casual: "flat", trainedOn: "epoch-1 votes" },
  "3": { kind: "always", layout: "tabs", trainedOn: "epoch-2 votes" },
};
export const versionHash = (version: string): string =>
  contentHash({ id: POLICY_ID, version, rule: RULES[version] });

/**
 * The incumbent: a fair coin per UNIT (stable: a user keeps their layout), recorded with
 * propensity 0.5. That randomisation is what makes every later candidate evaluable off-policy.
 */
const uniform = stableBucketPolicy({
  id: POLICY_ID,
  version: "1",
  weights: { flat: 1, tabs: 1 },
});

/**
 * The host's feature store: unit -> segment, written when the host knows the user. The planner's
 * choice context is its own ({ kind, unit, key, catalogId }) and carries no segment, so a
 * contextual policy reads its features by `unit`, as a real one reads a feature store.
 */
export class SegmentStore {
  private readonly bySegment = new Map<string, Segment>();
  set(unit: string, segment: Segment): void {
    this.bySegment.set(unit, segment);
  }
  /** A miss is the safe default, never a throw: an unknown unit is treated as casual. */
  get(unit: unknown): Segment {
    return (typeof unit === "string" ? this.bySegment.get(unit) : undefined) ?? "casual";
  }
}

/** Candidate 2: tabs for power users, flat for casual ones (right in epoch 1). Deterministic. */
const bySegmentOf = (segments: SegmentStore): Policy<Layout> => ({
  id: POLICY_ID,
  version: "2",
  select: (ctx: PolicyContext): PolicyChoice<Layout> => ({
    action: segments.get(ctx.unit) === "power" ? "tabs" : "flat",
    propensity: 1,
  }),
});

/** Candidate 3: tabs for everyone (what epoch-2 votes teach). Deterministic. */
const alwaysTabs: Policy<Layout> = {
  id: POLICY_ID,
  version: "3",
  select: (): PolicyChoice<Layout> => ({ action: "tabs", propensity: 1 }),
};

export type Version = "1" | "2" | "3";

/**
 * The code this process can run for each registered version, with a call log. The registry only
 * stores NAMES and hashes; the resolver is the process's own table. A version the process has no
 * code for acts as the incumbent (fail closed), never as something else.
 */
export class PolicyBook {
  private readonly byVersion: Record<Version, Policy<string>>;

  constructor(segments: SegmentStore) {
    this.byVersion = {
      "1": uniform,
      "2": bySegmentOf(segments) as Policy<string>,
      "3": alwaysTabs as Policy<string>,
    };
  }

  /** Every `select` call, in order: `<version>` per call. */
  readonly calls: string[] = [];

  /** The `PolicyResolver` `decideWithRollout` takes. */
  readonly resolve = (id: string, version: string): Policy<string> | undefined => {
    if (id !== POLICY_ID) return undefined;
    const p = this.byVersion[version as Version];
    if (p === undefined) return undefined;
    return {
      id: p.id,
      version: p.version,
      select: (ctx, actions) => {
        this.calls.push(p.version);
        return p.select(ctx, actions);
      },
    };
  };

  /** A candidate as a bare policy, for offline evaluation (it makes no recorded call). */
  candidate(version: Version): Policy<Layout> {
    return this.byVersion[version] as Policy<Layout>;
  }
}
