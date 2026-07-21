import { TypedFailure } from "@loom/core";
import type { FlowDefinition } from "@loom/core";
import { CHILD_FAILED, awaitAll, awaitChild, awaitChildren } from "@loom/orchestration";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// A release pipeline, built entirely from child workflows. The `release` parent
// spawns SEPARATE child executions and durably awaits them — each child has its own
// event log, its own replay, its own failure. Three primitives, three shapes of
// "await the children":
//
//   1. awaitChildren — build every service CONCURRENTLY, tolerate partial failure.
//      Returns a SETTLED ChildResult[] (input order); the parent proceeds with
//      whatever built and reports the rest. A flaky service does not sink the release.
//   2. awaitAll — smoke-test the built services, ALL-OR-NOTHING. If any test fails,
//      awaitAll throws `childFailed` and the parent aborts the release before publish.
//   3. awaitChild — publish ONE manifest. A single child, awaited for its output;
//      it would throw `childFailed` if publishing failed.
//
// Everything is durable and replay-safe: each spawn is fixed by ctx.decide, child
// ids are deterministic (`<parent>::<key>#<i>`), and the pipeline rides ONE
// suspend/resume cycle per await — no new syscall, no new event type.
// ─────────────────────────────────────────────────────────────────────────────

// ── Child: build one service. Fails (throws) when the service is flagged `failBuild`. ──
export interface BuildIn {
  service: string;
  failBuild?: boolean | undefined;
}
export interface BuildOut {
  service: string;
  artifact: string;
}
const buildRunner: FlowRunner<BuildIn, BuildOut> = async (_ctx, input) => {
  if (input.failBuild) throw new Error(`build failed for ${input.service}`);
  return { service: input.service, artifact: `${input.service}@1.0.0` };
};

// ── Child: smoke-test one service. Fails (throws) when flagged `failSmoke`. ──
export interface SmokeIn {
  service: string;
  failSmoke?: boolean | undefined;
}
export interface SmokeOut {
  service: string;
  ok: true;
}
const smokeRunner: FlowRunner<SmokeIn, SmokeOut> = async (_ctx, input) => {
  if (input.failSmoke) throw new Error(`smoke test failed for ${input.service}`);
  return { service: input.service, ok: true };
};

// ── Child: publish a single manifest for the shipped services. ──
export interface PublishIn {
  services: string[];
}
export interface PublishOut {
  manifest: string;
  count: number;
}
const publishRunner: FlowRunner<PublishIn, PublishOut> = async (_ctx, input) => ({
  manifest: input.services.length > 0 ? input.services.join(",") : "(empty)",
  count: input.services.length,
});

// ── Parent: the release pipeline. ──
export interface ServiceSpec {
  name: string;
  failBuild?: boolean | undefined;
  failSmoke?: boolean | undefined;
}
export interface ReleaseIn {
  services: ServiceSpec[];
}
export interface ReleaseOut {
  built: string[];
  buildFailures: string[];
  /** Present iff the release was NOT aborted at the smoke gate. */
  published?: PublishOut | undefined;
  /** The service whose smoke test aborted the release, if any. */
  smokeAbortedOn?: string | undefined;
}

const releaseRunner: FlowRunner<ReleaseIn, ReleaseOut> = async (ctx, input) => {
  // 1) BUILD every service concurrently, tolerating partial failure (settled results).
  const builds = await awaitChildren<BuildOut>(ctx, {
    key: "build",
    children: input.services.map((s) => ({
      flowId: "build",
      input: { service: s.name, failBuild: s.failBuild } satisfies BuildIn,
    })),
  });
  const built: string[] = [];
  const buildFailures: string[] = [];
  builds.forEach((result, i) => {
    // `built`/`buildFailures` derive purely from the LOGGED settled results and the
    // logged input order — so they are identical on replay (ADR 0061 identity rule).
    if (result.status === "completed") built.push(result.output.service);
    else buildFailures.push(input.services[i]!.name);
  });

  // 2) SMOKE-TEST the built services as an all-or-nothing gate. `built` came from step 1's
  //    logged results, so the fan-out here is deterministic across replay.
  if (built.length > 0) {
    try {
      await awaitAll<SmokeOut>(ctx, {
        key: "smoke",
        children: built.map((name) => ({
          flowId: "smoke",
          input: {
            service: name,
            failSmoke: input.services.find((s) => s.name === name)?.failSmoke,
          } satisfies SmokeIn,
        })),
      });
    } catch (err) {
      // awaitAll throws the SAME typed failure awaitChild throws — catch it and abort the
      // release cleanly instead of publishing a half-tested set.
      if (err instanceof TypedFailure && err.channel === CHILD_FAILED) {
        const failed = err.payload as { index: number };
        return { built, buildFailures, smokeAbortedOn: built[failed.index] };
      }
      throw err;
    }
  }

  // 3) PUBLISH a single manifest for everything that built and passed smoke.
  const published = await awaitChild<PublishOut>(ctx, {
    key: "publish",
    flowId: "publish",
    input: { services: built } satisfies PublishIn,
  });

  return { built, buildFailures, published };
};

// ── Flow definitions + a registry the supervisor and runtime share. ──
function defineFlow<I, O>(
  id: string,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
  runner: FlowRunner<I, O>
): RegisteredFlow<I, O> {
  return {
    definition: {
      _tag: "FlowDefinition",
      id,
      name: id,
      version: "1.0.0",
      inputSchema,
      outputSchema,
      steps: [],
    } satisfies FlowDefinition<I, O>,
    runner,
  } as RegisteredFlow<I, O>;
}

const serviceSpec = z.object({
  name: z.string(),
  failBuild: z.boolean().optional(),
  failSmoke: z.boolean().optional(),
});

export const buildFlow = defineFlow<BuildIn, BuildOut>(
  "build",
  z.object({ service: z.string(), failBuild: z.boolean().optional() }),
  z.object({ service: z.string(), artifact: z.string() }),
  buildRunner
);
export const smokeFlow = defineFlow<SmokeIn, SmokeOut>(
  "smoke",
  z.object({ service: z.string(), failSmoke: z.boolean().optional() }),
  z.object({ service: z.string(), ok: z.literal(true) }),
  smokeRunner
);
export const publishFlow = defineFlow<PublishIn, PublishOut>(
  "publish",
  z.object({ services: z.array(z.string()) }),
  z.object({ manifest: z.string(), count: z.number() }),
  publishRunner
);
export const releaseFlow = defineFlow<ReleaseIn, ReleaseOut>(
  "release",
  z.object({ services: z.array(serviceSpec) }),
  z.object({
    built: z.array(z.string()),
    buildFailures: z.array(z.string()),
    published: z.object({ manifest: z.string(), count: z.number() }).optional(),
    smokeAbortedOn: z.string().optional(),
  }),
  releaseRunner
);

/** Child flows the supervisor starts by recorded flowId (the parent is started directly). */
export const childFlows: Record<string, RegisteredFlow> = {
  build: buildFlow as RegisteredFlow,
  smoke: smokeFlow as RegisteredFlow,
  publish: publishFlow as RegisteredFlow,
};
