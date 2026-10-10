import {
  type ContainerNode,
  type Experience,
  type Operation,
  REFERENCE_CONTAINER_ROLES,
  type ReadPolicy,
  type Viewer,
  containerRoleFindings,
  findNode,
  walk,
} from "@loom-ui/core";
import { placeholderAlias } from "@loom-ui/core";
import { checkPlannerConformance } from "@loom-ui/planner";
import { ReferencePlanner } from "@loom-ui/planner";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT, DEMO_PLACEHOLDER_KEY, LEAD, Triage, intent, meta } from "../src/app";
import { catalog } from "../src/catalog";
import { entries, memoryDecide, reply, scriptedModel } from "../src/model";
import { capabilities } from "../src/world";

// loom-ui U15 (planner depth) on a support-ticket triage view, step by step. Every step is the
// real thing: the reference planner (scripted model, real `ctx.decide` shape), real hydration
// through a fake tool invoker, `renderBlueprintDom` with `referenceContainers()` under happy-dom,
// and the terminal renderer.

const open: Triage[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.dispose();
});
const triage = (replies: string[], viewer = LEAD): Triage => {
  const t = new Triage(scriptedModel(replies), viewer);
  open.push(t);
  return t;
};

const errors = (r: { findings: readonly { severity: string }[] }) =>
  r.findings.filter((f) => f.severity === "error");
const kinds = (ops: readonly Operation[]) => ops.map((o) => o.type);
/** The primitives a revise folded into its one `prompt` op. */
const inner = (ops: readonly Operation[]): Operation[] => {
  const only = ops[0];
  if (ops.length !== 1 || only?.type !== "prompt") throw new Error("expected one prompt op");
  return only.materialized;
};
const containersOf = (exp: Experience): ContainerNode[] => {
  const out: ContainerNode[] = [];
  walk(exp.root, (n) => {
    if (n.kind === "container" && n.id !== exp.root.id) out.push(n);
  });
  return out;
};
const childIds = (exp: Experience, id: string): string[] =>
  (findNode(exp.root, id) as ContainerNode).children.map((c) => c.id);

const tabEls = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>("[role='tab']")];
const panelEls = (host: HTMLElement) => [
  ...host.querySelectorAll<HTMLElement>("[role='tabpanel']"),
];
/** Everything a viewer could read: light DOM and every widget's shadow root, recursively. */
const deepText = (root: ParentNode): string => {
  let out = "";
  for (const n of root.childNodes) {
    if (n.nodeType === 3) out += `${n.textContent} `;
    else if (n.nodeType === 1) {
      const el = n as Element;
      out += el.shadowRoot ? `${deepText(el.shadowRoot)} ` : "";
      out += `${deepText(el)} `;
    }
  }
  return out;
};
const text = (host: HTMLElement) => deepText(host);

describe("1. compose: one tabs container, panels Overview / Queue / History", () => {
  it("composes the tab set through the role the host offered; every planner container is owned by the planner", async () => {
    const t = triage([reply(entries())]);
    const r = await t.compose();
    expect(errors(r)).toEqual([]);
    const exp = t.experience;

    const views = findNode(exp.root, "views") as ContainerNode;
    expect(views).toMatchObject({ kind: "container", role: "tabs", owner: "planner" });
    expect(childIds(exp, "views")).toEqual(["overview", "queue", "history"]);
    expect(childIds(exp, "overview")).toEqual(["open", "waiting"]);
    expect(childIds(exp, "queue")).toEqual(["sla", "queue_list"]);
    expect(childIds(exp, "history")).toEqual(["history_list"]);

    // Every container the planner inserted carries the edit boundary; the genesis root does not.
    const all = containersOf(exp);
    expect(all.map((c) => c.id)).toEqual(["views", "overview", "queue", "history"]);
    expect(all.every((c) => c.owner === "planner")).toBe(true);
    // The role rule (2+ titled panels) holds on what the planner authored.
    expect(
      containerRoleFindings(exp.root, REFERENCE_CONTAINER_ROLES, { ownedBy: "planner" })
    ).toEqual([]);
    // One model call, one recorded decision; every panel is titled (the title is the tab label).
    expect((t.model as ReturnType<typeof scriptedModel>).calls).toBe(1);
    expect(all.slice(1).map((c) => c.title?.fallback)).toEqual(["Overview", "Queue", "History"]);
  });

  it("the role rules are enforced on the model's reply: a lone panel, a bare widget, an untitled panel all fail closed", async () => {
    const drop = ["queue", "history", "sla", "queue_list", "history_list"];
    const lone = entries().filter((e) => !drop.includes(e.id as string));
    const widgetUnderTabs = [...entries(), { ...entries()[2], id: "stray", parent: "views" }];
    const untitled = entries().map((e) => (e.id === "queue" ? { ...e, title: undefined } : e));
    for (const [nodes, complaint] of [
      [lone, /needs at least 2/],
      [widgetUnderTabs, /"stray" is a widget/],
      [untitled, /"queue" has no title/],
    ] as const) {
      const t = triage([reply([...nodes])]);
      const r = await t.compose();
      expect(r.ops).toEqual([]);
      expect(r.findings.some((f) => f.code === "plan-failed")).toBe(true);
      expect(r.findings.map((f) => f.message).join("\n")).toMatch(complaint);
    }
  });

  it("a role the host did NOT offer is not a kind the model may use (the same reply is fine when offered)", async () => {
    const offered = triage([reply(entries())]);
    expect(errors(await offered.compose())).toEqual([]);

    const bare = new ReferencePlanner({
      model: scriptedModel([reply(entries())]),
      modelId: "m",
      maxAttempts: 1,
    });
    const r = await bare.compose({ intent, catalog, capabilities }, memoryDecide());
    expect(r.ops).toEqual([]);
    expect(r.findings.some((f) => f.code === "plan-failed")).toBe(true);
    // The reason is the unoffered role (the container kind is not one of the offered ones).
    const why = r.findings.map((f) => f.message).join("\n");
    expect(why).toMatch(/nodes\.0\.container: container must be one of: section, row, grid/);
    expect(why).not.toMatch(/one of:.*\b(tabs|stepper)\b/);
  });
});

describe("2. render: referenceContainers() on the web, every panel stacked on the terminal", () => {
  it("draws a real tablist: three tabs, aria wiring, roving tabindex, one panel visible", async () => {
    const t = triage([reply(entries())]);
    await t.compose();
    const lists = t.host.querySelectorAll("[role='tablist']");
    expect(lists.length).toBe(1);
    const tabs = tabEls(t.host);
    const panels = panelEls(t.host);
    expect(tabs.map((x) => x.textContent)).toEqual(["Overview", "Queue", "History"]);
    expect(panels.length).toBe(3);
    expect(tabs.map((x) => x.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((x) => x.tabIndex)).toEqual([0, -1, -1]);
    tabs.forEach((tab, i) => {
      expect(tab.getAttribute("aria-controls")).toBe(panels[i]?.id);
      expect(panels[i]?.getAttribute("aria-labelledby")).toBe(tab.id);
    });
    expect(panels.map((p) => p.hidden)).toEqual([false, true, true]);
    expect(panels.map((p) => p.getAttribute("aria-hidden"))).toEqual([null, "true", "true"]);
    // The hydrated values really arrived in the visible panel.
    expect(text(panels[0] as HTMLElement)).toContain("Open tickets");
    expect(text(panels[0] as HTMLElement)).toContain("42");
    // ... and a hidden panel keeps receiving data (it is hidden, not unmounted).
    expect(text(panels[1] as HTMLElement)).toContain("Cannot log in");
  });

  it("keyboard switching moves selection AND keeps focus on the new tab (the same element, not a rebuilt one)", async () => {
    const t = triage([reply(entries())]);
    await t.compose();
    const tabs = tabEls(t.host);
    (tabs[0] as HTMLElement).focus();
    expect(document.activeElement).toBe(tabs[0]);
    (tabs[0] as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabEls(t.host)[1]).toBe(tabs[1]);
    expect(tabs.map((x) => x.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(panelEls(t.host).map((p) => p.hidden)).toEqual([true, false, true]);
    (tabs[1] as HTMLElement).dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })
    );
    expect(document.activeElement).toBe(tabs[2]);
    expect(panelEls(t.host).map((p) => p.hidden)).toEqual([true, true, false]);
  });

  it("the terminal has no tabs: every panel prints, stacked in order, with its data", async () => {
    const t = triage([reply(entries())]);
    await t.compose();
    const frame = t.terminal();
    for (const s of ["Support triage", "Overview", "Queue", "History", "Cannot log in", "Wed"])
      expect(frame).toContain(s);
    const at = (s: string) => frame.indexOf(s);
    expect(at("Overview")).toBeLessThan(at("Queue"));
    expect(at("Queue")).toBeLessThan(at("History"));
    expect(frame).not.toMatch(/tablist|aria-/);
  });
});

describe("3. revise as a minimal diff", () => {
  const MOVE_AND_NOTES = reply(
    entries({ sla: "overview", notes: true }),
    "SLA up front, notes tab"
  );
  const REQUEST = "move the SLA metric to Overview, add a Notes tab";

  it("is exactly one moveNode plus the inserts of the new tab — never a recompose", async () => {
    const t = triage([reply(entries()), MOVE_AND_NOTES]);
    await t.compose();
    const before = t.experience;
    const r = await t.revise(REQUEST);
    expect(errors(r)).toEqual([]);
    const ops = inner(r.ops);
    expect(kinds(ops)).toEqual(["moveNode", "insertNode", "insertNode"]);
    expect(ops[0]).toMatchObject({ nodeId: "sla", newParentId: "overview" });
    const inserts = ops.filter(
      (o): o is Extract<Operation, { type: "insertNode" }> => o.type === "insertNode"
    );
    expect(inserts.map((o) => [o.node.id, o.parentId])).toEqual([
      ["notes", "views"],
      ["handoff", "notes"],
    ]);
    // No removeNode anywhere: nothing already there was torn down and rebuilt.
    expect(kinds(ops)).not.toContain("removeNode");

    const after = t.experience;
    expect(childIds(after, "views")).toEqual(["overview", "queue", "history", "notes"]);
    expect(childIds(after, "overview")).toEqual(["open", "waiting", "sla"]);
    expect(childIds(after, "queue")).toEqual(["queue_list"]);
    expect(after.versionHash).not.toBe(before.versionHash);
    // The new panel is planner-owned too, and the live tablist grew by one.
    expect((findNode(after.root, "notes") as ContainerNode).owner).toBe("planner");
    expect(tabEls(t.host).map((x) => x.textContent)).toEqual([
      "Overview",
      "Queue",
      "History",
      "Notes",
    ]);
  });

  it("checkPlannerConformance agrees: the same minimal revise reports no revise-recomposed (and no errors)", async () => {
    const model = scriptedModel([reply(entries()), MOVE_AND_NOTES]);
    const planner = new ReferencePlanner({ model, modelId: "scripted-triage", maxAttempts: 1 });
    const findings = await checkPlannerConformance(planner, {
      intent,
      catalog,
      capabilities,
      meta,
      revision: { text: REQUEST },
      ctx: memoryDecide(),
      containers: REFERENCE_CONTAINER_ROLES,
      modelCalls: () => model.calls,
    });
    expect(findings.filter((f) => f.code === "revise-recomposed")).toEqual([]);
    expect(findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("a recompose wearing a diff's clothes IS caught by the same kit (control)", async () => {
    const model = scriptedModel([reply(entries()), MOVE_AND_NOTES]);
    const inner0 = new ReferencePlanner({ model, modelId: "scripted-triage", maxAttempts: 1 });
    const naughty = {
      compose: inner0.compose.bind(inner0),
      revise: async (...a: Parameters<typeof inner0.revise>) => {
        const r = await inner0.revise(...a);
        const only = r.ops[0];
        if (only?.type !== "prompt") return r;
        // drop and re-add a node the request never mentioned
        const node = findNode(a[0].experience.root, "open");
        if (node === undefined) throw new Error("fixture: no `open` node");
        const redo: Operation[] = [
          { type: "removeNode", nodeId: "open" },
          { type: "insertNode", parentId: "overview", node },
        ];
        return { ...r, ops: [{ ...only, materialized: [...redo, ...only.materialized] }] };
      },
    };
    const findings = await checkPlannerConformance(naughty, {
      intent,
      catalog,
      capabilities,
      meta,
      revision: { text: REQUEST },
      ctx: memoryDecide(),
      containers: REFERENCE_CONTAINER_ROLES,
    });
    expect(findings.some((f) => f.code === "revise-recomposed")).toBe(true);
  });

  describe("an application-owned container stays locked", () => {
    const policy = (exp: Experience) => JSON.stringify(findNode(exp.root, "escalation_policy"));

    it("an ordinary revise leaves it exactly as it was", async () => {
      const t = triage([reply(entries()), MOVE_AND_NOTES]);
      await t.compose();
      await t.addEscalationPolicy();
      const frozen = policy(t.experience);
      const r = await t.revise(REQUEST);
      expect(errors(r)).toEqual([]);
      expect(kinds(inner(r.ops))).toEqual(["moveNode", "insertNode", "insertNode"]);
      expect(policy(t.experience)).toBe(frozen);
      expect(
        (findNode(t.experience.root, "escalation_policy") as ContainerNode).owner
      ).toBeUndefined();
    });

    it("a model that names the container, or a node inside it, is refused with a named finding and nothing is applied", async () => {
      const claim = [
        ...entries(),
        { id: "escalation_policy", container: "section", title: "Escalation policy", span: 12 },
        {
          id: "extra",
          type: "Memo",
          label: "Extra",
          span: 12,
          parent: "escalation_policy",
          props: { text: "Page nobody." },
        },
      ];
      const reach = [
        ...entries(),
        {
          id: "policy_text",
          type: "Memo",
          label: "Policy",
          span: 12,
          props: { text: "Never page anyone." },
        },
      ];
      for (const [nodes, code] of [
        [claim, "not-owned"],
        [reach, "nested-node"],
      ] as const) {
        const t = triage([reply(entries()), reply([...nodes])]);
        await t.compose();
        await t.addEscalationPolicy();
        const before = t.experience.versionHash;
        const r = await t.revise("tidy the policy");
        expect(r.ops).toEqual([]);
        expect(r.findings).toContainEqual(
          expect.objectContaining({
            code,
            severity: "error",
            nodeId: code === "not-owned" ? "escalation_policy" : "policy_text",
          })
        );
        expect(t.experience.versionHash).toBe(before);
      }
    });
  });
});

describe("4. re-role tabs -> stepper with one setRole", () => {
  it("is one setRole op, and the same panels are now a stepper", async () => {
    const t = triage([
      reply(entries({ sla: "overview", notes: true })),
      reply(entries({ sla: "overview", notes: true, role: "stepper" })),
    ]);
    await t.compose();
    expect(t.host.querySelectorAll("[role='tablist']").length).toBe(1);
    const r = await t.revise("walk me through it step by step");
    expect(errors(r)).toEqual([]);
    expect(inner(r.ops)).toEqual([{ type: "setRole", nodeId: "views", role: "stepper" }]);
    expect((findNode(t.experience.root, "views") as ContainerNode).role).toBe("stepper");
    expect(
      containerRoleFindings(t.experience.root, REFERENCE_CONTAINER_ROLES, { ownedBy: "planner" })
    ).toEqual([]);

    // The tablist is gone; Back / Next and a position line took its place.
    expect(t.host.querySelectorAll("[role='tablist']").length).toBe(0);
    const nav = t.host.querySelector("nav[data-chrome='stepper']") as HTMLElement;
    expect(nav).not.toBeNull();
    const position = () => nav.querySelector("[data-chrome-part='position']")?.textContent;
    const next = nav.querySelector("[data-chrome-action='next']") as HTMLButtonElement;
    const back = nav.querySelector("[data-chrome-action='back']") as HTMLButtonElement;
    expect(
      [...nav.querySelectorAll("[data-chrome-part='steps'] li")].map((li) => li.textContent)
    ).toEqual(["Overview", "Queue", "History", "Notes"]);
    expect(position()).toContain("1 / 4");
    expect(back.disabled).toBe(true);
    next.click();
    expect(position()).toContain("2 / 4");
    expect(position()).toContain("Queue");
  });
});

describe("5. policy A: a panel whose cards are all restricted collapses to a bare placeholder", () => {
  const withRefunds = (viewer = LEAD, refunds: boolean | "mixed" = true) =>
    triage([reply(entries({ refunds }))], viewer);

  it("a cleared viewer sees the Refunds panel and its data; hydration fetched it", async () => {
    const t = withRefunds(LEAD);
    expect(errors(await t.compose())).toEqual([]);
    expect(tabEls(t.host).map((x) => x.textContent)).toEqual([
      "Overview",
      "Queue",
      "History",
      "Refunds",
    ]);
    expect(text(t.host)).toContain("Pending refunds");
    expect(t.invoker.calls).toContain("billing.refunds");
    expect((await t.explain("refunds")).available).toBe(true);
    expect(t.terminal()).toContain("Pending refunds");
  });

  it("a low-clearance viewer sees a bare placeholder: no title, no role, no card, no fetch — and the tab set keeps its count", async () => {
    const t = withRefunds(AGENT);
    await t.compose();
    // The tab strip still has four entries (the set does not shrink), the fourth a neutral "Restricted".
    const labels = tabEls(t.host).map((x) => x.textContent);
    expect(labels).toHaveLength(4);
    expect(labels.slice(0, 3)).toEqual(["Overview", "Queue", "History"]);
    expect(labels[3]).toBe("Restricted"); // the placeholder's neutral label: no title survives
    const all = text(t.host);
    expect(all).not.toMatch(/refund/i);
    expect(all).not.toContain("18400");
    expect(all).not.toContain("18,400");
    expect(t.invoker.calls).not.toContain("billing.refunds");
    expect(t.terminal()).not.toMatch(/refund/i);
    // The experience itself is unredacted: the redaction is per viewer, at compile.
    expect(findNode(t.experience.root, "refunds")).toBeDefined();
    // explainNode answers {available:false} — for the collapsed panel, its cards, and an unknown id alike.
    expect(await t.explain("refunds")).toEqual({ available: false });
    expect(await t.explain("refund_pending")).toEqual({ available: false });
    expect(await t.explain("no_such_node")).toEqual({ available: false });
    expect((await t.explain("open")).available).toBe(true);
  });

  it("the placeholder's id is a KEYED alias (U10c): derivable from the host secret, never the node's own id", async () => {
    const t = withRefunds(AGENT);
    await t.compose();
    // The alias is a pure function of (host key, experience id, node id). A host holding the key
    // gets the same alias on every replica and after every restart; with the random per-process
    // fallback this equality could not hold.
    const expected = placeholderAlias(DEMO_PLACEHOLDER_KEY, t.experience.experienceId, "refunds");
    expect(t.placeholderIds()).toContain(expected);
    expect(expected.startsWith("r_")).toBe(true);
    expect(JSON.stringify(t.placeholderIds())).not.toMatch(/refund/i);
  });

  it("one visible card keeps the panel (title and all): the rule is ALL restricted, not ANY", async () => {
    const t = withRefunds(AGENT, "mixed");
    await t.compose();
    expect(tabEls(t.host).map((x) => x.textContent)).toEqual([
      "Overview",
      "Queue",
      "History",
      "Refunds",
    ]);
    expect(text(t.host)).not.toContain("Pending refunds"); // the secret card itself is still redacted
    expect(t.invoker.calls).not.toContain("billing.refunds");
    expect((await t.explain("refunds")).available).toBe(true);
    expect(await t.explain("refund_pending")).toEqual({ available: false });
  });
});

describe("5b. the read-time floor: a node the planner did NOT write is hidden by the declared table alone", () => {
  // The planner stamps `capability.sensitivity` on every node IT writes, so the cases above would
  // pass with no read policy at all. Here the APPLICATION inserts a Metric bound to the secret
  // `billing.refunds` with no `sensitivity` of its own: only `declaredToolClasses` classes it.
  const rawCard = async (viewer: Viewer, policy?: ReadPolicy) => {
    const t = new Triage(scriptedModel([reply(entries())]), viewer, policy);
    open.push(t);
    await t.compose();
    await t.addUnclassifiedRefundCard("overview");
    return t;
  };

  it("hides it from a low viewer: no text, no fetch, explain is {available:false}", async () => {
    const t = await rawCard(AGENT);
    const node = findNode(t.experience.root, "raw_refunds");
    expect(node).toBeDefined();
    expect(JSON.stringify(node)).not.toContain("sensitivity"); // nobody classified it
    expect(text(t.host)).not.toMatch(/refund/i);
    expect(text(t.host)).not.toContain("18400");
    expect(t.invoker.calls).not.toContain("billing.refunds");
    expect(t.terminal()).not.toMatch(/refund/i);
    expect(await t.explain("raw_refunds")).toEqual({ available: false });
    // The rest of the panel is untouched.
    expect(text(t.host)).toContain("Open tickets");
    expect((await t.explain("open")).available).toBe(true);
  });

  it("a cleared viewer still sees it (the table classes the tool, it does not delete the node)", async () => {
    const t = await rawCard(LEAD);
    expect(text(t.host)).toContain("Pending refunds");
    expect(t.invoker.calls).toContain("billing.refunds");
    expect((await t.explain("raw_refunds")).available).toBe(true);
  });

  it("control: the SAME view with an EMPTY table leaks it to the low viewer", async () => {
    const t = await rawCard(AGENT, {});
    expect(text(t.host)).toContain("Pending refunds");
    expect(t.invoker.calls).toContain("billing.refunds");
    expect((await t.explain("raw_refunds")).available).toBe(true);
  });
});
