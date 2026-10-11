# experience-merge

loom-ui's three-way merge, in an app that has nothing to do with any other: a **community-garden rota
board** that two volunteers, Ana and Ben, fork and edit independently. `mergeExperiences(base, ours,
theirs)` joins the forks. It is pure and deterministic, and it always returns an **ours-biased,
unsealed** partial plus the conflicts; the app seals the merge commit with both heads as parents
(`merge()` in `src/app.ts`).

| Scenario | What the two forks did | Result |
|---|---|---|
| disjoint | Ana adds a notice to "Beds"; Ben adds a whole "Events" section and re-words one notice | clean; every edit lands; sealed with `parents: [ana, ben]` |
| relabel | both relabel the same notice | `edit/edit` on that node; ours wins (swap the sides, the winner swaps) |
| move | both move one notice into different new sections | `move/move`; the notice stays in ours' section |
| key | each adds a DIFFERENT node, both labelled with the localization key `garden.member`, different words | `message/message`: no node id collides and every structural plane merges cleanly, yet one key now means two things; the report says which branch said what. Same key with the same words is reuse, not a conflict |

The key conflict is resolved by an ordinary op (`setLabel` giving the second meaning its own key);
`keyConflicts(ours, theirs, merged)` is the same check on its own.

There is **no consumer-specific code** here, only `@loom-ui/core`'s own operations.

```bash
pnpm --filter @loom/experience-merge test
pnpm --filter @loom/experience-merge build
```

Requires the sibling `../loom-ui` built at a commit that exports `mergeExperiences` (loom-ui PR #79).
