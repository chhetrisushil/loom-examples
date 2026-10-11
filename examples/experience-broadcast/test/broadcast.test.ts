import type { Audience, Viewer } from "@loom-ui/core";
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/register";
import { renderExperience } from "@loom-ui/renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it, vi } from "vitest";
import { openSurface } from "../src/client";
import { DeskServer, SECRETS, TITLES } from "../src/desk";

// The agent at their own desk is cleared for everything; the lobby wallboard is driven from the SAME
// logged-in machine, so the same clearance reaches it. The AUDIENCE is what keeps it off the screen.
const AGENT: Viewer = { clearance: "secret" };

/** Open one audience's surface end to end: compile, inventory, then the browser's own loads. */
async function open(
  audience: Audience,
  server = new DeskServer(),
  shared?: { runtime: InMemoryProjectionRuntime }
) {
  const web = server.open("web", audience, AGENT);
  const terminal = server.open("terminal", audience, AGENT);
  const surface = openSurface(terminal.inventory, (body) => server.hydrate(body, audience, AGENT), {
    audience,
    principalId: "agent-1",
    ...(shared && { runtime: shared.runtime }),
  });
  const wanted = terminal.inventory.handles.map((h) => h.handle);
  await vi.waitFor(() => {
    for (const h of wanted) expect(surface.store.status(h)?.state, h).toBe("ready");
  });
  return { server, web, terminal, ...surface, wanted };
}

/** Every string a viewer of the surface could read, from the terminal frame. */
const frame = (s: Awaited<ReturnType<typeof open>>): string =>
  renderExperience(s.terminal.compiled.blueprint, s.store);

/** The web surface, drawn by the Lit renderer, as readable text AND every attribute, shadow roots included. */
async function webText(s: Awaited<ReturnType<typeof open>>): Promise<string> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const handle = renderBlueprintDom(host, s.web.compiled.blueprint, {
    projectionRuntime: s.runtime,
    executionId: s.store.executionId,
    registry: litRegistry,
  });
  const out: string[] = [];
  const walk = async (root: ParentNode): Promise<void> => {
    for (const el of Array.from(root.querySelectorAll("*")) as Array<
      HTMLElement & { updateComplete?: Promise<unknown> }
    >) {
      await el.updateComplete;
      for (const a of el.getAttributeNames()) out.push(el.getAttribute(a) ?? "");
      for (const n of Array.from(el.childNodes))
        if (n.nodeType === 3) out.push(n.textContent ?? "");
      if (el.shadowRoot) await walk(el.shadowRoot);
    }
  };
  await walk(host);
  handle.dispose();
  host.remove();
  return out.join(" ");
}

const everySecret = (): string[] => [
  SECRETS.customerA,
  SECRETS.customerB,
  String(SECRETS.refundTotal),
  "48,275",
  SECRETS.refundWord,
  SECRETS.escalatedWord,
  SECRETS.refundTool,
  SECRETS.escalatedTool,
  "billing",
  "crm.",
  "sensitive",
  "secret",
];

describe("experience-broadcast: one support-desk Experience, two audiences", () => {
  it("a surface cannot be opened without an audience, and the split controller holds the store to it", async () => {
    const server = new DeskServer();
    const terminal = server.open("terminal", "broadcast", AGENT);
    // @ts-expect-error `audience` is required: the scope must say who the surface is for
    const bad: Parameters<typeof openSurface>[2] = {};
    expect(bad).toBeDefined();
    const { SplitHydrationController } = await import("@loom-ui/hydration/client");
    const { HydrationStore } = await import("@loom-ui/hydration/client");
    const loader = { load: vi.fn(), loadMany: vi.fn() };
    const store = new HydrationStore(new InMemoryProjectionRuntime(), {
      experienceId: terminal.inventory.experienceId,
      audience: "broadcast",
    });
    // a viewer-audience controller over a broadcast store is refused, and so is the reverse
    expect(() => new SplitHydrationController({ loader, store })).toThrow(/audience/);
    expect(
      () => new SplitHydrationController({ loader, store, audience: "broadcast" })
    ).not.toThrow();
  });

  it("the agent's own surface shows everything (the control for every absence below)", async () => {
    const s = await open("viewer");
    const out = frame(s);
    for (const shown of [SECRETS.customerA, SECRETS.customerB, "48,275", TITLES.refunds])
      expect(out, shown).toContain(shown);
    expect([...s.wanted].sort()).toEqual(["escalated", "open", "refunds", "sla"]);
    expect(s.server.tools.calls.sort()).toEqual(
      ["crm.escalated_customers", "billing.refund_exposure", "desk.open_tickets", "desk.sla"].sort()
    );
    expect(s.terminal.compiled.findings.map((f) => f.code)).not.toContain("audience-withheld");
    expect(out).not.toContain("redacted");
  });

  it("the wallboard, from the SAME experience and the SAME cleared viewer, redacts both classified widgets", async () => {
    const s = await open("broadcast");
    const out = frame(s);
    expect(out.match(/⊘ redacted/g)).toHaveLength(2);
    // the open widgets are there, with their data
    expect(out).toContain("37");
    expect(out).toContain("Within SLA");
    for (const secret of everySecret()) expect(out, secret).not.toContain(secret);
    // the same experience version drives both audiences, and their artifacts differ
    const personal = new DeskServer().open("terminal", "viewer", AGENT).compiled.blueprint;
    expect(s.terminal.compiled.blueprint.id).toBe(personal.id);
    expect(JSON.stringify(s.terminal.compiled.blueprint)).not.toBe(JSON.stringify(personal));
    // the server-side findings name what was withheld and why; the audience, not the viewer, did it
    expect(
      s.terminal.compiled.findings
        .filter((f) => f.code === "audience-withheld")
        .map((f) => f.nodeId)
        .sort()
    ).toEqual(["escalated", "refunds"]);
  });

  it("the wallboard and the agent's own surface share a runtime and a principal, never hydration state", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const server = new DeskServer();
    const mine = await open("viewer", server, { runtime });
    expect(mine.store.value("refunds")).toBeDefined();
    const wall = await open("broadcast", server, { runtime });
    // Opening the wall removed nothing from the agent's surface, and gave the wall nothing of it.
    expect(mine.store.value("refunds")).toBeDefined();
    expect(mine.store.value("escalated")).toBeDefined();
    expect(wall.store.value("refunds")).toBeUndefined();
    expect(wall.store.executionId).not.toBe(mine.store.executionId);
    expect(frame(mine)).toContain(SECRETS.customerA);
  });

  it("nothing withheld is in the broadcast Blueprint, its inventory, the browser's requests or the server's answers", async () => {
    const s = await open("broadcast");
    const wire = JSON.stringify({
      web: s.web.compiled.blueprint,
      terminal: s.terminal.compiled.blueprint,
      fingerprint: s.web.compiled.fingerprint,
      inventory: s.web.inventory,
      requests: s.loader.sent,
    });
    for (const secret of [...everySecret(), "escalated", "refunds"])
      expect(wire, secret).not.toContain(secret);
    expect(s.web.compiled.blueprint.layout).toBeDefined();
    // the browser listed, and asked for, the open handles only
    expect(s.wanted.sort()).toEqual(["open", "sla"]);
    expect(s.loader.sent.map((r) => r.handle).sort()).toEqual(["open", "sla"]);
    // and the withheld handles' tools were never called, so nothing was fetched to be dropped later
    expect(s.server.tools.calls.sort()).toEqual(["desk.open_tickets", "desk.sla"]);
    for (const h of ["escalated", "refunds"]) expect(s.store.status(h)).toBeUndefined();
  });

  it("the web wallboard (Lit) draws the marker and none of the withheld text, attributes included", async () => {
    const s = await open("broadcast");
    const text = await webText(s);
    expect(text).toContain("⊘ redacted");
    expect(text).toContain("Within SLA");
    for (const secret of everySecret()) expect(text, secret).not.toContain(secret);
    // control: the agent's web surface does carry them
    const own = await webText(await open("viewer"));
    expect(own).toContain(SECRETS.customerA);
  });

  it("a hostile wallboard client that asks for a withheld handle anyway is refused, indistinguishably, and nothing is called", async () => {
    const s = await open("broadcast");
    const callsBefore = s.server.tools.calls.length;
    const inv = s.web.inventory;
    const ask = (handle: string) =>
      JSON.stringify([
        { experienceId: inv.experienceId, versionHash: inv.versionHash, handle, params: {} },
      ]);
    const [refund] = JSON.parse(await s.server.hydrate(ask("refunds"), "broadcast", AGENT));
    const [ghost] = JSON.parse(await s.server.hydrate(ask("no-such-handle"), "broadcast", AGENT));
    expect(refund.state).toBe("error");
    expect(refund.finding.code).toBe(ghost.finding.code);
    expect(JSON.stringify(refund)).not.toContain(String(SECRETS.refundTotal));
    expect(s.server.tools.calls).toHaveLength(callsBefore);
    expect(s.server.refused).toContain("refunds"); // the server's own log names it; the client never does
    // control: the same request on the agent's own surface is served
    const [own] = JSON.parse(await s.server.hydrate(ask("refunds"), "viewer", AGENT));
    expect(own.state).toBe("ready");
  });
});
