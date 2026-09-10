import { flagDefinition } from "./flags";
import type { OperatorProfile } from "./profile";

/**
 * The one thing a derived profile is allowed to do to a surface: suggest which of the
 * agent's chosen WHY widgets leads.
 *
 * Deliberately this small. A flag is evidence that someone reads a particular kind of
 * detail, which justifies putting that detail first and justifies nothing else — not
 * hiding the rest, not adding anything, not changing what the agent selected. The set is
 * the agent's; the order is a suggestion; and a stated preference overrides it.
 */
export function suggestedLead(
  profile: OperatorProfile | null,
  available: readonly string[]
): string | null {
  if (profile === null) return null;
  for (const id of profile.flags) {
    const promoted = flagDefinition(id).promotes;
    if (available.includes(promoted)) return promoted;
  }
  return null;
}
