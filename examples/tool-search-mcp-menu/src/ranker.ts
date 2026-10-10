import type { ToolHit, ToolRanker } from "@loom/agent";
import { ANNOTATIONS } from "./catalog";

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.endsWith("s") ? w.slice(0, -1) : w));

/**
 * A deliberately trivial, deterministic custom ranker (ADR 0125 D13): a tool scores one point per
 * distinct query word found in its NAME or in the host's annotation vocabulary. It never reads a
 * remote description. It counts its calls so the example can prove a resume makes none.
 */
export class OverlapRanker implements ToolRanker {
  readonly kind = "word-overlap";
  calls = 0;
  private readonly docs = new Map<string, Set<string>>();

  constructor(toolIds: readonly string[]) {
    for (const id of toolIds) {
      const a = ANNOTATIONS[id];
      this.docs.set(id, new Set(words([id, ...(a?.tags ?? []), ...(a?.aliases ?? [])].join(" "))));
    }
  }

  rank(query: string, limit: number): readonly ToolHit[] {
    this.calls++;
    const q = new Set(words(query));
    const hits: ToolHit[] = [];
    for (const [id, doc] of this.docs) {
      let score = 0;
      for (const w of q) if (doc.has(w)) score++;
      if (score > 0) hits.push({ id, score });
    }
    return hits.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1)).slice(0, limit);
  }
}
