import { defineConfig } from "@loom/app";
import { analyzeRunnerReach } from "@loom/compiler";
import { GrantTable } from "@loom/effect-runtime";
import type { VerificationReport } from "@loom/verify";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import { TRIAGE_FLOW, type TriageApp } from "./app";
import { LLM_TOOL_ID, fakeLlm } from "./llm";

/**
 * Run `app.verify()` over the triage flow, the way a real app does: `defineConfig` with the flow,
 * a flow-keyed `GrantTable`, and (optionally) `checks.verify.reach` mapping the callee the flow
 * source uses (`planner`) to the REAL planner object that carries the declaration.
 *
 * The flow's source is analysed with the real compiler `analyzeRunnerReach` (in a project this
 * comes from the `loom-manifest.json` the compiler emits; here it is read off the runner itself).
 */
export function verifyTriage(
  app: TriageApp,
  opts: { mapReach: boolean; grantLlm: boolean }
): VerificationReport {
  const source = `const runner = ${app.triageRunner.toString()};`;
  const flow = { definition: app.definitions[TRIAGE_FLOW], runner: app.triageRunner };
  const loom = defineConfig({
    storage: { kind: "memory" },
    flows: [flow as unknown as RegisteredFlow],
    security: { authorizer: new GrantTable({ [TRIAGE_FLOW]: opts.grantLlm ? [LLM_TOOL_ID] : [] }) },
    execution: { registerEffects: (fx) => fx.register(LLM_TOOL_ID, fakeLlm().effect) },
    checks: { verify: { mode: "off", ...(opts.mapReach && { reach: { planner: app.planner } }) } },
  });
  return loom.verify({
    lint: { runnerReachByFlow: { [TRIAGE_FLOW]: analyzeRunnerReach(source, TRIAGE_FLOW) } },
  });
}
