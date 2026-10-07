import { installDom } from "./dom";

installDom();
// Imported AFTER the DOM exists: the renderer touches `document` / `customElements` at load.
const { findNode } = await import("@loom-ui/core");
const { AGENT, LEAD, Triage } = await import("./app");
const { entries, reply, scriptedModel } = await import("./model");

const say = (s = "") => console.log(s);
const step = (n: number, title: string) => say(`\n${n}. ${title}`);
const tabs = (t: InstanceType<typeof Triage>) =>
  [...t.host.querySelectorAll("[role='tab']")].map((x) => x.textContent);
const kinds = (ops: readonly { type: string }[]) => ops.map((o) => o.type).join(", ");
const innerOps = (ops: readonly { type: string; materialized?: readonly { type: string }[] }[]) =>
  ops[0]?.type === "prompt" ? (ops[0].materialized ?? []) : ops;

step(1, "Compose: a scripted model returns ONE `tabs` container (Overview / Queue / History)");
const t = new Triage(
  scriptedModel([
    reply(entries()),
    reply(entries({ sla: "overview", notes: true })),
    reply(entries({ sla: "overview", notes: true, role: "stepper" })),
  ]),
  LEAD
);
const composed = await t.compose();
say(`   ${composed.ops.length} ops; the planner was offered the reference roles (tabs, stepper)`);
say(
  `   every container is owner:"planner" -> ${["views", "overview", "queue", "history"].map((id) => `${id}:${(findNode(t.experience.root, id) as { owner?: string }).owner}`).join("  ")}`
);

step(2, "Render: referenceContainers() on the web, every panel stacked in the terminal");
say(
  `   web tablist: ${JSON.stringify(tabs(t))}  (roving tabindex, aria-controls / aria-labelledby wired)`
);
const first = t.host.querySelector("[role='tab']") as HTMLElement;
first.focus();
first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
say(
  `   ArrowRight -> focus stays on a tab: ${document.activeElement?.getAttribute("role") === "tab"} ("${document.activeElement?.textContent}")`
);
say("   terminal frame:");
for (const line of t.terminal().split("\n")) say(`     ${line}`);

step(3, 'Revise as a minimal diff: "move the SLA metric to Overview, add a Notes tab"');
await t.addEscalationPolicy();
const revised = await t.revise("move the SLA metric to Overview, add a Notes tab");
say(`   ops: ${kinds(innerOps(revised.ops))}   (no removeNode: nothing was rebuilt)`);
say(`   tabs now: ${JSON.stringify(tabs(t))}`);
say(`   the application's "escalation_policy" container was not touched`);

step(4, "Re-role tabs -> stepper: one setRole");
const restyled = await t.revise("make it a step-by-step flow");
say(`   ops: ${kinds(innerOps(restyled.ops))}`);
say(`   stepper position: ${t.host.querySelector("[data-chrome-part='position']")?.textContent}`);
t.dispose();

step(5, "Policy A: a panel whose cards are ALL bound to a secret capability collapses");
for (const [who, viewer] of [
  ["lead (secret)", LEAD],
  ["agent (internal)", AGENT],
] as const) {
  const v = new Triage(scriptedModel([reply(entries({ refunds: true }))]), viewer);
  await v.compose();
  say(`   ${who}`);
  say(`     tabs: ${JSON.stringify(tabs(v))}`);
  say(`     billing.refunds fetched: ${v.invoker.calls.includes("billing.refunds")}`);
  say(
    `     explainNode("refunds"): ${JSON.stringify(v.explain("refunds").available === false ? { available: false } : { available: true })}`
  );
  v.dispose();
}
