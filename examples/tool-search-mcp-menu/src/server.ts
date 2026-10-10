import type * as http from "node:http";
import { McpClient, createMcpServer } from "@loom/plugin-mcp";
import type { MappedMcpTool, McpServer } from "@loom/plugin-mcp";
import { type ServerLog, servedTools } from "./catalog";

const AUTH = { authorization: "Bearer demo-mcp-token" } as const;

export interface RunningServer {
  readonly server: McpServer;
  readonly log: ServerLog;
  /** The MCP tools mapped for the host: `origin: "remote"`, `jsonInputSchema`, description UNtrusted. */
  mapped(): Promise<MappedMcpTool[]>;
  stop(): Promise<void>;
}

/** A real MCP server over HTTP on an ephemeral port, authenticated (R12 refuses an open one). */
export async function startServer(): Promise<RunningServer> {
  const log: ServerLog = { calls: [] };
  const server = createMcpServer({
    port: 0,
    tools: servedTools(log),
    authenticate: (req: http.IncomingMessage) =>
      req.headers.authorization === AUTH.authorization ? { actor: "ops-agent" } : undefined,
    strict: false,
  });
  await server.start();
  const client = new McpClient({ transport: "http", url: server.url, headers: { ...AUTH } });
  await client.connect();
  return {
    server,
    log,
    mapped: () => client.listTools(),
    stop: async () => {
      await client.disconnect();
      await server.stop();
    },
  };
}
