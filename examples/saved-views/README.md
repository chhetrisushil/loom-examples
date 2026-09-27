# Saved Views — a composed surface as a logged artifact

A view assembled at runtime, promoted, and then re-opened after the world moved under it.

`db-observability` composes a dashboard per question and renders it. This example is about
everything that happens **after** that: what gets recorded, what survives a content sweep,
and the one question a content address cannot answer about itself.

It implements `loom/docs/composed-surfaces.md` end to end, and it is the example that would
have caught the defect [ADR 0095](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0095-binding-semantics-pin.md)
closes.

```
pnpm --filter @loom/saved-views start   # the narrated walkthrough
pnpm --filter @loom/saved-views test    # the same properties, as assertions
```

## The shape

| step | what happens | why it is in that order |
|---|---|---|
| **compose** | widgets from a **closed** catalogue, every node with an explicit `id` | a derived id hashes kind + props, so editing a title re-identifies the node and anything keyed on it dangles (ADR 0094) |
| **validate** | `validateBlueprint(view, catalogue)` — findings, never a throw | the **last** moment an off-catalogue component is still a findings list rather than a durable fact every replay reproduces |
| **record** | `content.put(encodeValue(view))` → a `sha256:` address | the address IS the semantic identity; two identical compositions collapse to one blob |
| **promote** | `ctx.emit(BLUEPRINT_COMPOSED, { ref, catalogId, intent })` | the log holds a 60-byte address, not a widget tree. Which *event* cites the ref is the whole difference between saved and ephemeral |
| **re-open** | resolve the ref, hydrate, draw | a read, not a generation: no model between the click and the pixels |
| **check** | `checkBlueprintPins(view, projectionRuntime.pins())` | the structure is byte-identical to what was promoted. Whether it still **means** the same thing is a different question |

## What the walkthrough shows

**A deploy changes what a saved view says, and nothing else changes.** Halfway through, the
fold registered under `spend` moves from a rolling 7-day window to calendar month-to-date.
The blueprint is byte-identical, its hash is unchanged, every binding resolves, the catalogue
still validates — and the number goes from **$750 to $1,650**.

```
pins: ok=false compared=2
  error: "spend" was recorded at version "1" and is now "2" — the derivation behind this
         name changed, so what it produces no longer means what this artifact was built against
```

A `DataBinding` is `{ projectionId, path }` — a **name**. The query, the filter, the
aggregation and the window all live in the fold behind that name, which is live code. So the
view records what each name *meant* (`Blueprint.projectionVersions`, inside the value and
therefore inside the address), and the re-open compares it.

Four more properties, each an assertion in the suite:

- **`incidents` is not flagged.** Only the binding that moved is a finding; a report that
  blamed the whole view would be as useless as one that blamed nothing.
- **A view promoted before the pin existed is reported**, not read as unchanged: `compared: 0`
  with an `unpinned` finding per binding. Two sides that declared nothing must never compare
  equal and read as a verified match.
- **An off-catalogue component reaches nothing** — not the content store, not the log. The
  test asserts on the emitted event stream, because "validated" and "recorded" look identical
  from a return value.
- **The sweep reclaims the draft and keeps the promoted view.** `sweepUnpinnedContent` pins on
  `BLUEPRINT_COMPOSED`, so promotion is literally what makes an artifact outlive content GC —
  the failure that does not show up until production. Reclaiming the draft at all depends on
  *how* it is cited: [ADR 0055 D4](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0055-k10-6-pin-seam-content-gc.md)
  made a **bare** ref load-bearing forever, regardless of which event cites it, because the
  sweep cannot tell an app's own bare citation from an ADR 0046 externalized field a live
  execution still resolves. Only a ref reached exclusively inside a claim-check envelope is
  still TTL-reclaimable — so `VIEW_DRAFTED` cites its ref that way, and `BLUEPRINT_COMPOSED`
  doesn't need to (it is pinned by event kind either way).

## What is deliberately absent

- **No model.** The composer's selection is scripted. Which widget answers which question is
  `db-observability`'s subject; this example is about the artifact's lifecycle, and a
  deterministic composer keeps every number above reproducible.
- **No new kernel surface.** `BLUEPRINT_COMPOSED` and `VIEW_DRAFTED` are userspace domain
  events — the fold skips unknown types while still advancing `sequence`. `KERNEL_ABI` and
  `EVENT_SCHEMA` are untouched by everything here.
- **No blueprint in surface state.** It would become data the client binds to, re-entering the
  fold on every change. The artifact is content-addressed and the log cites it.
