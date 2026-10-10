import { textOf } from "@loom/llm";
import { afterEach, describe, expect, it } from "vitest";
import { type Chat, newStores, startChat } from "../src/chat";
import { type Sse, openSse, until } from "../src/client";
import { LONG_OPENING, promptChars } from "../src/model";
import { Session } from "../src/session";

// Every claim below runs over REAL HTTP + SSE on port 0 against the real conversation layer; only the
// model is scripted. Teardown closes every stream and server, so nothing outlives a test.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
async function boot(opts?: Parameters<typeof startChat>[0]): Promise<Chat> {
  const chat = await startChat(opts);
  cleanup.push(() => chat.stop());
  return chat;
}
async function follow(s: Session, lastEventId?: string): Promise<Sse> {
  const sse = await openSse(s.eventsUrl, s.token, lastEventId);
  expect(sse.status).toBe(200);
  cleanup.push(() => sse.close());
  return sse;
}
/** `<generation>.<sequence>` as a sortable pair. */
const pos = (id: string): [number, number] => {
  const [g, n] = id.split(".").map(Number);
  return [g as number, n as number];
};
const isAfter = (a: string, b: string): boolean => {
  const [ga, na] = pos(a);
  const [gb, nb] = pos(b);
  return ga > gb || (ga === gb && na > nb);
};

describe("chat-agent", () => {
  it("multi-turn: later turns see earlier ones, and the transcript reads back in order", async () => {
    const chat = await boot();
    const alice = await Session.start(chat.url, "tok-alice");
    await alice.say("my name is Ada");
    await alice.settled(1);
    await alice.say("what is my name?");
    await alice.settled(2);

    expect((await alice.history()).map((m) => [m.turn, m.role, m.status])).toEqual([
      [1, "user", "complete"],
      [1, "assistant", "complete"],
      [2, "user", "complete"],
      [2, "assistant", "complete"],
    ]);
    // the second model call was shown the first exchange
    const shown = chat.model.requests[1]?.messages.map((m) => textOf(m.content)).join("\n");
    expect(shown).toContain("my name is Ada");
    expect(shown).toContain("re 1: my name is Ada");
  });

  it("barge-in: a new turn cuts the in-flight answer, which is kept and marked interrupted", async () => {
    const chat = await boot();
    const alice = await Session.start(chat.url, "tok-alice");
    const feed = await follow(alice);
    await alice.say("write me an epic");
    await until(() => chat.model.longStarted === 1, "the epic to start streaming");
    await alice.say("never mind, what is 2+2?"); // lands on the running turn
    await alice.settled(2);

    const h = await alice.history();
    expect(h.map((m) => [m.turn, m.role, m.status])).toEqual([
      [1, "user", "complete"],
      [1, "assistant", "interrupted"],
      [2, "user", "complete"],
      [2, "assistant", "complete"],
    ]);
    expect(h[1]?.text).toBe(LONG_OPENING); // the partial survived
    expect(chat.model.longAborted).toBe(1); // the generation itself was stopped, not just ignored
    // the interrupted partial is part of what the next answer is shown
    const shown = chat.model.requests
      .at(-1)
      ?.messages.map((m) => textOf(m.content))
      .join("\n");
    expect(shown).toContain("write me an epic");
    // the client watching the stream saw the interruption as a durable message
    await feed.waitFor(
      (e) => e.event === "message" && e.data.status === "interrupted",
      "the interrupted message on the stream"
    );
  });

  it("a tiny window stays bounded: old turns rotate out into a summary, history keeps everything", async () => {
    const chat = await boot({ contextWindow: 400, rotateEveryTurns: 4 });
    const alice = await Session.start(chat.url, "tok-alice");
    const TURNS = 12;
    for (let i = 1; i <= TURNS; i++) {
      await alice.say(`filler ${i} ${"padding ".repeat(20)}`);
      await alice.settled(i);
    }
    const sizes = chat.model.requests.map(promptChars);
    const transcript = (await alice.history()).reduce((n, m) => n + m.text.length, 0);

    // 400 tokens is ~1600 chars (plus the untrusted-input fences); unbounded, the last prompt would be the
    // whole transcript (~4000+). It plateaus instead.
    expect(Math.max(...sizes)).toBeLessThan(2_000);
    expect(transcript).toBeGreaterThan(3_500);
    expect(Math.abs((sizes.at(-1) ?? 0) - (sizes.at(-2) ?? 0))).toBeLessThan(50); // steady state: the window slid, it did not grow
    const last = chat.model.requests.at(-1)?.messages.map((m) => textOf(m.content)) ?? [];
    expect(last.some((t) => t.includes("Summary of the earlier conversation"))).toBe(true);
    expect(last.join("\n")).not.toContain("filler 1 "); // evicted from the prompt...
    expect((await alice.history()).some((m) => m.text.startsWith("filler 1 "))).toBe(true); // ...not from history
    expect((await alice.status()).body.generation).toBeGreaterThanOrEqual(2); // and the execution rotated
  });

  it("restart + Last-Event-ID: ids continue, nothing is skipped or repeated, replay calls no model", async () => {
    const stores = newStores(); // the durable half: it outlives the "process"
    let chat = await startChat({ stores, rotateEveryTurns: 2 }); // rotates, so ids span generations
    const first = chat; // captured: `chat` is reassigned below
    let firstStopped = false;
    cleanup.push(async () => {
      if (!firstStopped) await first.stop();
    });
    const alice = await Session.start(chat.url, "tok-alice");
    const feed1 = await follow(alice);
    for (let i = 1; i <= 3; i++) {
      await alice.say(`before ${i}`);
      await alice.settled(i);
    }
    await feed1.waitFor(
      (e) => e.event === "message" && e.data.turn === 3 && e.data.role === "assistant",
      "turn 3 reply"
    );
    const seen = feed1.messages();
    const lastSeen = seen.at(-1)?.id as string;
    feed1.close();

    // the process dies and a new one starts over the same durable stores, on a different port
    await first.stop();
    firstStopped = true;
    const oldUrl = first.url;
    chat = await startChat({ stores, rotateEveryTurns: 2 });
    const second = chat;
    cleanup.push(() => second.stop());
    alice.base = chat.url;
    expect(chat.url).not.toBe(oldUrl);

    const feed2 = await follow(alice, lastSeen);
    await alice.say("after 4");
    await feed2.waitFor(
      (e) => e.event === "message" && e.data.turn === 4 && e.data.role === "assistant",
      "turn 4 reply"
    );
    const resumed = feed2.messages();
    // exactly the new exchange; every id is strictly later than the last one seen before the restart
    expect(resumed.map((e) => `${e.data.turn}${e.data.role[0]}`)).toEqual(["4u", "4a"]);
    for (const e of resumed) expect(isAfter(e.id as string, lastSeen)).toBe(true);
    expect(isAfter(resumed[1]?.id as string, resumed[0]?.id as string)).toBe(true);
    expect(chat.model.calls).toBe(1); // the replayed turns made no model call

    // reconnecting from the FIRST id replays the rest with no gap and no duplicate: it is the history
    const firstSeen = seen[0]?.id as string;
    const feed3 = await follow(alice, firstSeen);
    await feed3.waitFor(
      (e) => e.event === "message" && e.data.turn === 4 && e.data.role === "assistant",
      "turn 4 on feed3"
    );
    const hist = (await alice.history()).map((m) => m.cursor);
    expect(feed3.messages().map((e) => e.id)).toEqual(hist.slice(1));
    expect(new Set(hist).size).toBe(hist.length);
  });

  it("another tenant gets 404, byte-identical to a conversation that does not exist", async () => {
    const chat = await boot();
    const alice = await Session.start(chat.url, "tok-alice");
    await alice.say("my secret plan is X-RAY-42");
    await alice.settled(1);

    const probe = async (id: string) => {
      const base = `${chat.url}/conversations/${id}`;
      const h = { authorization: "Bearer tok-mallory" };
      const json = { ...h, "content-type": "application/json" };
      const rs = await Promise.all([
        fetch(base, { headers: h }),
        fetch(`${base}/history`, { headers: h }),
        fetch(`${base}/events`, { headers: { ...h, accept: "text/event-stream" } }),
        fetch(`${base}/turns`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ text: "hi" }),
        }),
        fetch(`${base}/close`, { method: "POST", headers: json, body: "{}" }),
      ]);
      return Promise.all(rs.map(async (r) => [r.status, await r.text()] as const));
    };
    const theirs = await probe(alice.id);
    const nothing = await probe("conv-00000000-0000-0000-0000-000000000000");
    expect(theirs.map(([s]) => s)).toEqual([404, 404, 404, 404, 404]);
    expect(theirs).toEqual(nothing);
    expect(JSON.stringify(theirs)).not.toContain("X-RAY-42");

    // and mallory's attempts changed nothing for alice; alice still reads her own
    const h = await alice.history();
    expect(h).toHaveLength(2);
    expect(h[0]?.text).toContain("X-RAY-42");
  });
});
