import { SchedulePrincipalError } from "@loomwork/workflow-runtime";
import { describe, expect, it } from "vitest";
import { beat5 } from "../src/beats";

describe("beat 5: a scheduled agent (D12, ADR 0152)", () => {
  it("each tick runs as <schedule>@<occurrence>; settled leases let a third run; the fourth is skipped, never anonymous", async () => {
    const b = await beat5();
    expect(b.grant?.taskId).toBe("nightly-digest");
    expect(b.grant?.issuedTo).toBe("svc-digest");
    // ticks 1-3 ran, each as its OWN grant id (the tool saw it on ctx.principal)
    expect(b.ticks.slice(0, 3).map((t) => t.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    expect(b.w.senders).toEqual(b.ticks.slice(0, 3).map((t) => t.id));
    expect(b.w.senders.every((s) => /^nightly-digest@\d+$/.test(s))).toBe(true);
    expect(b.ticks.slice(0, 3).every((t) => t.settled)).toBe(true);
    // 11 total, 5 carved per tick: without the refund of the unused 2, tick 3 (5+5+5 > 11) could not have run.
    // tick 4 would need 9 + 5 > 11: skipped and reported, with no execution at all
    expect(b.ticks[3]?.status).toBeUndefined();
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]).toBeInstanceOf(SchedulePrincipalError);
    expect(String(((b.errors[0] as SchedulePrincipalError).cause as Error).message)).toContain(
      "headroom"
    );
    expect(await b.events(b.ticks[3]?.id ?? "")).toHaveLength(0);
    expect(b.w.calls["email.send"]).toBe(3);
  });

  it("the refund is what makes room: with no settleScheduledTick the third tick is skipped", async () => {
    const b = await beat5({ refund: false });
    expect(b.ticks.map((t) => t.status)).toEqual(["completed", "completed", undefined, undefined]);
    expect(b.errors).toHaveLength(2);
    expect(b.w.calls["email.send"]).toBe(2);
  });
});
