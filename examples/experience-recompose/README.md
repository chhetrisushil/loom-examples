# experience-recompose

loom-ui slice 6a reference: **an agent revision lands while the user types.** Headless (happy-dom), offline (a scripted planner), Lit widgets from `@loom-ui/renderer-lit` plus two app-registered kinds.

```bash
pnpm --filter @loom/experience-recompose test
```

## What it proves

`renderBlueprintDom`'s handle has `update(next)`. The revised Blueprint is reconciled onto the live DOM by **widget id**:

- the `NoteInput` the user is typing into keeps its `<textarea>` element, text, caret and focus while an alert is inserted and moved to the front of the grid, ahead of it — the subtree holding `document.activeElement` is never moved; its siblings move around it;
- the metric keeps its `lu-metric-card` element and is relabelled in place (`unit: ms → s`) through `DomWidgetHandle.patch` — the Lit element's reactive `widget` property is reassigned;
- the list keeps its `lu-data-table` element and its scroll position;
- the dropped badge is disposed and removed; the added alert is mounted at its position;
- the report is loom's identity report (`identity.added`, `identity.findings` = dropped ids) plus what the adapter did (`remounted`, `rebound`, `findings`).

A revision that changes a node's **kind** remounts exactly that node. An app renderer **without `patch`** is remounted and reported — never silently re-created.

## The recipe

```ts
controller.load(nextExperience);                    // hydration recomposes: unbound handles aborted/dropped, shared ones kept
handle.update(compile(nextExperience, opts).blueprint);
```

This example has no provider to call, so `deliver()` in `src/app.ts` stands in for `controller.load`: it writes a scripted value for each bound handle, chosen by the JSONPath the planner pinned on the handle's provider spec (`reshaping.scriptRef`) — handles are content hashes, not names.

## Where the operations come from

The planner returns operations (add, drop, relabel — it appends a new node and never moves or re-types one). Two things here are the **app's**: the "alerts first" layout rule (`alertsFirst()` — `moveNode` ops replayed after the planner's), and `retype()` (a kind change is `removeNode` + `insertNode` with the same id). Keyed recompose does not care who authored an operation; it cares that ids are stable.

## The user-input rule

`src/noteInput.ts`: user-entered state is DOM state. `patch` relabels and never touches the textarea; `update` writes the textarea only when the **bound** value changed.

## Files

- `src/catalog.ts` — Metric, Collection, Status, and two app kinds outside loom's catalogue: Note → `NoteInput`, Alert
- `src/noteInput.ts` — the app renderers (`noteInput`, `alert`) and the rule
- `src/planner.ts` — the scripted model (compose + two revisions with STABLE ids) and an in-memory `decide`
- `src/app.ts` — `createApp()`: runtime + store + `ReferencePlanner` + compile + `renderBlueprintDom`; `revise()` = planner ops + the app's layout rule, replayed, compiled, `handle.update`; `retype()` = remove + insert with the same id
- `test/recompose.test.ts` — the three rows above; `test/smoke.test.ts` — renderer-lit loads from the linked workspace
