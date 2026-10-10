import { TICKET_A, TICKET_B, TICKET_C } from "./model";
import { failureOf, mapCache, resultsOf, routesOf, runActs } from "./scenario";
import { ALL_GRANTS, Backend, MEMORY_SCOPE, boot, outputOf, runTicket } from "./world";

const heading = (s: string) => console.log(`\n== ${s}`);
const show = (r: Record<string, number>) => JSON.stringify(r);

async function main(): Promise<void> {
  const acts = await runActs();
  const be = acts.backend;

  heading("1. The capability ring picks the model (cheap-first; deep once a tool has failed)");
  console.log(
    `  recorded routes, ticket 1001: ${(await routesOf(be, "ticket-1001")).join(" -> ")}`
  );
  console.log(
    "  (the router's choice is a recorded decision; each call runs as the effect model:<route>)"
  );
  const noDeep = new Backend();
  const denied = boot({
    backend: noDeep,
    prompt: TICKET_A,
    grants: ALL_GRANTS.filter((g) => g !== "model:triage-deep"),
  });
  await runTicket(denied, "ticket-1999");
  console.log(
    `  same ticket, flow NOT granted model:triage-deep -> ${(await failureOf(noDeep, "ticket-1999"))?.slice(0, 110)}`
  );

  heading("2. Parallel lookups; the flaky one is feedback, not a failed run");
  console.log(`  turn 0 ran, in one scope: ${acts.first.toolRuns.join(", ")}`);
  const turn1 = resultsOf(acts.first.requests[1] as never);
  console.log(
    `  the model's turn-1 request saw isError: ${JSON.stringify(turn1.map((r) => r.isError))}`
  );

  heading("3. A refund parks on a human; restart; resume");
  console.log(
    `  parked. tool runs so far: ${show(acts.runsAtPark)}  model calls: ${show(acts.modelCallsAtPark)}`
  );
  console.log("  process 2 (new runtime, same store) resumes with { approved: true }");
  console.log(`  tool runs after:  ${show(acts.runsAfterResume)}   <- only issue_refund is new`);
  console.log(
    `  model calls after: ${show(acts.modelCallsAfterResume)}  <- one new call (the answer)`
  );
  console.log(
    `  carrier_status ran ${acts.runsAfterResume.carrier_status}x though it would succeed on a retry: a consumed failure is not re-run`
  );
  console.log(`  refunds issued: ${be.refunds.length}`);

  heading("4. writeBack: ticket 1002 (same customer) recalls ticket 1001");
  console.log(
    `  1002 answer: ${outputOf((await be.store.read("ticket-1002")) && (await acts.third.runtime.loadState("ticket-1002"))!).content}`
  );
  console.log(`  1002 tool runs: ${acts.third.toolRuns.length}`);
  console.log(
    `  control (empty memory): ${outputOf((await acts.control.runtime.loadState("ticket-2001"))!).content}`
  );
  const entries = await be.memory.recall("working", MEMORY_SCOPE);
  console.log(`  memory[${MEMORY_SCOPE}] roles: ${entries.map((e) => e.role).join(", ")}`);
  console.log(
    "  (1001 saw a tool error, so its answer is stored TAINTED and recalled fenced as data)"
  );

  heading("5. A terminal error is not feedback");
  const be3 = new Backend();
  const c = boot({ backend: be3, prompt: TICKET_C });
  const cs = await runTicket(c, "ticket-3001");
  console.log(`  ${TICKET_C}`);
  console.log(
    `  status=${cs.status}, tools run=${c.toolRuns.join(",")}, model calls=${c.requests.length} `
  );
  console.log(`  ${(await failureOf(be3, "ticket-3001"))?.slice(0, 100)}`);

  heading("6. Config errors, up front, before any model call");
  const bare = boot({ backend: new Backend(), prompt: TICKET_A, writeBack: true });
  await runTicket(bare, "cfg-1");
  console.log(
    `  writeBack: true  -> ${bare.configErrors[0]?.name}: ${bare.configErrors[0]?.message}`
  );
  const cache = boot({ backend: new Backend(), prompt: TICKET_A, ring: false, cache: mapCache() });
  await runTicket(cache, "cfg-2");
  console.log(
    `  cache, no cacheScope -> ${cache.configErrors[0]?.name}: ${cache.configErrors[0]?.message}`
  );
  void TICKET_B;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
