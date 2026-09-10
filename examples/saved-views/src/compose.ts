import { MetricCard, StatusBadge, blueprint$, stack } from "@loom/blueprint-runtime";
import type { Blueprint, VersionPins } from "@loom/blueprint-runtime";

// ── Composition ──────────────────────────────────────────────────────────────
//
// Deterministic on purpose. A model picking catalogue entries is `db-observability`'s
// subject; what this example is about is what happens to the artifact AFTERWARDS, and a
// scripted selection keeps that story readable and the test honest.
//
// Two things here are load-bearing:
//
//   • every node carries an EXPLICIT id. The derived id hashes kind + props, so editing a
//     title re-identifies the node — it remounts, and any pin, annotation or agent
//     reference keyed on the old id dangles (ADR 0094).
//   • `projectionVersions` records what each binding MEANT at composition. It is a field of
//     the value, so it is part of the content address — which is what makes "the meaning of
//     a view never changes silently" a property of the artifact rather than a paragraph
//     (ADR 0095).

export interface ComposeOptions {
  intent: string;
  /** `projectionRuntime.pins()` — what the folds behind these names mean right now. */
  pins: VersionPins;
}

export function composeSpendView({ intent, pins }: ComposeOptions): Blueprint {
  return blueprint$({
    id: "spend-and-incidents",
    title: intent,
    layout: stack({
      children: [
        MetricCard({
          id: "spend-total",
          title: "Cloud spend",
          binding: { projectionId: "spend", path: "total" },
          unit: "USD",
        }),
        MetricCard({
          id: "spend-samples",
          title: "Samples counted",
          binding: { projectionId: "spend", path: "samples" },
        }),
        StatusBadge({
          id: "incidents-open",
          title: "Open incidents",
          binding: { projectionId: "incidents", path: "open" },
        }),
      ],
    }),
    projections: ["spend", "incidents"],
    projectionVersions: pins,
  });
}

/** A composition that names a component the catalogue does not define — the case that must
 *  never reach the log, because a recorded blueprint is reproduced by every replay. */
export function composeOffCatalogue({ intent, pins }: ComposeOptions): Blueprint {
  return blueprint$({
    id: "off-catalogue",
    title: intent,
    layout: stack({
      children: [
        MetricCard({
          id: "spend-total",
          title: "Cloud spend",
          binding: { projectionId: "spend", path: "total" },
        }),
        // `Timeline` is a built-in widget of loom's own catalogue and is NOT in this app's.
        // A vocabulary is closed by what it declares, not by what exists.
        {
          _tag: "Widget" as const,
          id: "spend-timeline",
          kind: "Timeline",
          props: {},
          binding: { projectionId: "spend", path: "samples" },
        },
      ],
    }),
    projections: ["spend", "incidents"],
    projectionVersions: pins,
  });
}
