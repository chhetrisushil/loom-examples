import type { AgentLoopConfig } from "@loomwork/agent";
import { reachOf, resolveVerifyInput } from "@loomwork/app";
import { flow$, schedule$ } from "@loomwork/core";
import {
  type MintRequest,
  SCHEDULE_GATE,
  type ScheduleApprovalContext,
  type ScheduleGrantSpec,
  answerRenewal,
  answerScheduleApproval,
  deriveGrant,
  requestScheduleApproval,
  schedulePrincipalFor,
  scheduleResumeSchema,
  settleScheduledTick,
} from "@loomwork/task-authority";
import { verify } from "@loomwork/verify";
import { TimerService } from "@loomwork/workflow-runtime";
import { z } from "zod";
import {
  EMAIL,
  INCIDENTS,
  MODEL,
  PAGER,
  P_DIGEST,
  P_PAGE,
  P_TICK,
  RECALL,
  WRITE,
  errorsSeen,
} from "./model";
import { MINUTE, T0, World, deniedReasons, settled, until } from "./world";

type Request = Omit<MintRequest, "taskId" | "issuedTo" | "ttlMs">;

/**
 * The mint request for a team's digest task. The effects are the flow's REACH minus the pager (the
 * grant is the task's authority, the reach is only its upper bound); each leased effect sits in a lease,
 * because `taskLeaseMiddleware` refuses a granted effect that no lease counts; `reads` names the one
 * memory scope the task may recall.
 */
export function digestRequest(reach: string[], scope: string): Request {
  const template = deriveGrant(reach, {
    reads: [`${RECALL}:${scope}`],
    leases: {
      model: { ceiling: 20, effects: [MODEL] },
      email: { ceiling: 2, effects: [EMAIL] }, // at most two emails, however the model is steered
      reads: { ceiling: 20, effects: [INCIDENTS, RECALL] },
      writes: { ceiling: 2, effects: [WRITE] },
    },
  });
  return { ...template, effects: template.effects.filter((e) => e !== PAGER) };
}

/** Beat 1 (D9): derive the grant from the flow's reach, mint it, and lint an over-broad hand-written template. */
export async function beat1() {
  const w = new World();
  w.agentFlow("digest");
  const edges = { agentLoops: { digest: [w.configs.digest as AgentLoopConfig] } };
  const reach = reachOf(w.runtime, "digest", edges);
  const request = digestRequest(reach, "team:alpha");
  const grant = await w.broker.mint({
    taskId: "digest-1",
    issuedTo: "digest-agent",
    ttlMs: 3_600_000,
    ...request,
  });
  const lint = (effects: string[]) =>
    verify(
      resolveVerifyInput(w.runtime, { taskGrants: [{ flowId: "digest", effects, reach: edges }] }),
      {
        rules: ["task-grant-reach"],
      }
    ).findings;
  return {
    reach,
    grant,
    clean: lint(request.effects),
    overBroad: lint([...request.effects, "db.drop"]),
  };
}

/** The grant request for a flow, derived from the reach of its agent loop. */
export function requestFor(w: World, flowId: string, scope: string): Request {
  return digestRequest(
    reachOf(w.runtime, flowId, {
      agentLoops: { [flowId]: [w.configs[flowId] as AgentLoopConfig] },
    }),
    scope
  );
}

/** Beat 2 (D8): `reads` is signed into the grant; recalling another team's scope is refused. */
export async function beat2() {
  const w = new World();
  const mine = w.agentFlow("digest-alpha", { scope: "team:alpha" });
  const theirs = w.agentFlow("digest-beta", { scope: "team:beta" });
  await w.memory.remember("working", "team:alpha", {
    id: "n1",
    role: "user",
    content: "alpha: failover postmortem due Friday",
  });
  await w.memory.remember("working", "team:beta", {
    id: "n1",
    role: "user",
    content: "beta: billing outage notes",
  });
  // Both tasks hold the SAME grant shape: reads covers `memory.recall:team:alpha` only.
  const own = await w.run(mine, "own-scope", P_DIGEST, requestFor(w, "digest-alpha", "team:alpha"));
  const foreign = await w.run(
    theirs,
    "other-scope",
    P_DIGEST,
    requestFor(w, "digest-beta", "team:alpha")
  );
  const prompts = (from: number) => JSON.stringify(w.requests.slice(from).map((r) => r.messages));
  return {
    w,
    own,
    foreign,
    ownSawNote: prompts(0).includes("failover postmortem"),
    foreignReasons: deniedReasons(await w.events("other-scope")),
  };
}

/** Beat 3 (D11): what the model sees when the grant refuses a tool: terminal by default, feedback with `onDenied`. */
export async function beat3() {
  const w = new World();
  const soft = w.agentFlow("digest-soft", { onDenied: "reason" });
  const hard = w.agentFlow("digest-hard");
  const ok = await w.run(soft, "soft", P_PAGE, requestFor(w, "digest-soft", "team:alpha"));
  const seen = [...new Set(w.requests.flatMap(errorsSeen))]; // every later request repeats the transcript
  const emailsAfterSoft = w.calls[EMAIL] ?? 0;
  const bad = await w.run(hard, "hard", P_PAGE, requestFor(w, "digest-hard", "team:alpha"));
  return { w, ok, seen, emailsAfterSoft, bad, badReasons: deniedReasons(await w.events("hard")) };
}

/**
 * Beat 4 (D7): task B recalls a note task A wrote, then makes a governed write. B's grant covers the
 * email, so the authorizer is silent; `directedBy` is what sees that A's content steered it.
 */
export async function beat4() {
  const approved = new Set<string>(); // the operator's decisions, consulted by the broker
  const w = new World({
    provenance: true,
    approveCrossLineage: (r) => (r.lineages ?? []).every((l) => approved.has(l)),
  });
  const flow = w.agentFlow("digest-notes", { scope: "ops/notes", onExhausted: "park" });
  const req = requestFor(w, "digest-notes", "ops/*");
  const state = (id: string) => w.runtime.loadState(id);

  await w.run(flow, "task-A", P_DIGEST, req); // A: its own scope is empty, so nothing foreign; it writes a note back
  const emailsAfterA = w.calls[EMAIL] ?? 0;
  const note = JSON.stringify(await w.memory.recall("working", "ops/notes"));

  // B (a different root grant) recalls A's note, then tries its email: parked, not run.
  const parked = await w.run(flow, "task-B1", P_DIGEST, req);
  const request = Object.values(
    (parked.variables._decisions ?? {}) as Record<
      string,
      { choice?: { request?: { reason?: string; lineages?: string[] } } }
    >
  )
    .map((d) => d.choice?.request)
    .find((r) => r?.reason === "cross-lineage");
  const emailsWhileParked = w.calls[EMAIL] ?? 0;

  // The operator has NOT approved A's lineage: the reference broker refuses, the run fails, the email never runs.
  await answerRenewal(w.runtime, w.broker, "task-B1");
  const declined = await until(
    async () => (await state("task-B1"))?.status === "failed",
    "B1 to fail"
  ).then(() => state("task-B1"));

  // Approving the lineage is the operator's decision; a fresh B parks again, and now the renewal grants.
  approved.add("lineage:task-A");
  const parked2 = await w.run(flow, "task-B2", P_DIGEST, req);
  await answerRenewal(w.runtime, w.broker, "task-B2");
  await until(async () => (await state("task-B2"))?.status === "completed", "B2 to complete");
  return {
    w,
    note,
    emailsAfterA,
    parked,
    parked2,
    request,
    emailsWhileParked,
    declined,
    emailsAfterB2: w.calls[EMAIL] ?? 0,
  };
}

const SCHEDULE = "nightly-digest";
const OPERATOR = { actor: "ops-lead", tenant: "acme" };

/**
 * Beat 5 (D12, ADR 0152): a schedule has no human per run, so a human approves the SCHEDULE once; each
 * occurrence then runs as its own child grant of it, and a tick the schedule cannot afford is skipped.
 */
export async function beat5({ refund = true } = {}) {
  const w = new World({ timers: true });
  const tick = w.agentFlow("nightly-tick", { bare: true });
  const spec: ScheduleGrantSpec = {
    scheduleId: SCHEDULE,
    issuedTo: "svc-digest",
    effects: [MODEL, EMAIL],
    // The TOTAL over every tick: a tick is carved 5 calls and runs 3 (two model calls, one email).
    leases: { calls: { ceiling: 11, effects: [MODEL, EMAIL] } },
    ttlMs: 24 * 3_600_000,
    tenant: "acme",
  };
  // 1. The one-off approval run parks; the operator answers it, and only then is the schedule grant minted.
  const approval = flow$({
    id: "approve-schedule",
    name: "approve-schedule",
    version: "1.0.0",
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    steps: [],
    resumeSchemas: { [SCHEDULE_GATE]: scheduleResumeSchema },
  });
  w.runtime.registerFlow(approval, (async (ctx: ScheduleApprovalContext) => {
    await requestScheduleApproval(ctx, spec);
    return { approved: true };
  }) as never);
  await w.runtime.start(approval, {}, { executionId: "approve-nightly", principal: OPERATOR });
  await until(
    async () => (await w.runtime.loadState("approve-nightly"))?.status === "suspended",
    "the approval to park"
  );
  const grant = await answerScheduleApproval(
    w.runtime,
    w.broker,
    "approve-nightly",
    { approved: true },
    undefined,
    {
      expect: { issuedTo: "svc-digest", tenant: "acme" },
      now: () => w.clock.t,
      requireVerifiedApproval: true,
    }
  );

  // 2. The timer service asks the broker for each occurrence's principal; a skipped tick is reported, never run anonymously.
  const nightly = schedule$({
    id: SCHEDULE,
    cron: "* * * * *",
    flowId: "nightly-tick",
    input: { prompt: P_TICK },
  });
  const errors: unknown[] = [];
  const service = new TimerService(w.runtime, w.timerStore, {
    schedules: [nightly],
    now: () => w.clock.t,
    principalFor: schedulePrincipalFor(w.broker, { lease: { calls: 5 }, now: () => w.clock.t }),
    onError: (_id, e) => void errors.push(e),
  });
  const first = (Math.floor(T0 / MINUTE) + 1) * MINUTE;
  const ticks: { occurrence: number; id: string; status: string | undefined; settled: boolean }[] =
    [];
  for (let i = 0; i < 4; i++) {
    const occurrence = first + i * MINUTE;
    const id = `${SCHEDULE}@${occurrence}`;
    w.clock.t = occurrence;
    const before = errors.length;
    await service.tick(occurrence);
    const skipped = errors.length > before; // the hook refused: nothing was started
    const status = skipped ? undefined : (await settled(w.runtime, id)).status;
    // 3. A completed tick returns its unused lease to the schedule's headroom (once).
    const refunded =
      refund &&
      status === "completed" &&
      (await settleScheduledTick(w.runtime, w.broker, SCHEDULE, occurrence));
    ticks.push({ occurrence, id, status, settled: refunded });
  }
  return { w, grant, ticks, errors, events: (id: string) => w.events(id) };
}
