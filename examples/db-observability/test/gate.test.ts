import { describe, expect, it } from "vitest";
import { phase3Gate } from "../src/gate";
import type { BaselineReport } from "../src/metrics";

// ── The gate that decides whether Phase 3 may proceed ────────────────────────
//
// Phase 3 is the first step that touches blueprint identity, which is the first step that
// cannot be quietly undone. Every case here is about a way a gate can wave that through.

const rate = (r: number | null, denominator: number) => ({
  rate: r,
  numerator: r === null ? 0 : Math.round(r * denominator),
  denominator,
});
const dist = (meanMs: number | null, n: number) => ({ n, meanMs, p50Ms: meanMs });

const report = (over: Partial<BaselineReport> = {}): BaselineReport => ({
  taskSuccess: rate(0.5, 400),
  timeToSuccess: dist(60_000, 200),
  discovery: { "open.queries.slow": rate(0.2, 400) },
  escapeHatch: rate(0.05, 400),
  canonicalPreference: rate(0.1, 400),
  incidentTimeToMitigate: { adaptive: dist(300_000, 20), canonical: dist(300_000, 20) },
  sessions: 400,
  ...over,
});

describe("evidence comes first", () => {
  it("says insufficient-evidence — not clear — on a thin arm", () => {
    const verdict = phase3Gate(report({ sessions: 12 }), report({ taskSuccess: rate(0.9, 400) }));
    // The distinction the decision type exists for: this is not a failure, and the next
    // action is more data rather than a redesign. Collapsing it into `blocked` would send
    // someone to fix a system that may be working.
    expect(verdict.decision).toBe("insufficient-evidence");
    expect(verdict.reasons[0]).toMatch(/12 sessions/);
  });

  it("cannot be talked into `clear` by a large effect over nobody", () => {
    // The most dangerous input this function can receive: a thin sample that happens to
    // look spectacular. 100% vs 0% over nine sessions is not a result.
    const verdict = phase3Gate(
      report({ sessions: 9, taskSuccess: rate(0, 9) }),
      report({ sessions: 9, taskSuccess: rate(1, 9) })
    );
    expect(verdict.decision).toBe("insufficient-evidence");
  });

  it("treats an unmeasured metric as unmeasured, never as zero", () => {
    const verdict = phase3Gate(report({ taskSuccess: rate(null, 0) }), report());
    expect(verdict.decision).toBe("insufficient-evidence");
    expect(verdict.comparisons[0]?.delta).toBeNull();
  });
});

describe("the counter-metrics can veto a win", () => {
  it("blocks when efficiency rose and discovery fell", () => {
    // The capability trap: the system shows less, the primary metric improves, and the
    // operators who never see a capability never use it — which is read back as proof
    // they did not need it.
    const verdict = phase3Gate(
      report(),
      report({
        taskSuccess: rate(0.62, 400),
        discovery: { "open.queries.slow": rate(0.08, 400) },
      })
    );
    expect(verdict.decision).toBe("blocked");
    expect(verdict.reasons.join(" ")).toMatch(/discovery fell/);
  });

  it("blocks when operators reach for the canonical view more often", () => {
    const verdict = phase3Gate(
      report(),
      report({ taskSuccess: rate(0.62, 400), escapeHatch: rate(0.2, 400) })
    );
    expect(verdict.decision).toBe("blocked");
    expect(verdict.reasons.join(" ")).toMatch(/escape-hatch/);
  });

  it("blocks on a time-to-mitigate regression whatever the primary metric says", () => {
    const verdict = phase3Gate(
      report(),
      report({
        taskSuccess: rate(0.8, 400),
        incidentTimeToMitigate: { adaptive: dist(600_000, 20), canonical: dist(300_000, 20) },
      })
    );
    expect(verdict.decision).toBe("blocked");
    expect(verdict.reasons.join(" ")).toMatch(/guardrail/);
  });
});

describe("a neutral result is not a licence", () => {
  it("blocks when nothing much moved", () => {
    // "No harm" justifies KEEPING Phases 1–2. It does not justify proceeding to a change
    // that cannot be undone.
    const verdict = phase3Gate(report(), report({ taskSuccess: rate(0.505, 400) }));
    expect(verdict.decision).toBe("blocked");
    expect(verdict.reasons.join(" ")).toMatch(/below the/);
  });

  it("clears only when the effect is real and nothing else regressed", () => {
    const verdict = phase3Gate(
      report(),
      report({
        taskSuccess: rate(0.62, 400),
        discovery: { "open.queries.slow": rate(0.24, 400) },
        escapeHatch: rate(0.04, 400),
      })
    );
    expect(verdict.decision).toBe("clear");
    expect(verdict.reasons).toEqual([]);
  });
});
