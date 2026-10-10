import {
  type ContentRefTable,
  type Experience,
  type MCPToolNode,
  type MediaRef,
  type Operation,
  type ProviderSpec,
  type SemanticCatalog,
  type StatusCardValue,
  compile,
  defineSemanticCatalog,
  genesis,
  mediaCatalogEntries,
  orderKeyBetween,
  replay,
} from "@loom-ui/core";
import { seal } from "@loom-ui/core/log";
import {
  HYDRATION_PROJECTION_ID,
  HYDRATION_PROJECTION_VERSION,
  type HandleLoadResult,
  HydrationStore,
  type TransientInvoker,
  serveHandles,
} from "@loom-ui/hydration";
import { contentRefArgsFrom } from "@loom-ui/planner";
import type { CapabilityRef } from "@loom-ui/planner";
import { renderExperience, terminalRegistry } from "@loom-ui/renderer-terminal";
import type { TransientInvokeOptions } from "@loom/effect-runtime";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { readPng } from "./png";
import type { MediaVault } from "./vault";

// The loom-ui half. A gallery is a grid of `Image` widgets, each BOUND to a handle whose hydrated VALUE is
// a MediaRef: an address plus metadata, never bytes. The address travels only as a hydrated value (never
// as a node prop, never in the Blueprint), and what a viewer is handed to LOAD is decided by the host
// per viewer. A second tool, `vision.describe`, takes a content ref as an ARGUMENT; its input schema marks
// the field `x-content-ref`, so the model that composes a surface can never author one.

const GET_PIN = "sha256:photos-get-v1";
const DESCRIBE_PIN = "sha256:vision-describe-v1";

/** What the host offers a composer. The schemas carry the `x-content-ref` markers the table is read from. */
export const capabilities: readonly CapabilityRef[] = [
  {
    handle: "photo",
    toolName: "photos.get",
    toolVersion: "1.0.0",
    toolSchemaHash: GET_PIN,
    description: "One photo from the viewer's library, as a media reference",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    // The WHOLE output is a content reference: only a step reference to it may feed a marked argument.
    outputSchema: { type: "object", "x-content-ref": true },
  },
  {
    handle: "describe",
    toolName: "vision.describe",
    toolVersion: "1.0.0",
    toolSchemaHash: DESCRIBE_PIN,
    description: "Describe an image the viewer picked",
    inputSchema: {
      type: "object",
      properties: { image: { type: "string", "x-content-ref": true } },
    },
  },
];

/** Derived once from the capabilities and handed to BOTH composition and hydration, so they cannot disagree. */
export const contentRefTable: ContentRefTable = contentRefArgsFrom(capabilities);

export const catalog: SemanticCatalog = defineSemanticCatalog({
  id: "example.media-gallery.v1",
  entries: [
    ...mediaCatalogEntries({ surfaces: ["web", "terminal"] }),
    {
      name: "Caption",
      version: "1.0.0",
      props: [],
      binding: "required",
      surfaces: {
        web: { kind: "StatusCard", props: [], binding: "required" },
        terminal: { kind: "StatusCard", props: [], binding: "required" },
      },
    },
  ],
});

// ── The tool server (a stand-in for an MCP server behind `mcp.invoke`) ───────────────────────────

interface McpCall {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly expectedSchemaHash: string;
}

export class GalleryTools implements TransientInvoker {
  readonly calls: Array<{ toolName: string; args: Record<string, unknown>; tenant?: string }> = [];
  /** tenant -> photo id -> ref. Tenancy is the SERVER's: a viewer is only ever offered their own library. */
  private readonly library = new Map<string, Map<string, MediaRef>>();

  constructor(private readonly vault: MediaVault) {}

  refOf(tenant: string, id: string): MediaRef | undefined {
    return this.library.get(tenant)?.get(id);
  }

  /** The addresses this library holds: an external root set for the content sweep. */
  async *addresses(): AsyncGenerator<string> {
    for (const own of this.library.values()) for (const ref of own.values()) yield ref.address;
  }

  addPhoto(tenant: string, id: string, ref: MediaRef): void {
    const own = this.library.get(tenant) ?? new Map<string, MediaRef>();
    own.set(id, ref);
    this.library.set(tenant, own);
  }

  async invokeTransient<TIn, TOut>(
    toolId: string,
    input: TIn,
    opts?: TransientInvokeOptions
  ): Promise<TOut> {
    if (toolId !== MCP_INVOKE_TOOL_ID) throw new Error(`no transient tool "${toolId}"`);
    const call = input as unknown as McpCall;
    const tenant = opts?.principal?.tenant;
    this.calls.push({
      toolName: call.toolName,
      args: call.args,
      ...(tenant !== undefined && { tenant }),
    });
    if (call.toolName === "photos.get") {
      const ref = this.library.get(tenant ?? "")?.get(String(call.args.id));
      if (ref === undefined) throw new Error("no such photo");
      return ref as TOut;
    }
    if (call.toolName === "vision.describe") {
      // It reads the bytes straight from the store, which has no tenancy. What stops a foreign address
      // from getting here is the content-ref argument gate in front of it, not this tool.
      const bytes = await this.vault.store.get({ __loomContent: String(call.args.image) });
      const facts = bytes === null ? undefined : readPng(bytes);
      const out: StatusCardValue = facts
        ? {
            level: "ok",
            headline: `${facts.width}x${facts.height} image`,
            detail: `rgb(${facts.rgb.join(",")})`,
          }
        : { level: "warning", headline: "nothing to describe" };
      return out as TOut;
    }
    throw new Error(`no tool "${call.toolName}"`);
  }
}

// ── The Experience: N photos and one caption slot ────────────────────────────────────────────────

const step = (
  toolName: string,
  toolSchemaHash: string,
  args: Record<string, unknown>,
  overridable?: string[]
): MCPToolNode => ({
  stepId: "s",
  toolName,
  toolVersion: "1.0.0",
  toolSchemaHash,
  arguments: args,
  dependsOn: [],
  idempotent: true,
  ...(overridable && { overridable }),
});

const provider = (handle: string, s: MCPToolNode): ProviderSpec => ({
  handle,
  executionGraph: [s],
  reshaping: { engine: "JSONPath", scriptRef: "$" },
  outputShapeHash: "",
  outputCheck: "contract",
  // Per principal: one viewer's answer is never another's.
  cachePolicy: { ttlSeconds: 60, scope: "principal" },
});

export function galleryExperience(
  photoIds: readonly string[],
  captionArguments: Record<string, unknown> = {}
): Experience {
  const g = genesis({
    experienceId: "media-gallery",
    intent: { objective: "Browse my photos", source: "user" },
    meta: { author: "example", createdAt: "2026-10-10T00:00:00Z", sourceKind: "example" },
  });
  const ops: Operation[] = [];
  let order: string | null = null;
  for (const id of photoIds) {
    order = orderKeyBetween(order, null);
    ops.push({
      type: "remapProvider",
      handle: `photo-${id}`,
      spec: provider(`photo-${id}`, step("photos.get", GET_PIN, { id })),
    });
    ops.push({
      type: "insertNode",
      parentId: "root",
      node: {
        id: `img-${id}`,
        order,
        kind: "semantic",
        type: "Image",
        typeVersion: "1.0.0",
        span: 3,
        label: { key: `gallery.${id}`, fallback: `Photo ${id}` },
        props: {},
      },
    });
    ops.push({ type: "bindProvider", nodeId: `img-${id}`, handle: `photo-${id}` });
  }
  order = orderKeyBetween(order, null);
  ops.push({
    type: "remapProvider",
    handle: "caption",
    spec: provider("caption", step("vision.describe", DESCRIBE_PIN, captionArguments, ["image"])),
  });
  ops.push({
    type: "insertNode",
    parentId: "root",
    node: {
      id: "caption",
      order,
      kind: "semantic",
      type: "Caption",
      typeVersion: "1.0.0",
      span: 12,
      label: { key: "gallery.caption", fallback: "Caption" },
      props: {},
    },
  });
  ops.push({ type: "bindProvider", nodeId: "caption", handle: "caption" });
  const built = replay(g, ops);
  if (!built.ok) throw new Error(built.finding.message);
  return seal(built.value);
}

// ── One viewer's session ─────────────────────────────────────────────────────────────────────────

export interface GalleryOptions {
  readonly vault: MediaVault;
  readonly tools: GalleryTools;
  readonly tenant: string;
  readonly photoIds: readonly string[];
  /** Literal arguments for the caption step; a composer-written address here must be refused. */
  readonly captionArguments?: Record<string, unknown>;
}

export class GallerySession {
  readonly experience: Experience;
  readonly store: HydrationStore;
  readonly findings: Array<{ handle: string; code: string }> = [];

  constructor(private readonly o: GalleryOptions) {
    this.experience = galleryExperience(o.photoIds, o.captionArguments);
    this.store = new HydrationStore(new InMemoryProjectionRuntime(), {
      experienceId: this.experience.experienceId,
    });
  }

  /** Load handles through the real server-side path: the content-ref guard runs before any tool call. */
  async load(
    handles: readonly string[],
    params: Record<string, unknown> = {}
  ): Promise<HandleLoadResult[]> {
    const { vault, tools, tenant } = this.o;
    const results = await serveHandles(
      this.experience,
      handles.map((handle) => ({
        experienceId: this.experience.experienceId,
        versionHash: this.experience.versionHash,
        handle,
        params: handle === "caption" ? params : {},
      })),
      {
        invoker: tools,
        principal: { tenant, actor: `${tenant}-user` },
        principalId: tenant,
        contentRefArgs: contentRefTable,
        // A param that would fill a marked argument reaches the tool only if THIS viewer may read it.
        acceptContentRefParam: (ctx) => vault.canRead(ctx.principalId, String(ctx.value)),
        outputKinds: { catalog, surface: "terminal" },
        onFinding: (handle, finding) => this.findings.push({ handle, code: finding.code }),
      }
    );
    results.forEach((r, i) => {
      const handle = handles[i] as string;
      if (r.state === "ready") this.store.setValue(handle, r.value, { state: "ready" });
    });
    return results;
  }

  loadPhotos(): Promise<HandleLoadResult[]> {
    return this.load(this.o.photoIds.map((id) => `photo-${id}`));
  }

  /** The gallery as this viewer sees it in a terminal: links exist only for refs this viewer may read. */
  frame(): string {
    const compiled = compile(this.experience, {
      surface: "terminal",
      catalog,
      hydrationProjectionId: HYDRATION_PROJECTION_ID,
      hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
    });
    if (!compiled.ok) throw new Error(compiled.findings.map((f) => f.message).join("; "));
    return renderExperience(compiled.blueprint, this.store, {
      registry: terminalRegistry({ media: { link: this.o.vault.terminalLinkFor(this.o.tenant) } }),
    });
  }
}
