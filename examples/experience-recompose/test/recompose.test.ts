import { loomCatalogFor } from "@loom-ui/core";
import { validateBlueprint } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { catalog } from "../src/catalog";

describe("experience-recompose — an agent revision lands while the user types", () => {
  it("keeps the textarea's text, caret and focus, the kept metric's element and the list's scroll; adds (alert first), relabels and drops around them", async () => {
    const app = createApp();
    await app.compose();
    expect(validateBlueprint(app.blueprint, loomCatalogFor(catalog, "web").catalog).ok).toBe(true);
    const grid = () => app.host.querySelector("[data-layout='grid']") as HTMLElement;
    expect([...grid().children].map((e) => (e as HTMLElement).dataset.widgetId)).toEqual([
      "latency",
      "phase",
      "memo",
      "recent",
    ]);

    const ta = app.host.querySelector("textarea[data-note='memo']") as HTMLTextAreaElement;
    const metricEl = app.host.querySelector(
      "[data-widget-id='latency'] lu-metric-card"
    ) as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    const list = app.host.querySelector("[data-widget-id='recent'] lu-data-table") as HTMLElement;
    await metricEl.updateComplete;
    expect(metricEl.shadowRoot?.textContent).toContain("ms");

    // The user is mid-edit.
    ta.focus();
    ta.value = "ship the fix before the retro";
    ta.setSelectionRange(9, 9);
    list.scrollTop = 120;
    expect(document.activeElement).toBe(ta);

    const r = await app.revise(
      "add an alert about the degraded provider, show latency in seconds, drop the phase badge"
    );

    // What changed: alert added and moved first by the app's layout rule, phase dropped, unit relabelled.
    expect(r.identity.added).toEqual(["alert"]);
    expect(r.identity.findings.map((f) => f.nodeId)).toEqual(["phase"]);
    expect(r.remounted).toEqual([]);
    expect(r.findings).toEqual([]);
    expect([...grid().children].map((e) => (e as HTMLElement).dataset.widgetId)).toEqual([
      "alert",
      "latency",
      "memo",
      "recent",
    ]);

    // What did not.
    expect(document.activeElement).toBe(ta);
    expect(ta.value).toBe("ship the fix before the retro");
    expect(ta.selectionStart).toBe(9);
    expect(app.host.querySelector("textarea[data-note='memo']")).toBe(ta);
    expect(app.host.querySelector("[data-widget-id='latency'] lu-metric-card")).toBe(metricEl);
    await metricEl.updateComplete;
    expect(metricEl.shadowRoot?.textContent).not.toContain("ms");
    expect(metricEl.shadowRoot?.textContent).toContain("s"); // relabelled in place through patch: unit ms → s
    expect(app.host.querySelector("[data-widget-id='recent'] lu-data-table")).toBe(list);
    expect(list.scrollTop).toBe(120);

    app.handle.dispose();
  });

  it("changing a node's KIND (remove + insert with the same id) remounts only that node", async () => {
    const app = createApp();
    await app.compose();
    const others = ["latency", "memo", "phase"].map((id) =>
      app.host.querySelector(`[data-widget-id='${id}'] > *`)
    );
    const r = app.retype("recent", "Metric", { unit: "ms" });
    expect(r.remounted).toEqual(["recent"]);
    expect(r.identity.findings).toEqual([]); // the id survived — nothing was dropped
    expect(
      ["latency", "memo", "phase"].map((id) =>
        app.host.querySelector(`[data-widget-id='${id}'] > *`)
      )
    ).toEqual(others);
    expect(app.host.querySelector("[data-widget-id='recent'] lu-metric-card")).not.toBeNull();
    app.handle.dispose();
  });

  it("an app renderer without patch is remounted and reported, not silently re-created", async () => {
    const app = createApp({ patchable: false });
    await app.compose();
    const r = await app.revise("relabel the note for the on-call");
    expect(r.remounted).toEqual(["memo"]);
    expect(r.identity.added).toEqual([]);
    app.handle.dispose();
  });
});
