import type { LlmRequest } from "@loom/llm";
import type { ReasoningCache } from "@loom/reasoning";
import { TICKET_A, TICKET_B, TICKET_C, sawToolError } from "./model";
import {
  Backend,
  type Process,
  approve,
  boot,
  decisionsOf,
  outputOf,
  runTicket,
  settled,
  start,
} from "./world";

/** The tool_result parts of the last user message of a request. */
export function resultsOf(request: LlmRequest): { id: string; isError: boolean }[] {
  const last = request.messages[request.messages.length - 1];
  if (last === undefined || !Array.isArray(last.content)) return [];
  return last.content.flatMap((p) =>
    p.type === "tool_result" ? [{ id: p.toolUseId, isError: p.isError === true }] : []
  );
}

/** Every tool_result in the transcript of a request (not only the last message). */
export function allResultsOf(request: LlmRequest): { id: string; isError: boolean }[] {
  return request.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.flatMap((p) =>
          p.type === "tool_result" ? [{ id: p.toolUseId, isError: p.isError === true }] : []
        )
      : []
  );
}

/** The route id of every recorded routing decision, in log order. */
export async function routesOf(backend: Backend, executionId: string): Promise<string[]> {
  return decisionsOf(await backend.store.read(executionId))
    .filter((d) => /^reason:.*:route$/.test(d.decisionId))
    .map((d) => d.choice as string);
}

/** The error the execution failed with (EXECUTION_FAILED), if it did. */
export async function failureOf(
  backend: Backend,
  executionId: string
): Promise<string | undefined> {
  const e = (await backend.store.read(executionId)).find((x) => x.eventType === "EXECUTION_FAILED");
  return (e?.payload as { error?: string } | undefined)?.error;
}

export const mapCache = (): ReasoningCache => {
  const m = new Map<string, never>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v as never) };
};

export interface Acts {
  backend: Backend;
  /** Process 1: ticket A runs its lookups, then parks on the refund approval. */
  first: Process;
  /** Process 2: a fresh runtime over the same store resumes it. */
  second: Process;
  runsAtPark: Record<string, number>;
  runsAfterResume: Record<string, number>;
  modelCallsAtPark: Record<string, number>;
  modelCallsAfterResume: Record<string, number>;
  /** Process 3: ticket B in the same customer scope. */
  third: Process;
  /** A control: ticket B with an empty memory. */
  control: Process;
}

export async function runActs(): Promise<Acts> {
  const backend = new Backend();
  const first = boot({ backend, prompt: TICKET_A });
  await (await start(first, "ticket-1001")).waitForSuspend();
  const runsAtPark = { ...backend.runs };
  const modelCallsAtPark = { ...backend.modelCalls };

  const second = boot({ backend, prompt: TICKET_A }); // "restart": nothing carried over in memory
  await approve(second, "ticket-1001");
  const runsAfterResume = { ...backend.runs };
  const modelCallsAfterResume = { ...backend.modelCalls };

  const third = boot({ backend, prompt: TICKET_B });
  await runTicket(third, "ticket-1002");

  const control = boot({ backend: new Backend(), prompt: TICKET_B });
  await runTicket(control, "ticket-2001");
  return {
    backend,
    first,
    second,
    runsAtPark,
    runsAfterResume,
    modelCallsAtPark,
    modelCallsAfterResume,
    third,
    control,
  };
}

export { outputOf, runTicket, settled, sawToolError, TICKET_A, TICKET_B, TICKET_C };
