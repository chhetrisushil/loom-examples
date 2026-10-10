import type { PrincipalChain } from "@loom/effect-runtime";
import { Responder, until } from "../src/client";
import { type RoomOptions, TOKENS, ada, ben, cleo, mallory, openRoom } from "../src/room";
import type { Room } from "../src/room";

export class Latch {
  private open!: () => void;
  readonly promise = new Promise<void>((r) => {
    this.open = r;
  });
  release(): void {
    this.open();
  }
}

export interface Scene {
  room: Room;
  id: string;
  ada: Responder;
  ben: Responder;
  cleo: Responder;
  mallory: Responder;
  /** Wait until `who` sees `n` transcript entries. */
  settled(who: Responder, n: number): Promise<void>;
}

const open: Array<() => Promise<void> | void> = [];
/** Close every stream and server a test opened (call from `afterEach`). */
export async function teardown(): Promise<void> {
  for (const c of open.splice(0).reverse()) await c();
}

const token = (p: PrincipalChain): string =>
  Object.entries(TOKENS).find(([, v]) => v === p)?.[0] as string;

/** Ada owns the room; Ben and Cleo are invited; Mallory is authenticated but not. */
export async function scene(options: RoomOptions = {}): Promise<Scene> {
  const room = await openRoom(options);
  const as = (name: string, p: PrincipalChain) => new Responder(name, p, token(p), room.url);
  const r = {
    ada: as("ada", ada),
    ben: as("ben", ben),
    cleo: as("cleo", cleo),
    mallory: as("mallory", mallory),
  };
  open.push(async () => {
    for (const x of Object.values(r)) x.closeStreams();
    await room.close();
  });
  const id = await r.ada.start();
  await r.ada.invite(id, ben);
  await r.ada.invite(id, cleo);
  return {
    room,
    id,
    ...r,
    settled: (who, n) =>
      until(
        async () => (await who.history(id)).body.entries.length >= n,
        `${n} transcript entries`
      ),
  };
}
