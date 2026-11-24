import type { AgentLoopConfig } from "@loomwork/agent";
import { reachOf, resolveVerifyInput } from "@loomwork/app";
import { type MintRequest, deriveGrant } from "@loomwork/task-authority";
import { verify } from "@loomwork/verify";
import {
  EMAIL,
  INCIDENTS,
  MODEL,
  PAGER,
  P_DIGEST,
  P_PAGE,
  RECALL,
  WRITE,
  errorsSeen,
} from "./model";
import { World, deniedReasons } from "./world";

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
