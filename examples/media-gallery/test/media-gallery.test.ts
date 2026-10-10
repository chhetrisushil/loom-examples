import {
  MAX_INLINE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  OversizedInlinePartError,
  UnsupportedModalityError,
  guardRequest,
  mediaTypeAccepted,
  textOf,
} from "@loom/llm";
import type { LlmRequest } from "@loom/llm";
import {
  InMemoryContentStore,
  ReclaimOrphansSnapshotAckError,
  sweepUnpinnedContent,
} from "@loom/plugin-content";
import { describe, expect, it } from "vitest";
import { createAssistant } from "../src/assistant";
import { GallerySession, GalleryTools } from "../src/gallery";
import { DAY_MS, sweepMedia } from "../src/gc";
import { declaredCapabilities, scriptedVision } from "../src/model";
import { tinyPng } from "../src/png";
import { MediaVault } from "../src/vault";

const answerOf = (outcome: { variables: unknown }): string =>
  (outcome.variables as { _output: { content: string } })._output.content;

const ctxFor = (tenant: string | undefined) => ({
  executionId: "exec-1",
  origin: "tool" as const,
  maxBytes: 1_000_000,
  ...(tenant !== undefined && { principal: { tenant } }),
});

describe("media-gallery", () => {
  // ── 1 ── A ContentResolver AUTHORIZES with (ref, ctx) ─────────────────────────────────────────────
  it("an unauthorized resolve is refused: another tenant's image never reaches the model", async () => {
    const vault = new MediaVault();
    const mine = await vault.put("acme", tinyPng([200, 10, 10]), { mediaType: "image/png" });

    // Directly: the owner reads it; another tenant, and a caller with no principal, get nothing -
    // the same `null` an erased blob gives, so a denial is not an existence oracle.
    expect(await vault.resolveForModel(mine.source.ref, ctxFor("acme"))).not.toBeNull();
    expect(await vault.resolveForModel(mine.source.ref, ctxFor("globex"))).toBeNull();
    expect(await vault.resolveForModel(mine.source.ref, ctxFor(undefined))).toBeNull();
    expect(vault.denials.map((d) => [d.seam, d.tenant])).toEqual([
      ["model", "globex"],
      ["model", undefined],
    ]);

    // End to end: a tool (any tool) that NAMES acme's address in globex's conversation.
    const attachments = new Map([["passport-scan", mine]]);
    const run = async (tenant: string) => {
      const model = scriptedVision(declaredCapabilities("gpt-4o"));
      const a = createAssistant({ vault, provider: model, attachments });
      const { outcome } = await a.ask(tenant, "open the attachment please");
      const sawImage = JSON.stringify(model.seen.at(-1)).includes('"type":"image"');
      const toolText = textOf(model.seen.at(-1)?.messages.at(-1)?.content ?? "");
      return { outcome, sawImage, toolText, answer: answerOf(outcome) };
    };
    const owner = await run("acme");
    expect(owner.outcome.status).toBe("completed");
    expect(owner.sawImage).toBe(true);
    expect(owner.answer).toContain("I can see a 2x2 image");

    const foreign = await run("globex");
    expect(foreign.outcome.status).toBe("completed"); // the run survives: the model is told, as a tool error
    expect(foreign.sawImage).toBe(false);
    expect(foreign.answer).toContain("unavailable");
    expect(foreign.toolText).toContain("content_unavailable"); // the model is told only that it could not be opened
  });

  it("identical bytes stored by two tenants: both may read, a third may not, and every seam agrees", async () => {
    const vault = new MediaVault();
    const bytes = tinyPng([77, 88, 99]);
    const a = await vault.put("acme", bytes, { mediaType: "image/png" });
    const g = await vault.put("globex", bytes, { mediaType: "image/png" });
    expect(g.ref.address).toBe(a.ref.address); // one blob
    const address = a.ref.address;

    expect(await vault.resolveForModel(a.source.ref, ctxFor("acme"))).not.toBeNull();
    expect(await vault.resolveForModel(a.source.ref, ctxFor("globex"))).not.toBeNull();
    expect(await vault.resolveForModel(a.source.ref, ctxFor("initech"))).toBeNull();

    const req = { ref: a.ref, kind: "Image", widgetId: "img", purpose: "display" as const };
    for (const tenant of ["acme", "globex"]) {
      expect(await vault.mediaResolverFor(tenant)(req)).toMatchObject({ ok: true });
      expect(vault.terminalLinkFor(tenant)(a.ref)).toBe(vault.linkFor(tenant, address));
    }
    expect(await vault.mediaResolverFor("initech")(req)).toEqual({ ok: false });
    expect(vault.terminalLinkFor("initech")(a.ref)).toBeUndefined();
    expect(vault.linkFor("acme", address)).not.toBe(vault.linkFor("globex", address)); // links are viewer-scoped
  });

  // ── 2 ── x-content-ref: a marked argument only accepts a ref the caller may read ─────────────────
  it("a content-ref argument naming a foreign ref is refused, and the tool is never called", async () => {
    const vault = new MediaVault();
    const tools = new GalleryTools(vault);
    const theirs = await vault.put("globex", tinyPng([1, 2, 3]), { mediaType: "image/png" });
    const mine = await vault.put("acme", tinyPng([9, 8, 7]), { mediaType: "image/png" });
    const session = new GallerySession({ vault, tools, tenant: "acme", photoIds: [] });

    const foreign = await session.load(["caption"], { image: theirs.ref.address });
    expect(foreign[0]?.state).toBe("error");
    // loom-ui #64: a param the host gate refuses is `media-arg-param-refused` (a literal stays `media-arg-literal`)
    expect(session.findings.map((f) => f.code)).toContain("media-arg-param-refused");
    expect(tools.calls).toHaveLength(0); // refused BEFORE the call, not rejected by the tool
    expect(JSON.stringify(foreign)).not.toContain(theirs.ref.address.slice(7, 20)); // never echoed back

    const own = await session.load(["caption"], { image: mine.ref.address });
    expect(own[0]).toMatchObject({
      state: "ready",
      value: { headline: "2x2 image", detail: "rgb(9,8,7)" },
    });
    expect(tools.calls.map((c) => c.toolName)).toEqual(["vision.describe"]);

    // A composer-written LITERAL at a marked path is refused even for a ref the viewer owns.
    const literal = new GallerySession({
      vault,
      tools,
      tenant: "acme",
      photoIds: [],
      captionArguments: { image: mine.ref.address },
    });
    expect((await literal.load(["caption"]))[0]?.state).toBe("error");
    expect(tools.calls).toHaveLength(1);
  });

  // ── 3 ── the provider capability ALLOWLIST ─────────────────────────────────────────────────────────
  it("an unknown model id, or a custom baseUrl, gets a text-only fallback", async () => {
    const known = declaredCapabilities("gpt-4o");
    expect(mediaTypeAccepted(known.image, "image/png")).toBe(true);
    for (const caps of [
      declaredCapabilities("my-finetune-v3"), // not on the allowlist
      declaredCapabilities("gpt-4o", "https://llm.internal.example/v1"), // the id says nothing about what is behind it
    ]) {
      expect(caps).toEqual({});
    }

    const vault = new MediaVault();
    const textOnly = scriptedVision(declaredCapabilities("my-finetune-v3"));
    const a = createAssistant({ vault, provider: textOnly });
    const { outcome } = await a.ask("acme", "show me a red swatch");
    expect(outcome.status).toBe("completed");
    const last = JSON.stringify(textOnly.seen.at(-1));
    expect(last).not.toContain('"type":"image"'); // no image part reached the model
    // it got the description instead, read the portable way (`textOf` works on a string or on parts)
    expect(textOf(textOnly.seen.at(-1)?.messages.at(-1)?.content ?? "")).toContain(
      "this model takes no images"
    );
    expect(answerOf(outcome)).toContain("(text only)");
    expect(vault.denials).toEqual([]); // and nothing was fetched on its behalf

    // Fail closed: handing it an image anyway is refused before any wire call, by name.
    const image: LlmRequest = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", source: { kind: "data", data: "AAAA" } },
          ],
        },
      ],
    };
    await expect(textOnly.complete(image)).rejects.toBeInstanceOf(UnsupportedModalityError);
  });

  // ── 4 ── claim-check: the LOG holds addresses ──────────────────────────────────────────────────────
  it("the log holds addresses, not bytes", async () => {
    const vault = new MediaVault();
    const model = scriptedVision(declaredCapabilities("gpt-4o"));
    const a = createAssistant({ vault, provider: model });
    const { executionId, outcome } = await a.ask("acme", "show me red, green and blue swatches");
    expect(outcome.status).toBe("completed");

    // The model really did see three decoded images (so this is not a test of an empty run).
    expect(answerOf(outcome)).toMatch(
      /#1: .*rgb\(220,40,40\).*#2: .*rgb\(40,170,70\).*#3: .*rgb\(40,90,220\)/
    );

    const log = JSON.stringify(await a.eventStore.read(executionId));
    const seenByModel = JSON.stringify(model.seen.at(-1));
    for (const color of [
      [220, 40, 40],
      [40, 170, 70],
      [40, 90, 220],
    ] as const) {
      const bytes = tinyPng(color);
      const b64 = Buffer.from(bytes).toString("base64");
      expect(seenByModel).toContain(b64); // the provider got the bytes ...
      expect(log).not.toContain(b64); // ... the log never did
    }
    const addresses = [...log.matchAll(/sha256:[0-9a-f]{64}/g)].map((m) => m[0]);
    expect(new Set(addresses).size).toBe(3); // one address per swatch, cited by the tool frame and the model frame
    expect(log).toContain('"kind":"ref"');
    expect(log).not.toContain('"kind":"data"');

    // The snapshot store holds no bytes either, and neither does the attachment path (a tool NAMING an address).
    const snapshots = JSON.stringify(await a.snapshotStore.loadLatest(executionId));
    for (const color of [
      [220, 40, 40],
      [40, 170, 70],
      [40, 90, 220],
    ] as const)
      expect(snapshots).not.toContain(Buffer.from(tinyPng(color)).toString("base64"));
    const att = await vault.put("acme", tinyPng([13, 14, 15]), { mediaType: "image/png" });
    const viaAttachment = createAssistant({
      vault,
      provider: model,
      attachments: new Map([["passport-scan", att]]),
    });
    const run2 = await viaAttachment.ask("acme", "open the attachment please");
    expect(run2.outcome.status).toBe("completed");
    expect(JSON.stringify(model.seen.at(-1))).toContain(
      Buffer.from(tinyPng([13, 14, 15])).toString("base64")
    );
    const log2 = JSON.stringify(await viaAttachment.eventStore.read(run2.executionId));
    expect(log2).not.toContain(Buffer.from(tinyPng([13, 14, 15])).toString("base64"));
    expect(log2).toContain(att.ref.address);
  });

  // ── 5 ── loom-ui media widgets render a gallery from refs ───────────────────────────────────────────
  it("the gallery renders N items, and a viewer who cannot read one is given no link", async () => {
    const vault = new MediaVault();
    const tools = new GalleryTools(vault);
    const N = 5;
    const ids = Array.from({ length: N }, (_, i) => `p${i + 1}`);
    for (const [i, id] of ids.entries()) {
      const s = await vault.put("acme", tinyPng([i * 40, 90, 160]), {
        mediaType: "image/png",
        name: `${id}.png`,
        alt: `photo ${i + 1}`,
      });
      tools.addPhoto("acme", id, s.ref);
    }
    const session = new GallerySession({ vault, tools, tenant: "acme", photoIds: ids });
    const loaded = await session.loadPhotos();
    expect(loaded.every((r) => r.state === "ready")).toBe(true);

    const frame = session.frame();
    const items = frame.split("\n").filter((l) => /^Photo p\d+: image /.test(l));
    expect(items).toHaveLength(N);
    expect(items.every((l) => l.includes("https://media.example.com/v/"))).toBe(true);
    expect(frame).not.toMatch(/sha256:/); // an address is a capability: it is never printed

    // A second viewer whose library (wrongly) lists acme's photo: it draws, but with no way to open it.
    const first = (loaded[0] as { value: Parameters<typeof tools.addPhoto>[2] }).value;
    tools.addPhoto("globex", "p1", first);
    const other = new GallerySession({ vault, tools, tenant: "globex", photoIds: ["p1"] });
    await other.loadPhotos();
    const otherItems = other
      .frame()
      .split("\n")
      .filter((l) => l.startsWith("Photo p1: image"));
    expect(otherItems).toHaveLength(1);
    expect(otherItems[0]).not.toContain("https://");
    // loom-ui's MediaResolver seam says the same: denied has no reason, so it cannot be told from missing.
    const req = { ref: first, kind: "Image", widgetId: "img-p1", purpose: "display" as const };
    expect(await vault.mediaResolverFor("acme")(req)).toMatchObject({ ok: true });
    expect(await vault.mediaResolverFor("globex")(req)).toEqual({ ok: false });
  });

  // ── 6 ── content GC pins what a log still cites ─────────────────────────────────────────────────────
  it("a GC pin holds: a ref the log cites survives the orphan sweep, an uncited blob does not", async () => {
    const clock = { now: Date.now() };
    const vault = new MediaVault(new InMemoryContentStore({ now: () => clock.now }));
    const model = scriptedVision(declaredCapabilities("gpt-4o"));
    const a = createAssistant({ vault, provider: model });
    const { executionId, outcome } = await a.ask("acme", "show me a red swatch");
    expect(outcome.status).toBe("completed");
    const cited = [
      ...JSON.stringify(await a.eventStore.read(executionId)).matchAll(/sha256:[0-9a-f]{64}/g),
    ].map((m) => m[0]);
    expect(new Set(cited).size).toBe(1);
    const orphan = await vault.put("acme", tinyPng([1, 1, 1]), { mediaType: "image/png" }); // put, then the append never landed
    // A photo only an app table (the library) cites: no log mentions it, so it is pinned as an external ROOT.
    const tools = new GalleryTools(vault);
    const held = await vault.put("acme", tinyPng([2, 2, 2]), { mediaType: "image/png" });
    tools.addPhoto("acme", "held", held.ref);

    clock.now += 30 * DAY_MS; // a month on, both blobs are well past the 7-day TTL
    const report = await sweepMedia(vault, a, { now: clock.now, roots: () => tools.addresses() });
    expect(report.orphansReclaimed).toEqual([orphan.ref.address]);
    expect(
      await vault.store.get({ __loomContent: [...new Set(cited)][0] as string })
    ).not.toBeNull();
    expect(await vault.store.get({ __loomContent: orphan.ref.address })).toBeNull();
    expect(await vault.store.get({ __loomContent: held.ref.address })).not.toBeNull();
  });

  it("the erasing sweep is only allowed because the example touches what it cites: the wrapping is load-bearing", async () => {
    const clock = { now: Date.now() };
    const store = new InMemoryContentStore({ now: () => clock.now });
    // Spy on the touches the decorators make (ContentResolvingEventStore on append, ContentTouchingSnapshotStore on save).
    const touched = new Set<string>();
    const realTouch = store.touch?.bind(store);
    expect(realTouch).toBeDefined();
    store.touch = async (addresses) => {
      for (const a of addresses) touched.add(a);
      return (realTouch as NonNullable<typeof realTouch>)(addresses);
    };
    const vault = new MediaVault(store);
    const a = createAssistant({ vault, provider: scriptedVision(declaredCapabilities("gpt-4o")) });
    const { executionId } = await a.ask("acme", "show me a red swatch");
    const cited = [
      ...new Set(
        [
          ...JSON.stringify(await a.eventStore.read(executionId)).matchAll(/sha256:[0-9a-f]{64}/g),
        ].map((m) => m[0])
      ),
    ];
    expect(cited).toHaveLength(1);
    expect(touched.has(cited[0] as string)).toBe(true); // the append touched the media source it cites
    expect(a.touchProblems).toEqual([]); // no failed touch, no cited blob found missing

    // The second citation path: a snapshot that carries a media source (a compacted fork's seed) is touched on save.
    const seedOnly = await vault.put("acme", tinyPng([9, 9, 9]), { mediaType: "image/png" });
    expect(touched.has(seedOnly.ref.address)).toBe(false); // a bare put does not go through touch()
    await a.snapshotStore.save({
      id: "seed-1",
      executionId: "seed",
      workflowId: "gallery-chat",
      sequence: 1,
      state: { variables: { media: seedOnly.source } },
      createdAt: clock.now,
    } as unknown as Parameters<typeof a.snapshotStore.save>[0]);
    expect(touched.has(seedOnly.ref.address)).toBe(true); // ContentTouchingSnapshotStore touched it

    clock.now += 30 * DAY_MS;
    const base = {
      eventStores: [a.eventStore],
      snapshotStores: [a.snapshotStore],
      contentStore: store,
      pinnedEventTypes: [],
      olderThanMs: 7 * DAY_MS,
      now: clock.now,
    };
    // Without the snapshot acknowledgement loom refuses to ERASE (nothing is deleted) ...
    await expect(
      sweepUnpinnedContent({ ...base, reclaimOrphans: { completeScan: true } })
    ).rejects.toBeInstanceOf(ReclaimOrphansSnapshotAckError);
    // ... and the example's sweep, which wraps its stores and acknowledges, is allowed and keeps the cited blob.
    const report = await sweepMedia(vault, a, { now: clock.now });
    // (the seed blob is cited by no scanned execution here, so it is a legitimate orphan; the cited one is not)
    expect(report.orphansReclaimed).toEqual([seedOnly.ref.address]);
    expect(await store.get({ __loomContent: cited[0] as string })).not.toBeNull();
  });

  it("a sweep that omits an event store erases what only that store cites; scanning both keeps it", async () => {
    const setup = async () => {
      const clock = { now: Date.now() };
      const vault = new MediaVault(new InMemoryContentStore({ now: () => clock.now }));
      const first = createAssistant({
        vault,
        provider: scriptedVision(declaredCapabilities("gpt-4o")),
      });
      const second = createAssistant({
        vault,
        provider: scriptedVision(declaredCapabilities("gpt-4o")),
      });
      const r1 = await first.ask("acme", "show me a red swatch");
      const r2 = await second.ask("globex", "show me a green swatch"); // a DIFFERENT blob, in a SECOND event store
      const addr = async (a: typeof first, id: string) => [
        ...new Set(
          [...JSON.stringify(await a.eventStore.read(id)).matchAll(/sha256:[0-9a-f]{64}/g)].map(
            (m) => m[0]
          )
        ),
      ];
      const redAddr = await addr(first, r1.executionId);
      const greenAddr = await addr(second, r2.executionId);
      expect(redAddr).toHaveLength(1);
      expect(greenAddr).toHaveLength(1);
      expect(greenAddr[0]).not.toBe(redAddr[0]);
      clock.now += 30 * DAY_MS;
      return {
        vault,
        first,
        second,
        clock,
        red: redAddr[0] as string,
        green: greenAddr[0] as string,
      };
    };
    const has = async (v: MediaVault, address: string) =>
      (await v.store.get({ __loomContent: address })) !== null;

    // Footgun, pinned: scanning only the FIRST store makes the second run's blob an orphan, and it is erased.
    const partial = await setup();
    const preview = await sweepMedia(partial.vault, partial.first, {
      now: partial.clock.now,
      dryRun: true,
    });
    expect(preview.orphansReclaimed).toEqual([partial.green]); // the dry run names it ...
    expect(await has(partial.vault, partial.green)).toBe(true); // ... and deletes nothing
    await sweepMedia(partial.vault, partial.first, { now: partial.clock.now });
    expect(await has(partial.vault, partial.red)).toBe(true);
    expect(await has(partial.vault, partial.green)).toBe(false); // data loss: the log still cites it

    // Scanning both keeps both.
    const full = await setup();
    const report = await sweepMedia(full.vault, full.first, {
      now: full.clock.now,
      eventStores: [full.first.eventStore, full.second.eventStore],
      snapshotStores: [full.first.snapshotStore, full.second.snapshotStore],
    });
    expect(report.orphansReclaimed).toEqual([]);
    expect(await has(full.vault, full.red)).toBe(true);
    expect(await has(full.vault, full.green)).toBe(true);
  });

  // ── extra ── the inline limits the claim-check exists to avoid ───────────────────────────────────────
  it("inline media is capped per part and per request; a ref costs nothing against either", () => {
    const inline = (bytes: number) => ({
      type: "image" as const,
      mediaType: "image/png",
      source: { kind: "data" as const, data: Buffer.alloc(bytes, 1).toString("base64") },
    });
    const req = (...content: ReturnType<typeof inline>[]): LlmRequest => ({
      messages: [{ role: "user", content }],
    });
    expect(MAX_INLINE_BYTES).toBe(64 * 1024);
    expect(MAX_INLINE_TOTAL_BYTES).toBe(256 * 1024);
    expect(() => guardRequest(req(inline(MAX_INLINE_BYTES + 1)))).toThrow(OversizedInlinePartError);
    const parts = (n: number) => req(...Array.from({ length: n }, () => inline(MAX_INLINE_BYTES)));
    expect(() => guardRequest(parts(4))).not.toThrow(); // exactly the total cap: passes
    let total: unknown;
    try {
      guardRequest(parts(5));
    } catch (err) {
      total = err;
    }
    // Same error class as the per-part cap; the TOTAL cap is told apart by `limit` (and the message).
    expect(total).toBeInstanceOf(OversizedInlinePartError);
    expect((total as OversizedInlinePartError).limit).toBe(MAX_INLINE_TOTAL_BYTES);
    expect((total as OversizedInlinePartError).message).toContain("in this request totals");
    let part: unknown;
    try {
      guardRequest(req(inline(MAX_INLINE_BYTES + 1)));
    } catch (err) {
      part = err;
    }
    expect((part as OversizedInlinePartError).limit).toBe(MAX_INLINE_BYTES);
    expect((part as OversizedInlinePartError).message).toContain("part is");
    const ref = {
      type: "image" as const,
      mediaType: "image/png",
      source: { kind: "ref" as const, ref: { address: "sha256:ab", size: 5_000_000 } },
    };
    expect(() =>
      guardRequest({ messages: [{ role: "user", content: [ref, ref, ref, ref, ref] }] })
    ).not.toThrow();
  });
});
