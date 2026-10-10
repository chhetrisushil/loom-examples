// A responder's client: plain `fetch` for the HTTP routes, a small SSE reader for the stream, and
// loom-ui's ChatFeed to fold both into the transcript that responder is shown.
import { ChatFeed, chatTranscriptLines } from "@loom-ui/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import { identityOf } from "./room";

export interface SseEvent {
  event: string;
  id?: string;
  // biome-ignore lint/suspicious/noExplicitAny: the wire is JSON; the ChatFeed parses it field by field
  data: any;
}

/** Wait on a CONDITION (never a fixed sleep). A hang fails at `ms`, it does not read as a slow pass. */
export async function until(
  cond: () => boolean | Promise<boolean>,
  what = "condition",
  ms = 4_000
): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** Await a promise, but fail with a named timeout instead of hanging (bounded below vitest's 5 s). */
export function within<T>(p: Promise<T>, what: string, ms = 4_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: the wire is JSON
  body: any;
}

export class Responder {
  private streams: { events: SseEvent[]; close(): void }[] = [];
  constructor(
    readonly name: string,
    readonly principal: PrincipalChain,
    private readonly token: string,
    private readonly url: string
  ) {}

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }
  async post(path: string, body: unknown): Promise<Reply> {
    const res = await fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers() },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }
  async get(path: string): Promise<Reply> {
    const res = await fetch(`${this.url}${path}`, { headers: this.headers() });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }

  /** The owner starts the room (the server mints the id). */
  async start(): Promise<string> {
    const r = await this.post("/conversations", {});
    if (r.status !== 201) throw new Error(`start refused: ${r.status}`);
    return r.body.conversationId as string;
  }
  invite(id: string, who: PrincipalChain): Promise<Reply> {
    return this.post(`/conversations/${id}/participants`, identityOf(who));
  }
  say(
    id: string,
    text: string,
    extra: { messageId?: string; editOf?: number } = {}
  ): Promise<Reply> {
    return this.post(`/conversations/${id}/turns`, { text, ...extra });
  }
  history(id: string): Promise<Reply> {
    return this.get(`/conversations/${id}/history?direction=forward&limit=100`);
  }

  /** Open the SSE stream from the start; resolves once the server has answered. */
  async watch(id: string): Promise<{ status: number; events: SseEvent[] }> {
    const ctl = new AbortController();
    const res = await fetch(`${this.url}/conversations/${id}/events`, {
      headers: { accept: "text/event-stream", ...this.headers() },
      signal: ctl.signal,
    });
    const events: SseEvent[] = [];
    if (res.status === 200 && res.body !== null) {
      void (async () => {
        const reader = res.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        const dec = new TextDecoder();
        let buf = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              let event = "message";
              let evId: string | undefined;
              let data = "";
              for (const line of block.split("\n")) {
                if (line.startsWith("event: ")) event = line.slice(7);
                else if (line.startsWith("id: ")) evId = line.slice(4);
                else if (line.startsWith("data: ")) data += line.slice(6);
              }
              if (data !== "")
                events.push({
                  event,
                  ...(evId !== undefined && { id: evId }),
                  data: JSON.parse(data),
                });
            }
          }
        } catch {
          // aborted at teardown
        }
      })();
    } else {
      await res.arrayBuffer().catch(() => undefined);
    }
    this.streams.push({ events, close: () => ctl.abort() });
    return { status: res.status, events };
  }
  closeStreams(): void {
    for (const s of this.streams.splice(0)) s.close();
  }

  /** The transcript this responder is shown, folded from the HISTORY route. */
  async feedFromHistory(id: string): Promise<ChatFeed> {
    const feed = new ChatFeed({ viewer: identityOf(this.principal), mode: "shared" });
    const page = await this.history(id);
    const result = feed.applyHistory(page.body, "forward");
    if (!result.ok) throw new Error(`history refused by ChatFeed: ${result.finding.code}`);
    return feed;
  }
}

/** Fold SSE events (the same wire, live) into a ChatFeed. */
export function feedFromEvents(viewer: PrincipalChain, events: readonly SseEvent[]): ChatFeed {
  const feed = new ChatFeed({ viewer: identityOf(viewer), mode: "shared" });
  for (const e of events) {
    const result = feed.applyEvent(e.event, e.data);
    if (!result.ok) throw new Error(`event ${e.event} refused by ChatFeed: ${result.finding.code}`);
  }
  return feed;
}

/** The viewer's feed as printable lines (loom-ui's own words: speaker, status note, bare placeholder). */
export const render = (feed: ChatFeed): string => chatTranscriptLines(feed.value()).join("\n");
