import { type Batch, Lab } from "./lab";
import { armOf, fmt, trial } from "./lifecycle";
import { POLICY_ID } from "./policies";

// A narrated run of the whole loop. Offline, deterministic, no keys.
const h = (t: string) => console.log(`\n== ${t} ==`);
const say = (l: string) => console.log(`  ${l}`);

async function main(): Promise<void> {
  const lab = new Lab();
  const now = () => Date.parse(lab.iso());

  h("1. v1 is live: a fair coin per user, every choice logged with propensity 0.5");
  await lab.bootstrap();
  const base = await lab.serve("base", 120, 1);
  const settled = await lab.settle(base);
  const baseTrajs = await lab.trajectories(base);
  const served = { flat: 0, tabs: 0 };
  for (const s of base.surfaces) served[s.served]++;
  say(`120 planner turns served: ${served.flat} flat / ${served.tabs} tabs; 3 viewers each voted`);
  say(`closed: ${settled.appended} late rewards recorded (one pooled score per decision)`);

  h("2. v2 (by-segment layout, trained on epoch-1 votes): offline -> shadow -> canary");
  const t2 = await trial(lab, "2", {
    evidence: baseTrajs,
    incumbent: "1",
    shadow: { users: 60, epoch: 1 },
    canary: { users: 90, epoch: 2, fraction: 0.3 }, // the world drifts as the canary starts
    say,
  });
  say(`outcome: ${t2.outcome}`);
  const afterRollback = await lab.turn({ userId: "late@example.com", segment: "casual" });
  say(
    `after rollback the next decision is served by v${(await lab.registry.resolve(POLICY_ID))?.incumbent}: ${afterRollback.served}`
  );

  h("3. v3 (tabs for everyone, retrained on epoch-2 votes)");
  const evidence = await lab.trajectories(t2.batches.canary as Batch);
  const t3 = await trial(lab, "3", {
    evidence: armOf(evidence, "1"),
    incumbent: "1",
    shadow: { users: 60, epoch: 2 },
    canary: { users: 90, epoch: 2, fraction: 0.3 },
    say,
  });
  say(`outcome: ${t3.outcome}; live now: v${(await lab.registry.resolve(POLICY_ID))?.incumbent}`);
  const hist = await lab.registry.history(POLICY_ID);
  h("4. registry history");
  for (const e of hist)
    say(
      `#${e.seq} ${e.action}${e.version ? ` v${e.version}` : ""}${e.mode ? ` (${e.mode})` : ""}${e.note ? ` - ${e.note}` : ""}`
    );

  h("5. replay");
  const parked = await lab.parkedTurn({ userId: "replay@example.com", segment: "power" });
  const before = (await lab.eventStore.read(parked.executionId)).filter(
    (e) => e.eventType === "DECISION_RECORDED"
  ).length;
  const calls0 = lab.policies.calls.length;
  const modelCalls0 = lab.models.flat.calls + lab.models.tabs.calls;
  await lab.registry.rollback({
    id: POLICY_ID,
    to: "1",
    now: now(),
    note: "demo: registry changes under a parked run",
  });
  const r = await lab.runtime.resume(parked.executionId, { eventType: "ReplayGate", payload: {} });
  await r.waitForCompletion();
  const after = (await lab.eventStore.read(parked.executionId)).filter(
    (e) => e.eventType === "DECISION_RECORDED"
  ).length;
  say(
    `decisions recorded before/after replay: ${before}/${after}; planner model calls on replay: ${lab.models.flat.calls + lab.models.tabs.calls - modelCalls0}`
  );
  say(
    `policy.select consulted on replay ${lab.policies.calls.length - calls0}x (the recorded choice is served)`
  );
  say(`final mean-lift of v3 canary: ${fmt(t3.reports.canary?.lift)}`);
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
