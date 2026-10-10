import { SkillRegistry } from "@loom/agent";
import type { SkillDefinition, ToolDefinition } from "@loom/core";
import { instructions$, skill$, tool$ } from "@loom/core";
import { z } from "zod";

const io = z.object({}).passthrough();

/** A FIRST-PARTY tool: its description and vocabulary are the host's own, so both are trusted. */
export const firstParty = (id: string, description: string, extra: object = {}): ToolDefinition =>
  tool$({
    id,
    name: id,
    description,
    kind: "tool",
    inputSchema: io,
    outputSchema: io,
    ...extra,
  });

/** The agent's own tool: on the menu from turn 0, exactly as without `toolSearch`. */
export const lookupCustomer = firstParty("lookup_customer", "Look up a customer record by name");

export const postLedgerEntry = firstParty("post_ledger_entry", "Post one ledger entry");

export const MONTH_END_INSTRUCTIONS =
  "MONTH-END CLOSE: 1) confirm every invoice for the month is charged or voided. " +
  "2) post one ledger entry per charged invoice with post_ledger_entry. 3) never close twice.";

const skill = (
  id: string,
  description: string,
  text: string,
  extra: Partial<SkillDefinition> = {}
): SkillDefinition =>
  skill$({ id, name: id, description, instructions: instructions$(text), ...extra });

/** A registry the model could never fit in a prompt index: one needle among look-alikes. */
export function buildSkills(): SkillDefinition[] {
  const fillers = [
    ["incident_response", "Run an incident: page on-call, open a channel, write the timeline"],
    ["customer_offboarding", "Close an account: export data, cancel plans, revoke access"],
    ["data_retention", "Purge records past their retention window"],
    ["expense_audit", "Audit expense reports against policy"],
    ["release_checklist", "Walk a release through its go/no-go checklist"],
    ["vendor_review", "Review a vendor's security questionnaire"],
  ] as const;
  return [
    ...fillers.map(([id, d]) => skill(id, d, `${id.toUpperCase()}-RULES`)),
    skill(
      "month_end_close",
      "Close the books for a month: reconcile invoices and post the ledger",
      MONTH_END_INSTRUCTIONS,
      {
        tools: [postLedgerEntry],
        aliases: ["close the month", "run month end"],
        tags: ["finance"],
      }
    ),
  ];
}

export function buildRegistry(skills: readonly SkillDefinition[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const s of skills) registry.register(s);
  return registry;
}
