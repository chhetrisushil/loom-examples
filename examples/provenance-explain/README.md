# provenance-explain

loom-ui **U12** on an incident-triage board: *why is this card here?*, *what did this person see when
they approved?*, and *how do I forget a person without losing the history*. Headless and offline (a
scripted model, an in-memory content store, a fake transient invoker). Nothing here is specific to one
app; the board is just three Metric cards, one of them classified `secret`.

```bash
pnpm --filter @loom/provenance-explain start   # a short narrated walkthrough
pnpm --filter @loom/provenance-explain test    # the tests ARE the proof
```

## The pattern

```ts
// 1. Stamp the planner's recorded decision on the ops it produced.
const by = plannerProvenance(composed, { agentId: "triage-planner" });
await lineage.compose({ experienceId, expectedHead, ops: composed.ops.map((op) => ({ op, by, at })),
                        by, summary: composed.summary, summaryClass: composed.summaryClass });

// 2. Ask "why is this here" FOR A VIEWER. Unknown, hidden and unreadable all answer { available: false }.
await lineage.explain(experienceId, "customer_exposure", { viewer: { clearance: "internal" } });

// 3. Record what a viewer was shown (values sealed under a per-viewer key), read it back as of a time.
const snapshot = snapshotSeen(head, { viewer, read });             // read() is never called for hidden data
await seenLog.record({ experienceId, viewerId, snapshot, viewer });
const { views } = await seenLog.read({ experienceId, viewerId, reader, until: approvedAt });
const { values } = seenToState(views[0].entries);                  // the surface as it was shown

// 4. Forget a viewer, then reclaim what only they saw.
await seenLog.eraseViewer({ experienceId, viewerId });
await collectSeenGarbage(seenLog, { graceMs, ownsContentStore: true });
```

## What each step shows (`test/provenance.test.ts`, same order)

| Step | What it demonstrates |
|---|---|
| **1. Compose** | The reference planner (scripted model) composes the board; `plannerProvenance` links each op to the recorded `decisionId` and model. `explain` returns it as `created.by`; the model's summary arrives as `UntrustedText` and its class (`secret`, the strictest of what the planner read) is stored with the version. `lineage.verify` is clean. |
| **2. Edit, revert** | A hand edit is a second version attributed to the person; `explain` at that version shows `changed` and `changes: 1` while `created` still names the planner. `revert` is a NEW version whose ledger is the restored version's: `changes: 0` again. Nothing is rewritten. |
| **3. Explain, two viewers** | For a cleared on-call viewer the classified card explains fully. For a low-clearance viewer it returns bare `{ available: false }`, **identical to an id that does not exist** (no oracle). On the cards that viewer may see, the *words* (summary, prompt) are withheld because the version holds a secret card (the class floor, which the bound policy also raises for a hand-added unclassified card on the secret tool, even when the summary itself is only internal). On a board with no classified card the same viewer reads them. A model that omits or lowers the class cannot open the card. |
| **4. Record views** | Each viewer hydrates through their own store (the controller never invokes a provider whose class the viewer may not see), `snapshotSeen` captures the delivered values, `SeenLog.record` seals each ref under that viewer's key. The low viewer's snapshot says only that something was `restricted`. The raw stream holds no readable address or value; one value seen by two viewers is one blob. |
| **5. Replay at approval** | `read({ until })` returns the view as of the approval, `seenToState` rebuilds `values.<handle>` / `status.<handle>`: `open = 7` even though the data has since moved to `3`. A low-clearance *reader* of the same stream is redacted again at read time. |
| **6. Erase, collect, roll off** | `eraseViewer` destroys the viewer's key (crypto-shredding): reads say `erased`, `record` refuses, the log keeps only ciphertext (a `VIEWER_ERASED` marker, `VIEW_RECORDED` events no one can read). A sweep before the erasure deletes 0; after it, exactly the erased viewer's unique blob. The value blobs stay in the content store until `collectSeenGarbage` (mark-and-sweep) reclaims what no live view and no lineage artifact names: the erased viewer's unique value goes, the value another viewer also saw survives, so do the lineage's artifacts. With `maxViews: 3` a fourth view rolls the oldest off (it does not refuse), and the next sweep reclaims its unique blob. |

## Rules the example follows

- **The seen log is its own store and namespace** (`eventStoreLineageStore(es, seenStoreOptions)`), never the
  lineage's: a view is per-viewer, frequent and carries data. The content store is shared, so identical
  values dedupe, and so the collector can say "the lineage still cites this".
- **One hydration store per viewer.** A shared store would hold one viewer's classified values for another.
- **`ownsContentStore: true` is an assertion.** The sweep deletes what it cannot root; this example's
  content store holds only lineage artifacts and viewed values.
- **Classification is the capability's, enforced twice.** The exposure capability declares
  `sensitivity: "secret"`; the scripted model's reply carries no class at all.
  1. *Write time (planner floor):* `materialize` classes every node bound to a capability at least
     `cap.sensitivity`. A model that omits the class, or proposes a lower one, changes nothing
     (`sensitivity: "model-may-set"` lets it only RAISE).
  2. *Read time (bound policy):* the host builds `declaredToolClassesFrom(capabilities)` from the SAME
     capabilities and binds it once as a `ReadPolicy` on `Lineage` (`SeenLog` and the change feed
     inherit it; the example also passes it to `SeenLog` explicitly) and on the `HydrationController`
     (`createServeSurface(policy)` takes the same object). This covers nodes the planner did not write: a
     hand-inserted card with no class of its own on `legal.exposure` is still hidden from a low viewer
     (`explain` says unavailable, the provider is never invoked). The tests pair it with a control rig
     that binds nothing, where the same node is open. `undeclared: "deny"` would additionally refuse a tool the
     capabilities do not list; it is left off here.
  A capability's own `sensitivity` also classes the planner's *summary*.
- **`viewer`, `viewerId` and `reader` are claims.** Nothing in lineage or the seen log authorizes; the host does.
- **A fake clock.** Retention, `until` and the collector's grace period are all time; the rig injects it.

## Files

- `src/board.ts`: catalogue, capabilities, scripted model, in-memory `decide`.
- `src/hydrate.ts`: the fake transient invoker and per-viewer hydration.
- `src/scenario.ts`: the rig (lineage, seen log, key store, clock) and one function per step.
- `src/main.ts`: the narrated walkthrough.
