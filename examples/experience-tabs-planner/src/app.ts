import {
  type ContainerNode,
  type Experience,
  type Finding,
  type Intent,
  type Operation,
  REFERENCE_CONTAINER_ROLES,
  type Viewer,
  compile,
  emptyLedger,
  explainNode,
  genesis,
  orderKeyAfterAll,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  HydrationController,
  HydrationStore,
} from "@loom-ui/hydration";
import { type PlanResult, type PlannerModel, ReferencePlanner } from "@loom-ui/planner";
import { referenceContainers } from "@loom-ui/renderer-lit/containers";
import { type DomRenderHandle, litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
import type { Blueprint } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { catalog } from "./catalog";
import { memoryDecide } from "./model";
import { TriageInvoker, capabilities, declaredToolClasses, readPolicy } from "./world";

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
  private readonly timers: Array<() => void> = [];
  private readonly controller: HydrationController;
  private handle: DomRenderHandle | undefined;
  private exp: Experience | undefined;

  constructor(
    readonly model: PlannerModel,
    readonly viewer: Viewer = LEAD
  ) {
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
      const built = replay(genesis({ experienceId: EXPERIENCE_ID, intent, meta }), result.ops);
      if (!built.ok) throw new Error(built.finding.message);
      await this.show(seal(built.value));
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
    if (result.ops.length > 0) await this.apply(result.ops);
    return result;
  }

  /** Ops the APPLICATION authors (not the planner's): folded on and drawn the same way. */
  async apply(ops: readonly Operation[]): Promise<void> {
    const next = replay(this.experience, ops);
    if (!next.ok) throw new Error(next.finding.message);
    await this.show(seal(next.value));
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

  /** `explainNode` for this view's viewer, with the host's read policy bound. */
  explain(nodeId: string) {
    return explainNode(this.experience, nodeId, {
      viewer: this.viewer,
      ledger: emptyLedger(),
      declaredToolClasses,
    });
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
      declaredToolClasses,
    });
    if (!r.ok) throw new Error(`compile (${surface}): ${r.findings.map(msg).join("; ")}`);
    return r.blueprint;
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

const msg = (f: Finding): string => `${f.code}: ${f.message}`;
