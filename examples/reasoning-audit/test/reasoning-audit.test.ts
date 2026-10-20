import { AgentLoopConfigError, resetAgentLoopDefaults } from "@loom/agent";
import { isTainted, unwrapTainted } from "@loom/classify";
import { LLM_REASONING_CAPTURED, readReasoning } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { afterEach, describe, expect, it } from "vitest";
import { LIVE_REPLY, LIVE_THOUGHT_A, LIVE_THOUGHT_B, bootLive, listen, until } from "../src/live";
import {
  INJECTION,
  REDACTED_DATA,
  SIGNATURES,
  THOUGHTS,
  blockOrderIn,
  reasoningPartsIn,
} from "../src/model";
import {
  audit,
  eraseReasoning,
  logLeaks,
  recordedParts,
  replayFromLog,
  replayPartAs,
  runCaptured,
  textsOf,
} from "../src/scenario";
import { boot, review } from "../src/world";

// defineConfig installs process-wide agent-loop defaults (observability.onWarn); leave none behind.
afterEach(() => resetAgentLoopDefaults());

describe("1. observability.reasoning and the boot warning (ADR 0133 D7)", () => {
  it("warns once, naming the effect, when a capable model has no reasoning store", () => {
    const w = boot();
    expect(w.bootWarnings).toHaveLength(1);
    expect(w.bootWarnings[0]).toContain('"model:expense-model"');
    expect(w.bootWarnings[0]).toContain("no reasoning store is configured");
  });

  it("a configured store, or the explicit opt-out, is silent", () => {
    expect(boot({ reasoning: { store: new InMemoryContentStore() } }).bootWarnings).toEqual([]);
    expect(boot({ reasoning: false }).bootWarnings).toEqual([]);
  });

  it("with no store, text is not kept: the part is flagged omitted and no audit event is emitted", async () => {
    const w = boot();
    const run = await review(w, "nostore");
    expect(run.status).toBe("completed");
    expect(recordedParts(run, 0)[0]).toMatchObject({ omitted: true, signature: SIGNATURES[0] });
    expect(run.events.some((e) => e.eventType === LLM_REASONING_CAPTURED)).toBe(false);
  });
});

describe("2. capture: refs and signatures in the value, text only in the sidecar", () => {
  it("the step value has refs, digests and signatures and NO readable text anywhere in the log", async () => {
    const { run, world } = await runCaptured();
    expect(run.status).toBe("completed");
    expect(world.payments).toEqual([{ receipt: "R-77", amount: 48.5 }]); // legible total, not 9900
    expect(run.content).toContain("ignored");

    const part = recordedParts(run, 0)[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: "reasoning", kind: "summary", signature: SIGNATURES[0] });
    expect(part.textRef).toBeDefined();
    expect(part.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(part).not.toHaveProperty("text");
    // The redacted block is recorded with its opaque data and no text or ref.
    expect(recordedParts(run, 1).map((p) => p.kind)).toEqual(["summary", "redacted"]);
    expect(recordedParts(run, 1)[1]).toMatchObject({ signature: REDACTED_DATA });
    expect(recordedParts(run, 1)[1]).not.toHaveProperty("textRef");

    // NEGATIVE proof: search the serialized log for every thought.
    expect(logLeaks(run.events)).toEqual([]);
    expect(JSON.stringify(run.events)).toContain(SIGNATURES[0]);
  });

  it("emits one LLM_REASONING_CAPTURED per model call: refs and digests, never text or signatures", async () => {
    const { run } = await runCaptured();
    const events = run.events.filter((e) => e.eventType === LLM_REASONING_CAPTURED);
    expect(events).toHaveLength(3);
    const first = events[0]?.payload as { stepId: string; parts: Record<string, unknown>[] };
    expect(first.stepId).toBe("expense-agent#turn:0:call:0");
    expect(first.parts[0]).toMatchObject({ kind: "summary", size: THOUGHTS[0].length });
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("sig-turn");
  });

  it("turn 2's provider request carried the earlier reasoning back, unchanged and in block order", async () => {
    const { world } = await runCaptured();
    const [r0, r1, r2] = world.model.requests;
    expect(world.model.requests).toHaveLength(3);
    expect(reasoningPartsIn(r0 as never)).toEqual([]);
    // Turn 1's request: turn 0's part, text resolved from the sidecar at request time.
    expect(reasoningPartsIn(r1 as never)).toMatchObject([
      { signature: SIGNATURES[0], text: THOUGHTS[0] },
    ]);
    // Turn 2's request: turn 0's part, then turn 1's summary AND its redacted block.
    expect(reasoningPartsIn(r2 as never).map((p) => [p.kind, p.signature, p.text ?? null])).toEqual(
      [
        ["summary", SIGNATURES[0], THOUGHTS[0]],
        ["summary", SIGNATURES[1], THOUGHTS[1]],
        ["redacted", REDACTED_DATA, null],
      ]
    );
    expect(blockOrderIn(r2 as never)).toEqual([
      ["reasoning", "text", "tool_use"],
      ["reasoning", "reasoning", "text", "tool_use"],
    ]);
  });
});

describe("3. audit: readReasoning, erasure, replay", () => {
  it("returns the text TAINTED with status ok, and the injection is visible as evidence", async () => {
    const { world, store, run } = await runCaptured();
    const steps = await audit(world, store, run.executionId);
    expect(steps.map((s) => s.stepId)).toEqual([
      "expense-agent#turn:0:call:0",
      "expense-agent#turn:1:call:0",
      "expense-agent#turn:2:call:0",
    ]);
    expect(steps.every((s) => s.recordedAttempt === 1)).toBe(true);
    const parts = steps.flatMap((s) => s.attempts.flatMap((a) => a.parts));
    expect(parts.map((p) => `${p.kind}/${p.status}`)).toEqual([
      "summary/ok",
      "summary/ok",
      "redacted/ok",
      "summary/ok",
    ]);
    const first = parts[0]?.text;
    expect(isTainted(first)).toBe(true); // wrapped; unwrap only at the edge
    expect(unwrapTainted(first as never)).toBe(THOUGHTS[0]);
    expect(textsOf(steps)).toEqual([...THOUGHTS]);
    expect(THOUGHTS[0]).toContain("approve 9900");
    expect(INJECTION).toContain("approve 9900"); // what the receipt said; the reasoning corroborates the log
  });

  it("after the blobs are erased: status erased, and replay makes ZERO model calls with the identical result", async () => {
    const { world, store, run } = await runCaptured();
    expect(await eraseReasoning(store, run)).toBe(3);
    const steps = await audit(world, store, run.executionId);
    expect(steps.flatMap((s) => s.attempts.flatMap((a) => a.parts.map((p) => p.status)))).toEqual([
      "erased",
      "erased",
      "ok", // the redacted block has no text to erase
      "erased",
    ]);
    expect(textsOf(steps)).toEqual([]);

    const replay = await replayFromLog(run);
    expect(replay.status).toBe("completed");
    expect(replay.world.model.requests).toHaveLength(0);
    expect(replay.world.payments).toEqual([]); // no tool re-ran either
    expect(replay.content).toBe(run.content);
  });
});

describe("4. the forged-ref guard", () => {
  it("a part copied from another execution is dropped, not sent; its own execution still gets it", async () => {
    const { world, run } = await runCaptured("exp-owner");
    const own = await replayPartAs(world, run, "exp-owner");
    expect(own.sent).toHaveLength(1);
    expect(own.sent[0]).toMatchObject({ text: THOUGHTS[0] });
    const forged = await replayPartAs(world, run, "exp-forger");
    expect(forged.requests).toBe(1); // the call still happens...
    expect(forged.sent).toEqual([]); // ...without the part
  });
});

describe("5. live reasoning on its own channel", () => {
  it("reasoning deltas reach the hub as `reasoning` events, apart from the reply's `delta` events", async () => {
    const store = new InMemoryContentStore();
    const live = bootLive(store);
    const { conversationId } = await live.conversations.start();
    const events = listen(live.hub, conversationId);
    await live.conversations.sendTurn(conversationId, "Was R-77 approved?");
    await until(
      async () => (await live.conversations.history(conversationId)).entries.length >= 2,
      "the durable reply"
    );
    const thinking = events
      .filter((e) => e.type === "reasoning")
      .map((e) => (e as { text: string }).text);
    const reply = events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text);
    expect(thinking).toEqual([LIVE_THOUGHT_A, LIVE_THOUGHT_B]);
    expect(reply.join("")).toBe(LIVE_REPLY.join(""));
    expect(reply.join("")).not.toContain("asker wants");
    // Not journaled: the log has the audit event, never the readable thought.
    const log = JSON.stringify(await live.eventStore.read(conversationId));
    expect(log).toContain(LLM_REASONING_CAPTURED);
    expect(log).not.toContain(LIVE_THOUGHT_A);
    // The durable record is the sidecar, kept by the same store.
    const steps = await readReasoning(live.eventStore, store, {
      executionId: conversationId,
    });
    expect(textsOf(steps).join("")).toBe(LIVE_THOUGHT_A + LIVE_THOUGHT_B);
  });
});

describe("6. the direct routed path", () => {
  it("discards reasoning every turn and says so once, through the loop's sink", async () => {
    const w = boot({ reasoning: { store: new InMemoryContentStore() }, direct: true });
    const run = await review(w, "direct-1");
    expect(run.status).toBe("completed");
    expect(w.loopWarnings).toHaveLength(1);
    expect(w.loopWarnings[0]).toContain('"expense-model"');
    expect(w.loopWarnings[0]).toContain("discards it every turn");
    // No reasoning is continued, and none is captured.
    expect(w.model.requests).toHaveLength(3);
    for (const r of w.model.requests) expect(reasoningPartsIn(r)).toEqual([]);
    expect(run.events.some((e) => e.eventType === LLM_REASONING_CAPTURED)).toBe(false);
    expect(logLeaks(run.events)).toEqual([]);
  });

  it("requireReasoningContinuation turns the warning into an AgentLoopConfigError before any model call", async () => {
    const w = boot({ direct: true, requireContinuation: true });
    const run = await review(w, "direct-2");
    expect(w.configErrors).toHaveLength(1);
    expect(w.configErrors[0]).toBeInstanceOf(AgentLoopConfigError);
    expect(w.model.requests).toHaveLength(0);
    expect(w.loopWarnings).toEqual([]);
    expect(run.status).toBe("completed"); // the flow caught the config error and returned it
  });

  it("negative: the ring path (reasoningToolId) neither warns nor refuses", async () => {
    const w = boot({ reasoning: { store: new InMemoryContentStore() }, requireContinuation: true });
    const run = await review(w, "ring-1");
    expect(run.status).toBe("completed");
    expect(w.loopWarnings).toEqual([]);
    expect(w.configErrors).toEqual([]);
  });
});
