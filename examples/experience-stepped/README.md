# experience-stepped

loom-ui's **container-renderer seam** (`DomRenderOptions.containers`, Blueprint IR 2.2.0
`Layout.role`, loom ADR 0099), in an app that has nothing to do with any other: a **bike-share
rider onboarding**. Where `@loom-ui/renderer-lit`'s `registry` lets an app register a renderer
for a widget **kind**, `containers` lets it register one for a container **role** — this app
registers its own `stepped` renderer (`src/steppedContainer.ts`) for `role: "stepped"` and gets
progress-dot / Back-Next chrome around a plain vertical list of steps, with no change to the
adapter's own mount, keyed reconcile, reorder, subscription or focus-pin behaviour.

One `Experience`, authored as operations over a `genesis`, compiled for `web` and for `terminal`.
The root grid holds one `column` container (`"onboarding"`, `role: "stepped"`, titled "Rider
onboarding") with three step containers — account → payment → pickup — each holding a `Detail`
(loom-ui's `Note`) and a `Highlight` (loom-ui's `Kpi`).

**Who owns what.** The adapter keeps `body` (the flex holding the step sections), every step's
mount / keyed reconcile / reorder / subscriptions, and the focus pin. `steppedContainer.ts` owns
only its chrome — progress dots, Back/Next, an `aria-live="polite"` position readout — and which
step is visible: the step shown carries none of `hidden` / `inert` / `aria-hidden`; every other
step carries all three (design Q3). Which step is current is chrome state: it lives in the
renderer's own closure and survives exactly as long as the container does.

```bash
pnpm --filter @loom/experience-stepped test
pnpm --filter @loom/experience-stepped build
```

## What the tests exercise

- **Paging** (`test/stepped.test.ts`): exactly one step shown at a time; Back/Next move it and
  update the chrome's dots and position text; Back is disabled at the first step, Next at the
  last, and either at its own end is a no-op.
- **`setRole`**: `setRole(nodeId, null)` falls back to a plain list (chrome gone, every step
  visible with none of the three hidden attributes) and remounts every widget under the
  container (a role is part of its key, like a type change) — `setRole(nodeId, "stepped")`
  reverses it, remounting again.
- **Update**: an identical Blueprint makes zero DOM mutations (asserted with a `MutationObserver`)
  and an empty `RecomposeReport`.
- **A step's title change**: `setTitle` on a step patches the chrome's dots/position text and the
  adapter's own section heading — a CHILD's own field changed, so the container's `update` is
  called once; nothing remounts.
- **Appending a step**: inserting a fourth step (`confirm`) at the END keeps every existing step
  container's ordinal, so `RecomposeReport.remounted` is empty and none of the first three steps'
  DOM elements change identity — only the new step's own widgets mount. (A MID-list insert would
  shift later containers' ordinals and remount their widgets instead — a known limitation, loom-ui
  gap G6; this app only ever appends, and the suite deliberately does not test a mid-list insert
  as "no remount".)
- **A throwing renderer**: on the initial mount and on a later `update`, the container falls back
  to the plain list — findings say which (`mount-failed` / `patch-failed`), every step stays
  visible and its widgets stay subscribed to live projection data.
- **Terminal** (`test/terminal.test.ts`): `renderExperience` has no counterpart seam for `role` —
  every step prints under the title in reading order, and the frame is byte-identical whether or
  not the container carries a role (loom ADR 0099 D5).

There is **no consumer-specific code** here — only this app's own vocabulary (`Detail`,
`Highlight`) mapped onto loom-ui's generic kinds (`Note`, `Kpi`) and its own container role
(`"stepped"`) mapped onto its own renderer.

Requires the sibling `../loom-ui` built at a commit with the container-renderer seam
(`DomRenderOptions.containers`, `ContainerNode.role`, `setRole`) and the sibling `../loom` built
at Blueprint IR 2.2.0 (loom ADR 0099, `Layout.role`).
