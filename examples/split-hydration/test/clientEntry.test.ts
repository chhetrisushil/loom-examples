import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// ── The example's OWN browser file is browser-safe ───────────────────────────────
// `src/client.ts` (this example's "the browser side") imports ONLY from
// `@loom-ui/hydration/client` — never the root `@loom-ui/hydration` entry, which pulls in loom's
// sandbox (QuickJS WASM) and MCP plugin to execute providers. This bundles the SOURCE
// `src/client.ts` (no prior `tsc --build` needed) the way a real bundler would (esbuild, platform browser, resolved under the
// browser/import conditions — same method as `@loom-ui/hydration`'s own `clientEntry.test.ts`) and
// asserts the bundle carries no `.wasm`, no node builtin, and none of the server-only packages.

const SRC = resolve(__dirname, "../src");

const FORBIDDEN_PACKAGES = ["@loom/plugin-sandbox", "@loom/plugin-mcp", "@loom/effect-runtime"];

const FORBIDDEN_DIRS = FORBIDDEN_PACKAGES.flatMap((name) => {
  try {
    return [realpathSync(resolve(__dirname, "../node_modules", name))];
  } catch {
    return []; // not installed at all is fine — it is certainly not reachable then
  }
});

describe("split-hydration's client.ts is browser-safe", () => {
  it("bundles for the browser with no server-plane input", async () => {
    const out = await build({
      entryPoints: [resolve(SRC, "client.ts")],
      bundle: true,
      minify: false,
      platform: "browser",
      format: "esm",
      conditions: ["browser", "import"],
      write: false,
      logLevel: "silent",
      metafile: true,
    });
    expect(out.errors).toEqual([]);

    const inputs = Object.keys(out.metafile.inputs).map((f) => realpathSync(resolve(f)));
    expect(inputs.length).toBeGreaterThan(1);

    // No node builtin, and no path through a forbidden server-only package's own directory.
    const nodeBuiltins = inputs.filter((f) => f.startsWith("node:"));
    expect(nodeBuiltins).toEqual([]);
    const serverPlane = inputs.filter((f) => FORBIDDEN_DIRS.some((d) => f.startsWith(`${d}/`)));
    expect(serverPlane).toEqual([]);
    const sandboxy = inputs.filter((f) => /quickjs/i.test(f));
    expect(sandboxy).toEqual([]);

    // No .wasm asset anywhere in the bundle's own output or its inputs' directory names.
    const wasmOutputs = (out.outputFiles ?? []).filter((f) => f.path.endsWith(".wasm"));
    expect(wasmOutputs).toEqual([]);
    const wasmInputs = inputs.filter((f) => f.endsWith(".wasm"));
    expect(wasmInputs).toEqual([]);
  });

  it("imports @loom-ui/hydration ONLY through its browser-safe /client subpath", async () => {
    // A static source check, independent of the bundling walk above: the specifier itself must
    // never be the bare "@loom-ui/hydration" root entry, which is server-side.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(resolve(__dirname, "../src/client.ts"), "utf8");
    const specifiers = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers).toContain("@loom-ui/hydration/client");
    expect(specifiers).not.toContain("@loom-ui/hydration");
  });

  it("the walk is live: the SERVER file does reach the server plane", async () => {
    const out = await build({
      entryPoints: [resolve(SRC, "server.ts")],
      bundle: true,
      minify: false,
      platform: "node",
      format: "esm",
      write: false,
      logLevel: "silent",
      metafile: true,
      external: ["node:*"],
    });
    const inputs = Object.keys(out.metafile.inputs).map((f) => realpathSync(resolve(f)));
    const reachedSandboxOrMcp = FORBIDDEN_DIRS.some((d) =>
      inputs.some((f) => f.startsWith(`${d}/`))
    );
    expect(reachedSandboxOrMcp).toBe(true);
  });
});
