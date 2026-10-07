# experience-tabs-planner

loom-ui **U15 (planner depth)** on a **support-ticket triage view** (non-genUI, no consumer names):
the reference planner composes and revises *nested* structure — a tab set — and the shared
container roles make the same experience a tablist, a stepper, or a plain stack depending only on
the surface that draws it.

One `Experience`, authored by `ReferencePlanner` with a scripted model (a reply is the flat entry
list the planner contract takes; a group is an entry with `container`, its members name it with
`parent`), then hydrated through a fake tool invoker and drawn by `renderBlueprintDom` and the
terminal renderer.

```bash
pnpm --filter @loom/experience-tabs-planner start   # the narrated walkthrough
pnpm --filter @loom/experience-tabs-planner test
pnpm --filter @loom/experience-tabs-planner build   # tsc
```

## The walkthrough (each step is asserted in `test/triage.test.ts`)

1. **Compose.** One `tabs` container with panels Overview / Queue / History, each a titled
   container holding metrics or a table. The host passes `containers: REFERENCE_CONTAINER_ROLES`;
   without it the model may not use `tabs`. Every container the planner inserted carries
   `owner: "planner"` (the edit boundary a later revise needs), and the role rule holds
   (`containerRoleFindings`: 2+ panels, each a titled container — the title is the tab label). A
   reply that breaks it (one panel, a bare widget under `tabs`, an untitled panel) is retried with
   the exact complaint and fails closed.
2. **Render.** `renderBlueprintDom(host, blueprint, { containers: referenceContainers() })` draws
   a real `tablist`: three `tab`s, `aria-selected`, roving `tabindex`, `aria-controls` ↔
   `aria-labelledby`, one visible panel (the rest `hidden` + `inert` + `aria-hidden`, but still
   mounted and still receiving data). ArrowRight/End switch tabs **and keep focus** on the new tab
   (the buttons are reused, not rebuilt). The terminal has no tabs: every panel prints, stacked.
3. **Revise as a minimal diff.** "Move the SLA metric to Overview, add a Notes tab" is exactly
   `moveNode` + `insertNode` (the tab) + `insertNode` (its note) — no `removeNode`, nothing
   rebuilt — and `checkPlannerConformance` reports no `revise-recomposed` (a control planner that
   remove-and-reinserts a node *is* caught). An **application-owned** container (no `owner`) is
   locked: an ordinary revise leaves it byte-identical, and a model that names it (`not-owned`) or a
   node inside it (`nested-node`) is refused with that finding, no ops, nothing applied.
4. **Re-role.** The same panels, `tabs` → `stepper`, are ONE `setRole` op. The tablist is
   replaced by Back / Next and a position line.
5. **Policy A.** A *Refunds* panel whose cards are all bound to a capability declared `secret`
   (the class lives on the capability; `declaredToolClassesFrom(capabilities)` is bound on
   `compile`, `explainNode` and the hydration controller). A cleared viewer sees the panel; a
   low-clearance viewer sees **a bare placeholder** — no title, no role, no cards, no fetch of
   `billing.refunds` — and the tab set keeps its panel count (the fourth tab reads "Restricted").
   `explainNode` answers `{ available: false }` for the panel, its cards and an unknown id alike.
   One visible card keeps the whole panel: the rule is *all* restricted, not *any*.

## Notes

- Tests run under **happy-dom** (as the other loom-ui examples do), not jsdom. Widget text lives in
  shadow roots, so the assertions read through `shadowRoot`.
- `start` installs happy-dom on `globalThis` (`src/dom.ts`) and imports the renderer afterwards.
- The scripted model's replies are built by `entries({ role, sla, notes, refunds })` in
  `src/model.ts`; a revise reply restates the whole planner-owned region and the planner diffs it.
- Requires the sibling `../loom-ui` built at a commit with U15 (loom-ui #54: `containers` on
  `ComposeInput`/`ReviseInput`, `@loom-ui/renderer-lit/containers`) and `../loom` built.
