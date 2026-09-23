import type { HandleInventory } from "@loom-ui/hydration";
import { describe, expect, it } from "vitest";
import { openBoard } from "../src/client";
import { StationServer } from "../src/server";
import { WeatherTools } from "../src/tools";

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

/** Let the loader's JSON round trips and the 0 ms batch window run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function boot(opts: { readOnly?: boolean; prepare?: (tools: WeatherTools) => void } = {}) {
  const tools = new WeatherTools();
  opts.prepare?.(tools);
  const server = new StationServer({
    tools,
    clock: () => NOW,
    ...(opts.readOnly !== undefined && { readOnly: opts.readOnly }),
  });
  const { blueprint, inventory: served } = server.open();
  // The inventory crosses the same JSON boundary as everything else the browser sees: round-trip
  // it here too, so the simulated trust boundary is honest for it, not just for hydrate/loadMany.
  const inventory = JSON.parse(JSON.stringify(served)) as HandleInventory;
  const board = openBoard(
    inventory,
    (body) => server.hydrate(body),
    (body) => server.hydrateBatch(body)
  );
  return { tools, server, blueprint, inventory, ...board };
}

describe("split hydration: a weather-station board", () => {
  it("the browser receives a Blueprint and a handle inventory — never a provider", () => {
    const { blueprint, inventory, findings } = boot();
    expect(findings).toEqual([]);
    const wire = JSON.stringify({ blueprint, inventory });
    for (const secret of [
      "executionGraph",
      "toolName",
      "stations.",
      "scriptRef",
      "current-kpi",
      "frost-kpi",
      "series-trend",
      "alerts-table",
      "$now",
    ])
      expect(wire).not.toContain(secret);
    expect(inventory.handles.map((h) => [h.handle, h.priority, h.params])).toEqual([
      ["current", "P0", ["station"]],
      ["frost", "P0", ["station"]],
      ["series", "P1", ["from", "station", "to"]],
      ["alerts", "P2", ["station"]],
    ]);
    // Every revision is a keyed hash (HMAC-SHA256 hex): opaque, never the provider's own content
    // fingerprint — that would let a client confirm a guessed provider (tool, arguments) offline.
    for (const h of inventory.handles) expect(h.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("two widgets sharing one upstream step make ONE upstream call, in ONE batch", async () => {
    const { tools, store, loader } = boot();
    await settle();
    // current + frost both read `stations.current(station: ridge)` — the P0 group the scheduler
    // starts together crosses as ONE `loadMany`, and the server's batch pass shares the ONE call.
    expect(loader.batches[0]).toBe(2);
    expect(tools.calls.filter((c) => c.toolName === "stations.current")).toHaveLength(1);
    expect(store.value("current")).toEqual({ value: 9.25, unit: "°C", label: "Now" });
    expect(store.value("frost")).toEqual({ value: 1, unit: "risk", label: "Frost risk" });
    // series (P1) loads on its own, automatically, after the batch window — no visibility needed.
    expect(store.value("series")).toBeDefined();
    // alerts (P2) stays lazy until the surface reports it visible.
    expect(store.status("alerts")).toBeUndefined();
    // The browser sent no time at all: `$now` never left the server.
    expect(loader.sent.every((r) => Object.keys(r.params).length === 0)).toBe(true);
  });

  it("an empty alert log is a healthy empty table, not drift", async () => {
    const { store, controller, server } = boot();
    controller.markVisible("alerts");
    await settle();
    expect(store.status("alerts")?.state).toBe("ready");
    expect(store.value("alerts")).toEqual({ columns: ["At", "Level"], rows: [] });
    expect(server.drifts).toEqual([]);
  });

  it("the time-range picker and the station filter move only overridable arguments", async () => {
    const { tools, store, controller } = boot();
    controller.markVisible("alerts");
    await settle();
    const before = tools.calls.length;
    controller.setParams({ from: "$now-7d", station: "harbour", since: "$now-1h" });
    await settle();
    controller.markVisible("alerts"); // a re-queued P2 waits for the surface to re-report it
    await settle();
    const after = tools.calls.slice(before);
    expect(after.map((c) => c.toolName).sort()).toEqual([
      "stations.alerts",
      "stations.current",
      "stations.series",
    ]);
    // current + frost still share the call, even on the SECOND (parameterised) batch.
    expect(after.filter((c) => c.toolName === "stations.current")).toHaveLength(1);
    expect(after.find((c) => c.toolName === "stations.series")?.args).toEqual({
      station: "harbour",
      from: "2026-09-16T12:00:00.000Z",
      to: "2026-09-23T12:00:00.000Z",
    });
    // `since` is not overridable: the alert window stays the provider's own seven days.
    expect(after.find((c) => c.toolName === "stations.alerts")?.args).toEqual({
      station: "harbour",
      since: "2026-09-16T12:00:00.000Z",
    });
    expect(store.value("current")).toMatchObject({ value: 14.5 });
    expect(store.value("frost")).toMatchObject({ value: 0 }); // dew point 9.0°C: no frost risk
  });

  it("a client only ever receives a finding's PUBLIC form — never provider internals", async () => {
    const { store, server } = boot({
      prepare: (t) => {
        t.garbleCurrent = true;
      },
    });
    await settle();
    // current cannot render the garbled reading as-is: its Kpi contract fails, and it goes stale.
    expect(store.status("current")?.state).toBe("stale");
    const pub = store.status("current")?.finding;
    expect(pub?.code).toBe("output-contract-drift");
    expect(pub?.message).toBe(
      'handle "current": the output no longer matches what it declares; waiting for a repair'
    );
    const wire = JSON.stringify(pub);
    for (const secret of ["stations.current", "sha256", "n/a", "read", "reshap"])
      expect(wire).not.toContain(secret);
    // frost reads a DIFFERENT field of the SAME raw reading (dew point, not air temperature): it
    // is untouched by a garbled `tempC` and stays ready — sharing an upstream call does not mean
    // sharing the other widget's drift.
    expect(store.status("frost")?.state).toBe("ready");
    // The full finding — naming the provider and the contract it failed — reaches only the
    // server's own log (`onFinding`), never the client.
    const full = server.internalFindings.find(
      (f) => f.handle === "current" && f.finding.code === "output-contract-drift"
    );
    expect(full?.finding.message).not.toBe(pub?.message);
    expect(full?.finding.message).toContain("Kpi");
    expect(server.drifts[0]?.drift[0]?.contractKind).toBe("Kpi");
  });

  it("FrostRisk drifts on its OWN field going bad — even when CurrentReading's field is fine", async () => {
    const { store, server } = boot({
      prepare: (t) => {
        t.garbleFrost = true;
      },
    });
    await settle();
    // CurrentReading only reads `tempC`, which this scenario never touches: it stays ready.
    expect(store.status("current")?.state).toBe("ready");
    expect(store.value("current")).toEqual({ value: 9.25, unit: "°C", label: "Now" });
    // FrostRisk reads the garbled `dewPointC`: its OWN Kpi contract fails, exactly like
    // CurrentReading's does when its own field is bad — the reshaper never quietly answered
    // "no risk" for a reading it could not actually read.
    expect(store.status("frost")?.state).toBe("stale");
    const pub = store.status("frost")?.finding;
    expect(pub?.code).toBe("output-contract-drift");
    const wire = JSON.stringify(pub);
    for (const secret of ["stations.current", "sha256", "n/a", "dewPointC"])
      expect(wire).not.toContain(secret);
    const full = server.internalFindings.find(
      (f) => f.handle === "frost" && f.finding.code === "output-contract-drift"
    );
    expect(full?.finding.message).not.toBe(pub?.message);
    expect(full?.finding.message).toContain("Kpi");
  });

  it("an input-schema drift: the head goes stale, a read-only viewer proceeds — both are recorded", async () => {
    const upgraded = (t: WeatherTools) => t.upgrade("stations.current", "sha256:current-v2");
    const head = boot({ prepare: upgraded });
    await settle();
    expect(head.store.status("current")?.state).toBe("stale");
    expect(head.store.status("current")?.finding?.code).toBe("schema-drift");
    // current and frost share the drifted step: both are recorded (order not guaranteed — they
    // load in the same batch).
    expect(new Set(head.server.drifts.map((d) => `${d.handle}:${d.proceeded}`))).toEqual(
      new Set(["current:false", "frost:false"])
    );

    const viewer = boot({ prepare: upgraded, readOnly: true });
    await settle();
    expect(viewer.store.status("current")?.state).toBe("ready");
    expect(viewer.store.status("current")?.finding?.code).toBe("schema-drift-proceeded");
    expect(viewer.store.value("current")).toEqual({ value: 9.25, unit: "°C", label: "Now" });
    expect(new Set(viewer.server.drifts.map((d) => `${d.handle}:${d.proceeded}`))).toEqual(
      new Set(["current:true", "frost:true"])
    );
  });
});
