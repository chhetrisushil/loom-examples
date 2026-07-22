import type { A2UIServerMessage } from "@loom/plugin-a2ui";

// ── Terminal formatting for A2UI wire messages ────────────────────────────────
//
// Purely cosmetic — turns each `A2UIServerMessage` into one readable line so the
// delta→absolute translation is visible as the flow runs.

const KIND_LABEL: Record<string, string> = {
  createSurface: "createSurface ",
  updateDataModel: "updateDataModel",
  updateComponents: "updateComponents",
  deleteSurface: "deleteSurface ",
};

/** The message-type key (everything except the protocol `version`). */
export function a2uiKind(msg: A2UIServerMessage): string {
  return Object.keys(msg).find((k) => k !== "version") ?? "?";
}

export function formatMessage(msg: A2UIServerMessage): string {
  const kind = a2uiKind(msg);
  const body = (msg as Record<string, unknown>)[kind] as Record<string, unknown>;
  const label = KIND_LABEL[kind] ?? kind;

  if (kind === "createSurface") {
    const componentCount = Array.isArray(body.components) ? body.components.length : 0;
    return `  ${label}  surface=${body.surfaceId} catalog=${body.catalogId} components=${componentCount}\n              dataModel=${JSON.stringify(body.dataModel)}`;
  }
  if (kind === "updateDataModel") {
    // The heart of the adapter: an absolute value at one JSON Pointer.
    return `  ${label}  ${String(body.path)} = ${JSON.stringify(body.contents)}`;
  }
  if (kind === "deleteSurface") {
    return `  ${label}  surface=${body.surfaceId}`;
  }
  return `  ${label}  ${JSON.stringify(body)}`;
}
