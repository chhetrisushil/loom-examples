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

## Gotcha: React must be a singleton

An example that **mounts** `@loom/plugin-renderer-react` hooks under jsdom (e.g.
`db-command-center`) can hit `Cannot read properties of null (reading 'useState')`.
Cause: renderer-react is linked from `../loom`, whose built hooks import React
from `../loom`'s `node_modules`, while the app's react-dom would use this repo's
copy — two Reacts, null dispatcher. Fix (see
`examples/db-command-center/vite.config.ts`): alias every `react`/`react-dom`
specifier to the copy **renderer-react already uses** (resolved from the linked
package), so the whole test shares one React.

## Conventions

- Package manager: `pnpm@9.14.4` (pinned via `packageManager`; use `corepack`).
- Lint/format: `biome` (`pnpm lint`). Base TS config: `tsconfig.base.json`.
- This repo mirrors the sibling-repo pattern loom already uses for
  `../loom-plugins` (3P plugins) and `../loom-demo`.
