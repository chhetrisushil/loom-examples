import { checkBlueprintPins, validateBlueprint } from "@loom/blueprint-runtime";
import type {
  Blueprint,
  BlueprintValidation,
  PinReport,
  VersionPins,
} from "@loom/blueprint-runtime";
import { flow$ } from "@loom/core";
import { decodeValue, encodeValue } from "@loom/plugin-content";
import type { ContentRef, ContentStore } from "@loom/plugin-content";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { CATALOG_ID, catalogue } from "./catalogue";

/** The userspace event that carries a PROMOTED surface. The fold skips unknown types while
 *  still advancing `sequence`, so this costs no EVENT_SCHEMA change and no kernel change. */
export const BLUEPRINT_COMPOSED = "BLUEPRINT_COMPOSED";

/**
 * The same artifact, not promoted. A composition nobody saved is ephemeral by design — and
 * the difference between the two tiers is *which event cites the ref*, because that is what
 * the content sweep pins on (ADR 0055). Provenance and lifecycle stage, not technology.
 */
export const VIEW_DRAFTED = "VIEW_DRAFTED";

const promoteInput = z.object({ intent: z.string(), promote: z.boolean().optional() });
const promoteOutput = z.object({
  ref: z.string().nullable(),
  findings: z.array(z.string()),
  widgets: z.number(),
});

export type PromoteInput = z.infer<typeof promoteInput>;
export type PromoteOutput = z.infer<typeof promoteOutput>;

export const PromoteViewFlow = flow$({
  id: "promote-view",
  name: "Promote a composed view",
  version: "1.0.0",
  inputSchema: promoteInput,
  outputSchema: promoteOutput,
  steps: [],
});

/**
 * Promotion, in the order the recipe specifies (`loom/docs/composed-surfaces.md`).
 *
 * The ORDER is the point. Validation happens before the ref is stored and before anything
 * is emitted, because a recorded blueprint is durable: every replay reproduces it, and this
 * is the last moment at which an off-catalogue component is still a findings list rather
 * than a fact. It degrades — `validateBlueprint` never throws — so a caller can record the
 * gap and fall back rather than losing the surface.
 */
export function promoteViewRunner(
  content: ContentStore,
  compose: (intent: string, pins: VersionPins) => Blueprint,
  pinsOf: () => VersionPins
): FlowRunner<PromoteInput, PromoteOutput> {
  return async (ctx, { intent, promote = true }) => {
    const view = compose(intent, pinsOf());

    const report: BlueprintValidation = validateBlueprint(view, catalogue);
    if (!report.ok) {
      // Nothing is stored and nothing is emitted. The gap is the return value.
      return {
        ref: null,
        findings: report.findings.map((f) => `${f.code}:${f.nodeId}`),
        widgets: report.widgets,
      };
    }

    // The address IS the semantic identity, so "the view I was looking at" is a precise
    // statement and two identical compositions collapse to one blob.
    const ref = await content.put(encodeValue(view));

    // The log holds a 60-byte address, an intent and a catalogue id — never the tree.
    // Which EVENT carries it is the promotion decision, and the only thing standing between
    // this artifact and the next content sweep.
    ctx.emit(promote ? BLUEPRINT_COMPOSED : VIEW_DRAFTED, { ref, catalogId: CATALOG_ID, intent });

    return { ref: ref.__loomContent, findings: [], widgets: report.widgets };
  };
}

export function registerPromoteFlow(
  content: ContentStore,
  compose: (intent: string, pins: VersionPins) => Blueprint,
  pinsOf: () => VersionPins
): RegisteredFlow {
  return {
    definition: PromoteViewFlow,
    runner: promoteViewRunner(content, compose, pinsOf) as FlowRunner<unknown, unknown>,
  };
}

export interface OpenedView {
  view: Blueprint;
  /** Whether every binding still means what it meant when this view was promoted. */
  pinned: PinReport;
}

/**
 * Re-open a promoted view: a READ, not a generation. No model sits between the click and
 * the pixels, so a saved view never waits on composition — and cannot quietly become a
 * different view.
 *
 * The pin check is the one question the address cannot answer by itself. The structure is
 * byte-identical to what was promoted; whether it still MEANS the same thing depends on the
 * folds registered under the names it binds to, and those are live code.
 */
export async function openView(
  ref: ContentRef,
  content: ContentStore,
  pins: VersionPins
): Promise<OpenedView> {
  const bytes = await content.get(ref);
  if (bytes === null || bytes === undefined) {
    throw new Error(
      `blueprint ${ref.__loomContent} is gone — pin BLUEPRINT_COMPOSED in the content sweep`
    );
  }
  const view = decodeValue(bytes) as Blueprint;
  return { view, pinned: checkBlueprintPins(view, pins) };
}
