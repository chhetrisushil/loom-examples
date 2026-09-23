import {
  type HandleInventory,
  type HandleLoadRequest,
  type HandleLoadResult,
  type HandleLoader,
  HydrationStore,
  SplitHydrationController,
} from "@loom-ui/hydration";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";

// The browser side. It knows handles, priorities and param NAMES — nothing else. The transport is
// the app's; here it is two functions from a JSON body to a JSON body (in an app: two `fetch`
// calls, one per endpoint). `loadMany` is REQUIRED by `SplitHydrationController` — not an
// optimization it can fall back from — because the scheduler starts every P0 widget of one bind
// (and every P1 of one batch window) as a GROUP, and a group leaves as one `loadMany` round trip.

export class JsonLoader implements HandleLoader {
  readonly sent: HandleLoadRequest[] = [];
  /** The size of each `loadMany` call, in call order — lets a caller see a group leave together. */
  readonly batches: number[] = [];

  constructor(
    private readonly send: (body: string) => Promise<string>,
    private readonly sendBatch: (body: string) => Promise<string>
  ) {}

  async load(request: HandleLoadRequest): Promise<HandleLoadResult> {
    this.sent.push(request);
    return JSON.parse(await this.send(JSON.stringify(request))) as HandleLoadResult;
  }

  async loadMany(requests: readonly HandleLoadRequest[]): Promise<readonly HandleLoadResult[]> {
    this.sent.push(...requests);
    this.batches.push(requests.length);
    return JSON.parse(await this.sendBatch(JSON.stringify(requests))) as HandleLoadResult[];
  }
}

export function openBoard(
  inventory: HandleInventory,
  send: (body: string) => Promise<string>,
  sendBatch: (body: string) => Promise<string>
) {
  const loader = new JsonLoader(send, sendBatch);
  const store = new HydrationStore(new InMemoryProjectionRuntime(), {
    experienceId: inventory.experienceId,
  });
  const controller = new SplitHydrationController({ loader, store, batchWindowMs: 0 });
  const { findings } = controller.load(inventory);
  return { loader, store, controller, findings };
}
