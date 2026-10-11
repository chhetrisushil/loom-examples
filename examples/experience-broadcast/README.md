# experience-broadcast

loom-ui **audience**, for a support desk: ONE `Experience` rendered twice.

| Surface | Audience | Who decides what is shown |
|---|---|---|
| The agent's own screen | `"viewer"` (default) | the agent's clearance (`secret`: everything) |
| The lobby wallboard, driven from the same logged-in machine | `"broadcast"` | the broadcast ceiling: unclassified content only, **whoever is logged in** |

The board has four bound widgets and a note. Open tickets and SLA status are open to anyone; the
escalated customers' names are `sensitive` and the refund exposure is `secret`
(`bindProvider({ sensitivity })`). Compiling the same sealed version for the wallboard:

```ts
compile(exp, { surface, catalog, hydrationProjectionId, hydrationProjectionVersion,
               viewer: agent, audience: "broadcast", placeholderKey });
```

- turns each classified widget into loom's **redacted widget** (Blueprint IR 2.5.0): kind `Note`,
  `source: { type: "redacted", version: "1", redacted: true }`, an opaque `r_` id, the same grid cell, and no
  binding, title, props or original type. The Blueprint has no `audience` field; it records the result.
- raises `audience-withheld` findings server-side (a node the agent could see, the audience may not).
- is drawn by the Lit and terminal renderers as loom's constant `⊘ redacted` marker and nothing else.

The data boundary agrees: `handleInventory(exp, { viewer, audience })` does not list the classified handles, so the
wallboard's browser never asks for them (`DeskTools.calls` shows their tools are never called), and
`serveHandles(..., { viewer, audience })` refuses a hostile client that names one anyway, with the same
`unknown-handle` it gives a handle that does not exist.

`test/broadcast.test.ts` proves it end to end, with the agent's own surface as the positive control: no customer
name, refund figure, widget title, tool name or class word appears in the wallboard's Blueprints, inventory,
requests, terminal frame, or the Lit DOM (text and every attribute, shadow roots included).

There is no consumer-specific code here: only a desk's own vocabulary on loom-ui's generic kinds.

**Depends on loom-ui `feat/slice7-audience` (loom-ui PR #80)** and loom `2944ff32` or later (Blueprint IR 2.5.0).

```bash
pnpm --filter @loom/experience-broadcast test
pnpm --filter @loom/experience-broadcast build
```
