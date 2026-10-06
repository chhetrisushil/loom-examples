import { type Intent, type SemanticCatalog, defineSemanticCatalog, genesis } from "@loom-ui/core";
import {
  type CapabilityRef,
  type DecideContext,
  type DecideOptionsLike,
  type DecideScope,
  type PlannerModel,
  ReferencePlanner,
  providerHandle,
} from "@loom-ui/planner";

type DataClass = NonNullable<CapabilityRef["sensitivity"]>;

// An incident-triage board for an on-call rotation: how many incidents are open, who holds the
// pager, and how many customer accounts a regulated incident exposes. The third is CLASSIFIED
// (`secret`): the board carries a card only a cleared on-call engineer may see.

export const EXPERIENCE_ID = "incident-board";

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.incident-triage.v1",
  entries: [
    {
      name: "Metric",
      version: "1.0.0",
      props: ["unit", "format"],
      binding: "required",
      // The planner may propose a confidentiality class for a card's data (the host still decides
      // what to keep; a class can only be raised by later ops, never lowered by a planner).
      sensitivity: "model-may-set",
      surfaces: { web: { kind: "MetricCard" }, terminal: { kind: "MetricCard" } },
    },
  ],
});

/** Open incidents. Everyone on the team may see it. */
export const incidents: CapabilityRef = {
  handle: "incidents_open",
  toolName: "incidents.open",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:incidents-open-1-0",
  description: "Open incident counts",
  sensitivity: "internal",
  sampleOutput: { open: 7 },
};
/** Who holds the pager. */
export const pager: CapabilityRef = {
  handle: "oncall_now",
  toolName: "pager.oncall",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:pager-oncall-1-0",
  description: "The engineer currently holding the pager",
  sensitivity: "internal",
  sampleOutput: { primary: "Dana Ruiz" },
};
/** Customer exposure of a regulated incident: CLASSIFIED. */
export const exposureCap: CapabilityRef = {
  handle: "customer_exposure",
  toolName: "legal.exposure",
  toolVersion: "1.0.0",
  toolSchemaHash: "sha256:legal-exposure-1-0",
  description: "Customer accounts exposed by a regulated incident",
  sensitivity: "secret",
  sampleOutput: { accounts: 1200 },
};
export const capabilities: CapabilityRef[] = [incidents, pager, exposureCap];

/** The handle the reference planner mints for a path into a tool. */
export const handleFor = (cap: CapabilityRef, path: string): string =>
  providerHandle(cap.toolName, cap.toolVersion, cap.toolSchemaHash, {}, path);

export const intent: Intent = {
  objective: "Triage the open incidents and see who is on call",
  source: "user",
};
export const meta = {
  author: "triage-app",
  createdAt: "2026-10-07T00:00:00Z",
  sourceKind: "example",
} as const;
export const genesisBoard = (experienceId: string = EXPERIENCE_ID) =>
  genesis({ experienceId, intent, meta });

const card = (
  id: string,
  label: string,
  cap: CapabilityRef,
  path: string,
  unit: string,
  sensitivity?: DataClass
) => ({
  id,
  type: "Metric",
  label,
  span: 4,
  props: { unit },
  binding: {
    capability: cap.handle,
    arguments: {},
    path,
    priority: "P1",
    ...(sensitivity && { sensitivity }),
  },
});

/** What the scripted model returns for the compose. `exposure: false` is the board without the classified card. */
export const SUMMARY = "Open incidents, the pager and the regulated exposure on one row.";
export const SUMMARY_LITE = "Open incidents and the pager on one row.";
export const composeReply = (exposure: boolean): string =>
  JSON.stringify({
    summary: exposure ? SUMMARY : SUMMARY_LITE,
    nodes: [
      card("open_incidents", "Open incidents", incidents, "open", "incidents"),
      card("oncall", "On call", pager, "primary", "engineer"),
      ...(exposure
        ? [
            card(
              "customer_exposure",
              "Customer exposure",
              exposureCap,
              "accounts",
              "accounts",
              "secret"
            ),
          ]
        : []),
    ],
  });

/** A model with one scripted reply. Counts calls. */
export function scriptedModel(withExposure = true): PlannerModel & { calls: number } {
  const model = {
    calls: 0,
    async complete() {
      model.calls += 1;
      return {
        content: composeReply(withExposure),
        usage: { inputTokens: 700, outputTokens: 180 },
      };
    },
  };
  return model;
}

const NO_SCOPE: DecideScope = {
  invokeTransient() {
    return Promise.reject(new Error("the in-memory decide has no transient scope"));
  },
};

/** loom's `ctx.decide` shape in memory: one decision per id, kept as JSON like the log keeps it. */
export function memoryDecide(): DecideContext {
  const decisions = new Map<string, unknown>();
  return {
    async decide<T>(
      id: string,
      decider: (scope: DecideScope) => T | Promise<T>,
      _opts?: DecideOptionsLike
    ): Promise<T> {
      if (decisions.has(id)) return decisions.get(id) as T;
      const value = await decider(NO_SCOPE);
      decisions.set(id, JSON.parse(JSON.stringify(value)));
      return value;
    },
  };
}

export const newPlanner = (withExposure = true) =>
  new ReferencePlanner({ model: scriptedModel(withExposure), modelId: "scripted-triage" });
