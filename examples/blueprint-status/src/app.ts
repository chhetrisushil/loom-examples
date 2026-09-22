import type { Blueprint } from "@loom/blueprint-runtime";
import type { EventEnvelope } from "@loom/core";
import { TerminalRenderer, defaultTerminalRegistry } from "@loom/plugin-renderer-terminal";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { healthBoard } from "./blueprint";
import { valueContract } from "./check";
import { healthProjection } from "./health";

export interface Board {
  readonly runtime: InMemoryProjectionRuntime;
  readonly executionId: string;
  readonly blueprint: Blueprint;
  /** Fold health events into the projection — what the app's providers would emit. */
  apply(...events: EventEnvelope[]): void;
  /** Render the board from projection state through loom's terminal matrix + the app's check. */
  render(): string;
}

export function createBoard(executionId = "health-board-1"): Board {
  const runtime = new InMemoryProjectionRuntime();
  runtime.register(healthProjection);
  const blueprint = healthBoard({ projectionVersions: runtime.pins() });
  const renderer = new TerminalRenderer(runtime, {
    registry: defaultTerminalRegistry,
    check: valueContract,
  });
  return {
    runtime,
    executionId,
    blueprint,
    apply: (...events) => {
      for (const e of events) runtime.handleEvent(e);
    },
    render: () => renderer.render(blueprint, executionId),
  };
}
