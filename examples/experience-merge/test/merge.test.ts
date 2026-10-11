import { findNode, keyConflicts, nodeIds } from "@loom-ui/core";
import type { ContainerNode, ExperienceNode, SemanticNode } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import {
  baseBoard,
  disjointForks,
  edit,
  errorsOf,
  keyForks,
  merge,
  moveForks,
  relabelForks,
  text,
} from "../src/app";

const base = baseBoard();
const label = (exp: { root: ExperienceNode }, id: string) =>
  (findNode(exp.root, id) as SemanticNode).label?.fallback;

describe("experience-merge: two volunteers fork one garden rota and merge", () => {
  it("joins edits that touch different things with no conflict, and seals with both heads as parents", () => {
    const { ana, ben } = disjointForks(base);
    const m = merge(base, ana, ben);
    expect(m.conflicts).toEqual([]);
    // Ana's new notice and Ben's whole section are both there; Ben's re-worded compost too.
    expect(nodeIds(m.experience.root).sort()).toEqual(
      ["beds", "compost", "events", "root", "tools", "watering", "workday"].sort()
    );
    expect((findNode(m.experience.root, "compost") as SemanticNode).props.text).toBe(
      "Turn on Saturdays, bins by the gate"
    );
    expect(m.experience.parents).toEqual([ana.versionHash, ben.versionHash]);
    expect(m.experience.versionHash).toMatch(/^sha256:/);
    expect(errorsOf(m.experience)).toEqual([]);
  });

  it("is deterministic, and merging a fork with itself changes nothing", () => {
    const { ana, ben } = disjointForks(base);
    expect(merge(base, ana, ben)).toEqual(merge(base, ana, ben));
    const self = merge(base, ana, ana);
    expect(self.conflicts).toEqual([]);
    expect(nodeIds(self.experience.root)).toEqual(nodeIds(ana.root));
  });

  it("reports a node relabelled differently on both sides as edit/edit, and ours wins", () => {
    const { ana, ben } = relabelForks(base);
    const m = merge(base, ana, ben);
    expect(m.conflicts.map((c) => [c.kind, c.ref])).toEqual([["edit/edit", "compost"]]);
    expect(label(m.experience, "compost")).toBe("Compost heap");
    // Swapping the sides swaps the winner: the bias is explicit, not an accident of order.
    expect(label(merge(base, ben, ana).experience, "compost")).toBe("Compost bins");
  });

  it("reports a node moved to two sections as move/move, keeping it in ours' section", () => {
    const f = moveForks(base);
    const m = merge(f.base, f.ana, f.ben);
    expect(m.conflicts.map((c) => [c.kind, c.ref])).toEqual([["move/move", "watering"]]);
    const mornings = findNode(m.experience.root, "mornings") as ContainerNode;
    expect(mornings.children.map((n) => n.id)).toEqual(["watering"]);
  });

  it("catches one localization key given two meanings, which no structural plane sees", () => {
    const { ana, ben } = keyForks(base);
    const m = merge(base, ana, ben);
    // The merge is structurally clean in every plane except the key check ...
    expect(m.conflicts.map((c) => [c.plane, c.kind, c.ref])).toEqual([
      ["layout", "message/message", "garden.member"],
    ]);
    // ... and says which branch said what.
    expect(m.conflicts[0]?.detail).toContain('ours says "Member" (keys)');
    expect(m.conflicts[0]?.detail).toContain('theirs says "Volunteer" (signup)');
    // Reusing a key with the SAME words is not a conflict: that is what keys are for.
    const same = merge(
      base,
      ana,
      edit(base, {
        type: "insertNode",
        parentId: "beds",
        node: { ...(findNode(ana.root, "keys") as SemanticNode), id: "keys2", order: "m" },
      })
    );
    expect(same.conflicts).toEqual([]);
  });

  it("is resolved by an ordinary op: give the second meaning its own key, and the key check is quiet", () => {
    const { ana, ben } = keyForks(base);
    const m = merge(base, ana, ben);
    const resolved = edit(m.experience, {
      type: "setLabel",
      nodeId: "signup",
      label: text("garden.volunteer", "Volunteer"),
    });
    expect(keyConflicts(ana.root, ben.root, resolved.root)).toEqual([]);
    expect(label(resolved, "keys")).toBe("Member");
    expect(label(resolved, "signup")).toBe("Volunteer");
  });
});
