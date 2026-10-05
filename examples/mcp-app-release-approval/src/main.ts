import type { SurfaceState } from "@loom/agent-surface";
import { McpClient } from "@loom/plugin-mcp";
import { SURFACE_HOST_URI, surfaceHostPin } from "@loom/plugin-mcp-app";
import { buildApp } from "./app";
import { RegisteredReleaseFlow } from "./flow";
import { RELEASE_SIGNAL } from "./flow";
import type { ReleaseInput, ReleaseSignal } from "./flow";
import { startHost } from "./host";
import { APP_CHANNEL_HEADER, DEMO_AUTH_HEADERS, buildMcpServer } from "./server";

// A Loom agent surface served as an MCP App, driven end to end: a real MCP server
// over HTTP, the real published template executed in jsdom as the View, and an
// approval gate that outlives the data it was rendered from.
async function main(): Promise<void> {
  const app = buildApp();
  const eventStore = app.stores.eventStore;
  const input: ReleaseInput = { releaseId: "rel-2026-08-08", title: "Checkout v4.2" };
  const executionId = input.releaseId;

  // The pin captured at "plan time". Serving verifies the template still hashes
  // to this — a drifted template throws instead of quietly rendering something
  // else than the run was planned against.
  const pin = surfaceHostPin();

  const server = buildMcpServer({
    runtime: app.runtime,
    eventStore,
    executionId,
    releaseId: input.releaseId,
    pin,
  });
  await server.start();

  console.log("\n⧖  MCP App — a Loom surface rendered by an MCP host");
  console.log(`   server   ${server.url}`);
  console.log(`   template ${SURFACE_HOST_URI}  pin=${pin}\n`);

  // ── 1. The flow runs and parks at the gate ─────────────────────────────────
  const handle = await app.runtime.start(RegisteredReleaseFlow, input, { executionId });
  await handle.waitForSuspend();
  console.log("── 1. Flow suspended at the approval gate ───────────────────────");

  // ── 2. Audience scoping ────────────────────────────────────────────────────
  // The model and a rendered View see DIFFERENT tool lists. The cursor is the
  // View's refresh channel, not a capability the agent should reason about.
  const asModel = new McpClient({ transport: "http", url: server.url, headers: DEMO_AUTH_HEADERS });
  const asApp = new McpClient({
    transport: "http",
    url: server.url,
    headers: { ...DEMO_AUTH_HEADERS, [APP_CHANNEL_HEADER]: "app" },
  });
  console.log("── 2. Audience-scoped tool lists ────────────────────────────────");
  console.log(
    `   model sees: ${(await asModel.listTools()).map((t) => t.definition.id).join(", ")}`
  );
  console.log(
    `   app   sees: ${(await asApp.listTools()).map((t) => t.definition.id).join(", ")}\n`
  );

  // ── 3. The host fetches the app and renders it ─────────────────────────────
  // Fetched over HTTP, pin recomputed client-side, then executed. The template is
  // never inlined here — this is the artifact the server actually publishes.
  const resource = await asApp.readUiResource(SURFACE_HOST_URI);
  if (resource?.text === undefined) throw new Error("no ui:// resource served");
  console.log("── 3. Host fetched the app ──────────────────────────────────────");
  console.log(`   ${resource.uri}  ${resource.mimeType}`);
  console.log(`   pin matches plan time: ${resource.contentHash === pin}\n`);

  const host = await startHost({
    serverUrl: server.url,
    template: resource.text,
    userGrant: "demo-grant",
  });

  // First paint: the host hands the View the tool result, exactly as it would
  // after the tool that opened this app completed.
  const first = await asApp.callToolResult("loom.surface.since", { executionId });
  host.deliverToolResult(first);
  await host.waitForPolls(1);
  console.log("── 4. View rendered (real template, in a DOM) ───────────────────");
  console.log(`   ${host.rendered().replace(/\s+/g, " ").trim()}\n`);

  // ── 5. The world moves while the human deliberates ─────────────────────────
  console.log("── 5. CI reports a failure while the gate is open ───────────────");
  const failure: ReleaseSignal = { kind: "check-failed", check: "e2e" };
  await app.runtime.resume(executionId, { eventType: RELEASE_SIGNAL, payload: failure });
  console.log("   surface advanced — anyone holding a rendered view is now behind\n");

  // ── 6. A stale approval ────────────────────────────────────────────────────
  // The View has not polled since the failure, so its `seenSequence` predates it.
  // The click is genuine — a real DOM button, dispatched by a real click.
  console.log("── 6. Approve clicked from a stale view ─────────────────────────");
  if (!host.clickApprove()) throw new Error("no Approve button rendered");
  await settle();
  const afterStale = surfaceOf(app, executionId);
  console.log(`   status  = ${afterStale.status}`);
  console.log(`   notice  = ${afterStale.notice}\n`);

  // ── 7. The View catches up on its own ──────────────────────────────────────
  // No server push exists, so the refresh is the View's own poll of the ambient
  // cursor — the mechanism that makes the stale state recoverable at all.
  console.log("── 7. View polls the cursor and catches up ──────────────────────");
  const before = host.pollCount();
  await host.waitForPolls(before + 2);
  console.log(`   ${host.rendered().replace(/\s+/g, " ").trim()}\n`);

  // ── 8. A fresh approval ────────────────────────────────────────────────────
  console.log("── 8. Approve clicked from the refreshed view ───────────────────");
  host.clickApprove();
  await settle();
  console.log(`   status = ${surfaceOf(app, executionId).status}`);
  const state = await app.runtime.loadState(executionId);
  console.log(`   result = ${JSON.stringify(state?.variables?._output ?? null)}\n`);

  await host.close();
  await server.stop();
  await app.close();
}

interface ReleaseSurface extends SurfaceState {
  status?: string;
  notice?: string;
}

/** Loom's NATIVE surface, folded from delta patches — the same state the View sees. */
function surfaceOf(app: ReturnType<typeof buildApp>, executionId: string): ReleaseSurface {
  return (app.projectionRuntime.getState<ReleaseSurface>("ui", executionId) ??
    {}) as ReleaseSurface;
}

/** Let the in-flight resume settle (the click is fire-and-forget from the DOM). */
function settle(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
