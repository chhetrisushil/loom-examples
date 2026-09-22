# experience-recompose

loom-ui slice 6a reference: **an agent revision lands while the user types.** Headless (happy-dom), offline (a scripted planner and a fake tool), Lit widgets from `@loom-ui/renderer-lit` plus two app-registered kinds.

```bash
pnpm --filter @loom/experience-recompose test
```

## What it proves

`renderBlueprintDom`'s handle has `update(next)`. The revised Blueprint is reconciled onto the live DOM by **widget id**. The main revision is "add an alert above the note, move the metric below the list, show latency in seconds, drop the badge":

- the `NoteInput` the user is typing into keeps its `<textarea>` element, text, selection (`selectionStart`/`selectionEnd`) and focus while an alert is inserted and moved to the front and the metric is moved below the list. The metric crosses the focused note: the subtree holding `document.activeElement` is never moved, and its siblings move around it. With that pin disabled, the focus assertions fail;
- the metric keeps its `lu-metric-card` element and is relabelled in place through `DomWidgetHandle.patch` (the Lit element's reactive `widget` property is reassigned). "In seconds" **relabels the unit** (`ms` → `s`); it does not convert the value. `412` stays `412`;
- the list keeps its `lu-data-table` element and its scroll position;
- the dropped badge is disposed and removed. The added alert is mounted at its position;
- hydration recomposes in the same step. The badge's handle, bound only by the old artifact, is dropped from the store. The metric's and the list's handles are shared by both artifacts: they never go back to `pending` and the tool is not called again;
- the live tree's shape (tags, `data-*`, inline style, leaf text) equals a fresh `renderBlueprintDom` mount of the same Blueprint;
- the report is loom's identity report (`identity.added`, and `identity.findings` = the dropped ids) plus what the adapter did (`remounted`, `rebound`, `findings`);
- `dispose()` is clean: the tree is gone, the widgets are detached, and a later store write reaches no widget.

Four more tests:

- **The user-input rule:** a relabel of the note reaches its caption through `patch`, and the typed text, selection and focus are untouched.
- **The bound-Note rule:** `App.bindNote()` binds `memo` directly to a live value. A patch-only revision (the caption relabels; the binding doesn't change) never calls `update`, so the typed text stays; a genuine change to the bound value does call it, and overwrites what the user typed — `update` only ever protects text the app's own value hasn't moved past.
- **A kind change** (`Note` → `Alert`) remounts exactly that node.
- **An app renderer without `patch`** is remounted and reported, never silently re-created. The user gets a new textarea.

## The recipe

```ts
controller.load(nextExperience);                    // hydration recomposes: handles the new artifact no longer binds are dropped, shared ones kept
handle.update(compile(nextExperience, opts).blueprint);
```

"Dropped" here means removed from the store once its (by-then-settled) result is no longer needed — this example never revises before a P1 load resolves, so nothing here proves an *in-flight* load gets aborted. That path (`AbortController.abort()` on `recompose`) is `@loom-ui/hydration`'s own, covered by its controller tests, not this one's.

`src/app.ts` does exactly this with a real `HydrationController`. Its `TransientInvoker` (the one method hydration needs from loom's runtime) is a fake, `LatencyInvoker`, which answers every `latency.summary` call with a fixed output: p99 `412`, phase `steady`, 30 recent samples. The controller's batch timer is injected, so `settle()` fires due batches deterministically instead of waiting on wall-clock time.

## Where the operations come from

The planner returns operations: add, drop and relabel. It appends a new node and never moves or re-types one. Three things here are the **app's**:

- the layout rules `alertsFirst()` ("alerts go first") and `metricsBelowCollections()` ("the metric below the list"). They are `moveNode` ops, replayed after the planner's in every revision;
- `retype()`: a kind change is `removeNode` + `insertNode` with the same id.

Keyed recompose does not care who authored an operation. It cares that ids are stable.

## The user-input rule

`src/noteInput.ts`: user-entered state is DOM state. `patch` relabels and never touches the textarea. `update` writes the textarea only when the **bound** value changed — most Notes here are unbound (so `update` never fires for them); `App.bindNote()` binds `memo` directly to a live value so the bound-Note test above exercises the write.

## Files

- `src/catalog.ts`: Metric, Collection, Status, and two app kinds outside loom's catalogue: Note (binding `optional`) → `NoteInput`, and Alert
- `src/noteInput.ts`: the app renderers (`noteInput`, `alert`) and the rule
- `src/planner.ts`: the scripted model (compose + two revisions, with STABLE ids) and an in-memory `decide`
- `src/app.ts`: `createApp()`, which wires runtime + store + `HydrationController` (fake invoker) + `ReferencePlanner` + compile + `renderBlueprintDom`
  - `revise()` = planner ops, then the app's layout rules, replayed, then `controller.load` + `handle.update`
  - `retype()` = remove + insert with the same id
  - `bindNote()` = binds `memo` to a live value directly, via the same `buildProviderSpec` the planner's own `materialize` uses
- `test/recompose.test.ts`: the five tests above. `test/smoke.test.ts` checks that renderer-lit loads from the linked workspace
