import { type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";
import type { CapabilityRef } from "@loom-ui/planner";

/** What the planner may NAME: a small support-triage vocabulary, nothing app-specific to loom-ui. */
export const triageCatalog: SemanticCatalog = defineSemanticCatalog({
  id: "triage.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit"],
      binding: "required",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
    {
      name: "Collection",
      version: "1.0.0",
      props: ["columns"],
      binding: "required",
      surfaces: { web: { kind: "DataTable" }, terminal: { kind: "DataTable" } },
    },
    {
      name: "Insight",
      version: "1.0.0",
      props: ["tone"],
      binding: "none",
      surfaces: {
        web: { kind: "Insight", props: ["tone"], binding: "none" },
        terminal: { kind: "Insight", props: ["tone"], binding: "none" },
      },
    },
  ],
});

/** The one tool the planner may bind to. The caller resolves it and supplies a sample (spec: context is an input). */
export const capabilities: CapabilityRef[] = [
  {
    handle: "tickets_open",
    toolName: "tickets.open",
    toolVersion: "1.0.0",
    toolSchemaHash: "sha256:tickets-open-1-0",
    description: "Open support tickets for a queue",
    inputSchema: { type: "object", properties: { queue: { type: "string" } } },
    // Declared so the planner can classify its summary: a sample with no class withholds it (U7).
    sensitivity: "internal",
    sampleOutput: {
      queue: "billing",
      total: 14,
      rows: [{ id: "T-1", severity: "high", ageHours: 5 }],
    },
  },
];
