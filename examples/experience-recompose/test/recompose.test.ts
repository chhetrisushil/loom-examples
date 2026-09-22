import { type SemanticNode, findNode, loomCatalogFor } from "@loom-ui/core";
import { renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import { validateBlueprint } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app";
import { catalog } from "../src/catalog";

type LitEl = HTMLElement & { updateComplete: Promise<unknown>; value: unknown };

/** The DOM's shape: tag, data-* attributes, inline style, leaf text, children — recursively. */
interface Shape {
  tag: string;
  data: Record<string, string | undefined>;
  style: string | null;
  text?: string;
  children: Shape[];
}
const shape = (el: Element): Shape => {
  const h = el as HTMLElement;
  const data = Object.fromEntries(Object.entries(h.dataset).sort(([a], [b]) => (a < b ? -1 : 1)));
  const children = [...el.children].map(shape);
  return {
    tag: el.tagName.toLowerCase(),
    data,
    style: el.getAttribute("style"),
    ...(children.length === 0 && { text: el.textContent ?? "" }),
    children,
  };
};

/** The live tree's shape equals a FRESH mount of the same Blueprint in a separate host. */
const expectFreshMountParity = (app: App) => {
  const fresh = document.createElement("div");
  document.body.appendChild(fresh);
  const h = renderBlueprintDom(fresh, app.blueprint, {
    projectionRuntime: app.runtime,
    executionId: app.executionId,
    registry: app.registry,
  });
  try {
    expect(shape(app.host)).toEqual(shape(fresh));
  } finally {
    h.dispose();
    fresh.remove();
  }
};

const gridIds = (app: App) =>
  [...(app.host.querySelector("[data-layout='grid']") as HTMLElement).children].map(
    (e) => (e as HTMLElement).dataset.widgetId
  );

const handleOf = (app: App, id: string): string => {
  const n = findNode(app.experience.root, id) as SemanticNode | undefined;
  if (n?.binding === undefined) throw new Error(`"${id}" is not bound`);
  return n.binding.handle;
};

const note = (app: App) =>
  app.host.querySelector("textarea[data-note='memo']") as HTMLTextAreaElement;

/** The user is mid-edit: text typed, a selection in the middle, focus in the textarea. */
const typeInto = (ta: HTMLTextAreaElement) => {
  ta.focus();
  ta.value = "ship the fix before the retro";
  ta.setSelectionRange(9, 12);
  expect(document.activeElement).toBe(ta);
};
const expectUntouched = (app: App, ta: HTMLTextAreaElement) => {
  expect(note(app)).toBe(ta);
  expect(document.activeElement).toBe(ta);
  expect(ta.value).toBe("ship the fix before the retro");
  expect(ta.selectionStart).toBe(9);
  expect(ta.selectionEnd).toBe(12);
};

describe("experience-recompose — an agent revision lands while the user types", () => {
  it("keeps the textarea's text, selection and focus, the kept metric's element and the list's scroll; adds (alert first), moves (metric below the list), relabels and drops around them", async () => {
    const app = createApp();
    await app.compose();
    expect(validateBlueprint(app.blueprint, loomCatalogFor(catalog, "web").catalog).ok).toBe(true);
    expect(gridIds(app)).toEqual(["latency", "phase", "memo", "recent"]);

    const ta = note(app);
    const metricEl = app.host.querySelector("[data-widget-id='latency'] lu-metric-card") as LitEl;
    const list = app.host.querySelector("[data-widget-id='recent'] lu-data-table") as HTMLElement;
    await metricEl.updateComplete;
    // Hydrated through the real controller and the fake invoker.
    expect(metricEl.shadowRoot?.querySelector(".value")?.textContent).toBe("412");
    expect(metricEl.shadowRoot?.querySelector(".unit")?.textContent).toBe("ms");

    typeInto(ta);
    list.scrollTop = 120;

    // Hydration across the revision: the badge's handle is bound only by the OLD artifact; the
    // metric's and the list's are shared by both.
    const dropped = handleOf(app, "phase");
    const shared = [handleOf(app, "latency"), handleOf(app, "recent")];
    expect(app.store.status(dropped)?.state).toBe("ready");
    const seen: string[] = [];
    const unsub = shared.map((h) =>
      app.store.subscribe(h, (s) => seen.push(`${h}:${s.status?.state}`))
    );
    const callsBefore = app.invoker.calls.length;

    const r = await app.revise(
      "add an alert above the note, move the metric below the list, show latency in seconds, drop the badge"
    );
    for (const u of unsub) u();

    // What changed: alert added and moved first, metric moved below the list (both by the app's
    // layout rules), badge dropped, unit relabelled.
    expect(r.identity.added).toEqual(["alert"]);
    expect(r.identity.findings.map((f) => f.nodeId)).toEqual(["phase"]);
    expect(r.remounted).toEqual([]);
    expect(r.findings).toEqual([]);
    // The metric crosses the focused note: this order is only reachable without moving `memo`
    // because the reconcile pins the subtree holding document.activeElement.
    expect(gridIds(app)).toEqual(["alert", "memo", "recent", "latency"]);
    expect(app.host.querySelector("[data-widget-id='alert'] p")?.textContent).toBe(
      "Provider degraded — values may lag"
    );

    // Hydration: the dropped handle is gone from the store; the shared ones never went back to
    // pending and were not re-invoked.
    expect(app.store.status(dropped)).toBeUndefined();
    expect(seen.filter((s) => s.endsWith(":pending"))).toEqual([]);
    expect(app.invoker.calls.length).toBe(callsBefore);
    expect(shared.map((h) => app.store.status(h)?.state)).toEqual(["ready", "ready"]);

    // What did not change.
    expectUntouched(app, ta);
    expect(app.host.querySelector("[data-widget-id='latency'] lu-metric-card")).toBe(metricEl);
    await metricEl.updateComplete;
    // Relabelled in place through patch — the unit text changes, the value is not converted.
    expect(metricEl.shadowRoot?.querySelector(".unit")?.textContent).toBe("s");
    expect(metricEl.shadowRoot?.querySelector(".value")?.textContent).toBe("412");
    expect(app.host.querySelector("[data-widget-id='recent'] lu-data-table")).toBe(list);
    expect(list.scrollTop).toBe(120);

    expectFreshMountParity(app);

    // dispose() is clean: the tree is gone, the widgets are detached, and a later store write
    // reaches no widget (the subscriptions were released).
    app.dispose();
    expect(app.host.childElementCount).toBe(0);
    expect(ta.isConnected).toBe(false);
    expect(metricEl.isConnected).toBe(false);
    app.store.setValue(shared[0] as string, 999, { state: "ready" });
    expect(metricEl.value).toBe(412);
  });

  it("the user-input rule: a relabel reaches the note through patch and never touches what the user typed", async () => {
    const app = createApp({ patchable: true });
    await app.compose();
    const ta = note(app);
    const caption = () =>
      app.host.querySelector("[data-widget-id='memo'] label > span")?.textContent;
    expect(caption()).toBe("Handoff note");
    typeInto(ta);

    const r = await app.revise("relabel the note for the on-call");

    expect(caption()).toBe("Notes for the on-call");
    expect(r.remounted).toEqual([]);
    expect(r.findings).toEqual([]);
    expect(r.identity.added).toEqual([]);
    expect(r.identity.findings).toEqual([]);
    expectUntouched(app, ta);
    // The app's layout rule moved the metric below the list here too — across the focused note.
    expect(gridIds(app)).toEqual(["phase", "memo", "recent", "latency"]);
    expectFreshMountParity(app);
    app.dispose();
  });

  it("changing a node's KIND (remove + insert with the same id) remounts only that node", async () => {
    const app = createApp();
    await app.compose();
    const others = ["latency", "phase", "recent"].map((id) =>
      app.host.querySelector(`[data-widget-id='${id}'] > *`)
    );
    const ta = note(app);

    const r = app.retype("memo", "Alert", { tone: "info" });

    expect(r.remounted).toEqual(["memo"]);
    expect(r.findings).toEqual([]);
    expect(r.identity.added).toEqual([]);
    expect(r.identity.findings).toEqual([]); // the id survived — nothing was dropped
    expect(
      ["latency", "phase", "recent"].map((id) =>
        app.host.querySelector(`[data-widget-id='${id}'] > *`)
      )
    ).toEqual(others);
    expect(ta.isConnected).toBe(false);
    expect(app.host.querySelector("[data-widget-id='memo'] p")?.getAttribute("data-tone")).toBe(
      "info"
    );
    expect(gridIds(app)).toEqual(["latency", "phase", "memo", "recent"]);
    expectFreshMountParity(app);
    app.dispose();
  });

  it("an app renderer without patch is remounted and reported, not silently re-created", async () => {
    const app = createApp({ patchable: false });
    await app.compose();
    const ta = note(app);

    const r = await app.revise("relabel the note for the on-call");

    expect(r.remounted).toEqual(["memo"]);
    expect(r.findings).toEqual([]);
    expect(r.identity.added).toEqual([]);
    expect(note(app)).not.toBe(ta);
    expect(ta.isConnected).toBe(false);
    expectFreshMountParity(app);
    app.dispose();
  });
});
