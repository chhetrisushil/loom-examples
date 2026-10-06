import {
  type Experience,
  type Provenance,
  type ReadPolicy,
  type RecordedOperation,
  type Viewer,
  snapshotSeen,
} from "@loom-ui/core";
import {
  InMemoryLineageStore,
  InMemorySeenKeyStore,
  Lineage,
  type LineageResult,
  SeenLog,
  type SeenResult,
  collectSeenGarbage,
  eventStoreLineageStore,
  seenStoreOptions,
} from "@loom-ui/lineage";
import { plannerProvenance } from "@loom-ui/planner";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryContentStore, contentAddress, encodeValue } from "@loom/plugin-content";
import {
  EXPERIENCE_ID,
  capabilities,
  catalog,
  exposureCap,
  genesisBoard,
  handleFor,
  readPolicy as hostPolicy,
  intent,
  memoryDecide,
  newPlanner,
} from "./board";
import { type World, WorldInvoker, hydrateFor } from "./hydrate";

/** The unwrap every lineage / seen call needs: a refusal is a bug in the example, say so. */
export function must<T>(r: LineageResult<T> | SeenResult<T>): T {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`);
  return r.value;
}

/** The two people who open the board. Clearance is the host's claim; nothing here authorizes. */
export const DANA = { id: "dana", viewer: { clearance: "secret" } satisfies Viewer };
export const LEE = { id: "lee", viewer: { clearance: "internal" } satisfies Viewer };

const user = (agentId: string): Provenance => ({ source: "user", agentId });

/** Retention small enough to show roll-off with a handful of views. */
export const MAX_VIEWS = 3;

/**
 * Everything the scenario shares, in memory: ONE content store (artifact bytes and viewed values
 * both live in it, content-addressed), the lineage, and the per-viewer seen log with its key store.
 * Time is a fake clock so retention, `until` and the collector's grace period are deterministic.
 */
export function createRig(opts: { readPolicy?: ReadPolicy | null } = {}) {
  // Bound ONCE, here, on every read surface. `null` builds the control rig that binds nothing.
  const readPolicy = opts.readPolicy === null ? undefined : (opts.readPolicy ?? hostPolicy);
  const clock = { t: Date.parse("2026-10-07T09:00:00Z") };
  const iso = () => new Date(clock.t).toISOString();
  const tick = (ms = 60_000) => {
    clock.t += ms;
    return iso();
  };
  const content = new InMemoryContentStore({ now: () => clock.t });
  const lineage = new Lineage({
    events: new InMemoryLineageStore(),
    content,
    now: iso,
    ...(readPolicy && { readPolicy }),
  });
  const keys = new InMemorySeenKeyStore();
  // The seen log lives in a store (and a reserved stream namespace) of its own, never the lineage's.
  const seenEvents = eventStoreLineageStore(new InMemoryAsyncEventStore(), seenStoreOptions);
  const log = new SeenLog({
    events: seenEvents,
    content,
    lineage,
    keys,
    now: iso,
    ...(readPolicy && { readPolicy }),
    retention: { maxViews: MAX_VIEWS, maxSkewMs: 0 },
  });
  const world: World = { open: 7, primary: "Dana Ruiz", accounts: 1200 };
  const invoker = new WorldInvoker(world);
  return { readPolicy, clock, iso, tick, content, lineage, keys, seenEvents, log, world, invoker };
}
export type Rig = ReturnType<typeof createRig>;

/** Does the content store still hold the value `v` (by its plain content address)? */
export const holds = async (rig: Rig, v: unknown): Promise<boolean> =>
  (await rig.content.get({ __loomContent: addressOf(v) })) !== null;
export const addressOf = (v: unknown): string => contentAddress(encodeValue(v));

export const headOf = async (rig: Rig): Promise<Experience> =>
  must(await rig.lineage.resolveLatest(EXPERIENCE_ID));

// ── 1. compose with the reference planner; the decision is stamped on the ops ─────────────────

export async function composeBoard(
  rig: Rig,
  opts: { experienceId?: string; withExposure?: boolean; proposal?: "internal" } = {}
) {
  const experienceId = opts.experienceId ?? EXPERIENCE_ID;
  const withExposure = opts.withExposure ?? true;
  const planner = newPlanner(withExposure, opts.proposal);
  // The lite board never offers the classified capability: its summary is of an internal class.
  const offered = withExposure ? capabilities : capabilities.filter((c) => c !== exposureCap);
  const composed = await planner.compose(
    { intent, catalog, capabilities: offered },
    memoryDecide()
  );
  if (composed.ops.length === 0) throw new Error(JSON.stringify(composed.findings));
  const by = plannerProvenance(composed, { agentId: "triage-planner" });
  const start = must(await rig.lineage.start(genesisBoard(experienceId), { source: "system" }));
  const at = rig.tick();
  const ops: RecordedOperation[] = composed.ops.map((op) => ({ op, by, at }));
  const committed = must(
    await rig.lineage.compose({
      experienceId,
      expectedHead: start.experience.versionHash,
      ops,
      by,
      ...(composed.summary !== undefined && { summary: composed.summary }),
      ...(composed.summaryClass !== undefined && { summaryClass: composed.summaryClass }),
    })
  );
  return { composed, by, committed, version: committed.experience.versionHash };
}

// ── 2. hand-edit a card, then revert ─────────────────────────────────────────────────────────

export async function editThenRevert(rig: Rig, composedVersion: string) {
  const edited = must(
    await rig.lineage.compose({
      experienceId: EXPERIENCE_ID,
      expectedHead: composedVersion,
      ops: [
        {
          op: { type: "setProps", nodeId: "open_incidents", patch: { unit: "open" } },
          by: user("dana"),
          at: rig.tick(),
        },
      ],
      by: user("dana"),
    })
  );
  const reverted = must(
    await rig.lineage.revert({
      experienceId: EXPERIENCE_ID,
      expectedHead: edited.experience.versionHash,
      to: composedVersion,
      by: user("dana"),
    })
  );
  return { edited: edited.experience.versionHash, reverted: reverted.experience.versionHash };
}

// ── 4. what a viewer was shown ───────────────────────────────────────────────────────────────

/** Open the board as `who`: hydrate through the fake invoker, snapshot what was delivered, record it. */
export async function openBoard(
  rig: Rig,
  who: { id: string; viewer: Viewer },
  experienceId: string = EXPERIENCE_ID
) {
  const exp = must(await rig.lineage.resolveLatest(experienceId));
  const read = await hydrateFor(exp, who, rig.invoker, rig.readPolicy);
  const snapshot = snapshotSeen(exp, { viewer: who.viewer, read });
  const at = rig.iso();
  const result = must(
    await rig.log.record({
      experienceId,
      viewerId: who.id,
      snapshot,
      viewer: who.viewer,
    })
  );
  rig.tick();
  return { snapshot, at, ...result };
}

/** The views `viewerId` is entitled to, newest first, as the reader sees them. */
export async function viewsOf(
  rig: Rig,
  viewerId: string,
  opts: { reader?: Viewer; until?: string } = {}
) {
  return must(
    await rig.log.read({
      experienceId: EXPERIENCE_ID,
      viewerId,
      reader: opts.reader ?? { clearance: "secret" },
      ...(opts.until !== undefined && { until: opts.until }),
    })
  );
}

/** One collection pass. Everything written so far is older than the grace period. */
export async function sweep(rig: Rig) {
  rig.tick(10 * 60_000);
  const r = await collectSeenGarbage(rig.log, { graceMs: 60_000, ownsContentStore: true });
  if (!r.ok) throw new Error(`collector refused: ${JSON.stringify(r.refusal)}`);
  return r.report;
}

/** Every address the lineage cites: these must survive any sweep. */
export async function lineageBlobs(rig: Rig): Promise<string[]> {
  const out: string[] = [];
  await rig.lineage.forEachContentRef((a) => out.push(a));
  return out;
}

// ── the day's data, as the fake tools answer it ──────────────────────────────────────────────

/** Move the fake tools to a new reading. */
export const setWorld = (rig: Rig, w: Partial<World>) => Object.assign(rig.world, w);

/** The explanation of one node for one viewer, unwrapped (still the viewer-safe union). */
export const explain = async (
  rig: Rig,
  nodeId: string,
  viewer: Viewer,
  opts: { experienceId?: string; versionHash?: string } = {}
) =>
  must(
    await rig.lineage.explain(opts.experienceId ?? EXPERIENCE_ID, nodeId, {
      viewer,
      ...(opts.versionHash !== undefined && { versionHash: opts.versionHash }),
    })
  );

// ── a node nobody classified, stored on a classified tool ─────────────────────────────────────

export const RAW_ID = "incident-board-raw";

/**
 * A board whose exposure card was added by hand (not by the planner): it carries NO `sensitivity`
 * of its own. Only the host's bound read policy keeps it from a low viewer.
 */
export async function storeUnclassifiedExposure(rig: Rig) {
  const { version } = await composeBoard(rig, { experienceId: RAW_ID, withExposure: false });
  const head = must(await rig.lineage.resolveLatest(RAW_ID));
  const handle = handleFor(exposureCap, "accounts");
  const spec = {
    handle,
    executionGraph: [
      {
        stepId: "s1",
        toolName: exposureCap.toolName,
        toolVersion: exposureCap.toolVersion,
        toolSchemaHash: exposureCap.toolSchemaHash,
        arguments: {},
        dependsOn: [],
        idempotent: true,
      },
    ],
    reshaping: { engine: "JSONPath", scriptRef: "accounts" },
    outputShapeHash: "fnv1a64:042b41495f5d90e6",
    cachePolicy: { ttlSeconds: 60, scope: "principal" },
  } as const;
  const by = user("dana");
  const at = rig.tick();
  must(
    await rig.lineage.compose({
      experienceId: RAW_ID,
      expectedHead: version,
      by,
      ops: [
        { op: { type: "remapProvider", handle, spec: spec as never }, by, at },
        {
          op: {
            type: "insertNode",
            parentId: head.root.id,
            node: {
              id: "raw_exposure",
              order: "z",
              kind: "semantic",
              type: "Metric",
              typeVersion: "1.0.0",
              span: 4,
              label: { key: "raw_exposure.label", fallback: "Customer exposure" },
              props: { unit: "accounts" },
              binding: { handle, priority: "P1" },
            } as never,
          },
          by,
          at,
        },
      ],
    })
  );
}
