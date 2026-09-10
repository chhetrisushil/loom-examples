import { blueprintNodeIds, preservesNodes } from "@loom/blueprint-runtime";
import type { Blueprint, IdentityReport } from "@loom/blueprint-runtime";
import type { Topic } from "./catalogue";
import { TOPIC_MODELS } from "./topics";

// ── The node floor ───────────────────────────────────────────────────────────
//
// Every intent declares a floor: the nodes EVERY cohort's blueprint must contain. Cohorts
// may add above it; they may never subtract below it.
//
// Two reasons, and the second is the one that makes the floor a hard requirement rather
// than a usability convention:
//
//   1. The capability trap. A system that withholds a tool from someone assessed as not
//      needing it guarantees they never use it, and reads the absence of use back as
//      confirmation. The floor makes the worst case a worse ARRANGEMENT rather than a
//      missing capability — which is the same guarantee Phases 1–2 held by construction,
//      and the first thing Phase 3 could break, because a cohort changes what is composed
//      rather than merely how it is ordered.
//   2. Anything keyed on a node id. A runbook step naming a panel, an annotation, a pin, a
//      recorded operation: all of them resolve against a node id, and a cohort transition
//      re-composes the tree under that operator. Floor nodes exist in every cohort's tree
//      BY CONSTRUCTION, so those references survive a transition the operator did not ask
//      for and cannot see coming. Only above-floor references can dangle, and that set is
//      small, bounded, and known here rather than discovered in an incident.

/**
 * The floor per topic: the WHAT widget plus the WHY widgets the topic model itself
 * declares. Derived from the topic model rather than written out again, because a floor
 * maintained by hand beside the thing it constrains is a floor that drifts from it — and
 * it drifts silently, since nothing renders differently until an operator in some cohort
 * discovers a panel is gone.
 */
export function floorFor(topic: Topic): string[] {
  const model = TOPIC_MODELS[topic];
  return [model.primaryWidget, ...model.whyWidgets];
}

export interface FloorReport {
  topic: Topic;
  /** `ok: false` means a cohort's blueprint is missing something the floor guarantees. */
  ok: boolean;
  missing: string[];
  /** Above-floor nodes this cohort added — the bounded set that may legitimately differ. */
  above: string[];
  identity: IdentityReport;
}

/**
 * Check one composed blueprint against its intent's floor.
 *
 * Uses `preservesNodes` with the FLOOR as `before`: any finding is a node the floor
 * guarantees and this composition does not have, and everything the cohort added lands in
 * `added` — which is exactly right, since a cohort may add and never subtract.
 *
 * Reports rather than throws, on the same reasoning as `validateBlueprint`: a caller may
 * want to degrade to the canonical arrangement and file the gap, and a rate over
 * compositions is not computable from an exception.
 */
export function checkFloor(blueprint: Blueprint, topic: Topic): FloorReport {
  const identity = preservesNodes(floorFor(topic), blueprintNodeIds(blueprint));
  return {
    topic,
    ok: identity.ok,
    missing: identity.findings.map((f) => f.nodeId),
    // The header badges are above the floor too; they are structure, not capability.
    above: [...identity.added],
    identity,
  };
}
