import { evaluatePolicy, promotionGate, steps } from "@loom/learning";
import { type Route, tickets } from "./domain";
import { buildPolicy, trainCandidate } from "./policy";
import { heading, renderArms, renderCoverage, renderReport } from "./render";
import { serveTickets } from "./run";

// ── The continuous-learning loop, end to end ──────────────────────────────────
//
//   1. serve real traffic with a live policy      → a durable, LEARNABLE log
//   2. mine that log into trajectories            → (context, action, propensity, reward)
//   3. train a candidate offline                  → a new immutable version
//   4. evaluate the candidate ON THE REAL LOG     → SNIPS estimate, before it ships
//   5. gate it, gather more evidence, promote     → and measure that it helped
//
// Step 4 is the one no other agent runtime can offer: it needs the recorded
// choice to be *what actually ran*, which is exactly what replay determinism
// guarantees. Nothing here ever re-runs a flow to find out.

const ROUND = 240;
const GATE = { minSteps: 200, minEffectiveSamples: 20 };

async function main(): Promise<void> {
  // ── 1. Serve traffic with a cold policy ─────────────────────────────────────
  console.log(heading(`1. Serving ${ROUND} tickets with a COLD LinUCB policy`));
  const cold = buildPolicy({ version: "1-cold", epsilon: 0.15, seed: 7 });
  const round1 = await serveTickets(cold, ROUND);
  console.log(`  mean quality delivered   ${round1.meanQuality.toFixed(4)}`);
  console.log(renderArms(round1.trajectories));

  // ── 2. What the log captured ────────────────────────────────────────────────
  console.log(heading("2. What the log can teach (this is `loom learn report`)"));
  console.log(renderCoverage(round1.trajectories));
  console.log(
    "\n  Every decision carries the observation it was made on AND the probability\n" +
      "  the policy assigned to it. The propensity is the part that cannot be\n" +
      "  reconstructed later — log it now, or the data is countable but never evaluable."
  );

  // ── 3. Train a candidate, offline ───────────────────────────────────────────
  console.log(heading("3. Training a candidate offline, from the log alone"));
  const v2 = trainCandidate(steps(round1.trajectories), "2-trained");
  console.log(`  trained on         ${v2.applied} steps`);
  console.log(`  evidence per arm   ${JSON.stringify(v2.evidence)}`);

  // ── 4. Evaluate it against traffic it never saw ─────────────────────────────
  console.log(heading("4. Evaluating it against REAL traffic — the candidate never runs"));
  const r1 = evaluatePolicy(round1.trajectories, v2.policy);
  const g1 = promotionGate(r1, GATE);
  console.log(renderReport(r1, g1));
  for (const w of r1.warnings) console.log(`      ! ${w}`);
  console.log(
    "\n  A big lift the gate REFUSES anyway. The cold policy explored so little that\n" +
      "  the estimate rests on a handful of high-weight steps — exactly the failure a\n" +
      "  naive dashboard would have shipped. The answer is more evidence, not a\n" +
      "  lower bar."
  );

  // ── 5. Canary the candidate, gather evidence, re-evaluate ───────────────────
  console.log(heading(`5. Canarying v2 on ${ROUND} more tickets (exploration still on)`));
  const canary = buildPolicy({ version: "2-trained", epsilon: 0.25, seed: 11 });
  canary.fit(steps(round1.trajectories));
  const round2 = await serveTickets(canary, ROUND, { stream: tickets(ROUND) });
  console.log(`  mean quality delivered   ${round2.meanQuality.toFixed(4)}`);
  console.log(renderArms(round2.trajectories));

  const pooled = [...round1.trajectories, ...round2.trajectories];
  const v3 = trainCandidate(steps(pooled), "3-trained");
  const r2 = evaluatePolicy(pooled, v3.policy);
  const g2 = promotionGate(r2, GATE);
  console.log("");
  console.log(renderReport(r2, g2));
  for (const w of r2.warnings) console.log(`      ! ${w}`);

  // ── 6. Did it actually help? ────────────────────────────────────────────────
  console.log(heading("6. The payoff"));
  const delta = round2.meanQuality - round1.meanQuality;
  console.log(`  round 1 (cold)     ${round1.meanQuality.toFixed(4)}`);
  console.log(`  round 2 (learned)  ${round2.meanQuality.toFixed(4)}`);
  console.log(`  improvement        ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`);
  console.log(
    "\n  Same flow, same tickets, same code. The only thing that changed is a policy\n" +
      "  trained on the log the runtime was already writing — and every choice it made\n" +
      "  is still a recorded, replayable, auditable ctx.decide."
  );

  // ── 7. The control ──────────────────────────────────────────────────────────
  console.log(heading("7. Control: a deliberately bad candidate must be refused"));
  const alwaysCheap = {
    id: "always-gemma",
    version: "1",
    select: () => ({ action: "gemma" as Route }),
  };
  const bad = evaluatePolicy(pooled, alwaysCheap);
  console.log(renderReport(bad, promotionGate(bad, GATE)));

  // ── 8. The contrast ─────────────────────────────────────────────────────────
  console.log(heading(`8. The same ${ROUND} tickets, logged WITHOUT context or propensity`));
  const blind = await serveTickets(
    buildPolicy({ version: "1-cold", epsilon: 0.15, seed: 7 }),
    ROUND,
    {
      learnable: false,
      stream: tickets(ROUND),
    }
  );
  console.log(renderCoverage(blind.trajectories));
  const blindReport = evaluatePolicy(blind.trajectories, v3.policy);
  console.log("");
  console.log(renderReport(blindReport, promotionGate(blindReport, GATE)));
  console.log(
    "\n  Same executions, same rewards, same everything a dashboard would show — and\n" +
      "  nothing can be learned or proven from it. That is the cost of a bare\n" +
      "  ctx.decide, and you only discover it the day you want to improve.\n"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
