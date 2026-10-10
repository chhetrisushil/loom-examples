import { createHmac } from "node:crypto";
import type { MediaRef, MediaRequest, MediaResolution } from "@loom-ui/core";
import type { ContentResolver } from "@loom/llm";
import { type ContentStore, InMemoryContentStore } from "@loom/plugin-content";

// The ContentStore is content-addressed and has NO tenancy: whoever can name an address can read its
// bytes (loom ADR 0120 D4). So the authorization lives HERE, in the host, behind two seams:
//   - `resolveForModel`  - loom's `ContentResolver(ref, ctx)`: may THIS execution's principal read it?
//   - `mediaResolverFor` - loom-ui's `MediaResolver`: may THIS viewer be handed a URL for it?
// Both answer "no" the same way they answer "absent" (null / ok:false with no reason): a denial must not
// be an existence oracle for an address.

/** DEMO ONLY: a fixed key so the example is deterministic. A real host keeps this in a secret store. */
const DEMO_URL_KEY = "media-gallery-demo-key-do-not-use-in-production";

export interface Denial {
  readonly seam: "model" | "viewer";
  readonly tenant: string | undefined;
  readonly address: string;
}

export interface StoredMedia {
  readonly ref: MediaRef;
  /** The same blob as an LLM media source: only the address (plus size) is ever journaled. */
  readonly source: {
    readonly kind: "ref";
    readonly ref: { readonly address: string; readonly size: number };
  };
}

export class MediaVault {
  /** address -> the tenants that stored it. The store itself knows nothing of tenants. */
  private readonly owners = new Map<string, Set<string>>();
  /** Every refusal, for the host's audit log. */
  readonly denials: Denial[] = [];

  constructor(readonly store: ContentStore = new InMemoryContentStore()) {}

  /** Store `bytes` for `tenant`, returning the ref a log, a tool result or a widget may carry. */
  async put(
    tenant: string,
    bytes: Uint8Array,
    meta: { mediaType: string; name?: string; alt?: string }
  ): Promise<StoredMedia> {
    const { __loomContent: address } = await this.store.put(bytes);
    // Content-addressed: identical bytes are ONE blob, so ownership is a SET. Storing the bytes is proof
    // of possession, so a second tenant that stores the same bytes may read them - but a tenant that
    // merely knows the address may not.
    const holders = this.owners.get(address) ?? new Set<string>();
    holders.add(tenant);
    this.owners.set(address, holders);
    return {
      ref: {
        address,
        mediaType: meta.mediaType,
        size: bytes.length,
        ...(meta.name !== undefined && { name: meta.name }),
        ...(meta.alt !== undefined && { alt: meta.alt }),
        origin: "tool",
      },
      source: { kind: "ref", ref: { address, size: bytes.length } },
    };
  }

  /** May `tenant` read `address`? An unknown address is "no" too. */
  canRead(tenant: string | undefined, address: string): boolean {
    return tenant !== undefined && (this.owners.get(address)?.has(tenant) ?? false);
  }

  /**
   * loom's `ContentResolver`: authorizes with `(ref, ctx)`. The asking execution's principal comes from
   * `ctx.principal` (set when the execution started); an absent principal reads nothing. Denied, absent
   * and erased all answer `null`, so a tool that names a foreign address learns nothing.
   */
  readonly resolveForModel: ContentResolver = async (ref, ctx) => {
    const tenant = ctx.principal?.tenant;
    if (!this.canRead(tenant, ref.address)) {
      this.denials.push({ seam: "model", tenant, address: ref.address });
      return null;
    }
    const bytes = await this.store.get({ __loomContent: ref.address });
    return bytes !== null && bytes.length <= ctx.maxBytes ? bytes : null;
  };

  /** A short-lived, viewer-scoped link: only this tenant's session can use it. Never contains the address. */
  linkFor(tenant: string, address: string): string {
    const token = createHmac("sha256", DEMO_URL_KEY)
      .update(`${tenant}\u0000${address}`)
      .digest("hex");
    return `https://media.example.com/v/${token.slice(0, 24)}`;
  }

  /** loom-ui's `MediaResolver` for ONE viewer session. */
  mediaResolverFor(tenant: string): (request: MediaRequest) => Promise<MediaResolution> {
    return async ({ ref }) => {
      if (!this.canRead(tenant, ref.address)) {
        this.denials.push({ seam: "viewer", tenant, address: ref.address });
        return { ok: false }; // no reason: denied looks like missing
      }
      return { ok: true, url: this.linkFor(tenant, ref.address), size: ref.size ?? 0 };
    };
  }

  /** The synchronous link hook the terminal renderer takes (`media.link`). */
  terminalLinkFor(tenant: string): (ref: MediaRef) => string | undefined {
    return (ref) =>
      this.canRead(tenant, ref.address) ? this.linkFor(tenant, ref.address) : undefined;
  }
}
