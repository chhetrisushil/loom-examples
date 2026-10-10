/** A tiny HTTP + SSE client: what a browser's fetch / EventSource would do. */

export interface SseEvent {
  event: string;
  id?: string;
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON off the wire
  data: any;
}

export interface Sse {
  events: SseEvent[];
  /** The first event (from the start of the stream) satisfying `pred`. */
  waitFor(pred: (e: SseEvent) => boolean, what: string): Promise<SseEvent>;
  /** The durable `message` events only. */
  messages(): SseEvent[];
  close(): void;
}

export async function until(
  cond: () => boolean | Promise<boolean>,
  what: string,
  ms = 20_000
): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

export async function api(
  url: string,
  token: string,
  body?: unknown
  // biome-ignore lint/suspicious/noExplicitAny: arbitrary JSON off the wire
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    ...(body !== undefined && {
      method: "POST",
      body: JSON.stringify(body),
    }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && { "content-type": "application/json" }),
    },
  });
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

export async function openSse(
  url: string,
  token: string,
  lastEventId?: string
): Promise<Sse & { status: number }> {
  const ctl = new AbortController();
  const res = await fetch(url, {
    headers: {
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
      ...(lastEventId !== undefined && { "last-event-id": lastEventId }),
    },
    signal: ctl.signal,
  });
  const events: SseEvent[] = [];
  if (res.status === 200 && res.body !== null) {
    const body = res.body;
    void (async () => {
      const reader = body.getReader();
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
            let id: string | undefined;
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event: ")) event = line.slice(7);
              else if (line.startsWith("id: ")) id = line.slice(4);
              else if (line.startsWith("data: ")) data += line.slice(6);
            }
            if (data !== "")
              events.push({ event, ...(id !== undefined && { id }), data: JSON.parse(data) });
          }
        }
      } catch {
        // closed by the client
      }
    })();
  }
  const sse: Sse & { status: number } = {
    status: res.status,
    events,
    messages: () => events.filter((e) => e.event === "message"),
    async waitFor(pred, what) {
      let hit: SseEvent | undefined;
      await until(() => {
        hit = events.find(pred);
        return hit !== undefined;
      }, what);
      return hit as SseEvent;
    },
    close: () => ctl.abort(),
  };
  return sse;
}
