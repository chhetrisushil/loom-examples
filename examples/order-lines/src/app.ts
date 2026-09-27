import type { Experience } from "@loom-ui/core";
import { HydrationController, HydrationStore } from "@loom-ui/hydration";
import { type DomRenderHandle, litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
import type { Blueprint } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { HANDLE, buildBoard, compileFor } from "./board";
import { OrdersTools, type TopOrder } from "./tools";

export interface Mounted {
  readonly host: HTMLElement;
  readonly handle: DomRenderHandle;
  dispose(): void;
}

export interface Board {
  readonly runtime: InMemoryProjectionRuntime;
  readonly store: HydrationStore;
  readonly controller: HydrationController;
  readonly invoker: OrdersTools;
  readonly experience: Experience;
  readonly web: Blueprint;
  /** Fire the controller's batch timers and wait until nothing is in flight. */
  settle(): Promise<void>;
  mount(): Mounted;
  terminalFrame(): string;
}

export function createBoard(opts: {
  topOrders: readonly TopOrder[];
  topOrderPath?: string;
}): Board {
  const experience = buildBoard(opts.topOrderPath);
  const web = compileFor(experience, "web");
  const runtime = new InMemoryProjectionRuntime();
  const store = new HydrationStore(runtime, { experienceId: experience.experienceId });
  const invoker = new OrdersTools(opts.topOrders);
  // An injected timer, like `experience-recompose`'s app: `settle()` fires what is due instead
  // of waiting on wall-clock time, so the example is deterministic.
  const timers: Array<() => void> = [];
  const controller = new HydrationController({
    invoker,
    store,
    setTimer: (fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });
  const { findings } = controller.load(experience);
  if (findings.length > 0) throw new Error(`hydration refused: ${JSON.stringify(findings)}`);

  const board: Board = {
    runtime,
    store,
    controller,
    invoker,
    experience,
    web,
    async settle() {
      for (let round = 0; round < 50; round++) {
        for (const fn of timers.splice(0)) fn();
        await new Promise((r) => setTimeout(r, 0));
        if (timers.length === 0 && controller.inFlight().length === 0) return;
      }
      throw new Error("hydration did not settle");
    },
    mount() {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const handle = renderBlueprintDom(host, web, {
        projectionRuntime: runtime,
        executionId: store.executionId,
        registry: litRegistry,
      });
      return {
        host,
        handle,
        dispose() {
          handle.dispose();
          host.remove();
        },
      };
    },
    terminalFrame() {
      return renderExperience(compileFor(experience, "terminal"), store, {
        registry: terminalRegistry(),
      });
    },
  };
  return board;
}

export { HANDLE };
