import { createWorkerServer } from "@loom/plugin-worker-server";
import { LocalWorkerRuntime } from "@loom/worker-runtime-local";
import { buildBranchWorkerRuntime } from "./worker";

// `pnpm dev:worker` — the compute a branch simulation runs on. Point the coordinator at it
// with BRANCH_WORKER_URL and every forked branch is dispatched here instead of running
// inside the web server.
//
// Unauthenticated by design for a local demo: `createWorkerServer` without `authorize` will
// run any registered flow for any caller, so this belongs on a trusted network only.
const dataDir = process.env.LOOM_DATA_DIR ?? "./.data";
const port = Number(process.env.PORT ?? 7071);

const runtime = buildBranchWorkerRuntime(dataDir);
const server = createWorkerServer(new LocalWorkerRuntime(runtime), { port });

async function main(): Promise<void> {
  await server.start();
  console.log(`Branch worker on ${server.url} (stores: ${dataDir})`);
}
void main();

const shutdown = (): void => {
  void server.stop().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
