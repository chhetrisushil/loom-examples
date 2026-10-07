import {
  type ContainerNode,
  type Experience,
  type Finding,
  type Intent,
  type Operation,
  type Provenance,
  REFERENCE_CONTAINER_ROLES,
  type ReadPolicy,
  type RecordedOperation,
  type Viewer,
  compile,
  findNode,
  genesis,
  orderKeyAfterAll,
} from "@loom-ui/core";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationController,
  HydrationStore,
} from "@loom-ui/hydration";
import { InMemoryLineageStore, Lineage, type LineageResult } from "@loom-ui/lineage";
import {
  type PlanResult,
  type PlannerModel,
  ReferencePlanner,
  plannerProvenance,
  providerHandle,
} from "@loom-ui/planner";
import { referenceContainers } from "@loom-ui/renderer-lit/containers";
import { type DomRenderHandle, litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
import type { Blueprint } from "@loom/blueprint-runtime";
import { InMemoryContentStore } from "@loom/plugin-content";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { catalog } from "./catalog";
import { memoryDecide } from "./model";
import { TriageInvoker, capabilities, readPolicy as hostPolicy, refunds } from "./world";

export const EXPERIENCE_ID = "ticket-triage";

export const intent: Intent = { objective: "Triage today's support tickets", source: "user" };
export const meta: Experience["meta"] = {
  author: "triage-app",
  createdAt: "2026-10-07T00:00:00Z",
  sourceKind: "example",
};

/** Who looks at the view. Clearance is the host's claim; nothing here authenticates. */
export const LEAD: Viewer = { clearance: "secret" };
export const AGENT: Viewer = { clearance: "internal" };

/**
 * The triage view for ONE viewer: a planner that composes and revises it, the hydration that
 * feeds it, the web render (loom-ui's reference container renderers) and the terminal render.
 * The experience itself is never redacted — each render compiles it FOR the viewer.
 */
export class Triage {
  readonly runtime = new InMemoryProjectionRuntime();
  readonly store = new HydrationStore(this.runtime, { experienceId: EXPERIENCE_ID });
  readonly invoker = new TriageInvoker();
  readonly host: HTMLElement = document.createElement("div");
  readonly planner: ReferencePlanner;
  readonly ctx = memoryDecide();
  /** Every version this view goes through is recorded here; `explain` reads it back. */
  readonly lineage: Lineage;
  private readonly timers: Array<() => void> = [];
  private readonly controller: HydrationController;
  private handle: DomRenderHandle | undefined;
  private exp: Experience | undefined;

  constructor(
    readonly model: PlannerModel,
    readonly viewer: Viewer = LEAD,
    /** The host's read policy. Only the negative control passes anything but the declared table. */
    readonly readPolicy: ReadPolicy = hostPolicy
  ) {
    this.lineage = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
      readPolicy,
    });
    this.planner = new ReferencePlanner({ model, modelId: "scripted-triage", maxAttempts: 1 });
    this.controller = new HydrationController({
      invoker: this.invoker,
      store: this.store,
      viewer,
      readPolicy,
      setTimer: (fn) => {
        this.timers.push(fn);
        return () => {
          const i = this.timers.indexOf(fn);
          if (i >= 0) this.timers.splice(i, 1);
        };
      },
    });
    document.body.appendChild(this.host);
  }

  get experience(): Experience {
    if (this.exp === undefined) throw new Error("compose() first");
    return this.exp;
  }

  /** Compose, offering the reference container roles. Folds the ops and draws the result. */
  async compose(): Promise<PlanResult> {
    const result = await this.planner.compose(
      { intent, catalog, capabilities, containers: REFERENCE_CONTAINER_ROLES },
      this.ctx
    );
    if (result.ops.length > 0) {
      const start = must(
        await this.lineage.start(genesis({ experienceId: EXPERIENCE_ID, intent, meta }), HOST)
      );
      await this.record(
        start.experience.versionHash,
        result.ops,
        plannerProvenance(result, PLANNER)
      );
    }
    return result;
  }

  /** Revise: whatever the planner returns is folded on and drawn; a refusal returns no ops. */
  async revise(text: string): Promise<PlanResult> {
    const result = await this.planner.revise(
      {
        experience: this.experience,
        request: { text },
        catalog,
        capabilities,
        containers: REFERENCE_CONTAINER_ROLES,
      },
      this.ctx
    );
    if (result.ops.length > 0) {
      await this.record(
        this.experience.versionHash,
        result.ops,
        plannerProvenance(result, PLANNER)
      );
    }
    return result;
  }

  /** Ops the APPLICATION authors (not the planner's): folded on and drawn the same way. */
  async apply(ops: readonly Operation[]): Promise<void> {
    await this.record(this.experience.versionHash, ops, HOST);
  }

  /** The application's own container: a policy memo the planner must never edit. */
  async addEscalationPolicy(): Promise<void> {
    const root = this.experience.root as ContainerNode;
    await this.apply([
      {
        type: "insertNode",
        parentId: root.id,
        node: {
          id: "escalation_policy",
          order: orderKeyAfterAll(root.children),
          kind: "container",
          direction: "column",
          span: 12,
          title: { key: "triage.policy.title", fallback: "Escalation policy" },
          children: [
            {
              id: "policy_text",
              order: "a",
              kind: "semantic",
              type: "Memo",
              typeVersion: "1.0.0",
              span: 12,
              label: { key: "triage.policy.label", fallback: "Policy" },
              props: {
                text: {
                  key: "triage.policy.text",
                  fallback: "Page the on-call after two SLA breaches.",
                },
              },
            },
          ],
        },
      },
    ]);
  }

  /** `Lineage.explain` for this view's viewer; the lineage carries the host's bound read policy. */
  async explain(nodeId: string) {
    return must(await this.lineage.explain(EXPERIENCE_ID, nodeId, { viewer: this.viewer }));
  }

  /**
   * A card the application authors by hand on the refunds tool, in `panelId`: NO `sensitivity` of
   * its own (the planner never wrote it, so nothing stamped a class on it). Only the host's read
   * policy can keep it from a low-clearance viewer.
   */
  async addUnclassifiedRefundCard(panelId: string): Promise<void> {
    const handle = providerHandle(
      refunds.toolName,
      refunds.toolVersion,
      refunds.toolSchemaHash,
      {},
      "pending"
    );
    const panel = findNode(this.experience.root, panelId) as ContainerNode;
    await this.apply([
      {
        type: "remapProvider",
        handle,
        spec: {
          handle,
          executionGraph: [
            {
              stepId: "s1",
              toolName: refunds.toolName,
              toolVersion: refunds.toolVersion,
              toolSchemaHash: refunds.toolSchemaHash,
              arguments: {},
              dependsOn: [],
              idempotent: true,
            },
          ],
          reshaping: { engine: "JSONPath", scriptRef: "pending" },
          outputShapeHash: "fnv1a64:042b41495f5d90e6",
          cachePolicy: { ttlSeconds: 60, scope: "principal" },
        } as never,
      },
      {
        type: "insertNode",
        parentId: panelId,
        node: {
          id: "raw_refunds",
          order: orderKeyAfterAll(panel.children),
          kind: "semantic",
          type: "Metric",
          typeVersion: "1.0.0",
          span: 6,
          label: { key: "triage.raw_refunds.label", fallback: "Pending refunds" },
          props: { unit: "USD" },
          binding: { handle, priority: "P1" },
        } as never,
      },
    ]);
  }

  /** The terminal frame: every panel stacked, no chrome (a role is not a terminal concept). */
  terminal(): string {
    return renderExperience(this.blueprint("terminal"), this.store, {
      registry: terminalRegistry(),
    });
  }

  dispose(): void {
    this.handle?.dispose();
    this.controller.dispose();
    this.host.remove();
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────

  private blueprint(surface: "web" | "terminal"): Blueprint {
    const r = compile(this.experience, {
      surface,
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
      viewer: this.viewer,
      ...(this.readPolicy.declaredToolClasses !== undefined && {
        declaredToolClasses: this.readPolicy.declaredToolClasses,
      }),
    });
    if (!r.ok) throw new Error(`compile (${surface}): ${r.findings.map(msg).join("; ")}`);
    return r.blueprint;
  }

  /** Commit `ops` (authored by `by`) onto the lineage's head, then draw the version it produced. */
  private async record(head: string, ops: readonly Operation[], by: Provenance): Promise<void> {
    const at = new Date().toISOString();
    const recorded: RecordedOperation[] = ops.map((op) => ({ op, by, at }));
    const committed = must(
      await this.lineage.compose({
        experienceId: EXPERIENCE_ID,
        expectedHead: head,
        ops: recorded,
        by,
      })
    );
    await this.show(committed.experience);
  }

  private async show(next: Experience): Promise<void> {
    this.exp = next;
    const { findings } = this.controller.load(next);
    if (findings.length > 0) throw new Error(`hydration refused: ${findings.map(msg).join("; ")}`);
    const bp = this.blueprint("web");
    if (this.handle === undefined) {
      this.handle = renderBlueprintDom(this.host, bp, {
        projectionRuntime: this.runtime,
        executionId: this.store.executionId,
        registry: litRegistry,
        containers: referenceContainers(),
      });
    } else {
      this.handle.update(bp);
    }
    await this.settle();
  }

  /** Fire the batch timers and wait until nothing is in flight (deterministic, no wall clock). */
  private async settle(): Promise<void> {
    for (let round = 0; round < 50; round++) {
      for (const fn of this.timers.splice(0)) fn();
      await new Promise((r) => setTimeout(r, 0));
      if (this.timers.length === 0 && this.controller.inFlight().length === 0) return;
    }
    throw new Error("hydration did not settle");
  }
}

/** A refusal is a bug in the example: say so. */
function must<T>(r: LineageResult<T>): T {
  if (!r.ok) throw new Error(`lineage refused: ${JSON.stringify(r.refusal)}`);
  return r.value;
}

const HOST: Provenance = { source: "user", agentId: "triage-app" };
const PLANNER = { agentId: "triage-planner" } as const;

const msg = (f: Finding): string => `${f.code}: ${f.message}`;
