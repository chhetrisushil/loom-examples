import type { BindingStatus } from "@loom/blueprint-runtime";
import type { EventEnvelope } from "@loom/core";
import type { Projection } from "@loom/projection-runtime";

// ── The app's own read-model ──────────────────────────────────────────────────
// One projection holds, per widget key, the VALUE the widget shows and the STATUS of its
// delivery — in the same state object, so a Blueprint binding can name both with two paths
// (`values.<key>` and `status.<key>`, ADR 0097 D2). Nothing here knows about renderers: the
// fold records what the providers did; the Blueprint says where the renderer should look.

export const HEALTH_PROJECTION_ID = "health";
export const HEALTH_PROJECTION_VERSION = "1.0.0";

export interface HealthState {
  readonly values: Readonly<Record<string, unknown>>;
  readonly status: Readonly<Record<string, BindingStatus>>;
}

export type HealthEventType =
  | "health.delivered" // a provider produced a value → ready (value replaced)
  | "health.failed" // a provider failed → error (last value RETAINED, not shown)
  | "health.drifted" // a provider's output no longer matches → stale (last value shown, marked)
  | "health.requested"; // a refresh is in flight → pending (last value shown, marked)

export interface HealthPayload {
  readonly key: string;
  readonly value?: unknown;
  readonly message?: string;
}

const withStatus = (s: HealthState, key: string, status: BindingStatus): HealthState => ({
  ...s,
  status: { ...s.status, [key]: status },
});

const payloadOf = (e: EventEnvelope): HealthPayload => e.payload as HealthPayload;

export const healthProjection: Projection<HealthState> = {
  id: HEALTH_PROJECTION_ID,
  version: HEALTH_PROJECTION_VERSION,
  initialState: { values: {}, status: {} },
  handlers: {
    "health.delivered": (s, e) => {
      const { key, value } = payloadOf(e);
      return {
        values: { ...s.values, [key]: value },
        status: { ...s.status, [key]: { state: "ready", seq: e.sequence } },
      };
    },
    "health.failed": (s, e) => {
      const { key, message } = payloadOf(e);
      return withStatus(s, key, {
        state: "error",
        seq: e.sequence,
        finding: { code: "provider-failed", message: message ?? "provider failed" },
      });
    },
    "health.drifted": (s, e) => {
      const { key, message } = payloadOf(e);
      return withStatus(s, key, {
        state: "stale",
        seq: e.sequence,
        finding: { code: "drift", message: message ?? "output drifted" },
      });
    },
    "health.requested": (s, e) =>
      withStatus(s, payloadOf(e).key, { state: "pending", seq: e.sequence }),
  },
};

/** Build one health event; `sequence` is what the fold stamps into `status.<key>.seq`. */
export function healthEvent(
  executionId: string,
  sequence: number,
  eventType: HealthEventType,
  payload: HealthPayload
): EventEnvelope {
  return {
    id: `health-${sequence}`,
    workflowId: "health-board",
    executionId,
    eventType,
    sequence,
    timestamp: sequence,
    payload,
  };
}

/**
 * The scripted scenario: every row of the canonical status matrix, in order, on the latency
 * widget — ready → error (value retained) → stale → pending → a value that breaks the app's
 * contract → error outranking the contract → ready again — while the other widgets deliver once.
 */
export function scenario(executionId: string): EventEnvelope[] {
  const ev = (seq: number, type: HealthEventType, payload: HealthPayload) =>
    healthEvent(executionId, seq, type, payload);
  return [
    ev(1, "health.delivered", { key: "latency", value: 412 }),
    ev(2, "health.delivered", { key: "ingest", value: "ok" }),
    ev(3, "health.delivered", { key: "disk", value: 73 }),
    ev(4, "health.delivered", {
      key: "errors",
      value: [
        { code: "E_TIMEOUT", count: 41 },
        { code: "E_CONN_RESET", count: 7 },
      ],
    }),
    ev(5, "health.failed", { key: "latency", message: "latency probe timed out" }),
    ev(6, "health.drifted", { key: "latency", message: "probe output shape changed" }),
    ev(7, "health.requested", { key: "latency" }),
    ev(8, "health.delivered", { key: "latency", value: "oops" }),
    ev(9, "health.failed", { key: "latency", message: "latency probe timed out" }),
    ev(10, "health.delivered", { key: "queue", value: 17 }),
    ev(11, "health.delivered", { key: "latency", value: 398 }),
  ];
}
