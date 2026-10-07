import {
  type Experience,
  type ExperienceNode,
  type KpiValue,
  type LocalizedText,
  type Operation,
  type ProviderSpec,
  type SemanticFormat,
  type Surface,
  checkKindValue,
  compile,
  findNode,
  genesis,
  isContainer,
  orderKeyAfterAll,
  orderKeyBetween,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
} from "@loom-ui/hydration";
import {
  type DomContainerRegistry,
  type DomContainerRenderer,
  type DomRenderHandle,
  type RecomposeReport,
  litRegistry,
  renderBlueprintDom,
} from "@loom-ui/renderer-lit/dom";
import type { Blueprint } from "@loom/blueprint-runtime";
import { RendererRegistry } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { catalog } from "./catalog";
import { steppedContainer } from "./steppedContainer";

// ── A bike-share rider onboarding, non-genUI ────────────────────────────────────────────────
// One `column` container, `role: "stepper"`, three step containers (account → payment →
// pickup), each a `Detail` (loom-ui's `Note`) and a `Highlight` (loom-ui's `Kpi`). This app
// registers its OWN `stepper`-role container renderer (`steppedContainer.ts`) on loom-ui's
// container-renderer seam — the app owns chrome and step visibility, the adapter owns
// everything else. `confirm` is a fourth step, defined but never composed in: appending it is
// what the "no existing widget remounts" test exercises.

const ROOT_CONTAINER_ID = "onboarding";

export interface StepContent {
  readonly id: string;
  readonly title: LocalizedText;
  readonly detail: LocalizedText;
  readonly highlight: {
    readonly label: string;
    readonly value: number;
    readonly unit?: string;
    readonly format: SemanticFormat;
  };
}

const currency: SemanticFormat = { semanticType: "currency", currency: "USD" };
const count: SemanticFormat = { semanticType: "integer" };

export const STEPS: Record<"account" | "payment" | "pickup" | "confirm", StepContent> = {
  account: {
    id: "account",
    title: { key: "stepped.account.title", fallback: "Account" },
    detail: {
      key: "stepped.account.detail",
      fallback: "Create a rider profile with your name and a photo ID.",
    },
    highlight: { label: "Sign-up credit", value: 5, format: currency },
  },
  payment: {
    id: "payment",
    title: { key: "stepped.payment.title", fallback: "Payment" },
    detail: {
      key: "stepped.payment.detail",
      fallback: "Add a card or campus ID so a ride starts with one tap.",
    },
    highlight: { label: "Monthly plan", value: 15, format: currency },
  },
  pickup: {
    id: "pickup",
    title: { key: "stepped.pickup.title", fallback: "Pickup" },
    detail: {
      key: "stepped.pickup.detail",
      fallback: "Reserve a bike at the dock nearest to you before you walk over.",
    },
    highlight: { label: "Docks nearby", value: 3, unit: "bikes", format: count },
  },
  confirm: {
    id: "confirm",
    title: { key: "stepped.confirm.title", fallback: "Confirm" },
    detail: {
      key: "stepped.confirm.detail",
      fallback: "Review your details and confirm to start riding.",
    },
    highlight: { label: "Setup time", value: 2, unit: "min", format: count },
  },
};

/** The order the example composes into the initial experience — `confirm` joins later, by ops. */
const INITIAL_STEPS: readonly StepContent[] = [STEPS.account, STEPS.payment, STEPS.pickup];

export const detailNodeId = (step: StepContent): string => `${step.id}-detail`;
export const highlightNodeId = (step: StepContent): string => `${step.id}-highlight`;

/** A bare provider for a step's highlight — every bound handle needs one declared (`unknown-handle`
 * otherwise); the example seeds the real value straight into the store (like `experience-layout`
 * does for its counts), so nothing here is ever actually executed. */
function providerFor(handle: string): ProviderSpec {
  return {
    handle,
    executionGraph: [
      {
        stepId: `${handle}-1`,
        toolName: `bikeshare.${handle}`,
        toolVersion: "1.0.0",
        toolSchemaHash: `sha256:bikeshare.${handle}-1-0`,
        arguments: {},
        dependsOn: [],
        idempotent: true,
      },
    ],
    reshaping: { engine: "JSONPath", scriptRef: "$" },
    outputShapeHash: `shape:${handle}`,
    cachePolicy: { ttlSeconds: 60, scope: "principal" },
  };
}

/** The `KpiValue` a step's Highlight widget binds to — no `label`: the widget's own node label
 * (below) already names it, so the terminal's `"{title} ({label})"` caption is not doubled. */
export const kpiValueFor = (step: StepContent): KpiValue => ({
  value: step.highlight.value,
  format: step.highlight.format,
  ...(step.highlight.unit !== undefined && { unit: step.highlight.unit }),
});

/** One step: a titled column holding its Detail then its Highlight, in that order. */
function stepNode(step: StepContent, order: string) {
  const detailOrder = orderKeyBetween(null, null);
  const highlightOrder = orderKeyBetween(detailOrder, null);
  return {
    id: step.id,
    order,
    kind: "container" as const,
    direction: "column" as const,
    span: 12,
    title: step.title,
    children: [
      {
        id: detailNodeId(step),
        order: detailOrder,
        kind: "semantic" as const,
        type: "Detail",
        typeVersion: "1.0.0",
        span: 12,
        label: { key: `stepped.${step.id}.detail.label`, fallback: "Instructions" },
        props: { text: step.detail },
      },
      {
        id: highlightNodeId(step),
        order: highlightOrder,
        kind: "semantic" as const,
        type: "Highlight",
        typeVersion: "1.0.0",
        span: 12,
        label: { key: `stepped.${step.id}.highlight.label`, fallback: step.highlight.label },
        props: {
          ...(step.highlight.unit !== undefined && { unit: step.highlight.unit }),
          format: step.highlight.format,
        },
        binding: { handle: highlightNodeId(step), priority: "P1" as const },
      },
    ],
  };
}

function initialOperations(): Operation[] {
  const rootOrder = orderKeyBetween(null, null);
  let before: string | null = null;
  const stepOps: Operation[] = [];
  for (const step of INITIAL_STEPS) {
    const handle = highlightNodeId(step);
    stepOps.push({ type: "remapProvider", handle, spec: providerFor(handle) });
    const order = orderKeyBetween(before, null);
    stepOps.push({ type: "insertNode", parentId: ROOT_CONTAINER_ID, node: stepNode(step, order) });
    before = order;
  }
  return [
    {
      type: "insertNode",
      parentId: "root",
      node: {
        id: ROOT_CONTAINER_ID,
        order: rootOrder,
        kind: "container",
        direction: "column",
        span: 12,
        title: { key: "stepped.onboarding.title", fallback: "Rider onboarding" },
        role: "stepper",
        children: [],
      },
    },
    ...stepOps,
  ];
}

/** Shared by `appendStepOp`/`insertStepBeforeOp`: the two ops that add `step` at `order`. */
function insertStepOps(step: StepContent, order: string): Operation[] {
  const handle = highlightNodeId(step);
  return [
    { type: "remapProvider", handle, spec: providerFor(handle) },
    { type: "insertNode", parentId: ROOT_CONTAINER_ID, node: stepNode(step, order) },
  ];
}

/** The root container's step children, in `order`. Throws if `ROOT_CONTAINER_ID` is missing. */
function stepSiblings(experience: Experience): ExperienceNode[] {
  const parent = findNode(experience.root, ROOT_CONTAINER_ID);
  if (parent === undefined || !isContainer(parent)) {
    throw new Error(`"${ROOT_CONTAINER_ID}" is missing or not a container`);
  }
  return [...parent.children].sort((a, b) => (a.order < b.order ? -1 : 1));
}

/**
 * Appends `step` as the LAST step under the root container. Pure: reads `experience`, returns the
 * op; does not mutate anything.
 */
export function appendStepOp(experience: Experience, step: StepContent): Operation[] {
  return insertStepOps(step, orderKeyAfterAll(stepSiblings(experience)));
}

/**
 * Inserts `step` as a NEW step directly BEFORE an existing one, named by id — a MID-list insert,
 * shifting every later step's ORDINAL among its siblings. Under Blueprint IR 2.4.0 (loom ADR
 * 0101) that shift remounts nothing: every step container carries its own node id, so a step
 * container is kept by ID (plus type and role), never by its position among siblings — gap G6,
 * closed. (Before 2.4.0 a hand-built, id-less layout fell back to keying by ordinal, and a
 * mid-list insert there WOULD have remounted every later step's widgets — see the README's
 * "Recomposing" section, and `experience-recompose`'s CONTROL test.) Pure: reads `experience`,
 * returns the ops; does not mutate anything.
 */
export function insertStepBeforeOp(
  experience: Experience,
  step: StepContent,
  beforeId: string
): Operation[] {
  const siblings = stepSiblings(experience);
  const idx = siblings.findIndex((c) => c.id === beforeId);
  if (idx < 0) throw new Error(`no step "${beforeId}"`);
  const before = siblings[idx] as ExperienceNode;
  const prev = siblings[idx - 1];
  return insertStepOps(step, orderKeyBetween(prev?.order ?? null, before.order));
}

function compileFor(experience: Experience, surface: Surface): Blueprint {
  const r = compile(experience, {
    surface,
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
  });
  if (r.findings.length > 0)
    throw new Error(`compile (${surface}): ${r.findings.map((f) => f.message).join("; ")}`);
  return r.blueprint;
}

export interface App {
  readonly runtime: InMemoryProjectionRuntime;
  readonly store: HydrationStore;
  readonly host: HTMLElement;
  readonly handle: DomRenderHandle;
  experience: Experience;
  blueprint: Blueprint;
  /** Apply `ops` to the live experience, recompile for web, and land the result on the DOM. */
  land(ops: Operation[]): RecomposeReport;
  /** The CURRENT experience compiled for the terminal — role is not a terminal concept (Q4). */
  compileTerminal(): Blueprint;
  dispose(): void;
}

export function createApp(options: { containers?: DomContainerRegistry } = {}): App {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: "bike-share-onboarding" });
  // Every step's highlight is seeded up front, `confirm` included, so appending it later needs
  // no separate seeding step — the same pattern `experience-layout` uses for its counts.
  for (const step of Object.values(STEPS)) {
    const value = kpiValueFor(step);
    const check = checkKindValue("Kpi", value);
    if (!check.ok) throw new Error(`"${step.id}" highlight: ${check.finding.message}`);
    store.setValue(highlightNodeId(step), value, { state: "ready" });
  }

  const g = genesis({
    experienceId: "bike-share-onboarding",
    intent: { objective: "Get a new rider onto a bike", source: "application" },
    meta: { author: "example", createdAt: "2026-09-23T00:00:00Z", sourceKind: "example" },
  });
  const built = replay(g, initialOperations());
  if (!built.ok) throw new Error(built.finding.message);
  let experience = seal(built.value);
  let blueprint = compileFor(experience, "web");

  const host = document.createElement("div");
  document.body.appendChild(host);
  const containers: DomContainerRegistry =
    options.containers ??
    new RendererRegistry<DomContainerRenderer>().register("stepper", steppedContainer());
  const handle = renderBlueprintDom(host, blueprint, {
    projectionRuntime: runtime,
    executionId: store.executionId,
    registry: litRegistry,
    containers,
  });

  const app: App = {
    runtime,
    store,
    host,
    handle,
    get experience() {
      return experience;
    },
    set experience(e) {
      experience = e;
    },
    get blueprint() {
      return blueprint;
    },
    set blueprint(b) {
      blueprint = b;
    },
    land(ops) {
      const r = replay(experience, ops);
      if (!r.ok) throw new Error(r.finding.message);
      experience = seal(r.value);
      blueprint = compileFor(experience, "web");
      return handle.update(blueprint);
    },
    compileTerminal() {
      return compileFor(experience, "terminal");
    },
    dispose() {
      handle.dispose();
      host.remove();
    },
  };
  return app;
}
