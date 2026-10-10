import { api, until } from "./client";

/** One user's handle on one conversation, over HTTP. `base` changes across a restart (port 0). */
export class Session {
  constructor(
    public base: string,
    readonly token: string,
    readonly id: string
  ) {}

  static async start(base: string, token: string): Promise<Session> {
    const r = await api(`${base}/conversations`, token, {});
    if (r.status !== 201) throw new Error(`start failed: ${r.status}`);
    return new Session(base, token, r.body.conversationId as string);
  }

  get eventsUrl(): string {
    return `${this.base}/conversations/${this.id}/events`;
  }

  say(text: string, messageId?: string) {
    return api(`${this.base}/conversations/${this.id}/turns`, this.token, {
      text,
      ...(messageId !== undefined && { messageId }),
    });
  }

  status() {
    return api(`${this.base}/conversations/${this.id}`, this.token);
  }

  /** Wait until `turns` turns are answered and nothing is running. */
  settled(turns: number): Promise<void> {
    return until(async () => {
      const s = (await this.status()).body;
      return s?.turns === turns && s?.running === false;
    }, `turn ${turns} to settle`);
  }

  async history() {
    const r = await api(`${this.base}/conversations/${this.id}/history?limit=200`, this.token);
    return r.body.entries as {
      turn: number;
      role: "user" | "assistant";
      status: string;
      text: string;
      cursor: string;
    }[];
  }
}
