import { REVISE_SYSTEM } from "@loom-ui/planner";
import { ToolEffect } from "@loom/effect-runtime";

/** The effect id the planner's model reaches. Grants, middleware and verify all key on it. */
export const LLM_TOOL_ID = "llm.complete";

const node = (id: string, type: string, label: string, span: number, binding?: unknown) => ({
  id,
  type,
  label,
  span,
  props: {},
  ...(binding !== undefined && { binding }),
});

const open = node("open", "Metric", "Open tickets", 4, {
  capability: "tickets_open",
  arguments: { queue: "billing" },
  path: "total",
  priority: "P0",
});
const list = node("queue", "Collection", "Queue", 8, {
  capability: "tickets_open",
  arguments: { queue: "billing" },
  path: "rows",
  priority: "P1",
});
const why = node("why", "Insight", "Why the queue grew", 12);

/**
 * A deterministic, offline stand-in for a provider. It is a registered EFFECT (not a model passed
 * to the planner), so it is reachable only through `invokeTransient` and therefore only through
 * the authorizer and middleware chain. `calls` counts real executions.
 */
export function fakeLlm() {
  const state = { calls: 0 };
  const effect = new ToolEffect(async (req: { system?: string }): Promise<{ content: string }> => {
    state.calls += 1;
    const nodes = req.system === REVISE_SYSTEM ? [open, list, why] : [open, list];
    return { content: JSON.stringify({ summary: "billing queue triage", nodes }) };
  });
  return { effect, state };
}
