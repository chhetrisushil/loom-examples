import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
import { describe, expect, it } from "vitest";
import { STEPS, createApp } from "../src/app";

// Q4: no container-renderer counterpart on the terminal — a role is an interaction hint, and a
// one-shot text surface has none, so every step prints under the title in reading order,
// byte-identical whether or not the container carries a role (loom ADR 0099 D5).

describe("the terminal renders every step in reading order, with no stepped chrome", () => {
  it("prints the onboarding title and each step's heading, instructions and highlight", () => {
    const app = createApp();
    try {
      const frame = renderExperience(app.compileTerminal(), app.store, {
        registry: terminalRegistry(),
      });
      expect(frame).toContain("Rider onboarding");
      for (const step of [STEPS.account, STEPS.payment, STEPS.pickup]) {
        expect(frame).toContain(step.title.fallback);
        expect(frame).toContain(step.detail.fallback);
        expect(frame).toContain(step.highlight.label);
      }
      const at = (s: string) => frame.indexOf(s);
      expect(at(STEPS.account.title.fallback)).toBeGreaterThan(at("Rider onboarding"));
      expect(at(STEPS.account.title.fallback)).toBeLessThan(at(STEPS.payment.title.fallback));
      expect(at(STEPS.payment.title.fallback)).toBeLessThan(at(STEPS.pickup.title.fallback));
      // No trace of a "stepped" wizard: the terminal never mounts this app's chrome.
      expect(frame).not.toContain("Back");
      expect(frame).not.toContain("Next");
    } finally {
      app.dispose();
    }
  });

  it("a role on the onboarding container makes no difference — the frame is byte-identical with or without it", () => {
    const app = createApp();
    try {
      const withRole = app.compileTerminal();
      const removed = app.land([{ type: "setRole", nodeId: "onboarding", role: null }]);
      expect(removed.findings).toEqual([]);
      const withoutRole = app.compileTerminal();

      const frameWithRole = renderExperience(withRole, app.store, { registry: terminalRegistry() });
      const frameWithoutRole = renderExperience(withoutRole, app.store, {
        registry: terminalRegistry(),
      });
      expect(frameWithRole).toBe(frameWithoutRole);
    } finally {
      app.dispose();
    }
  });
});
