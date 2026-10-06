import { seenToState } from "@loom-ui/core";
import { EXPERIENCE_ID, handleFor, incidents } from "./board";
import {
  DANA,
  LEE,
  MAX_VIEWS,
  composeBoard,
  createRig,
  editThenRevert,
  explain,
  holds,
  lineageBlobs,
  must,
  openBoard,
  setWorld,
  sweep,
  viewsOf,
} from "./scenario";

const say = (s = "") => console.log(s);
const step = (n: number, title: string) => say(`\n${n}. ${title}`);
const brief = (e: Awaited<ReturnType<typeof explain>>) =>
  e.available
    ? `available; created by ${e.created?.by.source}${e.created?.by.decisionId ? ` (decision ${e.created.by.decisionId})` : ""}; changes=${e.changes}; words=${e.why ? `"${e.why.text}"` : "withheld"}`
    : "{ available: false }";

const rig = createRig();

step(1, "Compose the incident board with the reference planner (scripted model)");
const { composed, version } = await composeBoard(rig);
say(
  `   planner decision ${composed.report.decisionId} -> ${composed.ops.length} ops stamped with it`
);
say(`   summary class: ${composed.summaryClass} (the strictest class of what the model read)`);

step(2, "Hand-edit a card, then revert");
const { edited, reverted } = await editThenRevert(rig, version);
say(
  `   explain at the edit : ${brief(await explain(rig, "open_incidents", DANA.viewer, { versionHash: edited }))}`
);
say(`   explain after revert: ${brief(await explain(rig, "open_incidents", DANA.viewer))}`);
say(`   (the revert is a NEW version ${reverted.slice(7, 15)}, not a rewrite)`);

step(3, "Explain the same cards for a cleared on-call viewer and a low-clearance one");
for (const [who, v] of [
  ["dana (secret)", DANA.viewer],
  ["lee (internal)", LEE.viewer],
] as const) {
  say(`   ${who}`);
  say(`     open_incidents    : ${brief(await explain(rig, "open_incidents", v))}`);
  say(`     customer_exposure : ${brief(await explain(rig, "customer_exposure", v))}`);
  say(`     no_such_card      : ${brief(await explain(rig, "no_such_card", v))}`);
}

step(4, "Hydrate values, record what each viewer was shown, then change the data");
setWorld(rig, { open: 7, primary: "Dana Ruiz", accounts: 1200 });
const approved = await openBoard(rig, DANA);
await openBoard(rig, LEE);
say(
  `   dana saw open=7 and approved at ${approved.at}; lee saw open=7 (never customer_exposure: the capability classes it secret, the bound policy holds it back)`
);
setWorld(rig, { open: 5 });
await openBoard(rig, LEE);
setWorld(rig, { open: 3 });
await openBoard(rig, DANA);
say("   data moved on: open 7 -> 5 (lee looked) -> 3 (dana looked)");

step(5, "Replay what dana saw when she approved");
const then = await viewsOf(rig, "dana", { until: approved.at });
const now = await viewsOf(rig, "dana");
const open = (v: typeof then) => seenToState(v.views[0]!.entries).values;
say(`   as of ${approved.at}: values ${JSON.stringify(open(then))}`);
say(`   newest view         : values ${JSON.stringify(open(now))}`);

step(6, "Erase lee, collect garbage, roll old views off");
must(await rig.log.eraseViewer({ experienceId: EXPERIENCE_ID, viewerId: "lee" }));
say(`   lee's reads now: ${JSON.stringify(await viewsOf(rig, "lee"))}`);
say(`   blob for open=5 (only lee saw it) before sweep: ${await holds(rig, 5)}`);
const r1 = await sweep(rig);
const cited = await lineageBlobs(rig);
say(
  `   sweep: deleted ${r1.deleted}; open=5 held: ${await holds(rig, 5)}; open=7 (dana saw it too) held: ${await holds(rig, 7)}`
);
let present = 0;
for (const a of cited) if ((await rig.content.get({ __loomContent: a })) !== null) present += 1;
say(`   lineage blobs still present: ${present} of ${cited.length}`);
setWorld(rig, { open: 2 });
await openBoard(rig, DANA);
setWorld(rig, { open: 1, accounts: 900 });
await openBoard(rig, DANA);
const kept = await viewsOf(rig, "dana");
const openOf = (entries: Parameters<typeof seenToState>[0]) =>
  seenToState(entries).values[handleFor(incidents, "open")];
say(
  `   maxViews=${MAX_VIEWS}: dana has ${kept.views.length} views left, newest first: open=${JSON.stringify(kept.views.map((v) => openOf(v.entries)))}`
);
const r2 = await sweep(rig);
say(`   sweep: deleted ${r2.deleted}; open=7 (rolled off) held: ${await holds(rig, 7)}`);
