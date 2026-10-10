// The incident war room: ONE conversation shared by several responders (loom R17, ADR 0122 D10).
//
// Everything a host has to decide lives in this file, and nothing else does:
//   - WHO the participants are (the owner invites them over HTTP; a stranger is a uniform 404),
//   - WHAT each tool's data class is (`classOf`) and WHO is cleared for a class (`cleared`),
//   - WHAT each responder may CALL (the grant table: a turn runs AS ITS ASKER, so these are per person),
//   - the SERVICE principal that owns the coordinating execution (no human can `query` its raw log),
//   - the OWNER-SCOPED runtime policy `createConversations` asserts at construction,
//   - the HMAC key every inbox envelope is signed under.
import { createAgentModelEffect } from "@loom/agent";
import {
  type ConversationConfig,
  ConversationHub,
  type Conversations,
  type Identity,
  conversation$,
  createConversations,
  inboxBargeIn,
  logParticipants,
  sameIdentity,
} from "@loom/conversation";
import { agent$, tool$ } from "@loom/core";
import { EffectRuntime, GrantTable, ToolEffect } from "@loom/effect-runtime";
import type { PrincipalChain } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { LlmMessage, LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";
import { textOf } from "@loom/llm";
import { createConversationSseServer } from "@loom/plugin-conversation-sse";
import type { ConversationSseServer } from "@loom/plugin-conversation-sse";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime, executionAccessPolicy } from "@loom/workflow-runtime";
import { z } from "zod";

// ── people ──────────────────────────────────────────────────────────────────────────────────────
/** The incident commander: starts the room, owns it, is cleared for customer data. */
export const ada: PrincipalChain = { actor: "ada", tenant: "sre" };
/** The database responder: cleared for customer data. */
export const ben: PrincipalChain = { actor: "ben", tenant: "dba" };
/** The comms responder: NOT cleared for customer data, and has no grant on the export tool. */
export const cleo: PrincipalChain = { actor: "cleo", tenant: "comms" };
/** A DIFFERENT person who happens to share Ada's actor name in another tenant: NOT cleared. */
export const adaOther: PrincipalChain = { actor: "ada", tenant: "ext" };
/** Authenticated, but never invited. */
export const mallory: PrincipalChain = { actor: "mallory", tenant: "ext" };
/** Owns every coordinating execution. No end-user identity may equal it. */
export const SERVICE: PrincipalChain = { actor: "incident-service", tenant: "svc" };

// DEMO ONLY: load from a secret manager; loom requires >= 8 characters and supports previousKeys for rotation.
export const TOKENS: Readonly<Record<string, PrincipalChain>> = {
  "tok-ada": ada,
  "tok-ben": ben,
  "tok-cleo": cleo,
  "tok-mallory": mallory,
  "tok-ada-other": adaOther,
};

export const identityOf = (p: PrincipalChain): Identity => ({
  actor: p.actor as string,
  ...(p.tenant !== undefined && { tenant: p.tenant }),
});

// ── data classes ────────────────────────────────────────────────────────────────────────────────
export const PUBLIC = "public";
export const CUSTOMER_PII = "customer-pii";
/** The value the classified tool returns: it must never reach a viewer or a model context that is not cleared. */
export const PII_MARKER = "ACME-4417 ops@acme.example";

const runbookTool = tool$({
  id: "runbook-search",
  name: "runbook-search",
  description: "search the incident runbooks (public to every responder)",
  kind: "tool",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.any(),
});
const customerExport = tool$({
  id: "customer-export",
  name: "customer-export",
  description: "export the affected customers (customer-pii)",
  kind: "tool",
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.any(),
});

/** The host's class map. A tool it does not know is `unclassified`, which nobody but the asker is cleared for. */
const classOf = (tool: string): string | undefined =>
  tool === "runbook-search" ? PUBLIC : tool === "customer-export" ? CUSTOMER_PII : undefined;
/** Fail closed: a label this function does not recognise is `false`. Must return exactly `true` to clear. */
const PII_CLEARED: readonly Identity[] = [identityOf(ada), identityOf(ben)];
const cleared = (viewer: Identity, classes: readonly string[]): boolean =>
  classes.every(
    (c) =>
      c === PUBLIC || (c === CUSTOMER_PII && PII_CLEARED.some((who) => sameIdentity(who, viewer)))
  );

// ── the scripted, deterministic model ──────────────────────────────────────────────────────────
const fenced = /<untrusted-input[^>]*>([\s\S]*?)<\/untrusted-input>/;
/** The user's words for this turn, with the prompt-boundary fence taken off. */
export function lastUserText(request: LlmRequest): string {
  const last = request.messages[request.messages.length - 1] as LlmMessage;
  const text = textOf(last.content);
  return (fenced.exec(text)?.[1] ?? text).trim();
}
const hasToolResult = (m: LlmMessage): boolean =>
  Array.isArray(m.content) && m.content.some((p) => p.type === "tool_result");

/**
 * No API key, no network. A turn that mentions "customer" calls the classified tool, one that mentions
 * "runbook" calls the public one, anything else is answered from what the model was GIVEN: it counts the
 * earlier messages in its context, which is how a per-viewer context shows up in the output.
 */
export function incidentModel(request: LlmRequest): LlmResponse {
  const last = request.messages[request.messages.length - 1] as LlmMessage;
  if (hasToolResult(last)) {
    return { content: `Result: ${textOf(last.content)}`, stopReason: "end_turn" };
  }
  const text = lastUserText(request);
  const tool = /export/i.test(text)
    ? "customer-export"
    : /runbook/i.test(text)
      ? "runbook-search"
      : undefined;
  if (tool !== undefined) {
    return {
      content: "",
      toolCalls: [{ id: `call-${tool}`, name: tool, input: {} }],
      stopReason: "tool_use",
    };
  }
  const earlier = request.messages.length - 1;
  return {
    content: `Noted. I can see ${earlier} earlier message${earlier === 1 ? "" : "s"} in this room.`,
    stopReason: "end_turn",
  };
}

// ── the room ────────────────────────────────────────────────────────────────────────────────────
// DEMO ONLY: load from a secret manager; loom requires >= 8 characters and supports previousKeys for rotation.
export const ENVELOPE_KEY = "incident-room-envelope-key";

export interface RoomOptions {
  /** Wrap the scripted model, e.g. to hold a turn open (tests). */
  model?: (request: LlmRequest, scripted: LlmResponse) => LlmResponse | Promise<LlmResponse>;
  /** The conversation's clock for stamping envelopes (tests drive freshness with it). */
  now?: () => number;
  config?: Partial<ConversationConfig>;
  /** Options passed straight to `createConversations`. */
  conversations?: Record<string, unknown>;
  /** The execution policy the runtime is built with (default: the OWNER-scoped reference policy). */
  policy?: ReturnType<typeof executionAccessPolicy>;
}

export async function openRoom(options: RoomOptions = {}) {
  const requests: LlmRequest[] = [];
  const provider: LlmProvider = {
    async complete(request) {
      requests.push(request);
      const scripted = incidentModel(request);
      return (await options.model?.(request, scripted)) ?? scripted;
    },
  };
  const hub = new ConversationHub();
  // A turn runs AS ITS ASKER, so these grants are per PERSON. The service principal only coordinates.
  const effects = new EffectRuntime([], {
    authorizer: new GrantTable(
      {
        "incident-service": ["conversation.turn"],
        ada: ["model", "runbook-search", "customer-export"],
        ben: ["model", "runbook-search", "customer-export"],
        cleo: ["model", "runbook-search"],
      },
      { principal: (req) => req.principal?.actor ?? req.workflowId }
    ),
  });
  effects.register(
    "runbook-search",
    new ToolEffect(async () => ({ runbook: "failover-checklist-v3" }))
  );
  effects.register("customer-export", new ToolEffect(async () => ({ customers: PII_MARKER })));
  effects.register("model", createAgentModelEffect(hub.wrapProvider(provider), { stream: false }));

  const eventStore = new InMemoryAsyncEventStore();
  // OWNER-scoped: the coordinator's log holds every unfiltered answer, so nobody but its owner (the
  // service) may query/send/cancel/resume it. `createConversations` REFUSES a looser policy.
  const policy =
    options.policy ??
    executionAccessPolicy({
      rules: { query: "owner", send: "owner", cancel: "owner", resume: "owner" },
    });
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: effects,
    timerStore: new InMemoryTimerStore(),
    inboxEnabled: true,
    continueAsNewEnabled: true,
    divergence: "fail",
    executionAuthorizer: policy,
    executionAuthz: { requirePrincipal: true },
  });

  const flow = conversation$({
    key: ENVELOPE_KEY,
    agent: {
      definition: agent$({
        id: "incident-assistant",
        name: "Incident assistant",
        tools: [runbookTool, customerExport],
      }),
      modelToolId: "model",
    },
    hub,
    bargeIn: inboxBargeIn(eventStore),
    shared: {
      servicePrincipal: SERVICE,
      directory: logParticipants(eventStore),
      classOf,
      cleared,
    },
    ...options.config,
  });
  runtime.registerFlow(flow.definition, flow.runner);

  const conversations: Conversations = createConversations({
    runtime,
    eventStore,
    flow,
    effects,
    policy,
    ...(options.now !== undefined && { now: options.now }),
    ...options.conversations,
  });

  const server: ConversationSseServer = createConversationSseServer({
    conversations,
    hub,
    eventStore,
    authenticate: (req) => {
      const h = req.headers.authorization;
      return h?.startsWith("Bearer ") ? TOKENS[h.slice(7)] : undefined;
    },
    port: 0, // an ephemeral port: nothing to collide with, nothing left listening
  });
  await server.start();
  return {
    url: server.url,
    server,
    conversations,
    runtime,
    eventStore,
    requests,
    close: () => server.stop(),
  };
}
export type Room = Awaited<ReturnType<typeof openRoom>>;
