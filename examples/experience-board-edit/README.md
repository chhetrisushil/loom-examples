# experience-board-edit

loom-ui operations and planner accounting on a small greenhouse board: air temperature, humidity and a watering log, read through one climate tool. Headless and offline (a scripted model).

```bash
pnpm --filter @loom/experience-board-edit test
```

## What it proves

- **Resize.** A widget action carrying `setPlacement { nodeId, span, row, column }` is an experience op `interpretAction` admits; `apply` changes the node's width and grid placement. `null` clears a placement field (the key is removed); `span` can be set, never cleared.
- **Retiring a provider.** `removeProvider` is refused from a widget (`provider-op-not-interactive`) and refused by `apply` while any node still binds the handle (`provider-still-bound`, naming the node). Remove the widget first, then the provider.
- **The planner cleans up after itself.** "drop the watering log" revises to one `prompt` op whose primitives are the `removeNode` and a `removeProvider` for the handle that removal orphaned. The user's resize survives the revision: the draft keeps the span, so the planner emits no `setPlacement`.
- **Usage survives replay.** The scripted model reports token usage; `PlanReport.usage` carries it, recorded inside the plan's `ctx.decide`. A second compose on the same decisions is served from the record, tokens included, with no model call.
- **Titles.** The app titles the whole board with `setTitle` on the root, and `null` clears it again. A widget may not retitle the root (`root-immutable`), and a widget node has no title (`not-container`), because its heading is its label.
- **Drift repair keeps the call.** The trend widget binds a two-step provider (a station read feeding a trend calculation). When the trend tool's reply shape drifts, the drift is keyed on the terminal step, and the scripted repair keeps that call, arguments included, so the planner rebuilds the upstream step and the repaired provider runs end to end.
- **The lineage replays.** Compose ops + the user's ops + the revision's prompt op fold from genesis to the same tree and providers, with no planner and no model.
