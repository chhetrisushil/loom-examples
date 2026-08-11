# learning-router

**The continuous-learning loop, end to end — and the honest reasons it usually fails.**

A support-ticket triage flow routes each ticket to one of three model tiers using a
**LinUCB contextual bandit**. Then the offline half mines the log the runtime already wrote,
trains a candidate, evaluates it **against real traffic it never served**, and puts it through
a promotion gate.

```console
$ pnpm start
```

Everything is deterministic — seeded PRNG, no wall clock, no network — so the numbers below are
what you will see.

## What it teaches

| Stage | API | The point |
|---|---|---|
| 1. serve traffic | `decideWithPolicy` (`@loom/learning`) | one line makes a decision learnable |
| 2. inspect the log | `trajectories` | `(context, action, propensity, reward)` — the same summary `loom learn report` prints |
| 3. train | `LinUcbPolicy.fit` (3P) | offline, out of band, produces a **new version** |
| 4. evaluate | `evaluatePolicy` | SNIPS estimate **on real logs, before shipping** |
| 5. gate | `promotionGate` | refuses thin evidence even when the lift looks huge |
| 6. measure | — | quality goes 0.53 → 0.83 on identical tickets |
| 7. control | `evaluatePolicy` | a genuinely worse candidate is refused |
| 8. contrast | — | the same run logged the old way teaches **nothing** |

## The two moments worth reading the code for

**Stage 4 — the gate refuses a +0.37 lift.** The cold policy explored so little that the
estimate rests on ~9 effectively-independent steps out of 240. A dashboard would have shipped
it. The answer is more evidence, not a lower bar — so stage 5 canaries the candidate, pools the
logs, and *then* it passes with an effective sample size of 55.

**Stage 8 — the same executions, logged with a bare `ctx.decide`.** They complete, they are
scored, a dashboard shows identical numbers. And `evaluated: 0`, because no observation was
recorded and no outcome named the decision. Worse, credit assignment still hands each step the
execution's *terminal* reward, so the steps **look** scored while being attributable to
nothing. You discover this the day you first want to improve something — by which point the
logs are already written.

## Why this is possible at all

A learned policy normally breaks deterministic replay: the policy changes, so a re-run takes a
different path. Loom resolves that at the seam — `ctx.decide` records the **outcome of the
decision**, not the policy — so the recorded choice is served on every replay and the policy is
never re-consulted. Policies improve freely between runs; no past execution replays
differently.

That is also what makes stage 4 trustworthy: off-policy evaluation is only meaningful if the
recorded choice *is what actually ran*.

## Division of labour

Loom deliberately ships **no** reinforcement learning:

| | Where it lives |
|---|---|
| the durable `(context, action, propensity, reward)` record | kernel — `ctx.decide` ([ADR 0079](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0079-decision-context-and-policy.md)) |
| trajectories, off-policy evaluation, promotion gate | `@loom/learning` ([ADR 0080](https://github.com/chhetrisushil/loom/blob/main/docs/adr/0080-learning-substrate.md)) |
| **the learning algorithm** | `loom-plugin-linucb` — **third-party** |

`src/policy.ts` is the only file that imports the learner. Swapping LinUCB for anything else
that implements the one-method `Policy` SPI touches that file and nothing else.

## Layout

```
src/domain.ts   the simulated world + ground truth (deterministic, incl. the seeded PRNG)
src/policy.ts   the 3P LinUCB policy, its featurizer, and offline training
src/flow.ts     the flow: decideWithPolicy + recordOutcome (the only two learning lines)
src/app.ts      composition root — note there is no `learning:` config key
src/run.ts      serve N tickets, then read the logs back the way an offline job would
src/main.ts     the eight-stage narrative
```

## Notes

- **`epsilon` is not optional in spirit.** With `epsilon: 0` LinUCB is deterministic, every
  choice logs propensity `1`, and the log contains no counterfactuals — so it can never support
  an unbiased estimate of the *next* candidate. `src/policy.ts` explains the choice at the call
  site.
- **The candidate is evaluated with `epsilon: 0`.** Judge a policy on what it would choose, not
  on its exploration noise.
- This example needs **two** sibling checkouts: `../loom` and `../loom-plugins` (see the root
  `pnpm.overrides`).
