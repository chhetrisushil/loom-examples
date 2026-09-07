import { flow$ } from "@loom/core";
import type { TaskDefinition } from "@loom/core";
import { assertGrounded } from "@loom/knowledge";
import type { KnowledgeBase, Passage } from "@loom/knowledge";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

const answerInput = z.object({ question: z.string() });
const answerOutput = z.object({ answer: z.string(), cited: z.array(z.string()) });

export type AnswerInput = z.infer<typeof answerInput>;
export type AnswerOutput = z.infer<typeof answerOutput>;

/**
 * The model call as an ordinary task. `kind: "llm"` resolves the effect registered
 * under `toolId`, and the call is journaled like any other — one durable frame, served
 * from the log on replay.
 */
export interface AnswerCallInput {
  question: string;
  passages: Passage[];
}

export const AnswerTask: TaskDefinition<AnswerCallInput, string> = {
  _tag: "TaskDefinition",
  kind: "llm",
  id: "answer-from-passages",
  toolId: "answer-model",
};

/**
 * Retrieval-augmented generation in three lines, none of which is a RAG feature.
 *
 *  - `kb.retrieve` ranks the corpus against the question and REQUIRES `ctx.decide`,
 *    so which passages were retrieved becomes a `DECISION_RECORDED` fact. That is what
 *    makes the run reproducible: the corpus keeps changing, and a replay would otherwise
 *    rebuild a prompt out of a revision that did not exist when the answer was given.
 *  - `ctx.execute` runs the model call as a durable effect, at whose boundary
 *    `guardRequest` refuses any passage that reached an instruction position.
 *  - `assertGrounded` rejects a citation to a document that was never retrieved.
 *
 * `kb` is a closure argument, not framework state — loom does not know a corpus exists,
 * the same way it does not know a policy exists in `learning-router`.
 */
export function answerRunner(kb: KnowledgeBase): FlowRunner<AnswerInput, AnswerOutput> {
  return async (ctx, input) => {
    const passages = await kb.retrieve(input.question, { decide: ctx.decide, limit: 3 });

    const answer = await ctx.execute(AnswerTask, { question: input.question, passages });

    // `assertGrounded` compares what the ANSWER claims against what was retrieved, and
    // throws on a citation to a document that was never shown to the model. Deriving
    // `cited` from the passages instead would be a check that cannot fail.
    return { answer, cited: assertGrounded(citedIds(answer), passages).sort() };
  };
}

/** The ids the scripted model names in its answer, in the shape it writes them. */
function citedIds(answer: string): string[] {
  return [...answer.matchAll(/RB-\d+/g)].map((m) => m[0]);
}

export const AnswerFlow = flow$({
  id: "answer-from-runbooks",
  name: "Answer from runbooks",
  version: "1.0.0",
  inputSchema: answerInput,
  outputSchema: answerOutput,
  steps: [],
});

export function registerAnswerFlow(kb: KnowledgeBase): RegisteredFlow {
  return {
    definition: AnswerFlow,
    runner: answerRunner(kb) as FlowRunner<unknown, unknown>,
  };
}
