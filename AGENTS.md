# AGENTS.md — working in `loom-examples`

Instructions for any AI coding agent (and humans) operating in this repo.

## What this repo is

Runnable examples for the **Loom** framework. Each `examples/<name>` is a
standalone package demonstrating one usage pattern. The framework itself lives in
the sibling **`../loom`** repo and is **not published to any registry**.

## The one thing you must know: it needs `../loom` beside it

Examples consume Loom's unpublished `@loom/*` packages from the sibling checkout
via a central `link:` map. **`../loom` must be checked out next to this repo and
installed/built**, or nothing resolves:

```
workspace/
├── loom/            ← the framework (git@…/loom).  pnpm install && pnpm build
└── loom-examples/   ← this repo.                   pnpm install
```

- The map is `pnpm.overrides` in `./package.json`: every `@loom/*` dep is
  redirected to `link:../loom/{packages,plugins,tools}/<name>`. Paths resolve
  relative to this workspace root. Examples declare `"@loom/x": "*"` (the override
  wins) — do **not** reintroduce `workspace:*` for loom packages; there is no loom
  package in this workspace to satisfy it.
- Third-party versions shared across examples live in the `catalog:` of
  `pnpm-workspace.yaml`; examples reference them as `"<dep>": "catalog:"`.
- Why not git/npm deps? Loom is a pnpm-monorepo of interdependent unpublished
  packages (`workspace:*` internally). A git dep fetches the repo root, not a
  subpackage, and even a subpath can't resolve the package's own `workspace:*`
  deps. `link:` points at your already-installed loom checkout, sidestepping both.
  (Once loom publishes versioned packages, switch the overrides to versions.)

## Commands

```bash
pnpm install                       # after ../loom is installed + built
pnpm -r build                      # build every example
pnpm -r test                       # test every example
pnpm --filter @loom/db-observability start   # run one example end-to-end
```

## Adding / editing an example

- New loom package used by an example? Add one line to `pnpm.overrides` in
  `package.json` (`"@loom/newpkg": "link:../loom/packages/newpkg"`) and declare
  `"@loom/newpkg": "*"` in the example.
- Example `tsconfig.json` must **not** carry TypeScript project `references` to
  `../../packages/*` — those exist only inside the loom monorepo. Extend
  `../../tsconfig.base.json` and let types resolve from `node_modules`.
- **Exercise the real artifact, not a paraphrase of it.** An example is the last
  line of defence against a plugin that is internally consistent and externally
  wrong, so import what ships and run it. `mcp-app-release-approval` fetches the
  published `ui://` template over HTTP and executes it in jsdom rather than
  inlining a copy — which is how it found two bugs the plugin's own tests were
  green through: the template never called the cursor tool it was documented to
  poll, and its `List` branch read a prop the A2UI helper never emits. Assertions
  about a *source string* prove an artifact mentions the right things, never that
  it does them.
- **Don't vendor a loom class into an example.** A local copy rots silently when
  the linked `../loom` interface moves: vitest/esbuild happily runs the stale
  copy and only `pnpm build` (tsc) catches it. Import from `@loom/app` and the
  plugin barrels instead. If you must copy, run `pnpm build` — not just
  `pnpm test` — before believing it works.

## Gotcha: React must be a singleton

An example that **mounts** `@loom/plugin-renderer-react` hooks under jsdom (e.g.
`db-command-center`) can hit `Cannot read properties of null (reading 'useState')`.
Cause: renderer-react is linked from `../loom`, whose built hooks import React
from `../loom`'s `node_modules`, while the app's react-dom would use this repo's
copy — two Reacts, null dispatcher. Fix (see
`examples/db-command-center/vite.config.ts`): alias every `react`/`react-dom`
specifier to the copy **renderer-react already uses** (resolved from the linked
package), so the whole test shares one React.

## Convention: every `ctx.suspend` gate declares its resume contract

Any flow with a `ctx.suspend({ on })` gate MUST declare that gate's payload shape in
`resumeSchemas` on its `flow$` definition (loom ADR 0077):

```ts
const ApprovalDecision = z.object({ approved: z.boolean(), approvedBy: z.string() });

flow$({
  // …
  resumeSchemas: { ApprovalGranted: ApprovalDecision },
});
```

The runtime parses the payload **before** appending it, so a wrongly-shaped resume is refused
rather than becoming a permanent fold input. Derive the runner's type from the same schema
(`z.infer<typeof ApprovalDecision>`) so the static type cannot drift from what is enforced.

Two things to get right:

- **Model what the caller actually sends, not what the gate name suggests.** Several examples
  here send payloads that do not match their gate's name — `angular-command-center` sends
  `{ approvedBy, approvedAt }` with no `approved` field at all. Grep the `runtime.resume` call
  sites before writing the schema.
- **`z.object` STRIPS unknown keys**, and the parsed value is what gets recorded. If a payload
  legitimately carries an open envelope (see `a2ui-callfunction`), model the extra fields or
  use `.passthrough()`, or they will be silently dropped from the durable log.

## Conventions

- Package manager: `pnpm@9.14.4` (pinned via `packageManager`; use `corepack`).
- Lint/format: `biome` (`pnpm lint`). Base TS config: `tsconfig.base.json`.
- This repo mirrors the sibling-repo pattern loom already uses for
  `../loom-plugins` (3P plugins) and `../loom-demo`.
