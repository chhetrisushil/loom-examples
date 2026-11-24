import { beat1, beat2, beat3, beat4, beat5 } from "./beats";
import { PAGER } from "./model";

const heading = (s: string) => console.log(`\n== ${s}`);

async function main(): Promise<void> {
  const b1 = await beat1();
  heading("1. Grant from reach (ADR 0150 D9)");
  console.log(`  reachOf(digest)       : ${b1.reach.join(", ")}`);
  console.log(`  minted grant effects  : ${b1.grant.effects.join(", ")}   (reach minus the pager)`);
  console.log(`  verify, template inside the reach : ${b1.clean.length} findings`);
  for (const f of b1.overBroad)
    console.log(`  verify, template + db.drop        : [${f.severity}] ${f.message}`);

  const b2 = await beat2();
  heading("2. Leases + signed reads (D8)");
  console.log(
    `  own scope team:alpha  : ${b2.own.status}, the note reached the model: ${b2.ownSawNote}`
  );
  console.log(
    `  scope team:beta       : ${b2.foreign.status} <- ${/task-grant:read-scope/.exec(b2.foreignReasons[0] ?? "")?.[0]}`
  );

  const b3 = await beat3();
  heading("3. Denial the model sees (D11)");
  console.log(`  onDenied "reason"     : ${b3.ok.status}; the model was shown: ${b3.seen[0]}`);
  console.log(`  ${PAGER} ran ${b3.w.calls[PAGER] ?? 0}x, email.send ran ${b3.emailsAfterSoft}x`);
  console.log(
    `  default ("fail")      : ${b3.bad.status}; ${/task-grant:scope/.exec(b3.badReasons[0] ?? "")?.[0]} ended the run, the model never read it`
  );
  const b4 = await beat4();
  heading("4. Provenance: who directed the write (D7)");
  console.log(
    `  task A wrote a note, tagged with its verified lineage: ${b4.note.includes("lineage:task-A")}`
  );
  console.log(
    `  task B recalled it, then tried email.send -> ${b4.parked.suspendedOn?.on} (parked on ${JSON.stringify(b4.request?.lineages)}); emails sent: ${b4.emailsWhileParked}`
  );
  console.log(
    `  operator declines the lineage -> B ${b4.declined?.status}, emails sent: ${b4.emailsWhileParked}`
  );
  console.log(
    `  operator approves lineage:task-A -> a fresh B parks, is granted, and sends; emails sent: ${b4.emailsAfterB2}`
  );

  const b5 = await beat5();
  heading("5. A scheduled agent: one approval, a grant per tick (D12, ADR 0152)");
  console.log(`  approved once: schedule grant "${b5.grant?.taskId}" for ${b5.grant?.issuedTo}`);
  for (const t of b5.ticks)
    console.log(
      `  ${t.id}: ${t.status ?? "SKIPPED (no execution)"}${t.settled ? ", unused lease refunded" : ""}`
    );
  console.log(`  email.send ran as: ${b5.w.senders.join(", ")}`);
  console.log(
    `  onError: ${b5.errors.map((e) => `${(e as Error).name} <- ${String(((e as Error).cause as Error).message)}`).join("; ")}`
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
