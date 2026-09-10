import {
  StatusBadge,
  blueprint$,
  builtinCatalog,
  grid,
  stack,
  validateBlueprint,
} from "@loom/blueprint-runtime";
import type { Blueprint, BlueprintValidation, Layout, Widget } from "@loom/blueprint-runtime";
import type { LlmProvider } from "@loom/llm";
import type { ProjectionRuntime } from "@loom/projection-runtime";
import { type Classification, classifyIntent } from "./agent";
import { catalogueEntry } from "./catalogue";
import { NO_PREFERENCES, arrangeWhyWidgets, gapFor } from "./preferences";
import type { OperatorPreferences } from "./preferences";
import type { OperatorProfile } from "./profile";
import { suggestedLead } from "./suggest";
import { readTelemetry } from "./telemetry";
import { TOPIC_MODELS } from "./topics";

export interface DashboardResult {
  question: string;
  classification: Classification;
  what: string; // the direct answer
  why: string; // the supporting explanation
  whatWidget: string; // catalogue id of the primary widget
  whyWidgets: string[]; // catalogue ids of the supporting widgets
  blueprint: Blueprint;
  /**
   * The composed blueprint checked against the catalogue it was composed FROM.
   *
   * A hand-authored dashboard is reviewed once; a generated one is assembled per
   * question, from a selection an agent made, and nothing else looks at it before a
   * renderer does. `validateBlueprint` never throws — it returns every finding in one
   * pass — so the composer can report a gap rather than fail a request, which is the
   * right shape when the UI is a best effort over live telemetry.
   */
  validation: BlueprintValidation;
  /** The stated preferences this composition was arranged under (Phase 1). */
  preferences: OperatorPreferences;
  /** The derived profile it was arranged under, if any (Phase 2). */
  profile: OperatorProfile | null;
}

// Every projection a composed dashboard may bind to (the renderer reads these).
const ALL_PROJECTIONS = ["answer", "cpu", "connections", "replication", "queries"];

/**
 * Turns a natural-language question into a DYNAMICALLY-assembled dashboard:
 *   1. the agent categorises the question → topic + kind
 *   2. it reasons over live telemetry → a WHAT (direct answer) + WHY (explanation)
 *   3. it publishes the answer to a projection so widgets can bind to it
 *   4. it selects widgets from the catalogue and assembles a Blueprint at runtime
 * No dashboard is hand-authored — the UI is generated from intent + catalogue.
 */
export class DashboardComposer {
  constructor(
    private readonly pr: ProjectionRuntime,
    private readonly provider: LlmProvider,
    private readonly executionId: string
  ) {}

  /**
   * @param preferences the operator's STATED choices, resolved before composing. Omitted
   * — or `NO_PREFERENCES` — yields the canonical arrangement through this same method,
   * not a second code path, so the two cannot drift apart.
   */
  /**
   * @param surfaced a capability the exploration floor chose to surface this session
   * (Phase 2b). It leads over the profile's own suggestion — that is the whole point of
   * an experiment — and still yields to a stated preference.
   */
  async answer(
    question: string,
    preferences: OperatorPreferences = NO_PREFERENCES,
    profile: OperatorProfile | null = null,
    surfaced: string | null = null
  ): Promise<DashboardResult> {
    const classification = await classifyIntent(this.provider, question);
    const model = TOPIC_MODELS[classification.topic];

    const telemetry = readTelemetry(this.pr, this.executionId);
    const what = model.answer(telemetry);
    const why = model.explanation(telemetry);

    // Publish the agent's answer so the header/why widgets can bind to it.
    this.pr.seedState("answer", this.executionId, {
      question,
      topic: classification.topic,
      what,
      why,
    });

    const blueprint = this.buildBlueprint(
      classification,
      model.primaryWidget,
      model.whyWidgets,
      preferences,
      profile,
      surfaced
    );
    return {
      preferences,
      profile,
      question,
      classification,
      what,
      why,
      whatWidget: model.primaryWidget,
      whyWidgets: model.whyWidgets,
      blueprint,
      // Every widget here comes from a built-in builder, so the built-in catalogue is
      // the contract this composition is answerable to.
      validation: validateBlueprint(blueprint, builtinCatalog),
    };
  }

  /** Assemble the blueprint from the catalogue — a WHAT section then a WHY section. */
  private buildBlueprint(
    classification: Classification,
    primaryWidget: string,
    whyWidgets: string[],
    preferences: OperatorPreferences,
    profile: OperatorProfile | null,
    surfaced: string | null
  ): Blueprint {
    // A WHAT section (the direct answer + its primary widget) then a WHY section (the
    // explanation + the causal widgets in a grid). The terminal renderer ignores `gap`
    // and flattens the grid; the browser renders it as a real 2-column dashboard.
    const children: Array<Widget | Layout> = [
      StatusBadge({ title: "You asked", binding: { projectionId: "answer", path: "question" } }),
      StatusBadge({ title: "▶ WHAT", binding: { projectionId: "answer", path: "what" } }),
      catalogueEntry(primaryWidget).build(),
      StatusBadge({ title: "▶ WHY", binding: { projectionId: "answer", path: "why" } }),
      // Phase 1 acts HERE and only here: the operator's stated arrangement over the
      // widget set the topic model chose. It reorders and re-spaces; the set is the
      // agent's, and nothing a preference can say removes a widget from it.
      grid({
        columns: 2,
        gap: gapFor(preferences),
        children: arrangeWhyWidgets(
          whyWidgets,
          preferences,
          // The session's experiment outranks the profile's own habit — surfacing what an
          // operator already reaches for teaches nothing — and both yield to a stated
          // preference, which is checked inside `arrangeWhyWidgets`.
          surfaced ?? suggestedLead(profile, whyWidgets)
        ).map((id) => catalogueEntry(id).build()),
      }),
    ];

    return blueprint$({
      id: `observability-${classification.topic}`,
      title: `DB Observability — ${TOPIC_MODELS[classification.topic].label}`,
      layout: stack({ gap: 16, children }),
      projections: ALL_PROJECTIONS,
    });
  }
}
