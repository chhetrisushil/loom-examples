import {
  type Experience,
  type ExperienceNode,
  type Finding,
  type KpiValue,
  type LocalizedText,
  type Operation,
  type Placement,
  type ProviderSpec,
  type Surface,
  checkKindValue,
  compile,
  findNode,
  genesis,
  orderKeyBetween,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationStore,
} from "@loom-ui/hydration";
import type { Blueprint } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { catalog } from "./catalog";

// ── A branch-library board, laid out ─────────────────────────────────────────
// Two titled sections on the 12-column root grid. "Today" places every node on explicit grid
// lines — a two-row notice on the left, two counts stacked on its right — and they are INSERTED
// in a different order than they are placed, so the placement, not the insertion order, decides
// where each lands. "Collections" places nothing: its counts flow. Section titles are
// LocalizedText, resolved at compile like labels.

export const SECTION_TITLES = {
  today: { key: "library.section.today", fallback: "Today at the branch" },
  collections: { key: "library.section.collections", fallback: "Collections" },
} as const satisfies Record<string, LocalizedText>;

type Count = "visitors" | "loans" | "holds" | "overdue";

export const LABELS: Record<Count | "notice", string> = {
  visitors: "Visitors",
  loans: "Loans",
  notice: "Notice",
  holds: "Holds waiting",
  overdue: "Overdue items",
};

const NOTICE_TEXT: LocalizedText = {
  key: "library.notice.text",
  fallback: "The reading room closes at 17:00 for an author talk.",
};

/** Where each node of "Today" sits: a notice two rows tall on the left, the counts stacked on its right. */
export const TODAY_PLACEMENT = {
  notice: { row: 1, rowSpan: 2, column: 1 },
  visitors: { row: 1, column: 9 },
  loans: { row: 2, column: 9 },
} as const satisfies Record<string, Placement>;

const SAMPLES: Record<Count, KpiValue> = {
  visitors: { value: 312, unit: "people", format: { semanticType: "integer" } },
  loans: {
    value: 845,
    format: { semanticType: "integer" },
    label: "vs. last week",
    deltaPct: -0.031,
  },
  holds: { value: 57, format: { semanticType: "integer" } },
  overdue: { value: 19, format: { semanticType: "integer" } },
};

/** The library's own tools; the example seeds the store directly, but a bound handle still needs a provider. */
const provider = (handle: Count): ProviderSpec => ({
  handle,
  executionGraph: [
    {
      stepId: `${handle}-1`,
      toolName: `library.${handle}`,
      toolVersion: "1.0.0",
      toolSchemaHash: `sha256:library.${handle}-1-0`,
      arguments: { branch: "riverside" },
      dependsOn: [],
      idempotent: true,
    },
  ],
  reshaping: { engine: "JSONPath", scriptRef: "$" },
  outputShapeHash: `shape:${handle}`,
  cachePolicy: { ttlSeconds: 60, scope: "principal" },
});

/** A bound count: `span` columns wide, optionally on explicit grid lines. */
const count = (
  id: Count,
  order: string,
  span: number,
  placement: Placement = {}
): ExperienceNode => ({
  id,
  order,
  kind: "semantic",
  type: "Count",
  typeVersion: "1.0.0",
  span,
  ...placement,
  label: { key: `library.${id}.label`, fallback: LABELS[id] },
  props: {},
  binding: { handle: id, priority: "P1" },
});

function operations(): Operation[] {
  const counts: Count[] = ["visitors", "loans", "holds", "overdue"];
  const ops: Operation[] = counts.map(
    (h): Operation => ({ type: "remapProvider", handle: h, spec: provider(h) })
  );
  const today = orderKeyBetween(null, null);
  const collections = orderKeyBetween(today, null);
  const o1 = orderKeyBetween(null, null);
  const o2 = orderKeyBetween(o1, null);
  const o3 = orderKeyBetween(o2, null);
  ops.push(
    {
      type: "insertNode",
      parentId: "root",
      node: {
        id: "today",
        order: today,
        kind: "container",
        direction: "grid",
        span: 12,
        title: SECTION_TITLES.today,
        children: [],
      },
    },
    {
      type: "insertNode",
      parentId: "root",
      node: {
        id: "collections",
        order: collections,
        kind: "container",
        direction: "grid",
        span: 12,
        title: SECTION_TITLES.collections,
        children: [],
      },
    },
    // Inserted visitors, loans, notice — placed notice first (row 1, column 1).
    {
      type: "insertNode",
      parentId: "today",
      node: count("visitors", o1, 4, TODAY_PLACEMENT.visitors),
    },
    { type: "insertNode", parentId: "today", node: count("loans", o2, 4, TODAY_PLACEMENT.loans) },
    {
      type: "insertNode",
      parentId: "today",
      node: {
        id: "notice",
        order: o3,
        kind: "semantic",
        type: "Notice",
        typeVersion: "1.0.0",
        span: 8,
        ...TODAY_PLACEMENT.notice,
        label: { key: "library.notice.label", fallback: LABELS.notice },
        props: { text: NOTICE_TEXT },
      },
    },
    { type: "insertNode", parentId: "collections", node: count("holds", o1, 6) },
    { type: "insertNode", parentId: "collections", node: count("overdue", o2, 6) }
  );
  return ops;
}

/** Compile one surface; any finding is a defect in this example, so it throws. */
export function compileFor(
  experience: Experience,
  surface: Surface,
  resolveLabel?: (l: LocalizedText) => string
): Blueprint {
  const r = compile(experience, {
    surface,
    catalog,
    hydrationProjectionId: HYDRATION_PROJECTION_ID,
    hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    ...(resolveLabel && { resolveLabel }),
  });
  if (r.findings.length > 0)
    throw new Error(`compile (${surface}): ${r.findings.map((f) => f.message).join("; ")}`);
  return r.blueprint;
}

export interface App {
  readonly experience: Experience;
  readonly web: Blueprint;
  readonly terminal: Blueprint;
  readonly findings: Readonly<Record<"web" | "terminal", readonly Finding[]>>;
  readonly runtime: InMemoryProjectionRuntime;
  readonly store: HydrationStore;
}

export function createApp(options: { resolveLabel?: (l: LocalizedText) => string } = {}): App {
  const g = genesis({
    experienceId: "branch-board",
    intent: { objective: "Run the riverside branch today", source: "application" },
    meta: { author: "example", createdAt: "2026-09-23T00:00:00Z", sourceKind: "example" },
  });
  const built = replay(g, operations());
  if (!built.ok) throw new Error(built.finding.message);
  const experience = seal(built.value);
  const web = compileFor(experience, "web", options.resolveLabel);
  const terminal = compileFor(experience, "terminal", options.resolveLabel);

  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: experience.experienceId });
  for (const [handle, value] of Object.entries(SAMPLES)) {
    const check = checkKindValue("Kpi", value);
    if (!check.ok) throw new Error(`sample "${handle}": ${check.finding.message}`);
    store.setValue(handle, value, { state: "ready" });
  }
  return { experience, web, terminal, findings: { web: [], terminal: [] }, runtime, store };
}

/**
 * A revision: the two counts in "Today" trade rows. Same node ids, so a live DOM keeps both
 * widgets and only restyles their grid lines.
 */
export function swapCounts(experience: Experience): Experience {
  const visitors = findNode(experience.root, "visitors");
  const loans = findNode(experience.root, "loans");
  if (visitors?.kind !== "semantic" || loans?.kind !== "semantic")
    throw new Error("the board has no counts to swap");
  const r = replay(experience, [
    { type: "removeNode", nodeId: "visitors" },
    { type: "removeNode", nodeId: "loans" },
    { type: "insertNode", parentId: "today", node: { ...visitors, ...TODAY_PLACEMENT.loans } },
    { type: "insertNode", parentId: "today", node: { ...loans, ...TODAY_PLACEMENT.visitors } },
  ]);
  if (!r.ok) throw new Error(r.finding.message);
  return seal(r.value);
}
