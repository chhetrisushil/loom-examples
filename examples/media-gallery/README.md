# media-gallery

Multi-modal media, claim-checked by **address** (loom **R5**, ADR 0120, plus loom-ui **U9/U9b**). Headless and
offline: a scripted model, an in-memory content store, and PNGs built in code (no binary fixtures).

```bash
pnpm --filter @loom/media-gallery start   # a narrated walkthrough
pnpm --filter @loom/media-gallery test    # the tests ARE the proof
```

## The pattern

```ts
// 1. A media tool declares `returnsMedia`, stores the bytes, and returns an ADDRESS.
const renderSwatch = tool$({ id: "render_swatch", returnsMedia: true, /* ... */ });
return mediaResult([{ type: "image", mediaType: "image/png", source: { kind: "ref", ref: { address, size } } }]);

// 2. The ONE place bytes appear: fetched just before the provider call, through a resolver that AUTHORIZES.
createAgentModelEffect(provider, { resolveContent: async (ref, ctx) => canRead(ctx.principal, ref.address) ? bytes : null });

// 3. A tool argument that is itself a content ref: marked in the schema, checked at composition AND run time.
inputSchema: { properties: { image: { type: "string", "x-content-ref": true } } }
const table = contentRefArgsFrom(capabilities);                       // @loom-ui/planner
serveHandles(exp, requests, { contentRefArgs: table,
  acceptContentRefParam: (c) => vault.canRead(c.principalId, String(c.value)) });
```

## What each claim shows (`test/media-gallery.test.ts`, same order)

| Claim | What it demonstrates |
|---|---|
| **Unauthorized resolve** | `ContentResolver(ref, ctx)` reads `ctx.principal.tenant`. Another tenant, or no principal, gets `null` (the same answer as an erased blob: no existence oracle) and the refusal is audited. End to end, a tool that names another tenant's address gives the model a `content_unavailable` tool error, never the bytes. |
| **Foreign content-ref argument** | A param that would fill an `x-content-ref` argument reaches the tool only if the host's gate says this viewer may read it. A foreign ref is refused BEFORE the call (the tool's call count stays 0), and a composer-written literal is refused even for a ref the viewer owns. |
| **Text-only fallback** | The capability table is an allowlist: an unknown model id, or a known id behind a custom `baseUrl`, declares `{}`. The media tool checks `mediaTypeAccepted` and returns a description instead of a ref; handing that model an image anyway throws `UnsupportedModalityError` before any wire call. |
| **Log holds addresses** | The model saw the decoded base64; the event log contains each address and not one byte of any image. |
| **Gallery renders N items** | N `Image` widgets bound to MediaRefs, printed by the terminal renderer. A viewer-scoped link exists only for refs that viewer may read, and no address is ever printed. |
| **GC pin holds** | `sweepUnpinnedContent` reads `{ kind: "ref", ref: { address } }` in the log as a pin; an uncited blob past the TTL is reclaimed. A blob only an app table cites (the photo library) survives through `roots`. |
| (extra) **Inline limits** | `MAX_INLINE_BYTES` (64 KiB) and `MAX_INLINE_TOTAL_BYTES` (256 KiB) bound inline `data`; a ref of any size costs nothing against either. |

## Things to know

- **The store has no tenancy.** Whoever can name an address can read it, so authorization is the host's job at
  both seams: the loom `ContentResolver` and loom-ui's `MediaResolver` / terminal `media.link`.
- **Ownership is a set.** Content addressing makes identical bytes one blob; the vault records every tenant that
  stored it, so a second tenant storing the same bytes may read them, and one who merely knows the address may not.
- **A log citation is not the only root.** Blobs cited only by an app table (here the photo library) are
  orphans to the sweep unless you pass `roots`.
- **The sweep reclaims orphans, so the scan must be COMPLETE.** `src/gc.ts` runs
  `reclaimOrphans: { completeScan: true, snapshotsTouchContent: true }`, which deletes every stored blob that no
  SCANNED log, snapshot or `roots` entry cites. Leave an event store, a snapshot store (a compacted prefix's refs
  live only in its snapshot) or an external root out of the scan and every blob only it cites is an orphan, and
  is erased. Pass them all (`eventStores`, `snapshotStores`, `roots`), and run with `dryRun: true` first
  (`main.ts` does) to see what would go. The multi-store test pins the footgun.
- **The erasing sweep is only safe if every citation is also a TOUCH** (loom ADR 0055 D6 amendment 2). A ref that
  reaches a log or snapshot without a `put` (a fork copies one, a snapshot carries one) is invisible to the
  sweep's conditional delete, so loom refuses to erase unless you satisfy its guards, and this example satisfies
  each for real rather than just asserting it:
  1. `completeScan: true` - the caller passes every store that may cite a blob.
  2. The content store can `touch` (`InMemoryContentStore` has `touch` and `touchClock`; a custom store that lacks
     them throws `ReclaimOrphansTouchError` / `ReclaimOrphansClockError`).
  3. `snapshotsTouchContent: true` - true because `src/assistant.ts` wraps the snapshot store in
     `ContentTouchingSnapshotStore` (outside any encrypting store) over the SAME content store as the vault, and
     writes the log through `ContentResolvingEventStore` (`externalize: {}`: the log keeps the media sources
     verbatim and the decorator only touches what an append or fork cites). Their `onTouchError` feeds
     `assistant.touchProblems`, which a healthy run leaves empty.
  4. The orphan TTL leaves at least 60 s on the store's clock (`olderThanMs` is 7 days; a tiny one throws
     `ReclaimOrphansMarginError`). Tests move the injected clock, not the TTL.
  The "wrapping is load-bearing" test spies on `touch`, sees the append and a snapshot save touch their citations,
  checks `touchProblems` stays empty, and shows the sweep without the acknowledgement is refused.
- `returnsMedia` is the operator's declaration; without it a media-shaped tool output is plain data, so a
  hostile result cannot choose which stored blob is fetched into the prompt.
