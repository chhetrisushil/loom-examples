import { toolSpecFor } from "@loom/agent";
import { A2APeerClient } from "@loom/plugin-a2a";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockExternalAgent, startMockExternalAgent } from "../src/mockExternalAgent";

const ADVERTISED = "External agent (stands in for ADK/LangGraph) that root-causes incidents";
const WITHHELD = "Third-party tool; description withheld";

let external: MockExternalAgent;
beforeAll(async () => {
  external = await startMockExternalAgent();
});
afterAll(async () => {
  await external.close();
});

describe("what the model sees of a peer's card", () => {
  it("the peer's card description is on the definition, but the model-facing spec withholds it", async () => {
    const { definition } = await new A2APeerClient({ url: external.url }).map();
    expect(definition.description).toContain(ADVERTISED);
    const spec = toolSpecFor(definition);
    expect(spec.description).toBe(WITHHELD);
    expect(JSON.stringify(spec)).not.toContain("ADK/LangGraph");
  });

  it("a peer the operator vouches for (trustDescriptions) reaches the model verbatim", async () => {
    const { definition } = await new A2APeerClient({
      url: external.url,
      trustDescriptions: true,
    }).map();
    expect(toolSpecFor(definition).description).toContain(ADVERTISED);
  });
});
