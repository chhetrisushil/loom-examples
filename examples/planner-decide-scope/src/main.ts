import { TRIAGE_FLOW, UNGRANTED_FLOW, createTriageApp, delegatedPrincipal } from "./app";

async function main() {
  const app = createTriageApp();

  const h = await app.runtime.start(
    app.definitions[TRIAGE_FLOW],
    {},
    { executionId: "triage-1", principal: delegatedPrincipal }
  );
  await h.waitForSuspend();
  const seen = app.requests[0];
  console.log("granted flow  : the LLM call was authorized as", {
    toolId: seen?.toolId,
    workflowId: seen?.workflowId,
    executionId: seen?.executionId,
    actor: seen?.principal?.actor,
    delegation: seen?.principal?.delegation === undefined ? "none" : "present",
  });
  console.log("model calls   :", app.llm.calls);

  await (
    await app.runtime.resume("triage-1", { eventType: "reviewed", payload: {} })
  ).waitForCompletion();
  console.log("after replay  : model calls =", app.llm.calls, "(plan served from the log)");

  const denied = await app.runtime.start(
    app.definitions[UNGRANTED_FLOW],
    {},
    { executionId: "triage-2", principal: delegatedPrincipal }
  );
  const failure = await denied.waitForCompletion().then(
    () => undefined,
    (e: unknown) => e
  );
  console.log(
    "ungranted flow:",
    failure instanceof Error ? failure.name : "no error",
    "| model calls (unchanged) =",
    app.llm.calls,
    "| authorizer asked",
    app.requests.filter((r) => r.workflowId === UNGRANTED_FLOW).length,
    "time(s) | decision recorded:",
    (await app.eventTypes("triage-2")).includes("DECISION_RECORDED")
  );

  app.grant(UNGRANTED_FLOW);
  const again = await app.runtime.start(
    app.definitions[UNGRANTED_FLOW],
    {},
    { executionId: "triage-3", principal: delegatedPrincipal }
  );
  await again.waitForSuspend();
  console.log("after widening the grant: a fresh run decides, model calls =", app.llm.calls);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
