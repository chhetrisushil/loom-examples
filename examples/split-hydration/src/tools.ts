import type { TransientInvoker } from "@loom-ui/hydration";
import { TypedFailure } from "@loom/core";
import { MCP_INVOKE_TOOL_ID } from "@loom/plugin-mcp";

// A simulated MCP tool server behind loom's `mcp.invoke`: hydration calls it with
// `{ toolName, args, expectedSchemaHash }`. A pin that is not the tool's CURRENT input-schema hash
// fails typed (`schemaDrift`), exactly as loom's MCP plugin does — `upgrade` moves a pin to show it.

export const TOOL_PINS = {
  "stations.current": "sha256:current-v1",
  "stations.series": "sha256:series-v1",
  "stations.alerts": "sha256:alerts-v1",
} as const;
export type ToolName = keyof typeof TOOL_PINS;

interface McpCall {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly expectedSchemaHash: string;
}

export class WeatherTools implements TransientInvoker {
  readonly calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  /** Garble `stations.current`'s `tempC` field only — CurrentReading's Kpi cannot draw it. */
  garbleCurrent = false;
  /** Garble `stations.current`'s `dewPointC` field only — FrostRisk's Kpi cannot draw it. */
  garbleFrost = false;
  private readonly pins = new Map<string, string>(Object.entries(TOOL_PINS));

  /** The tool server changed a tool's input schema: its pin moves. */
  upgrade(tool: ToolName, pin: string): void {
    this.pins.set(tool, pin);
  }

  async invokeTransient<TIn, TOut>(toolId: string, input: TIn): Promise<TOut> {
    if (toolId !== MCP_INVOKE_TOOL_ID) throw new Error(`no transient tool "${toolId}"`);
    const call = input as unknown as McpCall;
    const pin = this.pins.get(call.toolName);
    if (pin === undefined) throw new Error(`no tool "${call.toolName}"`);
    if (call.expectedSchemaHash !== pin)
      throw new TypedFailure("schemaDrift", {
        toolName: call.toolName,
        expectedSchemaHash: call.expectedSchemaHash,
        observedHash: pin,
      });
    this.calls.push({ toolName: call.toolName, args: call.args });
    return this.answer(call) as TOut;
  }

  private answer(call: McpCall): unknown {
    const station = String(call.args.station);
    if (call.toolName === "stations.current")
      // ONE reading, two fields: CurrentReading and FrostRisk both bind this exact step (see
      // experience.ts) but each reshapes a DIFFERENT field of the one raw response, so garbling
      // one field never silently answers for the other.
      return {
        station,
        tempC: this.garbleCurrent ? "n/a" : station === "harbour" ? 14.5 : 9.25,
        dewPointC: this.garbleFrost ? "n/a" : station === "harbour" ? 9.0 : 1.5,
        observedAt: "2026-09-23T11:55:00.000Z",
      };
    if (call.toolName === "stations.series")
      return {
        station,
        samples: [
          { at: String(call.args.from), tempC: 8.5 },
          { at: String(call.args.to), tempC: 9.25 },
        ],
      };
    return { station, since: call.args.since, alerts: [] }; // a quiet week: nothing to report
  }
}
