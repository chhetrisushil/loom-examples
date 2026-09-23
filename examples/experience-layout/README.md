# experience-layout

loom-ui's placement and section titles, in an app that has nothing to do with any other: a
**branch-library board**. One `Experience`, authored as operations over a `genesis`, compiled once
for `web` and once for `terminal` (Blueprint IR 2.1.0, loom ADR 0098).

| Section | Title (a `LocalizedText`) | Layout |
|---|---|---|
| `today` | "Today at the branch" | Every node on explicit grid lines: a `Notice` 8 wide and **two rows tall** at row 1, column 1; `Visitors` at row 1, column 9; `Loans` at row 2, column 9. Inserted visitors → loans → notice, so the placement — not the order — decides where each lands. |
| `collections` | "Collections" | Two counts, 6 wide each, **unplaced**: they flow in document order, and their cells carry a span only. |

- **Web** (`renderBlueprintDom` + `litRegistry`): each titled section is a `<section aria-label>` with an
  `<h2>`, and the section is the root grid's cell; each placed widget's own element carries
  `grid-column` / `grid-row` (`1 / span 8`, `1 / span 2`). `swapCounts` revises the Experience so the two
  counts trade rows; `handle.update` keeps both widgets' elements and only restyles their grid lines
  (`remounted: []`).
- **Terminal** (`renderExperience`): each title prints underlined with `─`, and placed nodes print in
  reading order — row, then column — so the notice comes first.
- Titles resolve at compile through `resolveLabel` (the test renders the German titles); the Blueprint
  carries text, never the key.

There is **no consumer-specific code** here — only a library's own vocabulary mapped onto loom-ui's
generic kinds (`Kpi`, `Note`).

```bash
pnpm --filter @loom/experience-layout test
pnpm --filter @loom/experience-layout build
```

Requires the sibling `../loom-ui` built at a commit with Blueprint IR 2.1.0 support.
