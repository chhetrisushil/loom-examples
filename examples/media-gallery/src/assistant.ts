import { agentLoop$, createAgentModelEffect, mediaResult } from "@loom/agent";
import { agent$, tool$ } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { EffectRuntime, ToolEffect } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { type LlmCapabilities, type LlmProvider, mediaTypeAccepted } from "@loom/llm";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner } from "@loom/workflow-runtime";
import { z } from "zod";
import { type Rgb, tinyPng } from "./png";
import type { MediaVault, StoredMedia } from "./vault";

// The loom half: an agent loop whose tool RETURNS media. The tool declares `returnsMedia: true` (without
// it the loop treats a media-shaped output as plain data, so a hostile tool result cannot choose which
// stored blob is fetched into the prompt). It stores the bytes, and the journaled output is the ADDRESS.

const PALETTE: Record<string, Rgb> = {
  red: [220, 40, 40],
  green: [40, 170, 70],
  blue: [40, 90, 220],
};

export const renderSwatch = tool$({
  id: "render_swatch",
  name: "Render swatch",
  description: "Render a solid-colour swatch image (red, green or blue)",
  kind: "tool",
  returnsMedia: true,
  inputSchema: z.object({ color: z.enum(["red", "green", "blue"]) }),
  outputSchema: z.object({}).passthrough(),
});

/** Looks an attachment up by name in a directory SHARED by every tenant: it can name anyone's address. */
export const openAttachment = tool$({
  id: "open_attachment",
  name: "Open attachment",
  description: "Open a stored attachment by name",
  kind: "tool",
  returnsMedia: true,
  inputSchema: z.object({ name: z.string() }),
  outputSchema: z.object({}).passthrough(),
});

const assistant = agent$({
  id: "gallery-assistant",
  name: "Gallery assistant",
  tools: [renderSwatch, openAttachment],
});

/**
 * What a media tool returns, given what the model on the other end can take. A model that did not declare
 * the type gets a text description (the alt text) instead of a ref it would be refused anyway: the
 * provider capability allowlist is checked, by the tool, before any bytes are fetched.
 */
export function mediaOrText(stored: StoredMedia, caps: LlmCapabilities | undefined, text: string) {
  return mediaTypeAccepted(caps?.image, stored.ref.mediaType)
    ? mediaResult([
        { type: "text", text },
        { type: "image", mediaType: stored.ref.mediaType, source: stored.source },
      ])
    : {
        description: `${text} (${stored.ref.mediaType}, ${stored.ref.size} bytes; shown as text, this model takes no images)`,
      };
}

const flowDef: FlowDefinition = {
  _tag: "FlowDefinition",
  id: "gallery-chat",
  name: "gallery-chat",
  version: "1.0.0",
  inputSchema: z.object({ prompt: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  steps: [],
};

export interface AssistantOptions {
  readonly vault: MediaVault;
  readonly provider: LlmProvider;
  /** Files the shared directory `open_attachment` reads (name -> stored). */
  readonly attachments?: ReadonlyMap<string, StoredMedia>;
  readonly eventStore?: InMemoryAsyncEventStore;
}

export function createAssistant(options: AssistantOptions) {
  const eventStore = options.eventStore ?? new InMemoryAsyncEventStore();
  const snapshotStore = new InMemoryAsyncSnapshotStore();
  const effects = new EffectRuntime();
  effects.register(
    "model",
    // The ONLY place bytes appear: fetched here, just before the provider call, through the vault's
    // authorizing resolver. A replayed call is served from the log and never reaches it.
    createAgentModelEffect(options.provider, { resolveContent: options.vault.resolveForModel })
  );
  effects.register(
    "render_swatch",
    new ToolEffect(async (input, ctx) => {
      const { color } = input as { color: string };
      const tenant = ctx.principal?.tenant ?? "nobody";
      const stored = await options.vault.put(
        tenant,
        tinyPng(PALETTE[color] ?? (PALETTE.red as Rgb)),
        {
          mediaType: "image/png",
          name: `${color}.png`,
          alt: `a solid ${color} swatch`,
        }
      );
      return mediaOrText(stored, options.provider.capabilities, `a solid ${color} swatch`);
    })
  );
  effects.register(
    "open_attachment",
    new ToolEffect(async (input, ctx) => {
      const { name } = input as { name: string };
      const stored = options.attachments?.get(name);
      if (stored === undefined) return { error: "no such attachment" };
      void ctx;
      return mediaOrText(stored, options.provider.capabilities, `attachment ${name}`);
    })
  );
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore,
    effectRuntime: effects,
  });
  const runner: FlowRunner<{ prompt: string }, { content: string }> = async (ctx, input) => {
    const out = await agentLoop$(
      ctx,
      { definition: assistant, modelToolId: "model", maxIterations: 4 },
      { prompt: input.prompt }
    );
    return { content: out.content };
  };
  runtime.registerFlow(flowDef, runner as FlowRunner<unknown, unknown>);

  return {
    eventStore,
    snapshotStore,
    runtime,
    /** Run one conversation AS `tenant`: the principal travels to every effect and to the content resolver. */
    async ask(tenant: string, prompt: string, executionId?: string) {
      const handle = await runtime.start(
        flowDef,
        { prompt },
        {
          principal: { tenant, actor: `${tenant}-user` },
          ...(executionId !== undefined && { executionId }),
        }
      );
      const outcome = await handle.waitForCompletion();
      return { executionId: handle.executionId, outcome };
    },
  };
}
