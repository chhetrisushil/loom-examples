import { SOURCE_SKILL_ACTIVATION, SOURCE_TOOL_SEARCH } from "@loom/agent";
import type { EventEnvelope } from "@loom/core";
import { CATALOG_SIZE } from "./catalog";
import { resultsOf } from "./model";
import { RankerProbe } from "./ranker";
import type { RunningServer } from "./server";
import {
  AGENT_ID,
  EXECUTION_ID,
  type World,
  buildWorld,
  crashBefore,
  decisionsOf,
  resume,
  run,
} from "./world";

export const menuOf = (w: World, i: number): string[] =>
  (w.requests[i]?.tools ?? []).map((t) => t.name);

/** What each turn's model call was handed back, digested to one line per tool result. */
export function digest(w: World): string[] {
  const lines: string[] = [];
  w.requests.forEach((req, i) => {
    if (i === 0) return;
    for (const r of resultsOf(req)) {
      const taint = r.tainted ? " [TAINTED: fenced as data]" : "";
      if (r.result.instructions !== undefined) {
        lines.push(
          `  turn ${i}: activate_skill -> instructions: "${r.result.instructions.slice(0, 48)}..."`
        );
      } else if (r.tool === "search_tools") {
        const tools = (r.result.tools ?? []).map(
          (t) => `${t.name}${t.loaded ? "" : "(not loaded)"}`
        );
        const skills = (r.result.skills ?? []).map((s) => `skill:${s.id}`);
        lines.push(`  turn ${i}: search_tools -> ${[...tools, ...skills].join(", ")}${taint}`);
        for (const t of r.result.tools ?? [])
          lines.push(`            ${t.name}: "${t.description}"`);
      } else {
        lines.push(`  turn ${i}: ${r.tool} -> ok${taint}`);
      }
    }
  });
  return lines;
}

export interface Acts {
  readonly plain: World;
  readonly custom: World;
  readonly ranker: RankerProbe;
  readonly resumed: World;
  readonly resumedRanker: RankerProbe;
  readonly crashedLog: readonly EventEnvelope[];
  readonly fullLog: readonly EventEnvelope[];
  readonly resumedLog: readonly EventEnvelope[];
  /** MCP tool calls the server had served after the plain run / the custom run / the resume. */
  readonly mcpCalls: { plain: string[]; custom: string[]; resumed: string[] };
}

/**
 * Three runs of the same scripted model over the same live MCP server:
 *  - `plain`: the built-in BM25F ranker (host annotations close the vocabulary gap);
 *  - `custom`: a custom tool ranker (two-ranker mode with skill discovery), counting its calls;
 *  - `resumed`: `custom`'s log cut just before the skill activation (both searches already
 *    recorded), resumed by a world whose factory and ranker would count any call.
 */
export async function runActs(server: RunningServer): Promise<Acts> {
  const plain = buildWorld({ mcp: await server.mapped() });
  await run(plain);
  const afterPlain = [...server.log.calls];

  const mcp = await server.mapped();
  const ranker = new RankerProbe();
  const custom = buildWorld({ mcp, ranker: ranker.factory });
  await run(custom);
  const fullLog = await custom.store.read(EXECUTION_ID);

  const afterCustom = [...server.log.calls];
  const crashed = await crashBefore(fullLog, `${AGENT_ID}#turn:2`);
  const crashedLog = await crashed.read(EXECUTION_ID);
  const resumedRanker = new RankerProbe();
  const resumed = buildWorld({
    mcp: await server.mapped(),
    ranker: resumedRanker.factory,
    store: crashed,
  });
  await resume(resumed, crashedLog);
  const resumedLog = await crashed.read(EXECUTION_ID);
  const afterResume = [...server.log.calls];
  return {
    plain,
    custom,
    ranker,
    resumed,
    resumedRanker,
    crashedLog,
    fullLog,
    resumedLog,
    mcpCalls: {
      plain: afterPlain,
      custom: afterCustom.slice(afterPlain.length),
      resumed: afterResume.slice(afterCustom.length),
    },
  };
}

export const searchRecords = (log: readonly EventEnvelope[]) =>
  decisionsOf(log).filter((d) => d.source === SOURCE_TOOL_SEARCH);
export const activationRecords = (log: readonly EventEnvelope[]) =>
  decisionsOf(log).filter((d) => d.source === SOURCE_SKILL_ACTIVATION);
export { CATALOG_SIZE };
