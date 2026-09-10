import type { EventEnvelope, FlowDefinition } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import { WorkflowRuntime } from "@loom/workflow-runtime";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import {
  INCIDENT_MITIGATED,
  INCIDENT_OPENED,
  SESSION_ENDED,
  SESSION_STARTED,
  SESSION_SUCCEEDED,
  type SuccessKind,
} from "./metrics";

// Phase 0's write side: the events the baseline report reads. Deliberately thin — a
// session's life, an explicit success, and an incident's open/mitigate pair. No
// adaptation happens here and none is measured; this exists to produce the distribution
// every later phase is judged against.

interface Recorded {
  recorded: true;
}
const recordedSchema = z.object({ recorded: z.literal(true) }) as z.ZodSchema<Recorded>;

function emitter<TIn extends Record<string, unknown>>(
  id: string,
  name: string,
  eventType: string,
  inputSchema: z.ZodSchema<TIn>
): { definition: FlowDefinition<TIn, Recorded>; runner: FlowRunner<TIn, Recorded> } {
  return {
    definition: {
      _tag: "FlowDefinition",
      id,
      name,
      version: "1.0.0",
      inputSchema,
      outputSchema: recordedSchema,
      steps: [],
    },
    runner: async (ctx, input) => {
      ctx.emit(eventType, input);
      return { recorded: true };
    },
  };
}

const startFlow = emitter(
  "session-start",
  "Start a session",
  SESSION_STARTED,
  z.object({
    sessionId: z.string(),
    tenant: z.string(),
    operator: z.string(),
    topic: z.string(),
    adaptive: z.boolean(),
    canonicalReason: z.string().optional(),
  })
);
const successFlow = emitter(
  "session-success",
  "Record an explicit success",
  SESSION_SUCCEEDED,
  z.object({ sessionId: z.string(), kind: z.string() })
);
const endFlow = emitter(
  "session-end",
  "End a session",
  SESSION_ENDED,
  z.object({ sessionId: z.string(), endedCanonical: z.boolean().optional() })
);
const incidentOpenFlow = emitter(
  "incident-open",
  "Open an incident",
  INCIDENT_OPENED,
  z.object({ incidentId: z.string(), resource: z.string(), adaptive: z.boolean() })
);
const incidentMitigatedFlow = emitter(
  "incident-mitigated",
  "Mitigate an incident",
  INCIDENT_MITIGATED,
  z.object({ incidentId: z.string(), resource: z.string(), adaptive: z.boolean() })
);

export interface SessionRecorder {
  start(session: {
    sessionId: string;
    tenant: string;
    operator: string;
    topic: string;
    adaptive: boolean;
    canonicalReason?: string;
  }): Promise<void>;
  /** An EXPLICIT success. There is no other way to be counted as one. */
  succeeded(sessionId: string, kind: SuccessKind): Promise<void>;
  ended(sessionId: string, endedCanonical?: boolean): Promise<void>;
  incidentOpened(incidentId: string, resource: string, adaptive: boolean): Promise<void>;
  incidentMitigated(incidentId: string, resource: string, adaptive: boolean): Promise<void>;
  /** Every event this recorder has written, for the report to read. */
  log(): Promise<EventEnvelope[]>;
}

export function createSessionRecorder(): SessionRecorder {
  const eventStore = new InMemoryAsyncEventStore();
  const runtime = new WorkflowRuntime({
    eventStore,
    snapshotStore: new InMemoryAsyncSnapshotStore(),
    effectRuntime: new EffectRuntime(),
  });

  const flows = [startFlow, successFlow, endFlow, incidentOpenFlow, incidentMitigatedFlow] as const;
  for (const flow of flows) {
    runtime.registerFlow(
      flow.definition as FlowDefinition<unknown, unknown>,
      flow.runner as FlowRunner<unknown, unknown>
    );
  }

  let n = 0;
  const run = async <TIn extends Record<string, unknown>>(
    flow: { definition: FlowDefinition<TIn, Recorded>; runner: FlowRunner<TIn, Recorded> },
    input: TIn
  ): Promise<void> => {
    const registered: RegisteredFlow<TIn, Recorded> = {
      definition: flow.definition,
      runner: flow.runner,
    };
    const handle = await runtime.start(registered, input, { executionId: `evt-${++n}` });
    await handle.waitForCompletion();
  };

  return {
    start: (session) => run(startFlow, session as never),
    succeeded: (sessionId, kind) => run(successFlow, { sessionId, kind } as never),
    ended: (sessionId, endedCanonical) =>
      run(endFlow, { sessionId, ...(endedCanonical !== undefined && { endedCanonical }) } as never),
    incidentOpened: (incidentId, resource, adaptive) =>
      run(incidentOpenFlow, { incidentId, resource, adaptive } as never),
    incidentMitigated: (incidentId, resource, adaptive) =>
      run(incidentMitigatedFlow, { incidentId, resource, adaptive } as never),
    async log() {
      const ids = await eventStore.listExecutions();
      const logs = await Promise.all(ids.map((id) => eventStore.read(id)));
      // Ordered by time, because the report reads first-use and open/mitigate PAIRS out of
      // a single pass and would otherwise depend on which execution happened to be read
      // first.
      return logs.flat().sort((a, b) => a.timestamp - b.timestamp || a.sequence - b.sequence);
    },
  };
}
