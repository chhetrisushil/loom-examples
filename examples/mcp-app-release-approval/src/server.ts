import type * as http from "node:http";
import type { EventStore } from "@loom/event-runtime";
import { createMcpServer } from "@loom/plugin-mcp";
import type { McpServedTool, McpServer } from "@loom/plugin-mcp";
import {
  SURFACE_HOST_URI,
  isStale,
  surfaceCursorTool,
  surfaceHostResource,
} from "@loom/plugin-mcp-app";
import type { WorkflowRuntime } from "@loom/workflow-runtime";
import { RELEASE_SIGNAL } from "./flow";
import type { ReleaseSignal } from "./flow";
import { RELEASE_VIEW } from "./view";

/** Header the demo host uses to identify itself as the app channel. */
export const APP_CHANNEL_HEADER = "x-loom-audience";

export interface ServerDeps {
  runtime: WorkflowRuntime;
  eventStore: EventStore;
  executionId: string;
  releaseId: string;
  /** The template pin captured at plan time — verified before the app is served. */
  pin: string;
}

/** Head sequence of the durable log — the number a client's claim is judged against. */
async function headSequence(store: EventStore, executionId: string): Promise<number> {
  const events = await store.read(executionId);
  return events.length === 0 ? 0 : (events[events.length - 1]?.sequence ?? 0);
}

/**
 * The Approve tool — `journaled`, because it appends a durable fact.
 *
 * This is where the untrusted claim meets the log. The View asserts "I was looking
 * at revision N"; only the server can say what the head actually is, so the
 * staleness VERDICT is computed here and the flow is handed the verdict plus both
 * numbers. Evidence at the boundary, policy in the flow.
 */
function approveTool(deps: ServerDeps): McpServedTool {
  return {
    name: "approve",
    description: "Approve the release currently on screen.",
    mode: "journaled",
    ui: { resourceUri: SURFACE_HOST_URI, visibility: ["model", "app"] },
    inputSchema: {
      type: "object",
      properties: {
        surfaceId: { type: "string" },
        action: { type: "string" },
        seenSequence: { type: "number" },
      },
    },
    async handler(args: unknown): Promise<unknown> {
      const input = (args ?? {}) as { seenSequence?: number };
      // Captured BEFORE the resume — resuming appends events and would move the
      // very head we are judging against.
      const head = await headSequence(deps.eventStore, deps.executionId);
      const stale = isStale(input, head);

      const signal: ReleaseSignal = {
        kind: "approval",
        approver: "mcp-app-view",
        stale,
        headSequence: head,
        ...(typeof input.seenSequence === "number" && { seenSequence: input.seenSequence }),
      };

      await deps.runtime.resume(deps.executionId, {
        eventType: RELEASE_SIGNAL,
        payload: signal,
      });

      return { accepted: !stale, stale, seenSequence: input.seenSequence, headSequence: head };
    },
  };
}

export function buildMcpServer(deps: ServerDeps): McpServer {
  return createMcpServer({
    port: 0,
    serverInfo: { name: "loom-release-approval", version: "1.0.0" },

    // The ui:// app, verified against the plan-time pin before it is ever served.
    // A drifted template would throw here rather than silently render different
    // markup than the run was planned against.
    resources: [surfaceHostResource({ pin: deps.pin })],

    tools: [
      // The View's refresh channel. `ambient` (never journaled — its call count is
      // driven by a human's polling) and app-only (the model never sees it).
      surfaceCursorTool({
        store: deps.eventStore,
        components: RELEASE_VIEW,
        // Required, never defaulted. Nothing on this surface is sensitive, so we
        // say so EXPLICITLY rather than letting an empty default mean "we forgot".
        redact: [],
        authorize: (executionId) => executionId === deps.executionId,
      }),
      approveTool(deps),
    ],

    // The extension gives the SERVER no in-band audience signal — the host is the
    // party that knows whether a call came from the model or a rendered View. So
    // the boundary is deployment-supplied. A real deployment would use a distinct
    // port or credential; the demo uses a header.
    audienceOf: (req: http.IncomingMessage) =>
      req.headers[APP_CHANNEL_HEADER] === "app" ? "app" : "model",

    // App-originated journaled calls are denied by default. Approving is a state
    // transition requested by the user's UI, so it needs its own authority rather
    // than inheriting the flow's — here, a token the host presents.
    authorizeAppJournaledCall: (_tool, req: http.IncomingMessage) =>
      req.headers["x-loom-user-grant"] === "demo-grant",
  });
}
