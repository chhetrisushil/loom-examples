import { compile } from "@loom-ui/core";
import { HYDRATION_PROJECTION_ID, HYDRATION_PROJECTION_VERSION } from "@loom-ui/hydration";
import { frameworkKindContracts, litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
import type { GridLayout, Widget } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import {
  LABELS,
  SECTION_TITLES,
  TODAY_PLACEMENT,
  compileFor,
  createApp,
  mountPage,
  swapCounts,
} from "../src/app";
import { KIND_CONTRACTS, catalog } from "../src/catalog";

/** The root grid's two sections, in order. */
const sectionsOf = (layout: unknown): GridLayout[] =>
  (layout as GridLayout).children.map((c) => c.node as GridLayout);
/** Each cell's edge — everything but its node — keyed by the widget it places. */
const edges = (g: GridLayout | undefined) =>
  Object.fromEntries((g?.children ?? []).map(({ node, ...edge }) => [(node as Widget).id, edge]));

describe("experience-layout: placement and section titles on a branch-library board", () => {
  it("declares each kind's contract exactly as loom-ui publishes it", () => {
    for (const c of Object.values(KIND_CONTRACTS))
      expect(c).toEqual(frameworkKindContracts.find((f) => f.kind === c.kind));
  });

  it("compiles for web (with Lit coverage) and terminal with no findings", () => {
    const app = createApp();
    for (const surface of ["web", "terminal"] as const) {
      const r = compile(app.experience, {
        surface,
        catalog,
        hydrationProjectionId: HYDRATION_PROJECTION_ID,
        hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
        ...(surface === "web" && { registry: litRegistry }),
      });
      expect(r.findings, surface).toEqual([]);
    }
  });

  it("carries each section title and each placed node's grid lines into the Blueprint; unplaced cells carry a span only", () => {
    const [today, collections] = sectionsOf(createApp().web.layout);
    expect(today?.title).toBe(SECTION_TITLES.today.fallback);
    expect(collections?.title).toBe(SECTION_TITLES.collections.fallback);
    expect(edges(today)).toStrictEqual({
      visitors: { span: 4, ...TODAY_PLACEMENT.visitors },
      loans: { span: 4, ...TODAY_PLACEMENT.loans },
      notice: { span: 8, ...TODAY_PLACEMENT.notice },
    });
    expect(edges(collections)).toStrictEqual({ holds: { span: 6 }, overdue: { span: 6 } });
  });

  it("resolves section titles like labels: the viewer's text, never the message key", () => {
    const de: Record<string, string> = {
      [SECTION_TITLES.today.key]: "Heute in der Zweigstelle",
      [SECTION_TITLES.collections.key]: "Bestand",
    };
    const { web } = createApp({ resolveLabel: (l) => de[l.key] ?? l.fallback });
    expect(sectionsOf(web.layout).map((s) => s.title)).toEqual([
      "Heute in der Zweigstelle",
      "Bestand",
    ]);
    expect(JSON.stringify(web)).not.toContain(SECTION_TITLES.today.key);
  });

  it("draws named sections and places each widget on the web; a revision that moves widgets restyles them in place", () => {
    const app = createApp();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = renderBlueprintDom(host, app.web, {
      projectionRuntime: app.runtime,
      executionId: app.store.executionId,
      registry: litRegistry,
    });
    try {
      const section = host.querySelector(
        `section[aria-label="${SECTION_TITLES.today.fallback}"]`
      ) as HTMLElement;
      expect(section.querySelector("h2")?.textContent).toBe(SECTION_TITLES.today.fallback);
      expect(section.style.gridColumn).toBe("span 12"); // the section is itself a cell of the root grid
      const at = (id: string) => host.querySelector(`[data-widget-id='${id}']`) as HTMLElement;
      const lines = (id: string) => [at(id).style.gridColumn, at(id).style.gridRow];
      expect(lines("notice")).toEqual(["1 / span 8", "1 / span 2"]);
      expect(lines("visitors")).toEqual(["9 / span 4", "1 / span 1"]);
      expect(lines("loans")).toEqual(["9 / span 4", "2 / span 1"]);
      expect(lines("holds")).toEqual(["span 6", ""]);

      const before = { visitors: at("visitors"), loans: at("loans") };
      const report = handle.update(compileFor(swapCounts(app.experience), "web"));
      expect(report.findings).toEqual([]);
      expect(report.remounted).toEqual([]);
      expect(at("visitors")).toBe(before.visitors);
      expect(at("loans")).toBe(before.loans);
      expect(lines("visitors")).toEqual(["9 / span 4", "2 / span 1"]);
      expect(lines("loans")).toEqual(["9 / span 4", "1 / span 1"]);
    } finally {
      handle.dispose();
      host.remove();
    }
  });

  it('G1: title "none" mounts no Blueprint <h1>; the page\'s own header names the mount region', () => {
    const app = createApp();
    const { page, heading, mount, dispose } = mountPage(app);
    try {
      // The app's own header, outside the mount — never a second one from the renderer.
      expect(heading.tagName).toBe("H1");
      expect(heading.textContent).toBe(app.web.title);
      expect(page.querySelectorAll("h1")).toHaveLength(1);
      expect(mount.querySelector("h1")).toBeNull();
      // The mount region is named FROM that heading — a real accessible-name relationship, not
      // just two elements that happen to sit near each other.
      expect(mount.getAttribute("role")).toBe("region");
      expect(mount.getAttribute("aria-labelledby")).toBe(heading.id);
      expect(page.querySelector(`#${heading.id}`)).toBe(heading);
      // Section titles are a SEPARATE concern (per-container `<h2>`s) and are unaffected.
      expect(mount.querySelectorAll("h2")).toHaveLength(2);
      expect(
        mount.querySelector(`section[aria-label="${SECTION_TITLES.today.fallback}"] h2`)
          ?.textContent
      ).toBe(SECTION_TITLES.today.fallback);
    } finally {
      dispose();
    }
  });

  it("prints the sections as underlined headings and the placed nodes in reading order — row, then column", () => {
    const app = createApp();
    const frame = renderExperience(app.terminal, app.store, { registry: terminalRegistry() });
    const heading = (t: string) => `${t}\n${"─".repeat(t.length)}\n`;
    expect(frame).toContain(heading(SECTION_TITLES.today.fallback));
    expect(frame).toContain(heading(SECTION_TITLES.collections.fallback));
    const at = (s: string) => frame.indexOf(s);
    // Inserted visitors, loans, notice; placed notice (row 1, column 1), visitors (row 1, column 9), loans (row 2).
    expect(at(`${LABELS.notice}:`)).toBeGreaterThan(at(SECTION_TITLES.today.fallback));
    expect(at(`${LABELS.notice}:`)).toBeLessThan(at(`${LABELS.visitors}:`));
    expect(at(`${LABELS.visitors}:`)).toBeLessThan(at(LABELS.loans));
    expect(at(LABELS.loans)).toBeLessThan(at(SECTION_TITLES.collections.fallback));
    expect(at(`${LABELS.holds}:`)).toBeLessThan(at(`${LABELS.overdue}:`));
  });
});
