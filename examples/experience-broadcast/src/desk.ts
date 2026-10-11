import { createHmac } from "node:crypto";
import {
  type CompileResult,
  type Experience,
  type MCPToolNode,
  type Operation,
  type ProviderSpec,
  type Surface,
  type Viewer,
  compile,
  genesis,
  orderKeyBetween,
  replay,
} from "@loom-ui/core";
import type { Audience } from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  type HandleInventory,
  type HandleLoadRequest,
  HydrationCache,
  type RevisionFn,
  type ServeOptions,
  type TransientInvoker,
  handleInventory,
  serveHandles,
} from "@loom-ui/hydration";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { catalog } from "./catalog";

// ── One Experience, two audiences ─────────────────────────────────────────────
// The support desk's board is authored ONCE. Three of its widgets are open to anyone; two are
// classified: the escalated customers' names are `sensitive`, the refund exposure `secret`. The
// agent at their own desk is cleared for both; the lobby wallboard, a screen anyone walks past, is a
// BROADCAST: whoever happens to be logged in on the machine that drives it, the ceiling is the
// lowest class, so both classified widgets are withheld there.

/** Everything the classified widgets would say: none of it may reach the wallboard. */
export const SECRETS = {
  customerA: "Harborview Dental Group",
  customerB: "Quillfeather Logistics",
  refundTotal: 48_275,
  refundWord: "Refund exposure",
  escalatedWord: "Escalated customers",
  refundTool: "billing.refund_exposure",
  escalatedTool: "crm.escalated_customers",
} as const;

export const TITLES = {
  open: "Open tickets",
  sla: "SLA",
  escalated: SECRETS.escalatedWord,
  refunds: SECRETS.refundWord,
  note: "Handover",
} as const;

const TOOL_PINS: Record<string, string> = {
  "desk.open_tickets": "sha256:open-v1",
  "desk.sla": "sha256:sla-v1",
  [SECRETS.escalatedTool]: "sha256:escalated-v1",
  [SECRETS.refundTool]: "sha256:refund-v1",
};

/** A simulated MCP tool server. It records every call: a withheld handle's tool must never be among them. */
export class DeskTools implements TransientInvoker {
  readonly calls: string[] = [];
  async invokeTransient<TIn, TOut>(toolId: string, input: TIn): Promise<TOut> {
    if (toolId !== MCP_INVOKE_TOOL_ID) throw new Error(`no transient tool "${toolId}"`);
    const { toolName } = input as unknown as { toolName: string };
    this.calls.push(toolName);
    return this.answer(toolName) as TOut;
  }
  private answer(tool: string): unknown {
    switch (tool) {
      case "desk.open_tickets":
        return {
          value: 37,
          unit: "tickets",
          label: "waiting",
          format: { semanticType: "integer" },
        };
      case "desk.sla":
        return { level: "ok", headline: "Within SLA", detail: "Median first reply 6 min." };
      case SECRETS.escalatedTool:
        return {
          columns: ["Customer", "Open for"],
          rows: [
            [SECRETS.customerA, "3 days"],
            [SECRETS.customerB, "5 days"],
          ],
        };
      case SECRETS.refundTool:
        return { value: SECRETS.refundTotal, unit: "EUR", format: { semanticType: "integer" } };
      default:
        throw new Error(`no tool "${tool}"`);
    }
  }
}

const step = (tool: string): MCPToolNode => ({
  stepId: "read",
  toolName: tool,
  toolVersion: "1.0.0",
  toolSchemaHash: TOOL_PINS[tool] ?? "",
  arguments: {},
  dependsOn: [],
  idempotent: true,
});
const provider = (handle: string, tool: string): ProviderSpec => ({
  handle,
  executionGraph: [step(tool)],
  reshaping: { engine: "JSONPath", scriptRef: "$" },
  outputShapeHash: "",
  outputCheck: "contract",
  cachePolicy: { ttlSeconds: 60, scope: "global" },
});

const LAYOUT = [
  { id: "open", type: "OpenTickets", tool: "desk.open_tickets", span: 4 },
  { id: "sla", type: "SlaStatus", tool: "desk.sla", span: 8 },
  {
    id: "escalated",
    type: "EscalatedCustomers",
    tool: SECRETS.escalatedTool,
    span: 8,
    cls: "sensitive" as const,
  },
  {
    id: "refunds",
    type: "RefundExposure",
    tool: SECRETS.refundTool,
    span: 4,
    cls: "secret" as const,
  },
] as const;

/** The board, as operations over a genesis. The classified widgets say so on their bindings. */
export function deskBoard(): Experience {
  const g = genesis({
    experienceId: "support-desk",
    intent: { objective: "Run the support desk", source: "application" },
    meta: { author: "example", createdAt: "2026-10-11T00:00:00Z", sourceKind: "example" },
  });
  const ops: Operation[] = LAYOUT.map((n) => ({
    type: "remapProvider" as const,
    handle: n.id,
    spec: provider(n.id, n.tool),
  }));
  let order: string | null = null;
  const insert = (id: string, type: string, span: number, props: Record<string, unknown> = {}) => {
    order = orderKeyBetween(order, null);
    ops.push({
      type: "insertNode",
      parentId: "root",
      node: {
        id,
        order,
        kind: "semantic",
        type,
        typeVersion: "1.0.0",
        span,
        label: { key: `desk.${id}`, fallback: TITLES[id as keyof typeof TITLES] },
        props,
      },
    });
  };
  for (const n of LAYOUT) {
    insert(n.id, n.type, n.span);
    ops.push({
      type: "bindProvider",
      nodeId: n.id,
      handle: n.id,
      ...("cls" in n && { sensitivity: n.cls }),
    });
  }
  insert("note", "HandoverNote", 12, {
    text: { key: "desk.note.text", fallback: "Night shift: two callbacks promised." },
  });
  const built = replay(g, ops);
  if (!built.ok) throw new Error(built.finding.message);
  return seal(built.value);
}

// ── The server: one Experience, one policy, every audience ───────────────────
// DEMO ONLY: a fixed revision key so the example is deterministic. In production it lives in a secret store.
const REVISION_KEY = "experience-broadcast-demo-key-do-not-use-in-production";
const revisionOf: RevisionFn = (handle, fingerprint) =>
  createHmac("sha256", REVISION_KEY).update(`${handle}\u0000${fingerprint}`).digest("hex");
/** A fixed alias key (>= 16 bytes) so withheld widgets keep stable `r_` ids across compiles. DEMO ONLY. */
const PLACEHOLDER_KEY = "experience-broadcast-alias-key-demo-only";

export interface OpenedSurface {
  readonly compiled: CompileResult;
  readonly inventory: HandleInventory;
}

export class DeskServer {
  readonly tools = new DeskTools();
  /** The server's own log of refusals (real handle names): never what a client sees. */
  readonly refused: string[] = [];
  readonly experience = deskBoard();
  private readonly cache = new HydrationCache(() => 0);

  /** What a page GET returns for one audience: the compiled Blueprint and the handles it may ask for. */
  open(surface: Surface, audience: Audience, viewer: Viewer): OpenedSurface {
    const compiled = compile(this.experience, {
      surface,
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
      viewer,
      audience,
      placeholderKey: PLACEHOLDER_KEY,
    });
    const { inventory } = handleInventory(this.experience, { revisionOf, viewer, audience });
    return { compiled, inventory };
  }

  /** The batch endpoint, with the SAME audience and viewer `open` used. */
  async hydrate(body: string, audience: Audience, viewer: Viewer): Promise<string> {
    const requests = JSON.parse(body) as HandleLoadRequest[];
    const options: ServeOptions = {
      invoker: this.tools,
      now: 0,
      outputKinds: { catalog, surface: "web" },
      contentRefArgs: "none",
      cache: this.cache,
      viewer,
      audience,
      onFinding: (handle, finding) => {
        if (finding.code === "restricted") this.refused.push(handle);
      },
    };
    return JSON.stringify(await serveHandles(this.experience, requests, options));
  }
}
