import {
  type HandleInventory,
  type HandleLoadRequest,
  type HandleLoadResult,
  type HandleLoader,
  HydrationStore,
  SplitHydrationController,
} from "@loom-ui/hydration/client";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";

// The browser side of ONE surface. It knows only the handles its inventory lists: the broadcast
// inventory does not list the classified ones, so the wallboard's browser never even asks for them.

export class JsonLoader implements HandleLoader {
  readonly sent: HandleLoadRequest[] = [];
  constructor(private readonly sendBatch: (body: string) => Promise<string>) {}

  async load(request: HandleLoadRequest): Promise<HandleLoadResult> {
    this.sent.push(request);
    const [result] = JSON.parse(
      await this.sendBatch(JSON.stringify([request]))
    ) as HandleLoadResult[];
    if (result === undefined) throw new Error("no result");
    return result;
  }

  async loadMany(requests: readonly HandleLoadRequest[]): Promise<readonly HandleLoadResult[]> {
    this.sent.push(...requests);
    return JSON.parse(await this.sendBatch(JSON.stringify(requests))) as HandleLoadResult[];
  }
}

export function openSurface(
  inventory: HandleInventory,
  sendBatch: (body: string) => Promise<string>
) {
  const loader = new JsonLoader(sendBatch);
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, {
    experienceId: inventory.experienceId,
  });
  const controller = new SplitHydrationController({ loader, store, batchWindowMs: 0 });
  const { findings } = controller.load(inventory);
  return { loader, store, runtime, controller, findings };
}
