// ATTACK DEMONSTRATION. Never expose or copy this into a host; hosts never write to the inbox.
// Writes to the inbox that the host's client did NOT make. The runtime's policy is owner-scoped, so a
// peer cannot do this with an ordinary principal; this plays the worst case ADR 0122 D8 designs for: a
// policy slip (or a hostile node) that lets raw bytes into the coordinator's inbox. What arrives is data,
// not authority: the conversation body acts only on an envelope the host signed, for THIS conversation,
// fresh, and never twice.
import { CONVERSATION_TOPIC } from "@loom/conversation";
import type { Room } from "./room";

type Envelope = Record<string, unknown> & { text?: string };

/** The `n`th envelope the host's client signed for this conversation (0-based), as stored in the inbox. */
export async function capturedEnvelope(
  room: Room,
  conversationId: string,
  n = 0
): Promise<Envelope> {
  const stored = await room.eventStore.read(`__loom_inbox__:${conversationId}`);
  const payload = (stored[n]?.payload as { payload?: Envelope } | undefined)?.payload;
  if (payload === undefined) throw new Error(`no envelope #${n} in the inbox of ${conversationId}`);
  return structuredClone(payload);
}

/** Put `envelope` into the coordinator's inbox under a FRESH kernel messageId, with the host's system grant. */
export async function inject(
  room: Room,
  conversationId: string,
  envelope: Envelope
): Promise<void> {
  await room.runtime.send(
    conversationId,
    { topic: CONVERSATION_TOPIC, payload: envelope },
    room.runtime.systemOptions()
  );
}
