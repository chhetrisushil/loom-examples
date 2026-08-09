import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

// ── A release-approval flow whose surface keeps moving while a human deliberates ─
//
// The domain is incidental; the *shape* is the point. This gate can stay open for
// a long time, and the surface behind it is not frozen — CI keeps reporting. So by
// the time someone clicks Approve, the thing they looked at may not be the thing
// they are approving.
//
// The flow therefore does not treat an approval as self-evidently valid. It reads
// the provenance the View carried (which surface revision was on screen) and
// decides, in-domain, whether that decision still stands.

const releaseInput = z.object({ releaseId: z.string(), title: z.string() });
const releaseOutput = z.object({
  releaseId: z.string(),
  shipped: z.boolean(),
  approvedBy: z.string(),
  reviewRounds: z.number(),
});

export type ReleaseInput = z.infer<typeof releaseInput>;
export type ReleaseOutput = z.infer<typeof releaseOutput>;

/** The single gate this flow suspends on. Both signals arrive through it. */
export const RELEASE_SIGNAL = "ReleaseSignal";

/**
 * What a resume carries. `approval` is raised by the View's Approve button;
 * `check-failed` is CI reporting while the gate is still open.
 *
 * `stale` is computed at the TRUST BOUNDARY (the MCP tool handler, which owns the
 * event store) rather than inside the flow: `seenSequence` is a claim made by an
 * untrusted client, and the head sequence it must be judged against is a property
 * of the log, not of the runner. The flow receives the verdict plus both numbers
 * as evidence and keeps the *policy* — which is the split that matters.
 */
// Declared as a SCHEMA and inferred back into the type. The MCP tool handler that produces
// this signal receives `args: unknown` from an untrusted client, so this is the one gate in
// the repo with a real external boundary in front of it — `resumeSchemas` (ADR 0077) parses
// the payload before it reaches the durable log, and the union's discriminant is checked too.
export const ReleaseSignalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check-failed"), check: z.string() }),
  z.object({
    kind: z.literal("approval"),
    approver: z.string(),
    stale: z.boolean(),
    seenSequence: z.number().optional(),
    headSequence: z.number(),
  }),
]);
export type ReleaseSignal = z.infer<typeof ReleaseSignalSchema>;

export const ShipStep = step$({
  id: "ship",
  inputSchema: z.object({ releaseId: z.string() }),
  outputSchema: z.object({ shipped: z.boolean() }),
  handler: handler$(async () => ({ shipped: true })),
});

export const ScanChecksStep = step$({
  id: "scan-checks",
  inputSchema: z.object({ releaseId: z.string() }),
  outputSchema: z.object({ checks: z.array(z.string()) }),
  // Deterministic — no RNG, so the demo output is stable and replay-safe.
  handler: handler$(async () => ({ checks: ["build ✓", "unit ✓", "lint ✓"] })),
});

export const ReleaseFlow = flow$({
  id: "release-approval",
  name: "Release Approval",
  version: "1.0.0",
  inputSchema: releaseInput,
  outputSchema: releaseOutput,
  steps: [ScanChecksStep, ShipStep],
  resumeSchemas: { [RELEASE_SIGNAL]: ReleaseSignalSchema },
});

const runner: FlowRunner<ReleaseInput, ReleaseOutput> = async (ctx, input) => {
  ctx.ui.set("title", input.title);
  ctx.ui.set("releaseId", input.releaseId);
  ctx.ui.set("status", "scanning");

  const scanned = await ctx.run(ScanChecksStep, { releaseId: input.releaseId });
  ctx.ui.set("checks", scanned.checks);
  ctx.ui.set("failing", 0);
  ctx.ui.set("status", "awaiting-approval");
  ctx.ui.set("notice", "");

  let approver = "";
  let reviewRounds = 0;

  // The gate loop. `ctx.suspend` is positional for replay (ADR 0057), so looping
  // over it is replay-safe — each pass folds the resume event recorded for it.
  for (;;) {
    const signal = await ctx.suspend<ReleaseSignal>({
      on: RELEASE_SIGNAL,
      correlationKey: input.releaseId,
    });

    if (signal.kind === "check-failed") {
      // CI reported while the human was deliberating. The surface moves; anyone
      // holding a rendered view is now looking at history.
      ctx.ui.append("checks", `${signal.check} ✗`);
      ctx.ui.increment("failing");
      ctx.ui.set("notice", `New failure: ${signal.check}`);
      continue;
    }

    reviewRounds += 1;

    if (signal.stale) {
      // The decision was made against an older surface. Refusing is a DOMAIN
      // choice — this release gate holds that an approval must be based on the
      // current check set. A different flow could legitimately accept it.
      ctx.ui.set("status", "re-review");
      ctx.ui.set(
        "notice",
        `Approval ignored — it was based on revision ${signal.seenSequence ?? "unknown"}, ` +
          `but the checks changed (now at ${signal.headSequence}). Please re-review.`
      );
      continue;
    }

    approver = signal.approver;
    break;
  }

  ctx.ui.set("status", "shipping");
  ctx.ui.set("notice", "");
  const shipped = await ctx.run(ShipStep, { releaseId: input.releaseId });
  ctx.ui.set("status", "shipped");

  return {
    releaseId: input.releaseId,
    shipped: shipped.shipped,
    approvedBy: approver,
    reviewRounds,
  };
};

export const RegisteredReleaseFlow: RegisteredFlow = {
  definition: ReleaseFlow,
  runner: runner as FlowRunner<unknown, unknown>,
};
