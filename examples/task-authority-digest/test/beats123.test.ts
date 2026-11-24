import { describe, expect, it } from "vitest";
import { beat1, beat2, beat3 } from "../src/beats";
import { EMAIL, INCIDENTS, MODEL, PAGER, RECALL, WRITE } from "../src/model";

describe("beat 1: a grant derived from reach (D9)", () => {
  it("the grant is the reach minus the pager, and the lint passes only the template inside the reach", async () => {
    const b = await beat1();
    expect(b.reach).toEqual([EMAIL, INCIDENTS, MODEL, PAGER, RECALL, WRITE].sort());
    expect(b.grant.effects).toEqual(b.reach.filter((e) => e !== PAGER));
    expect(b.clean).toEqual([]);
    const warn = b.overBroad.filter((f) => f.rule === "task-grant-reach" && f.severity === "warn");
    expect(warn).toHaveLength(1);
    expect(warn[0]?.message).toContain('"db.drop"');
  });
});

describe("beat 2: leases and signed reads (D8)", () => {
  it("recalls its own scope, is refused another's before the store is read", async () => {
    const b = await beat2();
    expect(b.own.status).toBe("completed");
    expect(b.ownSawNote).toBe(true);
    expect(b.w.calls[EMAIL]).toBe(1);
    expect(b.foreign.status).toBe("failed");
    expect(b.foreignReasons).toHaveLength(1);
    expect(b.foreignReasons[0]).toContain("task-grant:read-scope");
    expect(JSON.stringify(b.w.requests.map((r) => r.messages))).not.toContain("billing outage");
  });
});

describe("beat 3: denial the model sees (D11)", () => {
  it("onDenied reason: the model reads the refusal, the run carries on, the pager never fires", async () => {
    const b = await beat3();
    expect(b.ok.status).toBe("completed");
    expect(b.seen).toHaveLength(1);
    expect(b.seen[0]).toContain("not authorized for this task (task-grant:scope");
    expect(b.emailsAfterSoft).toBe(1);
    expect(b.w.calls[PAGER] ?? 0).toBe(0);
  });
  it("the default is terminal: the run fails, nothing after the denial runs", async () => {
    const b = await beat3();
    expect(b.bad.status).toBe("failed");
    expect(b.badReasons[0]).toContain("task-grant:scope");
    expect(b.w.calls[EMAIL]).toBe(1); // still only the soft run's email
  });
});
