import {
  type ContainerNode,
  type Experience,
  type LocalizedText,
  type Operation,
  type SemanticNode,
  apply,
  genesis,
  mergeExperiences,
  replay,
  validateExperience,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import { catalog } from "./catalog";

// ── A community-garden rota board, edited by two volunteers ──────────────────
// Ana and Ben each fork the same sealed board and edit it on their own. `mergeExperiences` joins
// the forks. It is PURE and returns an ours-biased, UNSEALED partial plus the conflicts; the app
// decides what to do with them and seals the merge commit with both heads as its parents.

export const text = (key: string, fallback: string): LocalizedText => ({ key, fallback });

const notice = (id: string, order: string, label: LocalizedText, body: string): SemanticNode => ({
  id,
  order,
  kind: "semantic",
  type: "Notice",
  typeVersion: "1.0.0",
  span: 6,
  label,
  props: { text: body },
});

const section = (id: string, order: string, title: LocalizedText): ContainerNode => ({
  id,
  order,
  kind: "container",
  direction: "row",
  span: 12,
  title,
  children: [],
});

const meta = { author: "example", createdAt: "2026-10-11T00:00:00Z", sourceKind: "example" };

/** The ops that author the shared starting board: a "Beds" section holding two notices. */
const BASE_OPS: Operation[] = [
  { type: "insertNode", parentId: "root", node: section("beds", "G", text("garden.beds", "Beds")) },
  {
    type: "insertNode",
    parentId: "beds",
    node: notice("watering", "G", text("garden.watering", "Watering"), "Mornings, before 9"),
  },
  {
    type: "insertNode",
    parentId: "beds",
    node: notice("compost", "T", text("garden.compost", "Compost"), "Turn on Saturdays"),
  },
];

/** The sealed board both volunteers start from. */
export function baseBoard(): Experience {
  const start = genesis({
    experienceId: "garden-rota",
    intent: { objective: "Keep the garden rota current", source: "user" },
    meta,
  });
  const r = replay(start, BASE_OPS);
  if (!r.ok) throw new Error("the base board does not build");
  return seal(r.value);
}

/** A fork: the base plus one volunteer's edits. Throws on a refused op — a script bug, not data. */
export function edit(base: Experience, ...ops: Operation[]): Experience {
  let cur = base;
  for (const op of ops) {
    const r = apply(cur, op);
    if (!r.ok) throw new Error(`${op.type} refused`);
    cur = r.value;
  }
  return seal(cur);
}

export interface Merged {
  /** The merge commit: sealed, with both heads as parents. */
  readonly experience: Experience;
  /** What the merge could not decide; empty for a clean merge. */
  readonly conflicts: ReturnType<typeof mergeExperiences>["conflicts"];
}

/**
 * Merge two forks of `base`. The result of `mergeExperiences` is unsealed with no parents; the
 * caller names them — here the two heads — and seals. A conflicted merge is still a usable board
 * (ours wins every conflict), so the app can show it and ask for a resolution.
 */
export function merge(base: Experience, ours: Experience, theirs: Experience): Merged {
  const m = mergeExperiences(base, ours, theirs);
  return {
    experience: seal({ ...m.experience, parents: [ours.versionHash, theirs.versionHash] }),
    conflicts: m.conflicts,
  };
}

/** The structural verdict a host would gate a merge on: no errors for the web surface. */
export const errorsOf = (exp: Experience): string[] =>
  validateExperience(exp, catalog, "web")
    .findings.filter((f) => f.severity === "error")
    .map((f) => f.code);

// ── The forks of each scenario ───────────────────────────────────────────────

/** Ana adds a tools notice to the beds; Ben adds a whole "Events" section and re-words compost. */
export function disjointForks(base: Experience) {
  return {
    ana: edit(base, {
      type: "insertNode",
      parentId: "beds",
      node: notice("tools", "k", text("garden.tools", "Tools"), "Shed key is at the café"),
    }),
    ben: edit(
      base,
      {
        type: "insertNode",
        parentId: "root",
        node: section("events", "T", text("garden.events", "Events")),
      },
      {
        type: "insertNode",
        parentId: "events",
        node: notice(
          "workday",
          "G",
          text("garden.workday", "Workday"),
          "First Sunday of the month"
        ),
      },
      {
        type: "setProps",
        nodeId: "compost",
        patch: { text: "Turn on Saturdays, bins by the gate" },
      }
    ),
  };
}

/** Both volunteers relabel the compost notice, differently. */
export function relabelForks(base: Experience) {
  const relabel = (fallback: string): Operation => ({
    type: "setLabel",
    nodeId: "compost",
    label: text("garden.compost", fallback),
  });
  return { ana: edit(base, relabel("Compost heap")), ben: edit(base, relabel("Compost bins")) };
}

/** Both volunteers move the watering notice, into different new sections. */
export function moveForks(base: Experience) {
  const withSections = edit(
    base,
    {
      type: "insertNode",
      parentId: "root",
      node: section("mornings", "P", text("garden.mornings", "Mornings")),
    },
    {
      type: "insertNode",
      parentId: "root",
      node: section("evenings", "Q", text("garden.evenings", "Evenings")),
    }
  );
  const to = (parentId: string): Operation => ({
    type: "moveNode",
    nodeId: "watering",
    newParentId: parentId,
    newOrder: "G",
  });
  return {
    base: withSections,
    ana: edit(withSections, to("mornings")),
    ben: edit(withSections, to("evenings")),
  };
}

/**
 * The conflict nothing structural sees: each volunteer adds a DIFFERENT node, and both give it
 * the localization key `garden.member` with different words. No node id collides, no node was
 * edited twice, every plane merges cleanly — and the board now has one key meaning two things.
 */
export function keyForks(base: Experience) {
  const add = (id: string, order: string, word: string): Operation => ({
    type: "insertNode",
    parentId: "beds",
    node: notice(
      id,
      order,
      text("garden.member", word),
      `Ask the ${word.toLowerCase()} coordinator`
    ),
  });
  return {
    ana: edit(base, add("keys", "k", "Member")),
    ben: edit(base, add("signup", "m", "Volunteer")),
  };
}
