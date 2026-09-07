import { KnowledgeBase, packParagraphs } from "@loom/knowledge";
import { TieredMemory } from "@loom/memory";
import { SqliteMemoryStore } from "@loom/plugin-sqlite";

// ── The knowledge base: a memory tier, and one small mapping over it ──────────
//
// There is still no `knowledge$` construct, no document store and no index to
// configure. A corpus is the `semantic` tier of an ordinary memory — the tier that
// never evicts — and retrieval is `MemoryStore.search`, here SQLite's FTS5 index;
// swapping in a vector store is a different MemoryStore and no change above it.
//
// What `@loom/knowledge` adds (loom ADR 0091) is the one thing the store cannot
// express: the mapping from a DOCUMENT to the PASSAGES it is searched in. `search`
// ranks within one key, so the corpus is one key, while the thing people edit is a
// document inside it. Without that mapping, re-ingesting an edited runbook leaves
// BOTH revisions in the index — which this example could never have shown, because
// it ingests once and asks once.

export const CORPUS_SCOPE = "runbooks";
export const CORPUS_TIER = "semantic";

export interface Corpus {
  kb: KnowledgeBase;
  memory: TieredMemory;
  store: SqliteMemoryStore;
}

export function openCorpus(dbPath: string): Corpus {
  const store = new SqliteMemoryStore(dbPath);
  // One tier, no eviction. `working`/`episodic` bounds are for a conversation; a
  // corpus is kept until someone deletes it — and `KnowledgeBase` REFUSES a tier
  // that evicts, because eviction would drop passages its manifest still counts.
  const memory = new TieredMemory({ tiers: { [CORPUS_TIER]: {} }, store });
  const kb = new KnowledgeBase({
    memory,
    scope: CORPUS_SCOPE,
    tier: CORPUS_TIER,
    chunker: packParagraphs(260),
    // The provenance label the fence shows the model. Default is
    // `knowledge:<scope>:<docId>`; this corpus calls itself what its readers call it.
    origin: (doc) => `runbook:${doc.id}`,
  });
  return { kb, memory, store };
}
