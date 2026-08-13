import { type LoomApp, defineConfig } from "@loom/app";
import type { ResumeAuthenticator } from "@loom/workflow-runtime";
import { RELEASE_SIGNAL, RegisteredReleaseFlow } from "./flow";

/**
 * K12 — the kernel-side check that an approval really came from the trust
 * boundary.
 *
 * `src/server.ts` stamps `approver: "mcp-app-view"` itself, so a View cannot
 * forge an approver name. But that is a property of ONE code path: without an
 * authenticator, any holder of the runtime can resume this gate with a
 * hand-made ReleaseSignal and the kernel will accept it. Wiring one makes "only
 * the boundary may approve" a rule the KERNEL enforces rather than a convention
 * the server happens to follow.
 *
 * A real deployment verifies a signature or a session token here. The identity
 * list is this demo's stand-in, and is deterministic so replays stay stable.
 *
 * Note what is deliberately `not-applicable`: CI's `check-failed` signal carries
 * no authority claim, so it is not an approval to verify — returning `rejected`
 * for it would break a legitimate path.
 */
const RELEASE_APPROVERS = new Set(["mcp-app-view"]);

export const releaseResumeAuthenticator: ResumeAuthenticator = {
  verify(event) {
    if (event.eventType !== RELEASE_SIGNAL) return { status: "not-applicable" };
    const payload = (event.payload ?? {}) as { kind?: string; approver?: string };
    if (payload.kind !== "approval") return { status: "not-applicable" };
    const approver = payload.approver;
    if (typeof approver !== "string" || !RELEASE_APPROVERS.has(approver)) {
      return { status: "rejected", reason: `"${String(approver)}" may not approve a release` };
    }
    return { status: "verified", actor: approver, verifiedBy: "release-approver-list" };
  },
};

// ── Composition root ─────────────────────────────────────────────────────────
//
// In-memory stores, the WorkflowRuntime, and the native "ui" agent surface the
// flow drives via `ctx.ui.*`.
//
// Nothing MCP-specific is wired here. `@loom/plugin-mcp-app` folds the raw event
// stream itself, so it works against any Loom app that emits surface patches —
// the same property that let the A2UI adapter stay a pure read-side projection.
// Serving is composed separately, in src/server.ts.
export function buildApp(): LoomApp {
  return defineConfig({
    storage: { kind: "memory" },
    flows: [RegisteredReleaseFlow],
    surfaces: ["ui"],
    security: { resumeAuthenticator: releaseResumeAuthenticator },
    // Pre-flight rules (@loom/verify) at boot. "warn" prints findings without
    // blocking; `loom verify --config dist/app.js` exits non-zero for CI, and
    // `loom doctor` runs this plus the flow-graph and claim-check passes.
    //
    // Worth having HERE specifically: this flow suspends on a human approval
    // gate, which is what suspension-safety and the K12 ResumeAuthenticator
    // check are about.
    checks: { verify: "warn" },
  });
}
