# planner-learning

The learning lifecycle for a **loom-ui planner**, end to end, headless and offline (scripted model,
seeded viewers, in-memory stores). A planner draws the same dashboard in one of two layouts (`flat`
or `tabs`); *which* layout is a learned loom decision, and the viewers' votes are what teach it.

```bash
pnpm --filter @loom/planner-learning start   # a narrated run (~8 s)
pnpm --filter @loom/planner-learning test    # the tests ARE the proof
```

## The loop

```
planner turn (short flow)   ReferencePlanner.compose({ unit }) -> ONE planner, `variants.rollout` = the registry:
                                                          who picks the layout (incumbent / canary slice / shadow
                                                          beside), then the surface in that layout
host publishes              Lineage version + SeenLog view per viewer + DecisionLink (via linkFromLedger)
viewers vote                SignalIngestor (authenticated viewer, exposure REQUIRED) -> VoteLedger
close                       settleRewards -> ONE late reward on the decision (reward-pipeline principal)
learn                       trajectories -> evaluatePolicy (SNIPS + unit bootstrap) -> registry.promote (gate)
```

- **The planner owns the decision (loom-ui `variants.rollout`).** There is one `ReferencePlanner`, built with
  `variants: { rollout: { source: registry, policyId, resolve, bucketSecret }, variants: { flat, tabs } }`. Each
  turn it chooses a variant through `decideWithRollout` (the `unit`, an HMAC alias, is the traffic key), then composes
  it; the flow is `planner.compose({ intent, catalog, capabilities, unit }, ctx)` plus
  `plannerProvenance(plan, { agentId })`, whose `policyDecisionId` is `plan.report.variant.decisionId`, the
  decision a reward attaches to. No hand-rolled `decideWithRollout`, no per-layout planners, no hand-stamped id.
- **A contextual policy reads its features by `unit`.** The planner's choice context is its own
  (`{ kind, unit, key, catalogId }`), so v2 ("tabs for power users") cannot take `segment` from the context. It
  closes over the host's feature store (`SegmentStore`: unit -> segment, written when the host knows the user),
  as a real policy reads a feature store. Offline evaluation re-scores the logged `unit` through the same
  store, so SNIPS still has what v2 needs and the drift story is unchanged.
- **Where the acting version is visible.** The authority is the log: the `DECISION_RECORDED` stamp
  (`policy.version`, rollout mode, bucket, shadow arm) that `linkFromLedger` / `settleRewards` join on. A replayed
  `report.variant.policy` has no `version` (the registry's current version did not choose); a FRESH turn's
  report names the acting `{ id, version }` and carries the rollout stamp (mode, bucket, shadow arm).
- **Votes (loom-ui U11).** The viewer is the host's session (`{id, tenant}`), never the payload. A vote on a
  surface the server did not record showing that viewer (`seenLogExposure`) is refused `unexposed`; a re-vote
  replaces the earlier one (one viewer = one vote in the fold), a replayed batch is refused, and
  `maxBatchesPerViewer` caps a flood (`viewer-capacity`).
- **Lifecycle (loom R18, ADR 0124).** `src/lifecycle.ts` is a ~170-line controller (WHEN to move is application
  code, ADR 0124 D9): register -> offline gate -> **shadow** (the incumbent acts; the candidate's choice is
  stamped beside it) -> **canary** (units whose stable bucket is under the fraction) -> gate on fresh traffic ->
  **full**, or `rollback`. Every `promote` re-runs the gate inside the registry.
- **The story the numbers tell.** v2 (by-segment) is great on epoch-1 evidence and passes offline and shadow.
  The world then drifts (casual viewers now prefer `tabs`); on the canary window its lift is negative, the gate
  refuses, and the controller rolls back to v1. v3 (tabs for all), judged on epoch-2 traffic, is promoted.
- **Determinism.** The decision is recorded once with the acting version, propensity, bucket and shadow arm;
  replay serves it with zero new decisions, zero planner model calls and zero `policy.select` calls (the registry
  read and `select` run inside `ctx.decide`, ADR 0124 follow-up).

## Sample output (abridged)

```
== 2. v2 (by-segment layout, trained on epoch-1 votes): offline -> shadow -> canary ==
  offline  v2: logged 0.536 -> est 0.781 lift 0.245 CI[0.208, 0.278] ... => gate PASS
  shadow   60 users served by v1 only; v2: ... lift 0.295 ... => gate PASS
  canary   23 users on v2 (mean rating 0.438) vs 67 on v1 (0.463)
  canary   v2: logged 0.463 -> est 0.355 lift -0.108 CI[-0.171, -0.040] ... => gate REFUSE
  gate refused (...) -> ROLLED BACK to v1
== 3. v3 ... canary 31 users on v3 (mean rating 0.866) vs 59 on v1 (0.588) ... PROMOTED v3 to full
```

## Layout

`src/world.ts` (catalog, scripted model, drifting ground truth) · `src/policies.ts` (versions, content
hashes, resolver, segment store) · `src/lab.ts` (planner, flow, publish, viewers, settle) · `src/lifecycle.ts` (controller) ·
`src/main.ts` (narration).
