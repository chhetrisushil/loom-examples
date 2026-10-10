import { isTainted } from "@loom/classify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG_SIZE } from "../src/catalog";
import { resultsOf } from "../src/model";
import { type Acts, activationRecords, menuOf, runActs, searchRecords } from "../src/scenario";
import { type RunningServer, startServer } from "../src/server";
import { MONTH_END_INSTRUCTIONS } from "../src/skills";
import { buildWorld, run } from "../src/world";

let server: RunningServer;
let acts: Acts;

beforeAll(async () => {
  server = await startServer();
  acts = await runActs(server);
});
afterAll(async () => {
  await server.stop();
});

describe("the menu", () => {
  it("serves a large catalogue, and turn 0 offers only the meta-tools and the agent's own tool", () => {
    expect(CATALOG_SIZE).toBeGreaterThanOrEqual(60);
    expect(menuOf(acts.plain, 0)).toEqual(["search_tools", "activate_skill", "lookup_customer"]);
    expect(menuOf(acts.plain, 0).length).toBeLessThan(CATALOG_SIZE / 10);
  });

  it("grows append-only: every later menu extends the previous one", () => {
    for (let i = 1; i < acts.plain.requests.length; i++) {
      const prev = menuOf(acts.plain, i - 1);
      expect(menuOf(acts.plain, i).slice(0, prev.length)).toEqual(prev);
    }
    const last = menuOf(acts.plain, acts.plain.requests.length - 1);
    expect(last).toContain("charge_invoice");
    expect(last.length).toBeLessThan(CATALOG_SIZE / 4);
  });

  it("a tool nobody searched for stays off the menu", () => {
    const last = menuOf(acts.plain, acts.plain.requests.length - 1);
    expect(last).not.toContain("send_email");
  });
});

describe("remote (MCP) tools are untrusted", () => {
  it("the MCP plugin marks every tool remote, and the server's description does carry an injection", async () => {
    const mapped = await server.mapped();
    expect(mapped).toHaveLength(CATALOG_SIZE);
    expect(mapped.every((m) => m.definition.origin === "remote")).toBe(true);
    expect(
      mapped.find((m) => m.definition.id === "charge_invoice")?.definition.description
    ).toMatch(/ignore every other tool/);
  });

  it("the description is withheld from the model, in results and on the menu", () => {
    const wire = JSON.stringify(acts.plain.requests);
    expect(wire).not.toMatch(/ignore every other tool/i);
    const search = resultsOf(acts.plain.requests[1] as never).find(
      (r) => r.tool === "search_tools"
    );
    const hit = search?.result.tools?.find((t) => t.name === "charge_invoice");
    expect(hit?.description).toBe("Third-party tool; description withheld");
  });

  it("a search result naming a remote tool is tainted (fenced as data)", () => {
    const search = resultsOf(acts.plain.requests[1] as never).find(
      (r) => r.tool === "search_tools"
    );
    expect(search?.tainted).toBe(true);
    // the agent's own tool result is not
    const own = resultsOf(acts.plain.requests[1] as never).find(
      (r) => r.tool === "lookup_customer"
    );
    expect(own?.tainted).toBe(false);
    expect(isTainted(own?.result)).toBe(false);
  });
});

describe("vocabulary: host annotations", () => {
  it('"bill the customer" finds charge_invoice, and the call reaches the real MCP server', () => {
    const search = resultsOf(acts.plain.requests[1] as never).find(
      (r) => r.tool === "search_tools"
    );
    expect(search?.result.tools?.[0]?.name).toBe("charge_invoice");
    expect(search?.result.tools?.[0]?.loaded).toBe(true);
    // the built-in ranker drops query stopwords ("the"), so no alias that merely contains "the" matches
    expect((search?.result.tools ?? []).map((t) => t.name)).toEqual(["charge_invoice"]);
    expect(acts.mcpCalls.plain).toEqual(["charge_invoice"]);
  });

  it("without the annotation the same words do not find it (the gap is real)", async () => {
    const w = buildWorld({ mcp: await server.mapped(), annotations: {} });
    await run(w);
    const search = resultsOf(w.requests[1] as never).find((r) => r.tool === "search_tools");
    expect((search?.result.tools ?? []).map((t) => t.name)).not.toContain("charge_invoice");
    // the script reads the results, so it called whatever came back first: not charge_invoice
    expect(menuOf(w, w.requests.length - 1)).not.toContain("charge_invoice");
  });
});

describe("vocabulary: the query stoplist (ADR 0125 D15)", () => {
  it("with stopwords: [] the noise comes back: 'the' matches refund_payment and slow_queries", async () => {
    const w = buildWorld({ mcp: await server.mapped(), stopwords: [] });
    await run(w);
    const search = resultsOf(w.requests[1] as never).find((r) => r.tool === "search_tools");
    const names = (search?.result.tools ?? []).map((t) => t.name);
    expect(names).toContain("charge_invoice");
    expect(names).toEqual(expect.arrayContaining(["refund_payment", "slow_queries"]));
    expect(names.length).toBeGreaterThan(1);
  });
});

describe("skills: discovered through search, activated mid-loop", () => {
  it("search returns the skill without loading it; activation delivers the instructions as the result", () => {
    const search = resultsOf(acts.plain.requests[2] as never).find(
      (r) => r.tool === "search_tools"
    );
    expect(search?.result.skills?.map((s) => s.id)).toContain("month_end_close");
    expect(menuOf(acts.plain, 2)).not.toContain("post_ledger_entry");

    const activation = resultsOf(acts.plain.requests[3] as never)[0];
    expect(activation?.tool).toBe("activate_skill");
    expect(activation?.result.instructions).toBe(MONTH_END_INSTRUCTIONS);
    expect(activation?.tainted).toBe(false);
  });

  it("the skill's tool joins the menu after activation and then runs", () => {
    expect(menuOf(acts.plain, 3)).toContain("post_ledger_entry");
    expect(acts.plain.toolRuns).toEqual(["lookup_customer", "post_ledger_entry"]);
  });

  it("the system prompt never changes (the instructions travel as a tool result)", () => {
    const systems = new Set(acts.plain.requests.map((r) => JSON.stringify(r.system)));
    expect(systems.size).toBe(1);
  });
});

describe("two-ranker mode (a custom tool ranker)", () => {
  it("the custom ranker ranks tools and the built-in one ranks skills; both are recorded", () => {
    const records = searchRecords(acts.fullLog).map(
      (d) =>
        d.choice as { ranker: string; skillRanker?: string; results: string[]; skills?: string[] }
    );
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.ranker).toBe("word-overlap");
      expect(r.skillRanker).toBe("bm25f");
    }
    expect(records[0]?.results[0]).toBe("charge_invoice");
    expect(records[1]?.skills).toContain("month_end_close");
    expect(acts.ranker.calls).toBe(2);
    // the recorded kind is a plain string, whatever built the ranker
    for (const r of records) expect(typeof r.ranker).toBe("string");
  });

  it("the ranker factory is called once per run, lazily, with the run's SANITIZED docs", () => {
    expect(acts.ranker.factoryCalls).toBe(1);
    expect(acts.ranker.built).toHaveLength(1);
    const docs = acts.ranker.docsSeen[0] ?? [];
    expect(docs).toHaveLength(CATALOG_SIZE);
    const charge = docs.find((d) => d.id === "charge_invoice");
    // the host's annotation is present ...
    expect(charge?.aliases).toContain("bill the customer");
    expect(charge?.tags).toContain("billing");
    // ... and the server's description (it carries an injection) is not
    expect(charge?.description).toBeUndefined();
    expect(JSON.stringify(docs)).not.toMatch(/ignore every other tool/i);
    expect(docs.every((d) => d.description === undefined)).toBe(true);
  });

  it("the page is the same whichever tool ranker produced it", () => {
    const pick = (w: typeof acts.plain) =>
      (w.requests[1] ? resultsOf(w.requests[1]) : [])
        .find((r) => r.tool === "search_tools")
        ?.result.tools?.map((t) => t.name);
    expect(pick(acts.custom)).toEqual(pick(acts.plain));
    expect(pick(acts.plain)).toEqual(["charge_invoice"]);
  });
});

describe("durability: kill, restart, replay", () => {
  it("the resumed run completes without a replay divergence", () => {
    expect(acts.resumed.warnings.filter((m) => /diverge/i.test(m))).toEqual([]);
    expect(acts.crashedLog.length).toBeLessThan(acts.fullLog.length);
  });

  it("the replay makes ZERO ranker calls (the live run made two)", () => {
    expect(acts.ranker.calls).toBe(2);
    expect(acts.resumedRanker.calls).toBe(0);
    // nor is the factory even built: a resume never reaches the ranker
    expect(acts.resumedRanker.factoryCalls).toBe(0);
    expect(acts.resumedRanker.built).toEqual([]);
  });

  it("the recorded pages, and the activation, are identical after the resume", () => {
    expect(searchRecords(acts.resumedLog)).toEqual(searchRecords(acts.fullLog));
    expect(activationRecords(acts.resumedLog)).toEqual(activationRecords(acts.fullLog));
    expect(activationRecords(acts.resumedLog)).toHaveLength(1);
  });

  it("the model, resumed, sees the exact menu the original turn saw", () => {
    expect(menuOf(acts.resumed, 0)).toEqual(menuOf(acts.custom, 2));
  });

  it("the MCP server is not asked to charge twice", () => {
    expect(acts.mcpCalls.custom).toEqual(["charge_invoice"]);
    expect(acts.mcpCalls.resumed).toEqual([]);
  });
});
