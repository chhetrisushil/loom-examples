import type { AgentCard } from "@loom/plugin-a2a";
import { createTestApp } from "@loom/testing";
import { describe, expect, it } from "vitest";
import { AGENT_CARDS, CAPABILITY_AGENT, FLEET } from "../src/agents/definitions";
import { registerDiagnosticsEffects } from "../src/agents/diagnosticsRunner";
import { buildCatalog } from "../src/capabilities/catalog";
import { Orchestrator } from "../src/orchestrator/Orchestrator";

const CPU_GOAL = "Why is CPU utilization high? Fix it if remediation is low risk.";

// The CPU goal runs the diagnose capability, which drives agentLoop$ (a scripted model effect
// plus the db-metrics tool effect). A composition root that omits `registerEffects` fails the
// run with "No effect registered for toolId", so this pins the wiring.
describe("db-command-center-wc diagnose path", () => {
  it("runs the agentLoop$ diagnosis and resolves a low-risk CPU mission", async () => {
    const id = "wc-cpu";
    const catalog = buildCatalog();
    const app = createTestApp({
      surfaces: ["mission", "telemetry"],
      catalog,
      agents: FLEET.map((a) => AGENT_CARDS[a.id]).filter((c): c is AgentCard => c !== undefined),
      capabilityAgents: CAPABILITY_AGENT,
      execution: { registerEffects: registerDiagnosticsEffects },
    });
    const orchestrator = new Orchestrator({
      projectionRuntime: app.projectionRuntime,
      missionRuntime: app.runtime,
      catalog,
      bus: app.bus,
      missionId: id,
    });

    await orchestrator.run(CPU_GOAL);

    expect(app.projectionRuntime.getState<{ phase: string }>("mission", id).phase).toBe("resolved");
  });
});
