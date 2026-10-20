import { unwrapTainted } from "@loom/classify";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { LLM_REASONING_CAPTURED, readReasoning } from "@loom/llm";
import type { ReasoningStepRead } from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { ReplayVM } from "@loom/replay-vm";
import { THOUGHTS } from "./model";
import { type Run, type World, boot, flowDef, review } from "./world";

export const everyThought = [...THOUGHTS];

/** Does the serialized log contain any readable reasoning text? (It must never.) */
export function logLeaks(events: readonly EventEnvelope[]): string[] {
  const log = JSON.stringify(events);
  return everyThought.filter((t) => log.includes(t));
}

/** Act 2: a captured run over a content store. */
export async function runCaptured(executionId = "exp-1") {
  const store = new InMemoryContentStore();
  const world = boot({ reasoning: { store } });
  const run = await review(world, executionId);
  return { store, world, run };
}

/** The auditor's read: join the events to their blobs, digest-checked. */
export function audit(world: World, store: InMemoryContentStore, executionId: string) {
  return readReasoning(world.app.stores.eventStore, store, { executionId });
}

/** Readable text of every part, unwrapped ONLY to print or assert (it is tainted data). */
export function textsOf(steps: ReasoningStepRead[]): string[] {
  return steps.flatMap((s) =>
    s.attempts.flatMap((a) =>
      a.parts.flatMap((p) => (p.text === undefined ? [] : [unwrapTainted(p.text)]))
    )
  );
}

/** Erase every captured blob of `run` from the sidecar (a retention schedule, or a data-subject request). */
export async function eraseReasoning(store: InMemoryContentStore, run: Run): Promise<number> {
  let n = 0;
  for (const e of run.events) {
    if (e.eventType !== LLM_REASONING_CAPTURED) continue;
    const parts = (e.payload as { parts: { ref?: string }[] }).parts;
    for (const p of parts) {
      if (p.ref === undefined) continue;
      await store.delete({ __loomContent: p.ref });
      n++;
    }
  }
  return n;
}

/**
 * Replay: a fresh process over a log that stops just before EXECUTION_COMPLETED (a crash after
 * the last step). Every step is served from the log, so the model is not called and the sidecar
 * is not read.
 */
export async function replayFromLog(run: Run) {
  const cut = run.events.findIndex((e) => e.eventType === "EXECUTION_COMPLETED");
  const prefix = run.events.slice(0, cut);
  const crashed = new InMemoryAsyncEventStore();
  for (const e of prefix) await crashed.append(e);
  const fresh = boot({ eventStore: crashed }); // no reasoning store at all: replay needs none
  const folded = new ReplayVM(prefix, {
    executionId: run.executionId,
    workflowId: flowDef.id,
    workflowVersion: flowDef.version,
  }).getState();
  const handle = await fresh.app.runtime.restoreFromState(folded);
  const state = await handle.waitForCompletion();
  const out = state.variables._output as { content?: string } | undefined;
  return { world: fresh, status: state.status, content: out?.content };
}

/** The recorded reasoning parts of the first model step (what the step VALUE holds). */
export function recordedParts(run: Run, turn = 0): Record<string, unknown>[] {
  const step = run.events.find(
    (e) =>
      e.eventType === "STEP_COMPLETED" &&
      (e.payload as { stepId?: string }).stepId?.endsWith(`#turn:${turn}:call:0`)
  );
  return ((step?.payload as { output?: { reasoning?: Record<string, unknown>[] } })?.output
    ?.reasoning ?? []) as Record<string, unknown>[];
}

/**
 * Hand the model effect a transcript whose assistant turn carries a reasoning part RECORDED BY
 * `fromRun`, but call it as `asExecution`. The sidecar is sealed to the capturing execution, so
 * under any other execution id the ref resolves to "not yours" and the part (and every one after
 * it) is dropped before the provider sees the request.
 */
export async function replayPartAs(
  world: World,
  fromRun: Run,
  asExecution: string
): Promise<{ sent: Record<string, unknown>[]; requests: number }> {
  const part = recordedParts(fromRun, 0)[0];
  const before = world.model.requests.length;
  const request = {
    messages: [
      { role: "user", content: "Review receipt R-77 and approve it if it is within policy." },
      {
        role: "assistant",
        content: [
          part,
          { type: "text", text: "Reading the receipt." },
          { type: "tool_use", id: "u0", name: "read_receipt", input: { id: "R-77" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "u0", content: "TOTAL 48.50" }],
      },
    ],
  };
  await world.app.effectRuntime.execute(
    "model:expense-model",
    request as never,
    {
      executionId: asExecution,
      stepId: `${asExecution}#turn:1:call:0`,
      workflowId: flowDef.id,
      attempt: 1,
      emit: () => undefined,
    } as never
  );
  const sent = world.model.requests.slice(before);
  const last = sent[sent.length - 1];
  return { sent: last === undefined ? [] : reasoningPartsOf(last), requests: sent.length };
}

function reasoningPartsOf(request: { messages: { content: unknown }[] }): Record<
  string,
  unknown
>[] {
  return request.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content.filter((p) => (p as { type?: string }).type === "reasoning") as Record<
          string,
          unknown
        >[])
      : []
  );
}
