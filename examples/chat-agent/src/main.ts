import { textOf } from "@loom/llm";
import { startChat } from "./chat";
import { openSse, until } from "./client";
import { promptChars } from "./model";
import { Session } from "./session";

const heading = (s: string) => console.log(`\n== ${s}`);
const WINDOW = 400;

async function main(): Promise<void> {
  let chat = await startChat({ contextWindow: WINDOW, rotateEveryTurns: 4 });
  const open: { close(): void }[] = [];
  try {
    const alice = await Session.start(chat.url, "tok-alice");
    const feed = await openSse(alice.eventsUrl, "tok-alice");
    open.push(feed);

    heading("1. Multi-turn: one chained execution per conversation");
    await alice.say("hello");
    await alice.settled(1);
    await alice.say("what is loom?");
    await alice.settled(2);
    for (const m of await alice.history()) console.log(`  ${m.turn} ${m.role.padEnd(9)} ${m.text}`);

    heading("2. Barge-in: a new turn interrupts the in-flight answer");
    await alice.say("write me an epic");
    await until(() => chat.model.longStarted === 1, "the epic to start");
    await alice.say("never mind, what is 2+2?");
    await alice.settled(4);
    for (const m of (await alice.history()).filter((h) => h.turn >= 3))
      console.log(`  ${m.turn} ${m.role.padEnd(9)} [${m.status}] ${JSON.stringify(m.text)}`);
    console.log(`  the generation was cut (aborted=${chat.model.longAborted}), partial kept`);

    heading(`3. Tiny window (${WINDOW} tokens): rotation + compaction`);
    for (let i = 5; i <= 12; i++) {
      await alice.say(`filler ${i} ${"padding ".repeat(20)}`);
      await alice.settled(i);
    }
    const sizes = chat.model.requests.map(promptChars);
    const all = await alice.history();
    const last = chat.model.requests.at(-1);
    const summary = last?.messages.map((m) => textOf(m.content)).find((t) => t.includes("Summary"));
    console.log(`  rotated: generation ${(await alice.status()).body.generation}`);
    console.log(
      `  last prompt ${sizes.at(-1)} chars, plateaued (the prompt of turn 5 was ${sizes[4]}); the whole transcript is ${all.reduce((n, m) => n + m.text.length, 0)}`
    );
    console.log(`  history still holds all ${all.length} messages`);
    console.log(`  evicted turns folded into: ${summary?.replace(/\s+/g, " ").slice(0, 90)}...`);

    heading("4. Restart, then reconnect with Last-Event-ID");
    const lastSeen = feed.messages().at(-1)?.id as string;
    feed.close();
    await chat.stop();
    chat = await startChat({ stores: chat.stores, contextWindow: WINDOW, rotateEveryTurns: 4 });
    alice.base = chat.url;
    console.log(`  new process, new port; last id seen before: ${lastSeen}`);
    const feed2 = await openSse(alice.eventsUrl, "tok-alice", lastSeen);
    open.push(feed2);
    await alice.say("are you back?");
    await feed2.waitFor(
      (e) => e.event === "message" && e.data.role === "assistant" && e.data.turn === 13,
      "reply 13"
    );
    for (const e of feed2.messages())
      console.log(`  ${e.id}  ${e.data.turn} ${e.data.role}: ${e.data.text}`);
    console.log(`  model calls in the new process: ${chat.model.calls} (replay made none)`);

    heading("5. Another tenant asks for alice's conversation");
    const r = await fetch(`${chat.url}/conversations/${alice.id}/history`, {
      headers: { authorization: "Bearer tok-mallory" },
    });
    const ghost = await fetch(`${chat.url}/conversations/c-nope/history`, {
      headers: { authorization: "Bearer tok-mallory" },
    });
    console.log(
      `  mallory -> ${r.status} ${await r.text()}; a conversation that does not exist -> ${ghost.status} ${await ghost.text()}`
    );
  } finally {
    for (const o of open) o.close();
    await chat.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
