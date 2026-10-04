import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "@loom/app";
import { analyzeReachNode } from "@loom/compiler";
import { GrantTable, ToolEffect } from "@loom/effect-runtime";
import type { VerificationReport } from "@loom/verify";
import type { RegisteredFlow } from "@loom/workflow-runtime";
import ts from "typescript";
import { TRIAGE_FLOW, type TriageApp } from "./app";
import { LLM_TOOL_ID, fakeLlm } from "./llm";

/**
 * Analyse the `triage` runner from the REAL source text of `src/app.ts`: the file is parsed with
 * TypeScript and the runner's initializer is handed to the compiler's `analyzeReachNode`. Never a
 * transpiled `fn.toString()` (under vitest/tsx imported identifiers are rewritten, so a callee
 * could stop matching its `verify.reach` key). Only that one runner is analysed, not the whole
 * module, because app.ts holds several runners. In a project this result comes from the
 * `loom-manifest.json` the compiler emits.
 */
function triageRunnerReach() {
  const file = join(__dirname, "app.ts");
  const sf = ts.createSourceFile(
    "app.ts",
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true
  );
  let runner: ts.Node | undefined;
  const find = (n: ts.Node): void => {
    if (runner !== undefined) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === "triage") {
      runner = n.initializer;
      return;
    }
    n.forEachChild(find);
  };
  find(sf);
  if (runner === undefined) throw new Error("src/app.ts no longer declares the `triage` runner");
  return analyzeReachNode(runner, "src/app.ts");
}

/**
 * Run `app.verify()` over the triage flow, the way a real app does: `defineConfig` with the flow,
 * a flow-keyed `GrantTable`, and (optionally) `checks.verify.reach` mapping the callee the flow
 * source uses (`planner`) to the REAL planner object that carries the declaration.
 *
 * `llm` selects how the LLM effect is registered: `ambient` (default), `journaled` (which the
 * transient seam refuses), or `unregistered`.
 */
export function verifyTriage(
  app: TriageApp,
  opts: { mapReach: boolean; grantLlm: boolean; llm?: "ambient" | "journaled" | "unregistered" }
): VerificationReport {
  // `RegisteredFlow` defaults to <unknown, unknown>, which a Json-typed runner is not assignable
  // to (the runner's input is contravariant), hence the cast.
  const flow = {
    definition: app.definitions[TRIAGE_FLOW],
    runner: app.triageRunner,
  } as unknown as RegisteredFlow;
  const llm = opts.llm ?? "ambient";
  const loom = defineConfig({
    storage: { kind: "memory" },
    flows: [flow],
    security: { authorizer: new GrantTable({ [TRIAGE_FLOW]: opts.grantLlm ? [LLM_TOOL_ID] : [] }) },
    execution: {
      registerEffects: (fx) => {
        if (llm === "ambient") fx.register(LLM_TOOL_ID, fakeLlm().effect);
        else if (llm === "journaled") {
          fx.register(
            LLM_TOOL_ID,
            new ToolEffect(async () => ({ content: "" }), { mode: "journaled" })
          );
        }
      },
    },
    checks: { verify: { mode: "off", ...(opts.mapReach && { reach: { planner: app.planner } }) } },
  });
  return loom.verify({ lint: { runnerReachByFlow: { [TRIAGE_FLOW]: triageRunnerReach() } } });
}
