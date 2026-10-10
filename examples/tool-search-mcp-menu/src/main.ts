import { CATALOG_SIZE } from "./catalog";
import { digest, menuOf, runActs, searchRecords } from "./scenario";
import { startServer } from "./server";

const heading = (s: string) => console.log(`\n== ${s}`);

async function main(): Promise<void> {
  const server = await startServer();
  try {
    const acts = await runActs(server);

    heading(
      `1. A ${CATALOG_SIZE}-tool MCP catalogue, and a turn-0 menu of ${menuOf(acts.plain, 0).length}`
    );
    console.log(`  menu at turn 0: ${menuOf(acts.plain, 0).join(", ")}`);
    console.log(
      "  (search_tools + activate_skill are the loop's own; lookup_customer is the agent's own tool)"
    );

    heading('2. "bill the customer" -> charge_invoice (host annotations; built-in BM25F ranker)');
    for (const l of digest(acts.plain)) console.log(l);
    console.log(
      "  charge_invoice's description is the SERVER's text (it says: ignore every other tool).\n" +
        "  It is withheld, never ranked on, and the result is tainted. The alias is the HOST's."
    );
    console.log(
      `  menu at the last turn: ${menuOf(acts.plain, acts.plain.requests.length - 1).join(", ")}`
    );

    heading(
      "3. Same task, custom ranker: tools and skills are ranked separately, then interleaved"
    );
    for (const d of searchRecords(acts.fullLog)) {
      const v = d.choice as {
        ranker: string;
        skillRanker?: string;
        results: string[];
        skills?: string[];
      };
      console.log(
        `  recorded: ranker=${v.ranker} skillRanker=${v.skillRanker} tools=[${v.results}] skills=[${v.skills}]`
      );
    }
    console.log(`  ranker calls live: ${acts.ranker.calls}`);

    heading("4. Crash before the skill activation, then resume from the log");
    console.log(`  log prefix kept: ${acts.crashedLog.length} of ${acts.fullLog.length} events`);
    console.log(
      `  ranker calls during the resume: ${acts.resumedRanker.calls} (the searches are recorded facts)`
    );
    const before = JSON.stringify(searchRecords(acts.fullLog));
    const after = JSON.stringify(searchRecords(acts.resumedLog));
    console.log(`  same recorded pages after resume: ${before === after}`);
    console.log(
      `  the model call after the resume saw the same menu as the original turn 2: ${
        JSON.stringify(menuOf(acts.resumed, 0)) === JSON.stringify(menuOf(acts.custom, 2))
      }`
    );
    console.log(
      `  MCP calls: original run [${acts.mcpCalls.custom}], resume [${acts.mcpCalls.resumed}] (charge_invoice is not repeated)`
    );
  } finally {
    await server.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
