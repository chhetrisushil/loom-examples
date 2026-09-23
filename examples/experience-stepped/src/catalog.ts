import { type KindContract, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// This app's vocabulary: an instruction (static text) and a bound highlight, drawn as loom-ui's
// framework kinds `Note` and `Kpi` on both surfaces — exactly `frameworkKindContracts` from
// `@loom-ui/renderer-lit/dom`, spelled out so a terminal-only consumer never loads a DOM
// renderer (the pattern `experience-layout` uses for its own two entries).

export const KIND_CONTRACTS = {
  Note: { kind: "Note", props: ["text"], binding: "none" },
  Kpi: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
} as const satisfies Record<string, KindContract>;

const everywhere = (contract: KindContract) => ({ web: contract, terminal: contract });

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.stepped.v1",
  entries: [
    {
      name: "Detail",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"],
      binding: "none",
      surfaces: everywhere(KIND_CONTRACTS.Note),
    },
    {
      name: "Highlight",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      surfaces: everywhere(KIND_CONTRACTS.Kpi),
    },
  ],
});
