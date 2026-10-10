import { createAgentModelEffect } from "@loom/agent";
import { unwrapTainted } from "@loom/classify";
import {
  ConversationHub,
  conversation$,
  createConversations,
  inboxBargeIn,
} from "@loom/conversation";
import { agent$ } from "@loom/core";
import { EffectRuntime, type PrincipalChain, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { textOf } from "@loom/llm";
import { createConversationSseServer } from "@loom/plugin-conversation-sse";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import { type ScriptedModel, scriptedModel } from "./model";

/** Bearer token -> principal: the stand-in for a real verifier. Two tenants, one user each. */
export const alice: PrincipalChain = { actor: "alice", tenant: "acme" };
export const mallory: PrincipalChain = { actor: "mallory", tenant: "globex" };
export const TOKENS: Record<string, PrincipalChain> = {
  "tok-alice": alice,
  "tok-mallory": mallory,
};

/** Signs every inbox envelope: the conversation body acts only on what the host's client signed. */
const ENVELOPE_KEY = "chat-agent-demo-envelope-key";

/** The durable half of the app. A "process restart" is a new `startChat` over the SAME `Stores`. */
export interface Stores {
  eventStore: InMemoryAsyncEventStore;
  snapshotStore: InMemoryAsyncSnapshotStore;
}
export const newStores = (): Stores => ({
  eventStore: new InMemoryAsyncEventStore(),
  snapshotStore: new InMemoryAsyncSnapshotStore(),
});

export interface ChatOptions {
  stores?: Stores;
  /** The model's context window in tokens (tiny on purpose in the demo). */
  contextWindow?: number;
  /** A generation is rotated (continue-as-new) after this many turns. */
  rotateEveryTurns?: number;
}

export async function startChat(opts: ChatOptions = {}) {
  const stores = opts.stores ?? newStores();
  const model: ScriptedModel = scriptedModel();
  const hub = new ConversationHub();
  const effects = new EffectRuntime([]);
  effects.register(
    "model",
    createAgentModelEffect(hub.wrapProvider(model.provider), {
      stream: true,
      onDelta: hub.deltaSink(), // live tokens, attributed to the turn that is running the call
    })
  );
  // Evicted turns are folded into a rolling summary. Offline: a tiny extractive "summarizer".
  effects.register(
    "summarize",
    new ToolEffect(async (input: unknown) => {
      const { messages } = input as { messages: { content: unknown }[] };
      // The conversation hands the summarizer the user's words TAINTED ({ __loomTainted, value }),
      // which is not a string-or-parts, so `textOf` on the raw content throws. A summarizer unwraps
      // (it is the one place that may), then reads the content with `textOf`.
      const said = messages.map((m) =>
        textOf(unwrapTainted(m.content) as Parameters<typeof textOf>[0])
          .replace(/\s+/g, " ")
          .slice(0, 24)
      );
      return { summary: `earlier: ${said.join(" | ")}`.slice(0, 160) };
    })
  );

  // The conversation's log holds the unfiltered transcript, so the runtime policy is OWNER-scoped.
  const policy = executionAccessPolicy({
    rules: { query: "owner", send: "owner", cancel: "owner", resume: "owner" },
  });
  const runtime = new WorkflowRuntime({
    eventStore: stores.eventStore,
    snapshotStore: stores.snapshotStore,
    effectRuntime: effects,
    timerStore: new InMemoryTimerStore(),
    inboxEnabled: true,
    continueAsNewEnabled: true,
    divergence: "fail",
    executionAuthorizer: policy,
    executionAuthz: { requirePrincipal: true },
  });
  const chat = conversation$({
    key: ENVELOPE_KEY,
    agent: {
      definition: agent$({ id: "assistant", name: "Assistant", tools: [] }),
      modelToolId: "model",
    },
    budget: {
      contextWindow: opts.contextWindow ?? 400,
      reserveOutputTokens: 0,
      summarizerToolId: "summarize",
    },
    rotateEveryTurns: opts.rotateEveryTurns ?? 4,
    bargeIn: inboxBargeIn(stores.eventStore), // a new message interrupts the running turn
    hub,
  });
  runtime.registerFlow(chat.definition, chat.runner);
  const conversations = createConversations({
    runtime,
    eventStore: stores.eventStore,
    flow: chat,
    policy,
  });
  const server = createConversationSseServer({
    conversations,
    hub,
    eventStore: stores.eventStore,
    port: 0,
    authenticate: (req) => {
      const h = req.headers.authorization;
      return h?.startsWith("Bearer ") ? TOKENS[h.slice(7)] : undefined;
    },
  });
  await server.start();
  return { url: server.url, stop: () => server.stop(), stores, model, conversations, runtime };
}
export type Chat = Awaited<ReturnType<typeof startChat>>;
