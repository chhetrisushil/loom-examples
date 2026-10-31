import { McpClient } from "@loom/plugin-mcp";
import { JSDOM } from "jsdom";
import { APP_CHANNEL_HEADER, DEMO_AUTH_HEADERS } from "./server";

// ── A minimal MCP Apps HOST ──────────────────────────────────────────────────
//
// Loom is deliberately not a host (ADR 0072 D2) — iframe sandboxing, CSP
// synthesis and the sandbox-proxy architecture are browser-application concerns.
// But an example that only drives the SERVER proves half a protocol, and the half
// it skips is exactly where this binding has already been wrong once: the shipped
// template was published, pinned, and served without a single line of it ever
// having run.
//
// So this host runs the REAL `SURFACE_HOST_TEMPLATE` — the exact string the server
// publishes at `ui://loom/surface-host`, fetched over HTTP through a real
// `McpClient` — inside jsdom, and bridges its `postMessage` JSON-RPC to the MCP
// server. It stands in for the iframe, not for the template.
//
// What it does NOT do: enforce CSP, apply a sandbox attribute, or isolate origins.
// A real host must. Those are the reasons the host role was rejected for the
// kernel, not details this example is entitled to skip quietly.

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

export interface HostOptions {
  serverUrl: string;
  /** The template HTML — fetched from the server, never inlined. */
  template: string;
  /** Presented on app-originated journaled calls; without it, approve is denied. */
  userGrant?: string;
  /** Called for every message the View emits, for narration. */
  onViewMessage?: (msg: JsonRpcMessage) => void;
}

export interface McpAppHost {
  /** Deliver a tool result to the View, as `ui/notifications/tool-result`. */
  deliverToolResult(result: unknown): void;
  /** Click the first Button the View rendered. Returns false if none exists. */
  clickApprove(): boolean;
  /** The text content the View currently renders — proof it actually painted. */
  rendered(): string;
  /** How many cursor polls the View has issued. */
  pollCount(): number;
  /** Wait until the View has issued at least `n` polls (or time out). */
  waitForPolls(n: number, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startHost(options: HostOptions): Promise<McpAppHost> {
  // The app channel. Everything the VIEW originates goes through a client marked
  // as the app audience — that header is the deployment-supplied boundary the
  // server uses to distinguish a View from the model.
  const appClient = new McpClient({
    transport: "http",
    url: options.serverUrl,
    headers: {
      ...DEMO_AUTH_HEADERS,
      [APP_CHANNEL_HEADER]: "app",
      ...(options.userGrant !== undefined && { "x-loom-user-grant": options.userGrant }),
    },
  });

  let polls = 0;
  // The View's script runs SYNCHRONOUSLY while jsdom parses, and the template
  // handshakes immediately on load — so its `ui/initialize` arrives before the
  // constructor has even returned a window to dispatch replies into. A real host
  // never races this (the iframe loads asynchronously, after the host is wired),
  // but this harness must buffer or the handshake reply is dropped on the floor
  // and the View sits inert forever.
  let win: JSDOM["window"] | null = null;
  const outbox: JsonRpcMessage[] = [];

  const toView = (msg: JsonRpcMessage): void => {
    if (win === null) {
      outbox.push(msg);
      return;
    }
    win.dispatchEvent(new win.MessageEvent("message", { data: msg }));
  };

  // The View → host leg. The template posts JSON-RPC to `window.parent`.
  async function fromView(msg: JsonRpcMessage): Promise<void> {
    options.onViewMessage?.(msg);

    // Notifications (no id) need no reply.
    if (msg.id === undefined) return;

    if (msg.method === "ui/initialize") {
      toView({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2026-01-26",
          hostCapabilities: {},
          hostInfo: { name: "example-host", version: "1.0.0" },
          hostContext: { theme: "light", displayMode: "inline", locale: "en-US" },
        },
      });
      return;
    }

    if (msg.method === "tools/call") {
      const params = (msg.params ?? {}) as { name?: string; arguments?: unknown };
      if (params.name === "loom_surface_since") polls += 1;
      try {
        // A real host proxies the View's tool call to the server unchanged. The
        // SERVER decides whether an app may call this tool at all.
        const result = await appClient.callToolResult(params.name ?? "", params.arguments);
        toView({ jsonrpc: "2.0", id: msg.id, result });
      } catch (err) {
        toView({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(err) } });
      }
      return;
    }

    // Anything else this minimal host does not implement.
    toView({ jsonrpc: "2.0", id: msg.id, result: {} });
  }

  const dom = new JSDOM(`<!doctype html><html><body>${options.template}</body></html>`, {
    runScripts: "dangerously",
    // `window.parent` must be the host BEFORE the template's script runs, or its
    // handshake posts into the void.
    beforeParse(window) {
      Object.defineProperty(window, "parent", {
        configurable: true,
        value: {
          postMessage: (data: unknown) => {
            void fromView(data as JsonRpcMessage);
          },
        },
      });
    },
  });

  const { window } = dom;
  win = window;
  // Flush anything the View asked for during parse (the handshake).
  for (const queued of outbox.splice(0)) toView(queued);

  return {
    deliverToolResult(result: unknown): void {
      toView({
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { result },
      });
    },
    clickApprove(): boolean {
      const button = window.document.querySelector("button.loom-btn") as { click(): void } | null;
      if (button === null) return false;
      button.click();
      return true;
    },
    rendered(): string {
      return window.document.getElementById("loom-root")?.textContent ?? "";
    },
    pollCount: () => polls,
    async waitForPolls(n: number, timeoutMs = 8000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (polls < n) {
        if (Date.now() > deadline) {
          throw new Error(`View issued ${polls} poll(s); expected ${n} within ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    async close(): Promise<void> {
      // Stops the template's polling interval along with everything else.
      window.close();
    },
  };
}
