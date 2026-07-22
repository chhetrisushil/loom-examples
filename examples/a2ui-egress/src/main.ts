import type { SurfaceState } from "@loom/agent-surface";
import type { EventEnvelope } from "@loom/core";
import { A2UISurfaceBridge, A2UI_VERSION } from "@loom/plugin-a2ui";
import { buildApp } from "./app";
import type { ExpenseInput } from "./flow";
import { RegisteredExpenseFlow } from "./flow";
import { formatMessage } from "./render";
import { EXPENSE_VIEW } from "./view";

// A headless driver that projects a Loom agent surface onto the Google A2UI wire
// protocol via `@loom/plugin-a2ui`. It runs one expense-approval execution,
// prints every A2UI message the egress bridge emits, drives the human-approval
// gate by feeding an *inbound* A2UI `action` back through the bridge, then
// contrasts A2UI's absolute data model with Loom's native delta patches.
async function main(): Promise<void> {
  const app = buildApp();
  const eventStore = app.stores.eventStore;

  const input: ExpenseInput = { expenseId: "exp-4821", title: "NYC client visit" };
  // Fix the executionId up front so we can subscribe BEFORE starting and capture
  // every event live (the first patch would otherwise fire during start()).
  const executionId = "exp-4821";

  // One bridge = one A2UI session for one execution's surface. Feed it the Loom
  // event stream; it emits the A2UI messages a compliant client would render.
  const bridge = new A2UISurfaceBridge({
    executionId,
    components: EXPENSE_VIEW,
    surfaceProperties: { agentDisplayName: "Expense Approver" },
  });

  console.log(`\n⧖  A2UI egress — projecting the "ui" surface of ${executionId}`);
  console.log(`   surfaceId=${bridge.surfaceId}\n`);
  console.log("── A2UI wire messages (server → client) ─────────────────────────");

  const unsubscribe = await eventStore.subscribe(executionId, (event: EventEnvelope) => {
    // Each event yields 0+ A2UI messages. Non-surface events return [].
    for (const msg of bridge.handleEvent(event)) {
      console.log(formatMessage(msg));
    }
  });

  // Start the flow; it drives the surface, then suspends awaiting approval.
  const handle = await app.runtime.start(RegisteredExpenseFlow, input, { executionId });
  await handle.waitForSuspend();
  console.log("\n   ⏸  flow suspended — awaiting approval\n");

  // ── The inbound leg ──────────────────────────────────────────────────────────
  // Simulate an A2UI client activating the "approve" Button. The bridge normalizes
  // the inbound `action` (validating it targets this surface); the app decides how
  // to turn that action into a Loom event — here, the resume that satisfies the gate.
  console.log("── Inbound A2UI action (client → server) ────────────────────────");
  const clientMessage = {
    version: A2UI_VERSION,
    action: {
      surfaceId: bridge.surfaceId,
      action: "approve",
      context: { expenseId: input.expenseId },
    },
  };
  const action = bridge.ingestAction(clientMessage);
  if (action === null) {
    throw new Error("A2UI action was not accepted for this surface");
  }
  console.log(`  action "${action.action}" on ${action.surfaceId} → resume ExpenseApproved\n`);

  console.log("── A2UI wire messages (after approval) ──────────────────────────");
  const resumed = await app.runtime.resume(executionId, {
    eventType: "ExpenseApproved",
    payload: { approvedBy: "a2ui-client", a2ui: action },
  });
  await resumed.waitForCompletion();

  // ── The contrast ──────────────────────────────────────────────────────────────
  // A2UI ships absolute values at JSON Pointers (above). Loom's NATIVE surface is
  // the same state, but rebuilt purely by folding delta patches from the log — read
  // it straight off the projection runtime.
  const surface = app.projectionRuntime.getState<SurfaceState>("ui", executionId);
  console.log("\n── Loom native surface (folded from delta patches) ──────────────");
  console.log(JSON.stringify(surface, null, 2));

  // Tear the surface down on the client.
  console.log("\n── Teardown ─────────────────────────────────────────────────────");
  for (const msg of bridge.close()) {
    console.log(formatMessage(msg));
  }

  unsubscribe();
  await app.close();
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
