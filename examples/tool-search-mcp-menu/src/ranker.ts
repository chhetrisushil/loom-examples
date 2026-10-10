import { DEFAULT_STOPWORDS, type ToolHit, type ToolRanker, type ToolSearchDoc } from "@loom/agent";

const STOP = new Set<string>(DEFAULT_STOPWORDS);

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.endsWith("s") ? w.slice(0, -1) : w));

/**
 * A deliberately trivial, deterministic custom ranker (ADR 0125 D13/D15): a tool scores one point
 * per distinct query word found in its sanitized search DOC (name, tags, aliases, and a description
 * only if the doc has one). It is built from the docs the loop hands its factory, so it never
 * imports the host's annotations and never sees a remote description: the loop's trust policy
 * already decided what is indexable. A custom ranker keeps no built-in stoplist, so this one
 * drops the library's `DEFAULT_STOPWORDS` from the QUERY itself. It counts its calls so the
 * example can prove a resume makes none.
 */
export class OverlapRanker implements ToolRanker {
  readonly kind = "word-overlap";
  calls = 0;
  private readonly index = new Map<string, Set<string>>();

  constructor(docs: readonly ToolSearchDoc[]) {
    for (const d of docs) {
      this.index.set(
        d.id,
        new Set(words([d.id, ...d.tags, ...d.aliases, d.description ?? ""].join(" ")))
      );
    }
  }

  rank(query: string, limit: number): readonly ToolHit[] {
    this.calls++;
    const raw = query.toLowerCase().split(/[^a-z0-9]+/);
    const q = new Set(words(raw.filter((w) => !STOP.has(w)).join(" ")));
    const hits: ToolHit[] = [];
    for (const [id, doc] of this.index) {
      let score = 0;
      for (const w of q) if (doc.has(w)) score++;
      if (score > 0) hits.push({ id, score });
    }
    return hits.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : 1)).slice(0, limit);
  }
}

/**
 * The `toolSearch.ranker` factory plus a probe of what happened to it. The loop calls the factory
 * lazily, at most once per run, on the first search that reaches the ranker; a resume never calls
 * it (the searches are recorded). `factoryCalls`, `docsSeen` and `built` let the example prove both.
 */
export class RankerProbe {
  factoryCalls = 0;
  readonly docsSeen: (readonly ToolSearchDoc[])[] = [];
  readonly built: OverlapRanker[] = [];

  /** Total `rank` calls across every ranker this factory built. */
  get calls(): number {
    return this.built.reduce((n, r) => n + r.calls, 0);
  }

  readonly factory = (docs: readonly ToolSearchDoc[]): OverlapRanker => {
    this.factoryCalls++;
    this.docsSeen.push(docs);
    const r = new OverlapRanker(docs);
    this.built.push(r);
    return r;
  };
}
