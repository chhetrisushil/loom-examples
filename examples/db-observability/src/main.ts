import { blueprintNodeIds, preservesNodes } from "@loom/blueprint-runtime";
import { buildApp } from "./app";
import { ExplorationFloor } from "./exploration";
import { SCHEMA_REPAIRED, createHydrator } from "./hydration";
import { startTelemetryMcpServer } from "./mcpServer";
import { baselineReport, ttmRegressed } from "./metrics";
import { createPreferenceService } from "./preferenceService";
import { explainFlag } from "./profile";
import { createProfileService } from "./profileService";
import { createSessionRecorder } from "./sessions";
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
    const session = await profiles.open(cal, "session-cal-1", {
      available: ["connections.saturation", "queries.slow", "cpu.trend"],
    });
    const profile = session.profile;
    for (const flag of profile.detail) console.log(dim(`  ${explainFlag(flag)}`));

    const calView = await composer.answer(
      shared,
      await prefs.resolve(cal),
      profile,
      session.surfaced
    );
    console.log(dim("\n# cal (no stated preference; profile suggests the plan detail)"));
    console.log(renderer.render(calView.blueprint, executionId));

    // The profile the run used is a RECORDED DECISION, not a pointer to a store that has
    // since moved on. Expire the flag and the derived view empties — while the run that
    // already resolved still answers with what it was arranged under.
    // ── Phase 2b: the exploration floor, and canonical mode ───────────────────
    // Dee holds nothing, so every catalogue capability on this surface is above her
    // assessed level. The floor is forced here so the demo is deterministic; in a session
    // it fires for a fixed fraction, and the DRAW is what gets journaled — with the
    // propensity, without which the arm it creates could never be scored.
    console.log(note("\n── The exploration floor, and what an incident does to it ──"));
    // rate 0.99 rather than 1: a floor that ALWAYS explores is not a floor, and its
    // "declined" propensity would be zero — which is why the constructor refuses it.
    const explorer = createProfileService(new ExplorationFloor(0.99, () => 0));
    const dee = { tenant: "acme", operator: "dee", topic: "cpu" };
    const explored = await explorer.open(dee, "session-dee-1", {
      available: ["connections.saturation", "queries.slow", "cpu.trend"],
    });
    console.log(
      dim(
        `  surfaced "${explored.surfaced}" above dee's assessed level (propensity logged at the draw)`
      )
    );
    // She did not use it. That is a MEASUREMENT, recorded as a zero — an absent outcome
    // would be skipped by credit assignment, and scoring only the successes is what makes
    // an assessed level inflate forever.
    await explorer.scoreExploration(explored.explorationId as string, "session-dee-1-out", false);

    const underIncident = await explorer.open(dee, "session-dee-2", {
      available: ["connections.saturation", "queries.slow", "cpu.trend"],
      canonical: { active: true, reason: "page fired on orders-prod" },
    });
    console.log(
      dim(
        `  under incident (${underIncident.canonical.reason}): profile zeroed, surfaced ${underIncident.surfaced} — an incident is not a place to run an experiment`
      )
    );

    // ── Phase 0: the baseline the later phases are judged against ─────────────
    // Recorded with adaptation OFF, which is the control arm and costs nothing: it is the
    // same composer call with the profile zeroed. Every rate carries its denominator, and
    // a rate over nobody is null rather than zero — "nobody succeeded" and "nobody tried"
    // are different findings.
    console.log(note("\n── Phase 0: the baseline, with adaptation off ──"));
    const sessions = createSessionRecorder();
    await sessions.start({
      sessionId: "b1",
      tenant: "acme",
      operator: "ana",
      topic: "cpu",
      adaptive: false,
    });
    await sessions.succeeded("b1", "plan.exported");
    await sessions.ended("b1");
    // A session that ended without an explicit success is not a success, however fast it
    // was: the quickest session in any log is someone who found nothing and left.
    await sessions.start({
      sessionId: "b2",
      tenant: "acme",
      operator: "bo",
      topic: "cpu",
      adaptive: false,
    });
    await sessions.ended("b2");
    await sessions.incidentOpened("i-1", "orders-prod", false);
    await sessions.incidentMitigated("i-1", "orders-prod", false);

    const report = baselineReport([...(await sessions.log()), ...(await profiles.allEvents())]);
    console.log(
      dim(
        `  task success ${report.taskSuccess.numerator}/${report.taskSuccess.denominator}` +
          ` · time-to-success over ${report.timeToSuccess.n} success(es)` +
          ` · escape hatch ${report.escapeHatch.numerator}/${report.escapeHatch.denominator}` +
          ` · TTM canonical n=${report.incidentTimeToMitigate.canonical.n}, adaptive n=${report.incidentTimeToMitigate.adaptive.n}`
      )
    );
    const gate = ttmRegressed(
      report.incidentTimeToMitigate.canonical.meanMs,
      report.incidentTimeToMitigate.adaptive
    );
    // The guardrail fails CLOSED: with no adaptive incidents measured there is nothing to
    // clear, and "we could not tell" must never read as "no regression".
    console.log(dim(`  release gate: ${gate.blocked ? "BLOCKED" : "clear"} — ${gate.reason}`));

    const lapsed = await profiles.expire("acme", "cal", Date.now() + 400 * 24 * 60 * 60 * 1000);
    console.log(
      dim(
        `\n  expiry pass emitted ${lapsed} lapse event(s) → derived flags now [${(await profiles.derive("acme", "cal")).flags.join(", ")}]` +
          `, but session-cal-1 still resolves [${(await profiles.replay("session-cal-1")).profile.flags.join(", ")}]`
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
