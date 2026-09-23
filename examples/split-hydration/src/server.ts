import { createHmac } from "node:crypto";
import { type CompileResult, type Finding, compile } from "@loom-ui/core";
import {
  type DriftReport,
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  type HandleInventory,
  type HandleLoadRequest,
  HydrationCache,
  type RevisionFn,
  type ServeOptions,
  handleInventory,
  serveHandle,
  serveHandles,
} from "@loom-ui/hydration";
import { catalog } from "./catalog";
import { stationBoard } from "./experience";
import { reshapers } from "./reshapers";
import type { WeatherTools } from "./tools";

// The server side of the trust boundary. It alone holds the Experience and its providers. A page
// GET returns the compiled Blueprint and the handle inventory (never a provider); the hydrate
// endpoints answer through `serveHandle` (one request) or `serveHandles` (a batch — how the
// client's grouped loads, e.g. two P0 widgets that started together, cross in ONE round trip),
// resolving relative time on the SERVER's clock. A read-only viewer (a published page, a
// snapshot) cannot persist a repair, so it proceeds past an input drift; the head reports it and
// goes stale until the app's durable repair lands.

/**
 * DEMO ONLY: a fixed key baked into source so the example is deterministic and needs no secret
 * store. In production this key lives in server config or a secret manager — never in source —
 * and is rotated like any other credential (a rotation re-asks every client's inventory once).
 */
const DEMO_REVISION_KEY = "split-hydration-example-demo-key-do-not-use-in-production";

/** Keyed (HMAC-SHA256): a client can never confirm a guessed provider against this offline. */
const revisionOf: RevisionFn = (handle, fingerprint) =>
  createHmac("sha256", DEMO_REVISION_KEY).update(`${handle}\u0000${fingerprint}`).digest("hex");

export interface StationServerOptions {
  readonly tools: WeatherTools;
  readonly clock: () => number;
  readonly readOnly?: boolean;
}

export class StationServer {
  readonly drifts: DriftReport[] = [];
  /** Every finding a load produced, IN FULL — the server's own log. Never what a client sees. */
  readonly internalFindings: Array<{ handle: string; finding: Finding }> = [];
  private readonly experience = stationBoard();
  private readonly cache: HydrationCache;

  constructor(private readonly opts: StationServerOptions) {
    this.cache = new HydrationCache(opts.clock);
  }

  /** What a page GET returns: never a provider. */
  open(): { blueprint: CompileResult["blueprint"]; inventory: HandleInventory } {
    const { blueprint } = compile(this.experience, {
      surface: "web",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    const { inventory } = handleInventory(this.experience, { revisionOf });
    return { blueprint, inventory };
  }

  /** The single-load endpoint: one JSON request body in, one JSON load result out. */
  async hydrate(body: string): Promise<string> {
    const request = JSON.parse(body) as HandleLoadRequest;
    const result = await serveHandle(this.experience, request, this.serveOptions());
    return JSON.stringify(result);
  }

  /**
   * The batch endpoint: several requests in ONE round trip, answered in request order. This is
   * what a `HandleLoader.loadMany` posts to — the same one call that lets N handles sharing an
   * upstream step share the tool call too (one step memo per batch pass).
   */
  async hydrateBatch(body: string): Promise<string> {
    const requests = JSON.parse(body) as HandleLoadRequest[];
    const results = await serveHandles(this.experience, requests, this.serveOptions());
    return JSON.stringify(results);
  }

  private serveOptions(): ServeOptions {
    return {
      invoker: this.opts.tools,
      now: this.opts.clock(),
      outputKinds: { catalog, surface: "web" },
      reshapers,
      cache: this.cache,
      inputDrift: this.opts.readOnly === true ? "report-and-proceed" : "report",
      onDrift: (report) => this.drifts.push(report),
      onFinding: (handle, finding) => this.internalFindings.push({ handle, finding }),
    };
  }
}
