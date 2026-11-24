import { describe, expect, it } from "vitest";
import { beat4 } from "../src/beats";
import { EMAIL } from "../src/model";

describe("beat 4: provenance (D7)", () => {
  it("a foreign lineage's note parks the governed write; approving the lineage lets it through", async () => {
    const b = await beat4();
    expect(b.emailsAfterA).toBe(1);
    expect(b.note).toContain("lineage:task-A"); // the writer's verified lineage is on the note
    expect(b.parked.status).toBe("suspended");
    expect(b.parked.suspendedOn?.on).toBe("task-authority:renew");
    expect(b.request).toMatchObject({ reason: "cross-lineage", lineages: ["lineage:task-A"] });
    expect(b.emailsWhileParked).toBe(1); // B's email has not run
    expect(b.declined?.status).toBe("failed");
    expect(b.parked2.suspendedOn?.on).toBe("task-authority:renew");
    expect(b.emailsAfterB2).toBe(2); // exactly one more: B2's, after approval
    expect(b.w.calls[EMAIL]).toBe(2);
  });
});
