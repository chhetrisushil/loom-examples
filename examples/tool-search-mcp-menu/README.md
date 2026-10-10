# tool-search-mcp-menu

An agent facing a **64-tool MCP catalogue that must not go in the prompt** ([loom ADR 0125](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0125-tool-search.md)).
`agentLoop$({ toolSearch, skillActivation })` offers the model `search_tools` instead of the catalogue;
found tools join the menu, append-only. Offline and headless: a real `@loom/plugin-mcp` server over
HTTP, a scripted model that reads the results it is given.

```
pnpm --filter @loom/tool-search-mcp-menu start   # narrated trace
pnpm --filter @loom/tool-search-mcp-menu test    # the tests ARE the proof
```

| What it shows | Where |
|---|---|
| Turn-0 menu is `search_tools`, `activate_skill` and the agent's own tool (3 of 64+) | `menuOf(plain, 0)` |
| Remote (`origin: "remote"`) tools: the server's description (it carries an injection) is withheld, the result is tainted | test "remote (MCP) tools are untrusted" |
| Host `toolSearch.annotations` close the vocabulary gap: "bill the customer" finds `charge_invoice`; without them it does not | `src/catalog.ts` `ANNOTATIONS` |
| A skill registry with `discovery: "search"`: found by `search_tools`, loaded by `activate_skill`, instructions come back as the tool result, its tool joins the menu | `src/skills.ts` |
| A custom `toolSearch.ranker` puts search in two-ranker mode (tool ranker + built-in skill ranker, interleaved tool-first) | `src/ranker.ts` |
| Crash before the activation and resume: **0 ranker calls**, identical recorded pages, identical menu, no repeated MCP call | `src/scenario.ts` `runActs` |

Layout: `catalog.ts` (the 64 tools + host vocabulary), `server.ts` (MCP over HTTP), `skills.ts`,
`ranker.ts`, `model.ts` (scripted provider), `world.ts` (runtime wiring, crash/resume helpers),
`scenario.ts` (the three runs), `main.ts` (the trace).
