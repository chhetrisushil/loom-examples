import { blueprintNodeIds, preservesNodes } from "@loom/blueprint-runtime";
import { buildApp } from "./app";
import { SCHEMA_REPAIRED, createHydrator } from "./hydration";
import { startTelemetryMcpServer } from "./mcpServer";
import { createPreferenceService } from "./preferenceService";
import { explainFlag } from "./profile";
import { createProfileService } from "./profileService";
import { applyHydratedStates } from "./telemetry";

// Ask the observability assistant a few questions. Telemetry is HYDRATED by a
// TRANSIENT interpreter — plain-code invokeTransient over mcp.invoke
// (schema-hash-pinned dynamic MCP dispatch) chained into sandbox.eval (sandboxed,
// LLM-authored reshaping), writing zero events on the hot read path — then each
// question is analysed by the agent, categorised, and answered with a
// DYNAMICALLY-generated dashboard (WHAT + WHY), rendered headlessly to the
// terminal. Offline, no API key: the MCP server runs in-process. Midway, a
// simulated backend deploy drifts one tool's schema — the pinned hash
// mismatches, the transient read fails TYPED (schemaDrift), and hydration
// crosses the determinism boundary into a DURABLE repair run that records the
// fix (ADR 0060/0061/0063/0064/0065).

const QUESTIONS_BEFORE = [
  "Why is the CPU utilization high?",
  "What is the connection saturation level?",
];
const QUESTIONS_AFTER = [
  "Is replica lag a problem right now?",
  "Which slow queries are hurting us?",
];

const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const note = (s: string): string => `\x1b[33m${s}\x1b[0m`;

async function main(): Promise<void> {
  const server = await startTelemetryMcpServer();
  try {
    const { composer, renderer, executionId, projectionRuntime } = buildApp();
    const hydrator = createHydrator(server.url);

    console.log(
      dim("\n── Hydrating telemetry: transient walk, invokeTransient(mcp.invoke → sandbox.eval) ──")
    );
    const plan = await hydrator.buildPlan();
    console.log(
      dim(
        plan.nodes
          .map(
            (n) => `  ${n.projectionId} ← ${n.toolName} (pin ${n.expectedSchemaHash.slice(0, 18)}…)`
          )
          .join("\n")
      )
    );
    applyHydratedStates(projectionRuntime, executionId, await hydrator.hydrate("hydrate-1", plan));

    for (const question of QUESTIONS_BEFORE) {
      const result = await composer.answer(question);
      const { ok, widgets, findings } = result.validation;
      console.log(
        dim(
          `\n# "${question}" → topic=${result.classification.topic} kind=${result.classification.kind}` +
            ` · ${widgets} widgets, ${ok ? "catalogue-valid" : `${findings.length} finding(s)`}`
        )
      );
      // A generated dashboard is checked against the catalogue it was composed from,
      // and a gap is reported rather than rendered blank.
      for (const f of findings) console.log(dim(`  ! ${f.severity} ${f.code}: ${f.message}`));
      console.log(renderer.render(result.blueprint, executionId));
    }

    console.log(
      note("\n── Backend deploy: db.replication's input schema changes — the pin drifts ──")
    );
    server.upgradeReplicationTool();
    applyHydratedStates(projectionRuntime, executionId, await hydrator.hydrate("hydrate-2", plan));
    const repaired = (await hydrator.events("hydrate-2")).find(
      (e) => e.eventType === SCHEMA_REPAIRED
    );
    if (repaired) {
      const p = repaired.payload as {
        toolName: string;
        expectedSchemaHash: string;
        observedHash: string;
      };
      console.log(
        note(
          `⚠ schemaDrift on ${p.toolName}: pinned ${p.expectedSchemaHash.slice(0, 18)}… observed ${p.observedHash.slice(0, 18)}… — transient read escalated to a DURABLE repair run, recorded under the observed pin`
        )
      );
    }

    for (const question of QUESTIONS_AFTER) {
      const result = await composer.answer(question);
      console.log(
        dim(
          `\n# "${question}" → topic=${result.classification.topic} kind=${result.classification.kind}`
        )
      );
      console.log(renderer.render(result.blueprint, executionId));
    }

    // ── Phase 1: two operators, one question, one composer ────────────────────
    // Ana pinned the slow-query table on this topic and works compact; Bo has stated
    // nothing. Same agent, same widget set, same code path — only the arrangement
    // differs, and the invariant below is what keeps that difference safe.
    console.log(note("\n── Stated preferences: the same question for two operators ──"));
    const prefs = createPreferenceService();
    const ana = { tenant: "acme", operator: "ana", topic: "cpu" };
    const bo = { tenant: "acme", operator: "bo", topic: "cpu" };
    await prefs.state(ana, { density: "compact", pinnedWhyWidget: "queries.slow" });

    const shared = QUESTIONS_BEFORE[0] as string;
    const anaView = await composer.answer(shared, await prefs.resolve(ana));
    const boView = await composer.answer(shared, await prefs.resolve(bo));

    for (const [who, view] of [
      ["ana (compact, pinned queries.slow)", anaView],
      ["bo  (stated nothing → canonical)", boView],
    ] as const) {
      console.log(dim(`\n# ${who}`));
      console.log(renderer.render(view.blueprint, executionId));
    }

    // The guarantee, checked rather than asserted: an arrangement rearranges and never
    // withholds, so nothing Ana sees is unreachable to Bo and vice versa.
    const preserved = preservesNodes(
      blueprintNodeIds(boView.blueprint),
      blueprintNodeIds(anaView.blueprint)
    );
    console.log(
      dim(
        `\n  arrangement preserved every node: ${preserved.ok} (${preserved.compared} compared, ${preserved.added.length} added)`
      )
    );

    // ── Phase 2: a profile DERIVED from what the operator actually did ────────
    // Nothing here is stated. Cal opened the slow-query table three times over the
    // fortnight; that is evidence, it is in the log, and the flag it sets is a fold over
    // it — not a score, not a stored fact, and citable to the day.
    console.log(note("\n── A derived profile: evidence, a flag, and what it says ──"));
    const profiles = createProfileService();
    for (let i = 0; i < 3; i++) await profiles.observe("acme", "cal", "open.queries.slow");

    const cal = { tenant: "acme", operator: "cal", topic: "cpu" };
    const profile = await profiles.resolve(cal, "session-cal-1");
    for (const flag of profile.detail) console.log(dim(`  ${explainFlag(flag)}`));

    const calView = await composer.answer(shared, await prefs.resolve(cal), profile);
    console.log(dim("\n# cal (no stated preference; profile suggests the plan detail)"));
    console.log(renderer.render(calView.blueprint, executionId));

    // The profile the run used is a RECORDED DECISION, not a pointer to a store that has
    // since moved on. Expire the flag and the derived view empties — while the run that
    // already resolved still answers with what it was arranged under.
    const lapsed = await profiles.expire("acme", "cal", Date.now() + 400 * 24 * 60 * 60 * 1000);
    console.log(
      dim(
        `\n  expiry pass emitted ${lapsed} lapse event(s) → derived flags now [${(await profiles.derive("acme", "cal")).flags.join(", ")}]` +
          `, but session-cal-1 still resolves [${(await profiles.replay("session-cal-1")).flags.join(", ")}]`
      )
    );
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
