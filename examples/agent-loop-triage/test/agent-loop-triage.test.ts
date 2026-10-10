import { isTainted } from "@loom/classify";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmRequest } from "@loom/llm";
import { textOf } from "@loom/llm";
import { beforeAll, describe, expect, it } from "vitest";
import { DEEP, FAST, TICKET_A, TICKET_B, TICKET_C } from "../src/model";
import {
  type Acts,
  allResultsOf,
  failureOf,
  mapCache,
  resultsOf,
  routesOf,
  runActs,
} from "../src/scenario";
import {
  ALL_GRANTS,
  Backend,
  MEMORY_SCOPE,
  approve,
  boot,
  decisionsOf,
  outputOf,
  runTicket,
  settled,
  start,
} from "../src/world";

let acts: Acts;
beforeAll(async () => {
  acts = await runActs();
});

describe("tool failure is feedback", () => {
  it("the flaky lookup is an isError tool result, and the run completes", async () => {
    // The model's turn-1 request carries the three results of turn 0, in the model's order.
    const seen = resultsOf(acts.first.requests[1] as never);
    expect(seen.map((r) => r.id)).toEqual(["a0", "a1", "a2"]);
    expect(seen.map((r) => r.isError)).toEqual([false, false, true]);

    const state = await acts.second.runtime.loadState("ticket-1001");
    expect(state?.status).toBe("completed");
    expect(outputOf(state as never).content).toContain("Refunded order 1042");
    expect(await failureOf(acts.backend, "ticket-1001")).toBeUndefined();
  });

  it("a terminal error class still propagates: a quota stop fails the run and is not fed back", async () => {
    const backend = new Backend();
    const p = boot({ backend, prompt: TICKET_C });
    const state = await runTicket(p, "ticket-3001");
    expect(state.status).toBe("failed");
    expect(await failureOf(backend, "ticket-3001")).toMatch(/QuotaExceededError/);
    expect(p.requests).toHaveLength(1); // the model was never shown the failure and never asked again
    expect(p.toolRuns).toEqual(["check_refund_budget"]);
  });

  it("so does an authority denial: the ring refuses a model the flow was not granted", async () => {
    const backend = new Backend();
    const p = boot({
      backend,
      prompt: TICKET_A,
      grants: ALL_GRANTS.filter((g) => g !== `model:${DEEP}`),
    });
    const state = await runTicket(p, "ticket-1999");
    expect(state.status).toBe("failed");
    expect(await failureOf(backend, "ticket-1999")).toMatch(
      /CapabilityDeniedError.*model:triage-deep/
    );
    expect(backend.modelCalls[DEEP]).toBeUndefined(); // refused BEFORE the provider
  });
});

describe("the capability ring routes the model", () => {
  it("records the routed model id per turn: cheap first, deep once a tool has failed", async () => {
    expect(await routesOf(acts.backend, "ticket-1001")).toEqual([FAST, DEEP, DEEP]);
    // The router's choice is the model that answered, not a label.
    expect(acts.modelCallsAfterResume).toEqual({ [FAST]: 1, [DEEP]: 2 });
  });

  it("a clean ticket never leaves the cheap route", async () => {
    // TICKET_B recalls memory and calls no tool, so no tool_result can carry an error.
    expect(await routesOf(acts.backend, "ticket-1002")).toEqual([FAST]);
  });
});

describe("approval across a process restart", () => {
  it("parks before the refund; a FRESH runtime resumes it; no completed tool re-runs", () => {
    // Parked: the lookups ran, the destructive call did not.
    expect(acts.runsAtPark).toEqual({ lookup_customer: 1, lookup_order: 1, carrier_status: 1 });
    expect(acts.modelCallsAtPark).toEqual({ [FAST]: 1, [DEEP]: 1 });
    // Resumed in a new process: ONLY the refund is new, and ONE model call (the answer).
    expect(acts.runsAfterResume).toEqual({ ...acts.runsAtPark, issue_refund: 1 });
    expect(acts.second.toolRuns).toEqual(["issue_refund"]);
    expect(acts.modelCallsAfterResume).toEqual({ [FAST]: 1, [DEEP]: 2 });
    expect(acts.second.requests).toHaveLength(1);
    expect(acts.backend.refunds).toHaveLength(1);
    expect(acts.second.warnings.filter((w) => /diverge/i.test(w))).toEqual([]);
  });

  it("a refusal never issues the refund", async () => {
    const { approve, start } = await import("../src/world");
    const backend = new Backend();
    const first = boot({ backend, prompt: TICKET_A });
    await (await start(first, "t-deny")).waitForSuspend();
    const second = boot({ backend, prompt: TICKET_A });
    await approve(second, "t-deny", false);
    expect(backend.refunds).toEqual([]);
    expect(second.toolRuns).toEqual([]);
  });
});

describe("a consumed failure is not re-run on replay", () => {
  it("the carrier recovers on retry, yet it ran once and the transcript still says it failed", () => {
    // The backend would now SUCCEED (carrierFailures spent), so a re-run would change the answer.
    expect(acts.backend.carrierFailures).toBe(0);
    expect(acts.backend.runs.carrier_status).toBe(1);
    expect(acts.second.toolRuns).not.toContain("carrier_status");
    // After the restart the model is shown the SAME failure it consumed before.
    const seen = allResultsOf(acts.second.requests[0] as never);
    expect(seen.find((r) => r.id === "a2")?.isError).toBe(true);
  });

  it("NEGATIVE: without the outcome decisions the consumed failure DOES re-run (ADR 0121's crash window)", async () => {
    // Process 1 parks; then the log loses the outcome records, as if the process died between
    // each step's completion and its outcome decision.
    const first = new Backend();
    const p1 = boot({ backend: first, prompt: TICKET_A });
    await (await start(p1, "ticket-crash")).waitForSuspend();
    expect(first.runs.carrier_status).toBe(1);
    const stripped = new InMemoryAsyncEventStore();
    for (const e of await first.store.read("ticket-crash")) {
      const isOutcome =
        e.eventType === "DECISION_RECORDED" &&
        (e.payload as { source?: string }).source === "agent-outcome";
      if (!isOutcome) await stripped.append(e);
    }
    // Same world, same downstream counters, but the log without the outcomes.
    const crashed = new Backend(stripped);
    Object.assign(crashed.runs, first.runs);
    crashed.carrierFailures = 0; // the carrier has recovered, so a re-run would succeed
    const p2 = boot({ backend: crashed, prompt: TICKET_A });
    await approve(p2, "ticket-crash");
    await settled(p2, "ticket-crash");
    expect(p2.toolRuns).toContain("carrier_status"); // re-run: the outcome was not served
    expect(crashed.runs.carrier_status).toBe(2);
  });

  it("the outcome is a recorded decision, one per call", async () => {
    const outcomes = decisionsOf(await acts.backend.store.read("ticket-1001")).filter(
      (d) => d.source === "agent-outcome"
    );
    expect(outcomes.map((d) => d.decisionId)).toEqual([
      "triage-agent#turn:0:tool:0:outcome",
      "triage-agent#turn:0:tool:1:outcome",
      "triage-agent#turn:0:tool:2:outcome",
      "triage-agent#turn:1:tool:0:outcome",
    ]);
    expect(JSON.stringify(outcomes[2]?.choice)).toContain("failed");
    expect(JSON.stringify(outcomes[0]?.choice)).toContain('"ok":true');
  });
});

describe("writeBack memory", () => {
  it("the second ticket recalls what the first one wrote, and calls no tool", async () => {
    const answer = outputOf((await acts.third.runtime.loadState("ticket-1002")) as never).content;
    expect(answer).toContain("order 1042");
    expect(acts.third.toolRuns).toEqual([]);
    const roles = (await acts.backend.memory.recall("working", MEMORY_SCOPE)).map((e) => e.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("NEGATIVE: with an empty memory the same ticket has nothing to recall", async () => {
    const answer = outputOf((await acts.control.runtime.loadState("ticket-2001")) as never).content;
    expect(answer).toContain("no record");
  });

  it("ticket 1001's answer is stored TAINTED (it saw a tool error) and ticket 1002 gets it fenced", async () => {
    const entries = await acts.backend.memory.recall("working", MEMORY_SCOPE);
    const answers = entries.filter((e) => e.role === "assistant");
    // Ticket 1001's answer is tainted; ticket 1002 saw no tool, so its own answer is not.
    expect(answers.map((e) => isTainted(e.content))).toEqual([true, false]);

    // What ticket 1002's model was actually shown: the recall sits inside the untrusted fence,
    // in a `user` message, and is not in any instruction position (system or assistant).
    const req = acts.third.requests[0] as LlmRequest;
    const fencedText = (m: LlmRequest["messages"][number]) =>
      /<untrusted-input origin="[^"]*">[\s\S]*Refunded order 1042[\s\S]*<\/untrusted-input>/.test(
        textOf(m.content)
      );
    const carrying = req.messages.filter((m) => textOf(m.content).includes("Refunded order 1042"));
    expect(carrying.length).toBeGreaterThan(0);
    for (const m of carrying) {
      expect(m.role).toBe("user");
      expect(fencedText(m)).toBe(true);
    }
    expect(textOf(req.system ?? "")).not.toContain("Refunded order 1042");
  });

  it("the fork guard: `unless` returning true writes nothing and records the skip", async () => {
    const backend = new Backend();
    const p = boot({ backend, prompt: TICKET_B, fork: true });
    expect((await runTicket(p, "ticket-fork")).status).toBe("completed");
    expect(await backend.memory.recall("working", MEMORY_SCOPE)).toEqual([]);
    const events = await backend.store.read("ticket-fork");
    const skip = decisionsOf(events).find((d) => /#writeback:skip$/.test(d.decisionId));
    expect(skip?.choice).toBe(true);
    expect(
      events.some(
        (e) =>
          e.eventType === "STEP_COMPLETED" &&
          /#writeback$/.test(String((e.payload as { stepId?: string }).stepId))
      )
    ).toBe(false);
  });

  it("the write is a journaled effect (ring), not a direct call", async () => {
    const events = await acts.backend.store.read("ticket-1001");
    expect(
      events.some(
        (e) =>
          e.eventType === "STEP_COMPLETED" &&
          /#writeback$/.test(String((e.payload as { stepId?: string }).stepId))
      )
    ).toBe(true);
  });
});

describe("config errors", () => {
  it("bare `writeBack: true` throws AgentLoopConfigError before any model call", async () => {
    const p = boot({ backend: new Backend(), prompt: TICKET_A, writeBack: true });
    await runTicket(p, "cfg-1");
    expect(p.configErrors).toHaveLength(1);
    expect(p.configErrors[0]?.name).toBe("AgentLoopConfigError");
    expect(p.requests).toHaveLength(0);
    // `{}` (no toolId, no unless, no allowDirect) is just as bare.
    const q = boot({ backend: new Backend(), prompt: TICKET_A, writeBack: {} });
    await runTicket(q, "cfg-1b");
    expect(q.configErrors[0]?.name).toBe("AgentLoopConfigError");
  });

  it("NEGATIVE: each documented spelling is accepted (allowDirect / unless / toolId)", async () => {
    for (const writeBack of [
      { allowDirect: true },
      { unless: () => false },
      { toolId: "memwrite" },
    ]) {
      const p = boot({ backend: new Backend(), prompt: TICKET_B, writeBack });
      const state = await runTicket(p, "cfg-ok");
      expect(state.status).toBe("completed");
      expect(p.configErrors).toEqual([]);
    }
  });

  it("a response cache on the direct path requires cacheScope", async () => {
    const p = boot({ backend: new Backend(), prompt: TICKET_B, ring: false, cache: mapCache() });
    await runTicket(p, "cfg-2");
    expect(p.configErrors[0]?.message).toMatch(/cacheScope/);
    expect(p.requests).toHaveLength(0);

    const ok = boot({
      backend: new Backend(),
      prompt: TICKET_B,
      ring: false,
      cache: mapCache(),
      config: { cacheScope: "tenant-acme" },
    });
    expect((await runTicket(ok, "cfg-3")).status).toBe("completed");
    expect(ok.configErrors).toEqual([]);
  });
});

describe("settled() is bounded", () => {
  it("throws with the status on a deadline, and on an abort, instead of polling forever", async () => {
    const p = boot({ backend: new Backend(), prompt: TICKET_A });
    // An execution that never produces a terminal state: the poll must give up, not hang.
    await expect(settled(p, "never-started", { timeoutMs: 20 })).rejects.toThrow(
      /never-started not settled within 20ms \(status: no state\)/
    );
    const ac = new AbortController();
    ac.abort();
    await expect(settled(p, "never-started", { signal: ac.signal })).rejects.toThrow(/aborted/);
  });
});
