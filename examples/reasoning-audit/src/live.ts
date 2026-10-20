import { createAgentModelEffect } from "@loom/agent";
import {
  ConversationHub,
  type LiveEvent,
  conversation$,
  createConversations,
  inboxBargeIn,
} from "@loom/conversation";
import { agent$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { LlmProvider, LlmRequest, LlmStreamChunk } from "@loom/llm";
import { textOf } from "@loom/llm";
import type { InMemoryContentStore } from "@loom/plugin-content";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import { PROVIDER } from "./model";

/** What a streaming Anthropic-shaped model "thinks" while it answers, in two increments. */
export const LIVE_THOUGHT_A = "The asker wants to know if R-77 was approved. ";
export const LIVE_THOUGHT_B = "The log says 48.50 was approved; I will say so plainly.";
export const LIVE_REPLY = ["R-77 was ", "approved for 48.50."];

/** A streaming provider: reasoning deltas and reply deltas interleaved, then the terminal chunk. */
export function thinkingStream(): LlmProvider {
  return {
    capabilities: { reasoning: true },
    async complete() {
      throw new Error("this provider is only used streamed");
    },
    async *stream(_request: LlmRequest): AsyncGenerator<LlmStreamChunk> {
      yield { delta: "", done: false, reasoningDelta: LIVE_THOUGHT_A };
      yield { delta: LIVE_REPLY[0] as string, done: false };
      yield { delta: "", done: false, reasoningDelta: LIVE_THOUGHT_B };
      yield { delta: LIVE_REPLY[1] as string, done: false };
      yield {
        delta: "",
        done: true,
        stopReason: "end_turn",
        reasoning: [
          {
            kind: "summary",
            text: LIVE_THOUGHT_A + LIVE_THOUGHT_B,
            signature: "sig-live-1",
            provider: PROVIDER,
          },
        ],
      };
    },
  };
}

/** Wait on a condition (never a fixed sleep). */
export async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 20_000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * A conversation whose model streams. `hub.reasoningSink()` is the live reasoning sink: the effect
 * hands it each increment still wrapped as untrusted content, and the hub unwraps it at ITS edge
 * and publishes it as a `reasoning` event, a channel apart from the reply's `delta` events.
 */
export function bootLive(store: InMemoryContentStore) {
  const hub = new ConversationHub();
  const effects = new EffectRuntime([]);
  effects.register(
    "model",
    createAgentModelEffect(hub.wrapProvider(thinkingStream()), {
      stream: true,
      onDelta: hub.deltaSink(),
      reasoning: { store, live: true, onDelta: hub.reasoningSink() },
    })
  );
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore: new InMemoryTimerStore(),
    inboxEnabled: true,
    continueAsNewEnabled: true,
    divergence: "fail",
  });
  const chat = conversation$(
    {
      key: "reasoning-audit-demo-envelope-key",
      agent: {
        definition: agent$({ id: "assistant", name: "Assistant", tools: [] }),
        modelToolId: "model",
      },
      hub,
      bargeIn: inboxBargeIn(eventStore),
    },
    { id: "conversation" }
  );
  runtime.registerFlow(chat.definition, chat.runner);
  const conversations = createConversations({
    runtime,
    eventStore,
    flow: chat,
    runtimePolicyIsOwnerScoped: true,
  });
  return { hub, conversations, eventStore };
}

export type Live = ReturnType<typeof bootLive>;

/** Subscribe to a conversation's live events (reasoning and reply text are different event types). */
export function listen(hub: ConversationHub, conversationId: string): LiveEvent[] {
  const got: LiveEvent[] = [];
  hub.subscribe(conversationId, (e) => got.push(e));
  return got;
}

export { textOf };
