import type { SurfaceState } from "@loom/agent-surface";
import { McpClient } from "@loom/plugin-mcp";
import { SURFACE_HOST_URI, surfaceHostPin } from "@loom/plugin-mcp-app";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app";
import { RELEASE_SIGNAL, RegisteredReleaseFlow } from "../src/flow";
import type { ReleaseSignal } from "../src/flow";
import { startHost } from "../src/host";
import type { McpAppHost } from "../src/host";
import { APP_CHANNEL_HEADER, buildMcpServer } from "../src/server";

interface Harness {
  app: ReturnType<typeof buildApp>;
  server: Awaited<ReturnType<typeof buildMcpServer>>;
  host: McpAppHost;
  asApp: McpClient;
  asModel: McpClient;
  executionId: string;
  surface(): SurfaceState & { status?: string; notice?: string };
  close(): Promise<void>;
}

async function harness(opts: { userGrant?: string } = {}): Promise<Harness> {
  const app = buildApp();
  const executionId = "rel-test";
  const server = buildMcpServer({
    runtime: app.runtime,
    eventStore: app.stores.eventStore,
    executionId,
    releaseId: executionId,
    pin: surfaceHostPin(),
  });
  await server.start();

  const handle = await app.runtime.start(
    RegisteredReleaseFlow,
    { releaseId: executionId, title: "Checkout v4.2" },
    { executionId }
  );
  await handle.waitForSuspend();

  // The app-channel client mirrors what the HOST presents: audience header, plus
  // the user grant when the deployment has one. Without the grant, journaled
  // calls are denied — which is the point of several tests below.
  const asApp = new McpClient({
    transport: "http",
    url: server.url,
    headers: {
      [APP_CHANNEL_HEADER]: "app",
      ...(opts.userGrant !== undefined && { "x-loom-user-grant": opts.userGrant }),
    },
  });
  const asModel = new McpClient({ transport: "http", url: server.url });

  const resource = await asApp.readUiResource(SURFACE_HOST_URI);
  const host = await startHost({
    serverUrl: server.url,
    template: resource?.text ?? "",
    ...(opts.userGrant !== undefined && { userGrant: opts.userGrant }),
  });
  host.deliverToolResult(await asApp.callToolResult("loom.surface.since", { executionId }));
  await host.waitForPolls(1);

  return {
    app,
    server,
    host,
    asApp,
    asModel,
    executionId,
    surface: () =>
      (app.projectionRuntime.getState<SurfaceState>("ui", executionId) ?? {}) as SurfaceState & {
        status?: string;
      },
    async close() {
      await host.close();
      await server.stop();
      await app.close();
    },
  };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("the app is a real MCP App", () => {
  it("serves the pinned template, and the client recomputes the same pin", async () => {
    h = await harness();
    const resource = await h.asApp.readUiResource(SURFACE_HOST_URI);
    expect(resource?.mimeType).toBe("text/html;profile=mcp-app");
    // The plan-time pin equals what a reader recomputes — that equality is the
    // whole value of the pin, and it only holds because both sides hash the same way.
    expect(resource?.contentHash).toBe(surfaceHostPin());
  });

  it("scopes tool listings by audience", async () => {
    h = await harness();
    expect((await h.asModel.listTools()).map((t) => t.definition.id)).toEqual(["approve"]);
    // The cursor is the View's refresh channel, not a capability the model reasons about.
    expect((await h.asApp.listTools()).map((t) => t.definition.id)).toContain("loom.surface.since");
  });

  it("hides the app-only cursor from the model entirely", async () => {
    h = await harness();
    // Reported as unknown rather than forbidden — a refusal would confirm it exists.
    await expect(
      h.asModel.callTool("loom.surface.since", { executionId: h.executionId })
    ).rejects.toThrow(/unknown tool/);
  });
});

describe("the View is the real template, executed", () => {
  it("renders the surface, including a data-bound list", async () => {
    h = await harness();
    const rendered = h.host.rendered();
    expect(rendered).toContain("Checkout v4.2");
    expect(rendered).toContain("awaiting-approval");
    // The list regression: `list()` emits `children: {path, componentId}`, and a
    // template reading a non-existent `items` prop rendered nothing here.
    expect(rendered).toContain("build ✓");
    expect(rendered).toContain("lint ✓");
  });

  it("polls the cursor on its own — there is no server push", async () => {
    h = await harness();
    const before = h.host.pollCount();
    await h.host.waitForPolls(before + 2);
    expect(h.host.pollCount()).toBeGreaterThan(before);
  });

  it("picks up surface changes through its own poll", async () => {
    h = await harness();
    const failure: ReleaseSignal = { kind: "check-failed", check: "e2e" };
    await h.app.runtime.resume(h.executionId, { eventType: RELEASE_SIGNAL, payload: failure });

    const before = h.host.pollCount();
    await h.host.waitForPolls(before + 2);
    expect(h.host.rendered()).toContain("e2e ✗");
  });
});

describe("decision provenance across the gate", () => {
  it("refuses an approval made against a stale surface", async () => {
    h = await harness({ userGrant: "demo-grant" });

    // The world moves while the View is not looking.
    await h.app.runtime.resume(h.executionId, {
      eventType: RELEASE_SIGNAL,
      payload: { kind: "check-failed", check: "e2e" } satisfies ReleaseSignal,
    });

    // A genuine click from a DOM that has not refreshed.
    expect(h.host.clickApprove()).toBe(true);
    await settle();

    const surface = h.surface();
    expect(surface.status).toBe("re-review");
    expect(String(surface.notice)).toMatch(/Please re-review/);
  });

  it("accepts the approval once the View has caught up", async () => {
    h = await harness({ userGrant: "demo-grant" });
    await h.app.runtime.resume(h.executionId, {
      eventType: RELEASE_SIGNAL,
      payload: { kind: "check-failed", check: "e2e" } satisfies ReleaseSignal,
    });

    h.host.clickApprove();
    await settle();
    expect(h.surface().status).toBe("re-review");

    // The View refreshes itself, then the same click carries current provenance.
    const before = h.host.pollCount();
    await h.host.waitForPolls(before + 2);
    h.host.clickApprove();
    await settle(500);

    expect(h.surface().status).toBe("shipped");
    const state = await h.app.runtime.loadState(h.executionId);
    expect((state?.variables?._output as { shipped?: boolean } | undefined)?.shipped).toBe(true);
  });

  // The seam that makes any of this checkable: without provenance the server
  // cannot distinguish a considered approval from a stale one.
  it("treats an approval carrying no provenance as stale", async () => {
    h = await harness({ userGrant: "demo-grant" });
    const result = await h.asApp.callTool("approve", {});
    expect(result).toMatchObject({ accepted: false, stale: true });
  });
});

describe("the journaled/ambient boundary at the surface", () => {
  it("denies an app-originated journaled call without a user grant", async () => {
    h = await harness(); // no userGrant
    const denied = await h.asApp.callToolResult("approve", { seenSequence: 999 });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toMatch(/journaled/);
  });

  it("admits it when the host presents the grant", async () => {
    h = await harness({ userGrant: "demo-grant" });
    const ok = await h.asApp.callToolResult("approve", { seenSequence: 999 });
    expect(ok.isError).not.toBe(true);
  });

  it("refuses a cursor read for an execution the caller may not see", async () => {
    h = await harness();
    // Same wording as an absent surface — a distinct refusal would confirm the id.
    await expect(
      h.asApp.callTool("loom.surface.since", { executionId: "someone-elses" })
    ).rejects.toThrow(/no surface for execution/);
  });
});

// ── K12: the approval gate is closed by the KERNEL, not by convention ────────
//
// `src/server.ts` stamps the approver itself, so a View cannot forge one — but
// that is a property of one code path. These assert the property that survives
// somebody adding a second one.
describe("the resume authenticator", () => {
  it("refuses an approval that did not come from the trust boundary", async () => {
    const h = await harness();
    const forged: ReleaseSignal = {
      kind: "approval",
      approver: "not-the-view",
      stale: false,
      headSequence: 0,
    };
    await expect(
      h.app.runtime.resume(h.executionId, { eventType: RELEASE_SIGNAL, payload: forged })
    ).rejects.toThrow(/may not approve/);
    await h.close();
  });

  it("leaves CI's check-failed signal alone — it carries no authority claim", async () => {
    // `not-applicable`, not `rejected`: treating a non-approval as a failed
    // approval would break a legitimate path.
    const h = await harness();
    const check: ReleaseSignal = { kind: "check-failed", check: "e2e" };
    await expect(
      h.app.runtime.resume(h.executionId, { eventType: RELEASE_SIGNAL, payload: check })
    ).resolves.toBeDefined();
    await h.close();
  });
});

describe("the approval log is tamper-evident", () => {
  // The K12 authenticator decides whether an approval is ACCEPTED. That says nothing about
  // whether the record still says what it said — and this app's entire output is a record of
  // who approved a production release. `@loom/plugin-audit-chain` hash-chains every event in
  // metadata the fold ignores, so the two questions stay separate and both are answerable.

  it("verifies the chain over a real approval, and counts what it checked", async () => {
    h = await harness({ userGrant: "demo-grant" });
    h.host.clickApprove();
    await settle(500);
    // Assert the approval actually landed — a chain verified over a log with no approval
    // in it would pass while proving nothing about the thing this app records.
    expect(h.surface().status).toBe("shipped");

    const verified = await h.app.auditLog.verifyChain(h.executionId);
    expect(verified.ok).toBe(true);
    // The denominator: `ok` over an empty log would be a pass that proves nothing.
    expect(verified.length).toBeGreaterThan(3);
    expect(verified.brokenAt).toBeUndefined();
  });

  it("detects an edit to the approval AFTER the fact", async () => {
    h = await harness({ userGrant: "demo-grant" });
    h.host.clickApprove();
    await settle(500);
    expect(h.surface().status).toBe("shipped");
    expect((await h.app.auditLog.verifyChain(h.executionId)).ok).toBe(true);

    // Tamper with the durable record the way an attacker with store access would: rewrite
    // the approver on the event that reopened the gate, leaving every hash in place.
    const events = await h.app.auditLog.read(h.executionId);
    const approval = events.find(
      (e) => e.eventType === RELEASE_SIGNAL && (e.payload as ReleaseSignal).kind === "approval"
    );
    expect(approval).toBeDefined();
    (approval as { payload: Record<string, unknown> }).payload.approver = "someone-else";

    const broken = await h.app.auditLog.verifyChain(h.executionId);
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt).toBe(approval?.sequence);
    expect(broken.reason).toBeTruthy();
  });
});
