import {
  MAX_INLINE_BYTES,
  MAX_INLINE_TOTAL_BYTES,
  OversizedInlinePartError,
  guardRequest,
} from "@loom/llm";
import { InMemoryContentStore } from "@loom/plugin-content";
import { createAssistant } from "./assistant";
import { GallerySession, GalleryTools, contentRefTable } from "./gallery";
import { DAY_MS, sweepMedia } from "./gc";
import { declaredCapabilities, scriptedVision } from "./model";
import { tinyPng } from "./png";
import { MediaVault } from "./vault";

// A narrated walkthrough. Everything is offline: a scripted model, an in-memory content store, tiny PNGs
// built in code. `pnpm --filter @loom/media-gallery test` is the proof; this is the story.

const say = (heading: string, ...lines: string[]): void => {
  console.log(`\n== ${heading}`);
  for (const l of lines) console.log(`   ${l}`);
};
const answerOf = (outcome: { variables: unknown }): string =>
  (outcome.variables as { _output: { content: string } })._output.content;
const short = (address: string): string => `${address.slice(0, 14)}...`;

const clock = { now: Date.now() };
const vault = new MediaVault(new InMemoryContentStore({ now: () => clock.now }));

// 1. An agent whose tool returns media: the model sees the bytes, the log keeps the address.
const model = scriptedVision(declaredCapabilities("gpt-4o"));
const assistant = createAssistant({ vault, provider: model });
const run = await assistant.ask("acme", "show me red, green and blue swatches");
const log = JSON.stringify(await assistant.eventStore.read(run.executionId));
const addresses = new Set([...log.matchAll(/sha256:[0-9a-f]{64}/g)].map((m) => m[0]));
say(
  "1. the model sees the image, the log keeps its address",
  `status: ${run.outcome.status}`,
  `model: ${answerOf(run.outcome)}`,
  `log: ${log.length} bytes, ${addresses.size} distinct addresses (${[...addresses].map(short).join(", ")}), inline data: ${log.includes('"kind":"data"')}`
);

// 2. Authorization lives in the resolver.
const secret = await vault.put("acme", tinyPng([255, 255, 0]), {
  mediaType: "image/png",
  name: "passport-scan.png",
});
const attachments = new Map([["passport-scan", secret]]);
const foreignModel = scriptedVision(declaredCapabilities("gpt-4o"));
const foreign = await createAssistant({ vault, provider: foreignModel, attachments }).ask(
  "globex",
  "open the attachment"
);
say(
  "2. a ContentResolver authorizes with (ref, ctx)",
  `globex asks for acme's attachment -> ${answerOf(foreign.outcome)}`,
  `denials audited: ${JSON.stringify(vault.denials.map((d) => ({ seam: d.seam, tenant: d.tenant })))}`
);

// 3. The provider allowlist.
say("3. the provider capability allowlist (a shipped provider, read offline)");
for (const [label, caps] of [
  ["gpt-4o", declaredCapabilities("gpt-4o")],
  ["my-finetune-v3", declaredCapabilities("my-finetune-v3")],
  ["gpt-4o @ custom baseUrl", declaredCapabilities("gpt-4o", "https://llm.internal.example/v1")],
] as const)
  console.log(`   ${label.padEnd(26)} declares ${JSON.stringify(caps)}`);
const textOnly = scriptedVision(declaredCapabilities("my-finetune-v3"));
const fallback = await createAssistant({ vault, provider: textOnly }).ask(
  "acme",
  "show me a red swatch"
);
console.log(`   an unknown model gets text, not an image -> ${answerOf(fallback.outcome)}`);

// 4. The gallery.
const tools = new GalleryTools(vault);
const ids = ["sunrise", "harbour", "ridge", "market"];
for (const [i, id] of ids.entries()) {
  const s = await vault.put("acme", tinyPng([60 + i * 50, 120, 200 - i * 40]), {
    mediaType: "image/png",
    name: `${id}.png`,
    alt: `${id} at dawn`,
  });
  tools.addPhoto("acme", id, s.ref);
}
const session = new GallerySession({ vault, tools, tenant: "acme", photoIds: ids });
await session.loadPhotos();
say("4. a loom-ui gallery, N Image widgets bound to MediaRefs", ...session.frame().split("\n"));

// 5. A tool argument that is itself a content ref.
const theirs = await vault.put("globex", tinyPng([5, 5, 5]), { mediaType: "image/png" });
const mine = await vault.put("acme", tinyPng([250, 20, 20]), { mediaType: "image/png" });
const describes = () => tools.calls.filter((c) => c.toolName === "vision.describe").length;
const refused = await session.load(["caption"], { image: theirs.ref.address });
const callsAfterRefusal = describes();
const accepted = await session.load(["caption"], { image: mine.ref.address });
say(
  "5. x-content-ref arguments",
  `table: ${JSON.stringify(contentRefTable)}`,
  `foreign ref -> ${refused[0]?.state} (${session.findings.map((f) => f.code).join(", ")}); vision.describe calls made: ${callsAfterRefusal}`,
  `own ref     -> ${JSON.stringify(accepted[0])}`
);

// 6. Inline limits.
const big = {
  messages: [
    {
      role: "user" as const,
      content: [
        {
          type: "image" as const,
          mediaType: "image/png",
          source: {
            kind: "data" as const,
            data: Buffer.alloc(MAX_INLINE_BYTES + 1).toString("base64"),
          },
        },
      ],
    },
  ],
};
let limit = "accepted";
try {
  guardRequest(big);
} catch (err) {
  limit = err instanceof OversizedInlinePartError ? `refused (${err.name})` : String(err);
}
say(
  "6. inline limits",
  `per part ${MAX_INLINE_BYTES} B, per request ${MAX_INLINE_TOTAL_BYTES} B; a ${MAX_INLINE_BYTES + 1} B inline image: ${limit}`,
  "a ref of any size costs nothing against either; it is fetched at call time"
);

// 7. GC.
const orphan = await vault.put("acme", tinyPng([1, 1, 1]), { mediaType: "image/png" });
clock.now += 30 * DAY_MS;
const scan = { now: clock.now, roots: () => tools.addresses() };
const preview = await sweepMedia(vault, assistant, { ...scan, dryRun: true }); // nothing is deleted
const intactAfterPreview = (await vault.store.get({ __loomContent: orphan.ref.address })) !== null;
const report = await sweepMedia(vault, assistant, scan);
const survives = await vault.store.get({ __loomContent: [...addresses][0] as string });
say(
  "7. GC pins what a log still cites",
  `dry run first: ${preview.orphansReclaimed.length} would be reclaimed, the orphan is still stored: ${intactAfterPreview}`,
  `orphans reclaimed: ${report.orphansReclaimed.length} (uncited, past the TTL; the orphan put in step 7 is among them: ${report.orphansReclaimed.includes(orphan.ref.address)})`,
  `gallery photos survive (held by the library, an external root): ${(await Promise.all(ids.map(async (id) => vault.store.get({ __loomContent: (await tools.refOf("acme", id))?.address ?? "" })))).every((b) => b !== null)}`,
  `a swatch the run cited still resolves: ${survives !== null}`
);
