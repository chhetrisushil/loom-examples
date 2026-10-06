import type { Experience, SeenReader, Viewer } from "@loom-ui/core";
import { HydrationController, HydrationStore, type TransientInvoker } from "@loom-ui/hydration";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";

/** What the triage tools return right now. Mutate it to "change the data". */
export interface World {
  open: number;
  primary: string;
  accounts: number;
}

/** A fake transient invoker: answers each tool from `world`, and counts the calls. */
export class WorldInvoker implements TransientInvoker {
  readonly calls: string[] = [];
  constructor(readonly world: World) {}
  async invokeTransient<TIn, TOut>(_toolId: string, input: TIn): Promise<TOut> {
    const toolName = (input as { toolName?: unknown }).toolName;
    this.calls.push(String(toolName));
    switch (toolName) {
      case "incidents.open":
        return { open: this.world.open } as TOut;
      case "pager.oncall":
        return { primary: this.world.primary } as TOut;
      case "legal.exposure":
        return { accounts: this.world.accounts } as TOut;
      default:
        throw new Error(`no fake tool "${String(toolName)}"`);
    }
  }
}

/**
 * Hydrate `exp` for ONE viewer. The controller never invokes a provider whose class the viewer
 * may not see. A hydration store holds whatever its viewer's principal chain was
 * allowed to read, so each viewer gets a store of their own (see `HydrationStore`'s scope docs).
 * Returns the `SeenReader` a `snapshotSeen` call reads the delivered values through.
 */
export async function hydrateFor(
  exp: Experience,
  who: { id: string; viewer: Viewer },
  invoker: TransientInvoker
): Promise<SeenReader> {
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, {
    experienceId: exp.experienceId,
    principalId: who.id,
  });
  // Batched (P1) loads wait on a timer; inject it so `settle` fires them deterministically.
  const timers: Array<() => void> = [];
  const controller = new HydrationController({
    invoker,
    store,
    viewer: who.viewer,
    setTimer: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const { findings } = controller.load(exp);
  if (findings.length > 0) throw new Error(`hydration refused: ${JSON.stringify(findings)}`);
  for (let round = 0; round < 50; round++) {
    for (const fn of timers.splice(0)) fn();
    await new Promise((r) => setTimeout(r, 0));
    if (timers.length === 0 && controller.inFlight().length === 0) break;
  }
  const state = store.state();
  controller.dispose();
  return (source) => {
    if (source.kind !== "handle") return undefined;
    const status = state.status[source.handle]?.state;
    return source.handle in state.values
      ? { found: true, value: state.values[source.handle], ...(status && { status }) }
      : { found: false, ...(status && { status }) };
  };
}
