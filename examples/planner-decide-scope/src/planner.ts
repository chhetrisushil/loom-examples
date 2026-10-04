import { limitInvoker, memoInvoker } from "@loom-ui/hydration";
import {
  type DecideScope,
  type PlannerModel,
  ReferencePlanner,
  scopeInvoker,
} from "@loom-ui/planner";
import { LLM_TOOL_ID } from "./llm";

/**
 * The model factory. The planner calls it ONCE PER DECISION with that decider's scope, so
 * everything built here lives and dies with one decider:
 *
 * - `scopeInvoker(scope)` makes each call run AS the deciding execution (workflowId, executionId,
 *   full principal incl. delegation, composed cancellation, budget admission);
 * - `limitInvoker` caps in-flight calls for this decider;
 * - `memoInvoker` dedupes within this decider. It keys on everything but `signal` and the
 *   identity is fixed by the scope, so it is only correct PER SCOPE: hoist it out of the factory
 *   and one execution could be served another's result, skipping its authorization.
 *
 * Do NOT pass `principal` / `as` / `resources` through this invoker: scopeInvoker REFUSES them
 * (a rejection), because a call that thinks it runs as someone else must not silently run as the
 * deciding execution. The same goes for configuring `principal` on hydration over this invoker.
 */
export const modelFor = (scope: DecideScope): PlannerModel => {
  const invoker = memoInvoker(limitInvoker(scopeInvoker(scope), 2));
  return {
    complete: (request) => invoker.invokeTransient(LLM_TOOL_ID, request),
  };
};

export const createPlanner = () => new ReferencePlanner({ model: modelFor, modelId: "fake-llm@1" });
