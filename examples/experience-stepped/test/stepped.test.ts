import type { DomContainerRenderer } from "@loom-ui/renderer-lit/dom";
import { RendererRegistry } from "@loom/blueprint-runtime";
import { describe, expect, it } from "vitest";
import { STEPS, appendStepOp, createApp, detailNodeId, highlightNodeId } from "../src/app";

// The container-renderer seam (Blueprint IR 2.2.0 `Layout.role`, loom ADR 0099), exercised by
// this app's OWN `stepped` renderer (`src/steppedContainer.ts`), registered on
// `DomRenderOptions.containers` the way an app registers a widget renderer on `registry`. The
// adapter owns the body — mount, keyed reconcile, reorder, subscriptions, focus pin; this
// renderer owns only its chrome (progress dots + Back/Next) and which of the children it is
// handed are visible.

const roleHost = (host: HTMLElement): HTMLElement | null =>
  host.querySelector("[data-container-role]");
const nav = (host: HTMLElement): HTMLElement | null =>
  host.querySelector("nav[data-chrome='stepped']");
const backBtn = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector("[data-chrome-action='back']") as HTMLButtonElement;
const nextBtn = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector("[data-chrome-action='next']") as HTMLButtonElement;
const position = (host: HTMLElement): HTMLElement =>
  host.querySelector("[data-chrome-part='position']") as HTMLElement;
const dots = (host: HTMLElement): (string | null)[] =>
  [...host.querySelectorAll("[data-chrome-part='dots'] li")].map((li) => li.textContent);
const widgetEl = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-widget-id='${id}']`);

/**
 * The onboarding container's body — the flex holding its step sections — whichever way it is
 * currently drawn: with chrome (a role host) or plain (its own titled section, still there since
 * "Rider onboarding" never changes in these tests).
 */
const onboardingBody = (host: HTMLElement): HTMLElement => {
  const rh = roleHost(host);
  if (rh) return rh.querySelector(":scope > [data-layout]") as HTMLElement;
  // Plain: the onboarding container's own title wrap — the FIRST titled section in document
  // order, since it is the outermost (a step's own titled section nests inside it).
  const section = host.querySelector("section[aria-label]") as HTMLElement;
  return section.querySelector(":scope > [data-layout]") as HTMLElement;
};
const stepSections = (host: HTMLElement): HTMLElement[] =>
  [...onboardingBody(host).children] as HTMLElement[];

const BASE_STEPS = [STEPS.account, STEPS.payment, STEPS.pickup];
const allWidgetIds = (): string[] =>
  BASE_STEPS.flatMap((s) => [detailNodeId(s), highlightNodeId(s)]).sort();

describe("paging: exactly one step shown at a time, the rest hidden accessibly", () => {
  it("shows step 1 only; Next/Back move the current step and update the chrome", () => {
    const app = createApp();
    try {
      const sections = stepSections(app.host);
      expect(sections.length).toBe(3);
      expect(sections.map((s) => s.hidden)).toEqual([false, true, true]);
      expect(sections[0]?.hasAttribute("inert")).toBe(false);
      expect(sections[0]?.hasAttribute("aria-hidden")).toBe(false);
      for (const hidden of sections.slice(1)) {
        expect(hidden.getAttribute("inert")).toBe("");
        expect(hidden.getAttribute("aria-hidden")).toBe("true");
      }
      expect(position(app.host).textContent).toBe("Step 1 of 3: Account");
      expect(dots(app.host)).toEqual(["Account", "Payment", "Pickup"]);
      expect(backBtn(app.host).disabled).toBe(true);
      expect(nextBtn(app.host).disabled).toBe(false);

      nextBtn(app.host).click();
      expect(stepSections(app.host).map((s) => s.hidden)).toEqual([true, false, true]);
      expect(position(app.host).textContent).toBe("Step 2 of 3: Payment");
      expect(backBtn(app.host).disabled).toBe(false);
      expect(nextBtn(app.host).disabled).toBe(false);

      nextBtn(app.host).click();
      expect(stepSections(app.host).map((s) => s.hidden)).toEqual([true, true, false]);
      expect(position(app.host).textContent).toBe("Step 3 of 3: Pickup");
      expect(nextBtn(app.host).disabled).toBe(true);

      nextBtn(app.host).click(); // Next is disabled at the last step — a click is a no-op
      expect(position(app.host).textContent).toBe("Step 3 of 3: Pickup");

      backBtn(app.host).click();
      backBtn(app.host).click();
      expect(position(app.host).textContent).toBe("Step 1 of 3: Account");
      expect(backBtn(app.host).disabled).toBe(true);
      backBtn(app.host).click(); // Back is disabled at the first step — a click is a no-op
      expect(position(app.host).textContent).toBe("Step 1 of 3: Account");
    } finally {
      app.dispose();
    }
  });
});

describe("setRole toggles the container between chrome and plain", () => {
  it("setRole(null) falls back to plain — every step visible, chrome gone, widgets remounted; setRole('stepped') brings it back", () => {
    const app = createApp();
    try {
      const ids = allWidgetIds();

      const removed = app.land([{ type: "setRole", nodeId: "onboarding", role: null }]);
      expect(removed.findings).toEqual([]);
      expect([...removed.remounted].sort()).toEqual(ids);
      expect(roleHost(app.host)).toBeNull();
      expect(nav(app.host)).toBeNull();
      const plain = stepSections(app.host);
      expect(plain.length).toBe(3);
      for (const s of plain) {
        expect(s.hidden).toBe(false);
        expect(s.hasAttribute("inert")).toBe(false);
        expect(s.hasAttribute("aria-hidden")).toBe(false);
      }

      const added = app.land([{ type: "setRole", nodeId: "onboarding", role: "stepped" }]);
      expect(added.findings).toEqual([]);
      expect([...added.remounted].sort()).toEqual(ids);
      expect(roleHost(app.host)).not.toBeNull();
      expect(nav(app.host)).not.toBeNull();
      expect(stepSections(app.host).map((s) => s.hidden)).toEqual([false, true, true]);
    } finally {
      app.dispose();
    }
  });
});

describe("an identical Blueprint update", () => {
  it("makes zero DOM mutations and reports nothing", () => {
    const app = createApp();
    try {
      const observer = new MutationObserver(() => {});
      observer.observe(app.host, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const report = app.land([]); // no ops — the same experience, recompiled
      const records = observer.takeRecords();
      observer.disconnect();
      expect(records).toEqual([]);
      expect(report).toMatchObject({ remounted: [], rebound: [], findings: [] });
    } finally {
      app.dispose();
    }
  });
});

describe("a step's title change", () => {
  it("patches the chrome's labels and the section heading — no remount", () => {
    const app = createApp();
    try {
      nextBtn(app.host).click(); // onto "payment", so the position text names it
      const report = app.land([
        {
          type: "setTitle",
          nodeId: "payment",
          title: { key: "stepped.payment.title", fallback: "Payment method" },
        },
      ]);
      expect(report).toMatchObject({ remounted: [], findings: [] });
      expect(position(app.host).textContent).toBe("Step 2 of 3: Payment method");
      expect(dots(app.host)).toEqual(["Account", "Payment method", "Pickup"]);
      expect(app.host.querySelector("section[aria-label='Payment method']")).not.toBeNull();
    } finally {
      app.dispose();
    }
  });
});

describe("appending a step via ops", () => {
  it("remounts none of the existing widgets; the new step's own widgets mount fresh", () => {
    const app = createApp();
    try {
      const before = new Map(
        BASE_STEPS.flatMap((s) => [
          [detailNodeId(s), widgetEl(app.host, detailNodeId(s))] as const,
          [highlightNodeId(s), widgetEl(app.host, highlightNodeId(s))] as const,
        ])
      );

      const ops = appendStepOp(app.experience, STEPS.confirm);
      const report = app.land(ops);
      expect(report.remounted).toEqual([]);
      expect(report.findings).toEqual([]);

      for (const [id, el] of before) expect(widgetEl(app.host, id)).toBe(el);
      expect(widgetEl(app.host, detailNodeId(STEPS.confirm))).not.toBeNull();
      expect(widgetEl(app.host, highlightNodeId(STEPS.confirm))).not.toBeNull();

      expect(stepSections(app.host).length).toBe(4);
      expect(position(app.host).textContent).toBe("Step 1 of 4: Account"); // the current step is kept
      expect(dots(app.host)).toEqual(["Account", "Payment", "Pickup", "Confirm"]);
    } finally {
      app.dispose();
    }
  });
});

describe("a container renderer that throws", () => {
  it("falls back to the plain container on the initial mount — every step visible, still live", () => {
    const boom: DomContainerRenderer = () => {
      throw new Error("chrome exploded");
    };
    const containers = new RendererRegistry<DomContainerRenderer>().register("stepped", boom);
    const app = createApp({ containers });
    try {
      expect(roleHost(app.host)).toBeNull();
      expect(nav(app.host)).toBeNull();
      const sections = stepSections(app.host);
      expect(sections.length).toBe(3);
      expect(
        sections.every(
          (s) => !s.hidden && !s.hasAttribute("inert") && !s.hasAttribute("aria-hidden")
        )
      ).toBe(true);
      expect(widgetEl(app.host, highlightNodeId(STEPS.account))).not.toBeNull();
    } finally {
      app.dispose();
    }
  });

  it("falls back to the plain container on update — patch-failed, chrome disposed, children un-hidden and still subscribed", () => {
    const flaky: DomContainerRenderer = (host, props) => {
      host.insertBefore(document.createElement("nav"), props.body);
      return {
        update: () => {
          throw new Error("chrome update exploded");
        },
        dispose: () => {},
      };
    };
    const containers = new RendererRegistry<DomContainerRenderer>().register("stepped", flaky);
    const app = createApp({ containers });
    try {
      expect(roleHost(app.host)).not.toBeNull();
      const report = app.land([
        {
          type: "setTitle",
          nodeId: "onboarding",
          title: { key: "stepped.onboarding.title", fallback: "Rider onboarding (updated)" },
        },
      ]);
      expect(report.remounted).toEqual([]);
      expect(report.findings).toEqual([
        {
          code: "patch-failed",
          nodeId: "",
          message: expect.stringMatching(/"stepped".*chrome update exploded/),
        },
      ]);
      expect(roleHost(app.host)).toBeNull();
      const sections = stepSections(app.host);
      expect(sections.length).toBe(3);
      expect(
        sections.every(
          (s) => !s.hidden && !s.hasAttribute("inert") && !s.hasAttribute("aria-hidden")
        )
      ).toBe(true);
      expect(widgetEl(app.host, highlightNodeId(STEPS.account))).not.toBeNull();
    } finally {
      app.dispose();
    }
  });
});
