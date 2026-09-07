import { tainted } from "@loom/classify";
import { TieredMemory } from "@loom/memory";
import { SqliteMemoryStore } from "@loom/plugin-sqlite";
import { type Chunk, type RunbookDoc, chunk } from "./corpus";

// ── The knowledge base: a memory tier, and nothing else ──────────────────────
//
// There is no knowledge$ construct, no document store, no index to configure.
// A corpus is the `semantic` tier of an ordinary memory — the tier that never
// evicts, which is exactly what a knowledge base is and exactly why its "newest
// N" means nothing. Retrieval is `MemoryStore.search`, provided here by SQLite's
// FTS5 index; swapping in a vector store is a different MemoryStore and no
// change above it.

export const CORPUS_SCOPE = "runbooks";
export const CORPUS_TIER = "semantic";

/** What one retrieved chunk looks like once it is back out of the store. */
export interface StoredChunk {
  docId: string;
  title: string;
  /**
   * TAINTED at ingest, not at the prompt. The wrapper is plain JSON, so it rides
   * the memory store, the recorded retrieval and the effect input unchanged — a
   * replay hands the prompt builder a value that is still marked untrusted. Taint
   * it here (where the content enters) and every downstream path is covered;
   * taint it at the boundary and you have to remember, on every path.
   */
  text: ReturnType<typeof tainted<string>>;
}

export function openCorpus(dbPath: string): { memory: TieredMemory; store: SqliteMemoryStore } {
  const store = new SqliteMemoryStore(dbPath);
  // One tier, no eviction. `working`/`episodic` bounds are for a conversation;
  // a corpus is kept until someone deletes it.
  const memory = new TieredMemory({ tiers: { [CORPUS_TIER]: {} }, store });
  return { memory, store };
}

/** Chunk every document and remember each chunk. Returns the number of chunks stored. */
export async function ingest(memory: TieredMemory, docs: RunbookDoc[]): Promise<number> {
  let count = 0;
  for (const doc of docs) {
    for (const piece of chunk(doc)) {
      const stored: StoredChunk = {
        docId: piece.docId,
        title: piece.title,
        text: tainted(piece.text, `runbook:${piece.docId}`),
      };
      await memory.remember(CORPUS_TIER, CORPUS_SCOPE, { content: stored });
      count++;
    }
  }
  return count;
}

/** The chunk shape a flow passes to the model effect (JSON, straight out of the log). */
export function asStoredChunk(content: unknown): StoredChunk {
  return content as StoredChunk;
}

export type { Chunk };
