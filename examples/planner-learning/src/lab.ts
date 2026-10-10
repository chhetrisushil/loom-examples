import {
  type Intent,
  type Operation,
  type Provenance,
  REFERENCE_CONTAINER_ROLES,
  type Viewer as UiViewer,
  genesis,
  snapshotSeen,
} from "@loom-ui/core";
import { SIGNAL_VERSION } from "@loom-ui/core/signals";
import {
  DecisionLinks,
  type DecisionRef,
  InMemoryVoteLog,
  type IngestResult,
  SignalIngestor,
  VoteLedger,
  defaultReward,
  linkFromLedger,
  seenLogExposure,
  settleRewards,
  unitAlias,
} from "@loom-ui/learning";
import {
  InMemoryLineageStore,
  InMemorySeenKeyStore,
  Lineage,
  SeenLog,
  eventStoreLineageStore,
  seenStoreOptions,
} from "@loom-ui/lineage";
import { ReferencePlanner, plannerProvenance } from "@loom-ui/planner";
import { flow$ } from "@loom/core";
import { EffectRuntime } from "@loom/effect-runtime";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import {
  InMemoryPolicyKv,
  PolicyRegistry,
  type PromotionThresholds,
  type Trajectory,
  decideWithRollout,
  trajectories,
} from "@loom/learning";
import { InMemoryContentStore } from "@loom/plugin-content";
import { InMemoryAsyncSnapshotStore } from "@loom/snapshot-runtime";
import {
  type FlowRunner,
  type RegisteredFlow,
  WorkflowRuntime,
  executionAccessPolicy,
} from "@loom/workflow-runtime";
import { z } from "zod";
import { POLICY_ID, PolicyBook, versionHash } from "./policies";
import {
  type Epoch,
  LAYOUTS,
  type Layout,
  NODES,
  SEGMENTS,
  type Segment,
  TENANT,
  appeal,
  capabilities,
  catalog,
  replies,
  scriptedModel,
  seededRng,
  stars,
} from "./world";

// ── The lab: one process holding every moving part of the loop ───────────────────────────────
//
//   planner turn (flow)  -> decideWithRollout picks the LAYOUT through the registry
//                        -> ReferencePlanner composes the surface in that layout
//   host publishes it    -> Lineage version, DecisionLink (execution + decision), views in SeenLog
//   viewers vote         -> SignalIngestor (authenticated viewer, exposure REQUIRED) -> VoteLedger
//   close                -> settleRewards: ONE late reward per decision, by a reward-pipeline principal
//   learn                -> trajectories -> evaluatePolicy (SNIPS + bootstrap) -> registry.promote

export const KEY = "planner-learning-pseudonym-key-0123456789";
export const BUCKET_SECRET = "planner-learning-bucket-secret";
export const REWARD_ID = "rating";

/** Registry thresholds: a FLOOR every promotion must clear (small, because the example is). */
export const GATE: PromotionThresholds = {
  minSteps: 50,
  minEffectiveSamples: 15,
  minUnits: 20,
  minLiftLowerBound: 0,
  minClusters: 20,
  intervalEstimator: "snips",
};
/** Bootstrap options every evaluation uses (seeded: the same log gives the same interval). */
export const BOOTSTRAP = { resamples: 400, seed: 11, level: 0.9 };

const owner = (actor: string) => ({ tenant: TENANT, actor });
const pipeline = { tenant: TENANT, actor: "reward-pipeline" };
const HOST = { source: "system" as const };
const intent: Intent = { objective: "Orders at a glance", source: "user" };
const meta = {
  author: "planner-learning",
  createdAt: "2026-10-10T00:00:00Z",
  sourceKind: "example",
};
const viewerClearance: UiViewer = { clearance: "internal" };

const must = <T>(r: { ok: true; value: T } | { ok: false; refusal: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.refusal));
  return r.value;
};

export interface UserSpec {
  /** The host's user id. Never recorded: only its HMAC alias (the `unit`) reaches the log. */
  userId: string;
  segment: Segment;
}

export interface Surface {
  executionId: string;
  experienceId: string;
  versionHash: string;
  unit: string;
  segment: Segment;
  /** The layout actually served (what the flow returned). */
  served: Layout;
  ref: DecisionRef;
}

export interface Batch {
  label: string;
  epoch: Epoch;
  surfaces: Surface[];
}

export interface LabOptions {
  maxBatchesPerViewer?: number;
  viewersPerSurface?: number;
}

const flowIo = { inputSchema: z.any(), outputSchema: z.any() };

export class Lab {
  readonly eventStore = new InMemoryAsyncEventStore();
  readonly runtime: WorkflowRuntime;
  readonly registry = new PolicyRegistry({
    kv: new InMemoryPolicyKv(),
    scope: TENANT,
    thresholds: GATE,
  });
  readonly policies = new PolicyBook();
  readonly models = { flat: scriptedModel(replies.flat), tabs: scriptedModel(replies.tabs) };
  readonly lineage: Lineage;
  readonly seenLog: SeenLog;
  readonly links = new DecisionLinks();
  readonly ledger: VoteLedger;
  readonly ingestor: SignalIngestor;
  readonly flow: RegisteredFlow;
  private t = Date.parse("2026-10-10T09:00:00Z");
  private n = 0;
  private batchNo = 0;
  private readonly planners: Record<Layout, ReferencePlanner>;
  private readonly viewersPerSurface: number;

  constructor(opts: LabOptions = {}) {
    this.viewersPerSurface = opts.viewersPerSurface ?? 3;
    this.runtime = new WorkflowRuntime({
      eventStore: this.eventStore,
      snapshotStore: new InMemoryAsyncSnapshotStore(),
      effectRuntime: new EffectRuntime(),
      // The reward pipeline may annotate any execution of its tenant; nobody else may (ADR 0116).
      executionAuthorizer: executionAccessPolicy({ rules: { annotate: "tenant" } }),
    });
    const mk = (l: Layout) =>
      new ReferencePlanner({ modelId: `scripted-${l}`, model: this.models[l], maxAttempts: 1 });
    this.planners = { flat: mk("flat"), tabs: mk("tabs") };

    const content = new InMemoryContentStore({ now: () => this.t });
    this.lineage = new Lineage({
      events: new InMemoryLineageStore(),
      content,
      now: () => this.iso(),
    });
    this.seenLog = new SeenLog({
      events: eventStoreLineageStore(new InMemoryAsyncEventStore(), seenStoreOptions),
      content,
      lineage: this.lineage,
      keys: new InMemorySeenKeyStore(),
      now: () => this.iso(),
    });
    this.ledger = new VoteLedger({
      log: new InMemoryVoteLog(),
      pseudonymKey: KEY,
      clock: () => this.t,
      ...(opts.maxBatchesPerViewer !== undefined && {
        maxBatchesPerViewer: opts.maxBatchesPerViewer,
      }),
    });
    this.ingestor = new SignalIngestor({
      links: this.links,
      ledger: this.ledger,
      clock: () => this.t,
      // AUTHORITATIVE exposure: what the SERVER recorded as shown to this viewer, node by node.
      // ("client-claimed" would believe the browser's own say-so.) The SeenLog has no tenant, so
      // views are recorded under a tenant-keyed id.
      exposure: seenLogExposure(this.seenLog, {
        versionIsEnough: false,
        viewerIdOf: ({ tenant, viewerId }) => `${tenant}/${viewerId}`,
      }),
    });

    const ResumeGate = z.object({});
    const definition = flow$({
      id: "layout-turn",
      name: "Layout planner turn",
      version: "1.0.0",
      ...flowIo,
      steps: [],
      resumeSchemas: { ReplayGate: ResumeGate },
    });
    const runner: FlowRunner<TurnInput, unknown> = async (ctx, input) => {
      // 1. The learned decision: WHICH layout. Resolved through the registry (who is live, who is
      //    only watching), recorded once with the acting version, its propensity and the shadow arm.
      const layout = (await decideWithRollout(
        ctx,
        "layout",
        { source: this.registry, policyId: POLICY_ID, resolve: this.policies.resolve },
        input.unit,
        { unit: input.unit, segment: input.segment },
        [...LAYOUTS],
        { source: "planner-learning", bucketSecret: BUCKET_SECRET }
      )) as Layout;

      // 2. The planner composes the surface in that layout. The model call lives inside the
      //    planner's own ctx.decide, so a replay serves it from the log.
      const plan = await this.planners[layout].compose(
        {
          intent,
          catalog,
          capabilities,
          ...(layout === "tabs" && { containers: REFERENCE_CONTAINER_ROLES }),
        },
        ctx as never
      );
      // The ops are stamped with the decision a reward will attach to.
      const by = {
        ...plannerProvenance(plan, { agentId: "layout-planner" }),
        policyDecisionId: "layout",
      };

      if (input.park) await ctx.suspend<Record<string, never>>({ on: "ReplayGate" });
      return { layout, ops: plan.ops, by };
    };
    this.flow = { definition, runner } as unknown as RegisteredFlow;
    this.runtime.registerFlow(this.flow.definition, this.flow.runner);
  }

  /** Install v1 as the first incumbent (it needs no verdict: nothing is running to protect). */
  async bootstrap(): Promise<void> {
    const now = Date.parse(this.iso());
    await this.registry.register({
      id: POLICY_ID,
      version: "1",
      contentHash: versionHash("1"),
      now,
    });
    await this.registry.bootstrap({ id: POLICY_ID, version: "1", now });
  }

  iso(): string {
    return new Date(this.t).toISOString();
  }
  private tick(ms = 1000): void {
    this.t += ms;
  }

  /** The users of a batch: `count` fresh units, half power / half casual. */
  users(label: string, count: number): UserSpec[] {
    return Array.from({ length: count }, (_, i) => ({
      userId: `${label}-user-${i}@example.com`,
      segment: SEGMENTS[i % 2] as Segment,
    }));
  }

  // ── one planner turn ────────────────────────────────────────────────────────────────────

  /** Run one planner turn for a user and publish what it composed. Terminal, so it can be rewarded. */
  async turn(user: UserSpec): Promise<Surface> {
    const unit = unitAlias(KEY, user.userId);
    const executionId = `ex-${this.n++}`;
    const handle = await this.runtime.start(
      this.flow,
      { unit, segment: user.segment } satisfies TurnInput,
      { executionId, principal: owner(user.userId) }
    );
    const final = await handle.waitForCompletion();
    return this.publish(executionId, unit, user.segment, final.variables._output as TurnOutput);
  }

  /** A turn that parks at a gate right after deciding and composing: the thing a replay re-enters. */
  async parkedTurn(user: UserSpec) {
    const unit = unitAlias(KEY, user.userId);
    const executionId = `ex-${this.n++}`;
    const handle = await this.runtime.start(
      this.flow,
      { unit, segment: user.segment, park: true } satisfies TurnInput,
      { executionId, principal: owner(user.userId) }
    );
    await handle.waitForSuspend();
    return { executionId, unit, handle };
  }

  private async publish(
    executionId: string,
    unit: string,
    segment: Segment,
    out: TurnOutput
  ): Promise<Surface> {
    this.tick();
    const experienceId = `surface-${executionId}`;
    const start = must(await this.lineage.start(genesis({ experienceId, intent, meta }), HOST));
    const committed = must(
      await this.lineage.compose({
        experienceId,
        expectedHead: start.experience.versionHash,
        ops: out.ops.map((op) => ({ op, by: out.by, at: this.iso() })),
        by: out.by,
      })
    );
    const versionHash = committed.experience.versionHash;
    const ref: DecisionRef = { executionId, decisionId: "layout" };
    // The link is READ OFF the provenance ledger: each node maps to the decision stamped on the op
    // that wrote it, and a node with no stamped decision earns no planner reward.
    this.links.register(
      experienceId,
      versionHash,
      linkFromLedger(must(await this.lineage.provenance(experienceId, versionHash)), {
        executionOf: (d) => (d === ref.decisionId ? executionId : undefined),
        tenant: TENANT,
      })
    );
    return { executionId, experienceId, versionHash, unit, segment, served: out.layout, ref };
  }

  // ── viewers ─────────────────────────────────────────────────────────────────────────────

  /** The server shows `viewerId` the surface: it snapshots and RECORDS the view (the proof of exposure). */
  async show(s: Surface, viewerId: string): Promise<void> {
    const exp = must(await this.lineage.get(s.experienceId, s.versionHash));
    const snapshot = snapshotSeen(exp, {
      viewer: viewerClearance,
      read: () => ({ found: true, value: 1, status: "ready" }),
    });
    must(
      await this.seenLog.record({
        experienceId: s.experienceId,
        viewerId: `${TENANT}/${viewerId}`,
        snapshot,
        viewer: viewerClearance,
      })
    );
  }

  /** The client reports what the viewer saw and how they rated it. `ingest` is the whole trust boundary. */
  async vote(
    s: Surface,
    viewerId: string,
    rating: number,
    opts: { batchId?: string; tenant?: string } = {}
  ): Promise<IngestResult> {
    this.batchNo += 1;
    return this.ingestor.ingest({
      // the AUTHENTICATED session, never a field of the payload
      viewer: { id: viewerId, tenant: opts.tenant ?? TENANT },
      raw: {
        v: SIGNAL_VERSION,
        batchId: opts.batchId ?? `b${this.batchNo}`,
        view: { experienceId: s.experienceId, versionHash: s.versionHash },
        signals: [
          ...NODES.map((node) => ({ kind: "exposure" as const, node })),
          { kind: "feedback" as const, rating },
        ],
      },
    });
  }

  // ── a batch of traffic ──────────────────────────────────────────────────────────────────

  /** Serve `count` users, show each surface to its viewers and collect their ratings. */
  async serve(label: string, count: number, epoch: Epoch): Promise<Batch> {
    const surfaces: Surface[] = [];
    for (const user of this.users(label, count)) {
      const s = await this.turn(user);
      surfaces.push(s);
      const rng = seededRng(Number.parseInt(s.unit.slice(-8), 16) || 1);
      for (let j = 0; j < this.viewersPerSurface; j++) {
        const viewerId = `${s.unit}-v${j}`;
        await this.show(s, viewerId);
        await this.vote(s, viewerId, stars(appeal(s.served, s.segment, epoch), rng));
      }
    }
    return { label, epoch, surfaces };
  }

  /** Close a batch: ONE pooled late reward per decision, recorded by the reward-pipeline principal. */
  async settle(batch: Batch) {
    this.tick();
    return settleRewards({
      ledger: this.ledger,
      runtime: this.runtime,
      decisions: batch.surfaces.map((s) => s.ref),
      // weights 0/1/0: the rating alone (engagement and outcomes are not collected here)
      reward: defaultReward({ engagement: 0, feedback: 1, outcome: 0 }),
      rewardId: REWARD_ID,
      closeId: batch.label.slice(0, 32),
      clock: () => this.t,
      authorize: () => ({ principal: pipeline }),
    });
  }

  /** The batch's decision log, mined into (context, action, propensity, reward) trajectories. */
  async trajectories(batch: Batch): Promise<Trajectory<Layout>[]> {
    const events = (
      await Promise.all(batch.surfaces.map((s) => this.eventStore.read(s.executionId)))
    ).flat();
    return trajectories<Layout>(events, {
      // success of the TURN says nothing about whether the layout was liked; only votes count
      terminalReward: () => undefined,
      unitOf: (_id, ctx) => (typeof ctx?.unit === "string" ? ctx.unit : undefined),
    });
  }
}

interface TurnInput {
  unit: string;
  segment: Segment;
  park?: boolean;
}
interface TurnOutput {
  layout: Layout;
  ops: readonly Operation[];
  by: Provenance;
}
