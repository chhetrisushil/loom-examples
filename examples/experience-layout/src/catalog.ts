import { type KindContract, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// The branch library's vocabulary: a bound count and a static notice, drawn as loom-ui's
// framework kinds `Kpi` and `Note` on both surfaces. The contracts are exactly
// `frameworkKindContracts` from `@loom-ui/renderer-lit/dom`, spelled out so a terminal-only
// consumer never loads a DOM renderer; the test pins them.

export const KIND_CONTRACTS = {
  Kpi: { kind: "Kpi", props: ["unit", "format"], binding: "required" },
  Note: { kind: "Note", props: ["text"], binding: "none" },
} as const satisfies Record<string, KindContract>;

const everywhere = (contract: KindContract) => ({ web: contract, terminal: contract });

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.library.v1",
  entries: [
    {
      name: "Count",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(KIND_CONTRACTS.Kpi),
    },
    {
      name: "Notice",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"],
      binding: "none",
      surfaces: everywhere(KIND_CONTRACTS.Note),
    },
  ],
});
