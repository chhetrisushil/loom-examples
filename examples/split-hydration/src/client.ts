import {
  type HandleInventory,
  type HandleLoadRequest,
  type HandleLoadResult,
  type HandleLoader,
  HydrationStore,
  SplitHydrationController,
} from "@loom-ui/hydration/client";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";

// The browser side. It knows handles, priorities and param NAMES — nothing else. The transport is
// the app's; here it is two functions from a JSON body to a JSON body (in an app: two `fetch`
// calls, one per endpoint). `loadMany` is REQUIRED by `SplitHydrationController` — not an
// optimization it can fall back from — because the scheduler starts every P0 widget of one bind
// (and every P1 of one batch window) as a GROUP, and a group leaves as one `loadMany` round trip.
//
// Both methods are handed the scheduler's `AbortSignal` and thread it straight through to the
// transport: a real `send`/`sendBatch` passes it to `fetch`'s own `signal` option, so an aborted
// group (every one of its callers gone — a superseded load, a disposed controller) cancels the
// in-flight request instead of leaving it to finish unread. This demo's `send`/`sendBatch` are
// synchronous simulations that never abort, so they ignore it — but the signature carries it so a
// production transport can honor it without changing `JsonLoader` itself.

export class JsonLoader implements HandleLoader {
  readonly sent: HandleLoadRequest[] = [];
  /** The size of each `loadMany` call, in call order — lets a caller see a group leave together. */
  readonly batches: number[] = [];

  constructor(
    private readonly send: (body: string, signal: AbortSignal) => Promise<string>,
    private readonly sendBatch: (body: string, signal: AbortSignal) => Promise<string>
  ) {}

  async load(request: HandleLoadRequest, signal: AbortSignal): Promise<HandleLoadResult> {
    this.sent.push(request);
    return JSON.parse(await this.send(JSON.stringify(request), signal)) as HandleLoadResult;
  }

  async loadMany(
    requests: readonly HandleLoadRequest[],
    signal: AbortSignal
  ): Promise<readonly HandleLoadResult[]> {
    this.sent.push(...requests);
    this.batches.push(requests.length);
    return JSON.parse(await this.sendBatch(JSON.stringify(requests), signal)) as HandleLoadResult[];
  }
}

export function openBoard(
  inventory: HandleInventory,
  send: (body: string, signal: AbortSignal) => Promise<string>,
  sendBatch: (body: string, signal: AbortSignal) => Promise<string>
) {
  const loader = new JsonLoader(send, sendBatch);
  const store = new HydrationStore(new InMemoryProjectionRuntime(), {
    experienceId: inventory.experienceId,
  });
  const controller = new SplitHydrationController({ loader, store, batchWindowMs: 0 });
  const { findings } = controller.load(inventory);
  return { loader, store, controller, findings };
}
