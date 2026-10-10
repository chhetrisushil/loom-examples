import { compile } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";
import { currentLocale, setLocale } from "@loom-ui/renderer-lit";
import { frameworkKindContracts, litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/register";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PICK_LIST, TITLES, createApp } from "../src/app";
import { KIND_CONTRACTS, catalog } from "../src/catalog";

type LitEl = HTMLElement & { updateComplete: Promise<unknown> };

/** Every `<tag>` under `host`, after each has finished its first render. */
async function mounted(host: HTMLElement, tag: string): Promise<LitEl[]> {
  const els = [...host.querySelectorAll(tag)] as LitEl[];
  await Promise.all(els.map((e) => e.updateComplete));
  return els;
}

const shadowText = (el: HTMLElement): string => el.shadowRoot?.textContent ?? "";

describe("experience-kinds: a warehouse board on loom-ui's framework kinds", () => {
  const VIEWER = "de-DE";
  let before: string;
  beforeEach(() => {
    before = currentLocale();
    setLocale(VIEWER);
  });
  afterEach(() => setLocale(before));

  it("declares each framework kind's contract exactly as loom-ui publishes it", () => {
    for (const c of Object.values(KIND_CONTRACTS))
      expect(c).toEqual(frameworkKindContracts.find((f) => f.kind === c.kind));
  });

  it("compiles the one Experience for web and terminal with no findings", () => {
    const app = createApp();
    expect(app.findings.web).toEqual([]);
    expect(app.findings.terminal).toEqual([]);
  });

  it("has a Lit renderer for every framework kind the web compile resolves to", () => {
    const app = createApp();
    const r = compile(app.experience, {
      surface: "web",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
      registry: litRegistry,
    });
    expect(r.findings.filter((f) => f.code === "renderer-coverage")).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("mounts every kind once through litRegistry, each drawing its own contract", async () => {
    const app = createApp();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = renderBlueprintDom(host, app.web, {
      projectionRuntime: app.runtime,
      executionId: app.store.executionId,
      registry: litRegistry,
    });
    try {
      for (const tag of ["lu-kpi", "lu-table", "lu-status-card", "lu-note", "lu-timeseries"])
        expect(await mounted(host, tag), tag).toHaveLength(1);

      // Kpi: value, caption and the ▲ change badge (deltaPct is a fraction: +0.042 → ▲ 4.2%).
      const [kpi] = await mounted(host, "lu-kpi");
      expect(shadowText(kpi as LitEl)).toContain(TITLES.stock);
      expect(shadowText(kpi as LitEl)).toContain("▲");

      // Table: each numeric column in its OWN semantics, in the viewer's locale — the unit-price
      // column is EUR currency, drawn the German way, never the en-US way.
      const [table] = await mounted(host, "lu-table");
      const price = PICK_LIST.rows[0]?.[3] as number;
      const de = new Intl.NumberFormat(VIEWER, { style: "currency", currency: "EUR" }).format(
        price
      );
      const en = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(
        price
      );
      expect(de).not.toBe(en);
      expect(shadowText(table as LitEl)).toContain(de);
      expect(shadowText(table as LitEl)).not.toContain(en);

      // StatusCard: a change is announced politely, without stealing focus.
      const [card] = await mounted(host, "lu-status-card");
      const live = (card as LitEl).shadowRoot?.querySelector('[role="status"]');
      expect(live?.getAttribute("aria-live")).toBe("polite");
      expect(shadowText(card as LitEl)).toContain("Door 3");

      // Note: unbound; its LocalizedText resolved at compile to the fallback, never the key.
      const [note] = await mounted(host, "lu-note");
      expect(shadowText(note as LitEl)).toContain(app.noteText.fallback);
      expect(shadowText(note as LitEl)).not.toContain(app.noteText.key);

      // TimeSeries: latency rides a right-hand axis of its own (start-anchored tick labels).
      const [chart] = await mounted(host, "lu-timeseries");
      const rightTicks = (chart as LitEl).shadowRoot?.querySelectorAll(
        '.axis text[text-anchor="start"]'
      );
      expect(rightTicks?.length ?? 0).toBeGreaterThan(0);
    } finally {
      handle.dispose();
      host.remove();
    }
  });

  it("renders the same store in the terminal: every widget's title, the badge and the (R) axis", () => {
    const app = createApp();
    const frame = renderExperience(app.terminal, app.store, { registry: terminalRegistry() });
    for (const title of Object.values(TITLES)) expect(frame).toContain(title);
    expect(frame).toContain("▲ 4.2%");
    // The right-axis row keeps its marker even when the label fills the 12-character label
    // column: loom-ui (e0ed543) cuts the LABEL to make room, so "Pick latency" (exactly 12
    // characters) prints "Pick lat (R)". Before that fix the marker was the part cut off and the
    // row read "Pick latency" with no marker, which this assertion refuses.
    expect(frame).toMatch(/^\s+Pick lat \(R\) /m);
    // The terminal prints numbers exactly as the web does for en-US, whatever the viewer's locale.
    expect(frame).toContain("€1,234.50");
    expect(frame).toContain("Keep aisle 7 clear");
  });
});
