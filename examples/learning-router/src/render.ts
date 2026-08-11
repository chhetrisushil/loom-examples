import type { EvalReport, PromotionVerdict, Trajectory } from "@loom/learning";
import { steps } from "@loom/learning";
import type { Route } from "./domain";

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** What the log can and cannot teach — the same summary `loom learn report` prints. */
export function renderCoverage(ts: readonly Trajectory<Route>[]): string {
  const all = steps(ts);
  const withContext = all.filter((s) => s.context !== undefined).length;
  const withPropensity = all.filter((s) => s.policy?.propensity !== undefined).length;
  const scored = all.filter((s) => s.rewardSource === "direct").length;
  const share = (n: number) => `${n}/${all.length} (${pct(all.length === 0 ? 0 : n / all.length)})`;

  return [
    `  decisions          ${all.length}`,
    `  with context       ${share(withContext)}`,
    `  with propensity    ${share(withPropensity)}`,
    `  directly scored    ${share(scored)}`,
  ].join("\n");
}

/** How often each route was taken, and how it did. */
export function renderArms(ts: readonly Trajectory<Route>[]): string {
  const arms = new Map<string, { n: number; sum: number }>();
  for (const s of steps(ts)) {
    if (s.reward === undefined) continue;
    const cur = arms.get(String(s.action)) ?? { n: 0, sum: 0 };
    cur.n += 1;
    cur.sum += s.reward;
    arms.set(String(s.action), cur);
  }
  return [...arms.entries()]
    .sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n)
    .map(([key, v]) => `    ${key.padEnd(10)} mean ${(v.sum / v.n).toFixed(3)}  n=${v.n}`)
    .join("\n");
}

export function renderReport(report: EvalReport, verdict: PromotionVerdict): string {
  const lines = [
    `  candidate          ${report.policy.id}@${report.policy.version}`,
    `  evaluated steps    ${report.evaluated}`,
    `  agreement w/ log   ${pct(report.agreement)}`,
    `  logged value       ${report.loggedValue.toFixed(4)}`,
  ];
  if (report.estimatedValue !== undefined) {
    const lift = report.lift ?? 0;
    lines.push(`  estimated value    ${report.estimatedValue.toFixed(4)}  (${report.estimator})`);
    lines.push(`  lift               ${lift >= 0 ? "+" : ""}${lift.toFixed(4)}`);
  } else {
    lines.push(`  estimated value    —  (${report.estimator})`);
  }
  if (report.effectiveSampleSize !== undefined) {
    lines.push(`  effective samples  ${report.effectiveSampleSize.toFixed(1)}`);
  }
  lines.push(`  gate               ${verdict.ok ? "PASS" : "REFUSED"}`);
  for (const r of verdict.reasons) lines.push(`      · ${r}`);
  return lines.join("\n");
}

export function heading(text: string): string {
  return `\n${text}\n${"─".repeat(Math.max(text.length, 62))}`;
}
