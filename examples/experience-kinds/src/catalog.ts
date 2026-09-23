import { type KindContract, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// The warehouse's semantic vocabulary. Every type resolves to one of loom-ui's FRAMEWORK kinds
// (Kpi, Table, StatusCard, Note, TimeSeries), which sit outside loom's built-in catalogue — so
// each resolution declares the kind's loom contract (ADR 0088 D2: props AND binding). These are
// exactly `frameworkKindContracts` from `@loom-ui/renderer-lit/dom`; they are spelled out here so
// this module (and a terminal-only consumer of it) never loads a DOM renderer, and
// `test/kinds.test.ts` pins them to that list so they cannot drift.

export const KIND_CONTRACTS = {
  Kpi: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
  Table: { kind: "Table", props: [], binding: "required" },
  StatusCard: { kind: "StatusCard", props: [], binding: "required" },
  Note: { kind: "Note", props: ["text"], binding: "none" },
  TimeSeries: { kind: "TimeSeries", props: ["unit", "format"], binding: "required" },
} as const satisfies Record<string, KindContract>;

/** The same kind on both surfaces: the web draws it with Lit, the terminal prints it. */
const everywhere = (contract: KindContract) => ({ web: contract, terminal: contract });

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.warehouse.v1",
  entries: [
    {
      // Pallets on hand; the value carries its own format and the change since the last count.
      name: "StockLevel",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(KIND_CONTRACTS.Kpi),
    },
    {
      // Lines waiting to be picked; each column declares its own number semantics in the value.
      name: "PickList",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(KIND_CONTRACTS.Table),
    },
    {
      name: "DockStatus",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(KIND_CONTRACTS.StatusCard),
    },
    {
      // Static text for the shift. `textProps` lets `text` be a LocalizedText that `compile`
      // resolves for the viewer's locale, so a Blueprint carries display text, never a key.
      name: "ShiftNote",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"],
      binding: "none",
      surfaces: everywhere(KIND_CONTRACTS.Note),
    },
    {
      // Orders per hour against pick latency: two units, so latency gets its own right axis.
      name: "Throughput",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(KIND_CONTRACTS.TimeSeries),
    },
  ],
});
