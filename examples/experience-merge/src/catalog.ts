import { type KindContract, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// The garden's vocabulary is one kind: a static notice, drawn as loom-ui's framework `Note` on
// both surfaces. Nothing here binds data — the example is about merging the COMPOSITION.
const note: KindContract = { kind: "Note", props: ["text"], binding: "none" };

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.garden.v1",
  entries: [
    {
      name: "Notice",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"],
      binding: "none",
      surfaces: { web: note, terminal: note },
    },
  ],
});
