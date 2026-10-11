import { type KindContract, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";

// The support desk's vocabulary, mapped onto loom-ui's generic framework kinds. `Note` is also the
// kind a withheld widget compiles to (loom's redacted widget), so the catalogue always declares it.

const KPI = { kind: "Kpi", props: ["unit", "format"], binding: "required" } as const;
const TABLE = { kind: "Table", props: [], binding: "required" } as const;
const CARD = { kind: "StatusCard", props: [], binding: "required" } as const;
const NOTE = { kind: "Note", props: ["text"], binding: "none" } as const;
const everywhere = (c: KindContract) => ({ web: c, terminal: c });

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.support-desk.v1",
  entries: [
    {
      name: "OpenTickets",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(KPI),
    },
    {
      name: "SlaStatus",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(CARD),
    },
    {
      name: "EscalatedCustomers",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(TABLE),
    },
    {
      name: "RefundExposure",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: everywhere(KPI),
    },
    {
      name: "HandoverNote",
      version: "1.0.0",
      props: ["text"],
      textProps: ["text"],
      binding: "none",
      surfaces: everywhere(NOTE),
    },
  ],
});
