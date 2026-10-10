import { HYDRATION_PROJECTION_ID, HydrationStore } from "@loom-ui/hydration";
import { litRegistry, renderBlueprintDom } from "@loom-ui/renderer-lit/dom";
import "@loom-ui/renderer-lit/register";
import { MetricCard, blueprint$, cell, grid } from "@loom/blueprint-runtime";
import { InMemoryProjectionRuntime } from "@loom/projection-runtime";
import { describe, expect, it } from "vitest";

describe("smoke: @loom-ui/renderer-lit loads under vitest + happy-dom from the linked workspace", () => {
  it("mounts a MetricCard through litRegistry and updates it through handle.update", async () => {
    const runtime = new InMemoryProjectionRuntime();
    const store = new HydrationStore(runtime, { experienceId: "smoke" });
    store.setValue("h", 412, { state: "ready" });
    const bp = (title: string) =>
      blueprint$({
        id: "smoke@1",
        title: "Smoke",
        projections: [HYDRATION_PROJECTION_ID],
        layout: grid({
          columns: 12,
          children: [
            cell(
              6,
              MetricCard({
                id: "m",
                title,
                binding: {
                  projectionId: HYDRATION_PROJECTION_ID,
                  path: "values.h",
                  status: { path: "status.h" },
                },
              })
            ),
          ],
        }),
      });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const handle = renderBlueprintDom(host, bp("Latency"), {
      projectionRuntime: runtime,
      executionId: store.executionId,
      registry: litRegistry,
    });
    const el = host.querySelector("lu-metric-card") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    await el.updateComplete;
    expect(el.shadowRoot?.textContent).toContain("Latency");
    const r = handle.update(bp("Latency p99"));
    await el.updateComplete;
    expect(r.remounted).toEqual([]);
    expect(host.querySelector("lu-metric-card")).toBe(el);
    expect(el.shadowRoot?.textContent).toContain("Latency p99");
    handle.dispose();
  });
});
