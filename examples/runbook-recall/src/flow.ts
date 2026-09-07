import { flow$ } from "@loom/core";
import type { TaskDefinition } from "@loom/core";
import type { TieredMemory } from "@loom/memory";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { CORPUS_SCOPE, CORPUS_TIER, type StoredChunk, asStoredChunk } from "./knowledge";

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
  chunks: StoredChunk[];
}

export const AnswerTask: TaskDefinition<AnswerCallInput, string> = {
  _tag: "TaskDefinition",
  kind: "llm",
  id: "answer-from-passages",
  toolId: "answer-model",
};

/**
 * Retrieval-augmented generation with no retrieval-augmented-generation feature.
 *
 * Two ordinary primitives do all of it:
 *
 *  - `recallRelevant` ranks the corpus against the question and REQUIRES `ctx.decide`,
 *    so which passages were retrieved becomes a `DECISION_RECORDED` fact. That is what
 *    makes the run reproducible: the corpus keeps growing, and a replay would otherwise
 *    rebuild a prompt out of documents that did not exist when the answer was given.
 *  - `ctx.execute` runs the model call as a durable effect, at whose boundary
 *    `guardRequest` refuses any passage that reached an instruction position.
 *
 * `memory` is a closure argument, not framework state — loom does not know a corpus
 * exists, the same way it does not know a policy exists in `learning-router`.
 */
export function answerRunner(memory: TieredMemory): FlowRunner<AnswerInput, AnswerOutput> {
  return async (ctx, input) => {
    const recalled = await memory.recallRelevant(CORPUS_TIER, CORPUS_SCOPE, input.question, {
      decide: ctx.decide,
      limit: 3,
    });
    const chunks: StoredChunk[] = recalled.map((entry) => asStoredChunk(entry.content));

    const answer = await ctx.execute(AnswerTask, { question: input.question, chunks });

    return { answer, cited: [...new Set(chunks.map((c) => c.docId))].sort() };
  };
}

export const AnswerFlow = flow$({
  id: "answer-from-runbooks",
  name: "Answer from runbooks",
  version: "1.0.0",
  inputSchema: answerInput,
  outputSchema: answerOutput,
  steps: [],
});

export function registerAnswerFlow(memory: TieredMemory): RegisteredFlow {
  return {
    definition: AnswerFlow,
    runner: answerRunner(memory) as FlowRunner<unknown, unknown>,
  };
}
