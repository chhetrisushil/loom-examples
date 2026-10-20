import { resetAgentLoopDefaults } from "@loom/agent";
import { isTainted, unwrapTainted } from "@loom/classify";
import { InMemoryContentStore } from "@loom/plugin-content";
import { bootLive, listen, until } from "./live";
import { blockOrderIn, reasoningPartsIn } from "./model";
import {
  audit,
  eraseReasoning,
  logLeaks,
  recordedParts,
  replayFromLog,
  replayPartAs,
  runCaptured,
} from "./scenario";
import { boot, review } from "./world";

const heading = (s: string) => console.log(`\n== ${s}`);
const clip = (s: string, n = 78) => (s.length > n ? `${s.slice(0, n)}...` : s);

async function main(): Promise<void> {
  heading("1. defineConfig({ observability: { reasoning: { store } } }) and the boot warning");
  const unconfigured = boot();
  console.log("  no store configured, the model can return reasoning -> onWarn:");
  for (const w of unconfigured.bootWarnings) console.log(`    ${clip(w, 150)}`);
  const store = new InMemoryContentStore();
  const configured = boot({ reasoning: { store } });
  console.log(`  with a store: warnings = ${JSON.stringify(configured.bootWarnings)}`);
  console.log(
    `  with reasoning: false: warnings = ${JSON.stringify(boot({ reasoning: false }).bootWarnings)}`
  );

  heading("2. A two-tool-turn run: the step value holds refs and signatures, never the text");
  const world = configured;
  const run = await review(world, "exp-1");
  console.log(`  status=${run.status}, payments=${JSON.stringify(world.payments)}`);
  console.log("  recorded parts of turn 0 (the STEP_COMPLETED value):");
  console.log(`    ${clip(JSON.stringify(recordedParts(run, 0)[0]), 200)}`);
  const events = run.events.filter((e) => e.eventType === "LLM_REASONING_CAPTURED");
  console.log(`  LLM_REASONING_CAPTURED events: ${events.length}`);
  console.log(`    ${clip(JSON.stringify(events[1]?.payload), 220)}`);
  const leaks = logLeaks(run.events);
  console.log(`  readable reasoning found in the serialized log: ${leaks.length} of 3 thoughts`);
  const second = world.model.requests[1];
  const third = world.model.requests[2];
  if (second !== undefined && third !== undefined) {
    console.log(
      `  turn 2's request carried back: ${reasoningPartsIn(third)
        .map((p) => `${p.kind}:${String(p.signature)}`)
        .join(", ")}`
    );
    console.log(`  block order per assistant turn: ${JSON.stringify(blockOrderIn(third))}`);
  }

  heading("3. Audit: readReasoning (tainted), then erase the blobs, then replay");
  const read = await audit(world, store, "exp-1");
  for (const s of read) {
    const a = s.attempts[0];
    console.log(
      `  ${s.stepId}: recorded attempt ${s.recordedAttempt}, ${a?.parts.map((p) => `${p.kind}/${p.status}`).join(", ")}`
    );
    for (const p of a?.parts ?? []) {
      if (p.text !== undefined) {
        console.log(`    tainted=${isTainted(p.text)}  "${clip(unwrapTainted(p.text))}"`);
      }
    }
  }
  const erased = await eraseReasoning(store, run);
  console.log(`  erased ${erased} blobs from the sidecar`);
  const after = await audit(world, store, "exp-1");
  console.log(
    `  readReasoning now: ${after.flatMap((s) => s.attempts.flatMap((a) => a.parts.map((p) => `${p.kind}/${p.status}`))).join(", ")}`
  );
  const replay = await replayFromLog(run);
  console.log(
    `  replay from the log in a fresh process: status=${replay.status}, model calls=${replay.world.model.requests.length}, same answer=${replay.content === run.content}`
  );

  heading("4. The forged-ref guard: another execution's part is dropped");
  const fresh = await runCaptured("exp-2");
  const own = await replayPartAs(fresh.world, fresh.run, "exp-2");
  const forged = await replayPartAs(fresh.world, fresh.run, "exp-forger");
  console.log(
    `  same part, called as its own execution -> provider was sent ${own.sent.length} reasoning part(s)`
  );
  console.log(
    `  same part, called as "exp-forger"     -> provider was sent ${forged.sent.length} reasoning part(s)`
  );

  heading("5. Live: reasoning reaches the asker on its own channel");
  const liveStore = new InMemoryContentStore();
  const live = bootLive(liveStore);
  const { conversationId } = await live.conversations.start();
  const events2 = listen(live.hub, conversationId);
  await live.conversations.sendTurn(conversationId, "Was R-77 approved?");
  await until(
    async () => (await live.conversations.history(conversationId)).entries.length >= 2,
    "the reply"
  );
  const think = events2
    .filter((e) => e.type === "reasoning")
    .map((e) => (e as { text: string }).text);
  const text = events2.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text);
  console.log(`  reasoning events: ${JSON.stringify(think)}`);
  console.log(`  reply deltas:     ${JSON.stringify(text)}`);

  heading("6. The direct routed path discards reasoning: a warning, or a refusal");
  const direct = boot({ reasoning: { store: new InMemoryContentStore() }, direct: true });
  const dr = await review(direct, "direct-1");
  console.log(
    `  status=${dr.status}; loop warning: ${clip(direct.loopWarnings[0] ?? "(none)", 170)}`
  );
  console.log(
    `  reasoning parts sent back on turn 2: ${reasoningPartsIn(direct.model.requests[1] as never).length}`
  );
  const strict = boot({ direct: true, requireContinuation: true });
  await review(strict, "direct-2");
  console.log(
    `  requireReasoningContinuation: true -> ${strict.configErrors[0]?.name}: ${clip(strict.configErrors[0]?.message ?? "", 120)}`
  );
  resetAgentLoopDefaults();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
