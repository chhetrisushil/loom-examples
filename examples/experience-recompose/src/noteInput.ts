import type { DomWidgetRenderer } from "@loom-ui/renderer-lit/dom";

/**
 * The app's NoteInput: a labelled <textarea>. Two rules from the loom-ui design (§2.2):
 *  • `patch` relabels — it never touches the textarea's value, caret or focus; what the user
 *    typed is DOM state and stays;
 *  • `update` writes the textarea only when the BOUND value changed (Note is unbound here, so
 *    it never does — the branch exists to show where the rule lives).
 */
export const noteInput =
  (opts: { patchable: boolean } = { patchable: true }): DomWidgetRenderer =>
  (host, props) => {
    const label = document.createElement("label");
    const caption = document.createElement("span");
    caption.textContent = String(props.widget.props.label ?? props.widget.title ?? "Note");
    const ta = document.createElement("textarea");
    ta.dataset.note = props.widget.id;
    ta.rows = 3;
    label.append(caption, ta);
    host.appendChild(label);
    let bound: unknown = props.value;
    if (typeof bound === "string") ta.value = bound;
    return {
      update: (value) => {
        if (value === bound) return; // nothing the app knows about changed — the user's text stays
        bound = value;
        if (typeof value === "string") ta.value = value;
      },
      ...(opts.patchable && {
        patch: (widget) => {
          caption.textContent = String(widget.props.label ?? widget.title ?? "Note");
        },
      }),
      dispose: () => label.remove(),
    };
  };

/** An unbound alert line — the node the revision adds above the note. */
export const alert: DomWidgetRenderer = (host, props) => {
  const el = document.createElement("p");
  el.dataset.tone = String(props.widget.props.tone ?? "info");
  el.textContent = props.widget.title ?? "Alert";
  host.appendChild(el);
  return {
    update: () => {},
    patch: (w) => {
      el.dataset.tone = String(w.props.tone ?? "info");
      el.textContent = w.title ?? "Alert";
    },
    dispose: () => el.remove(),
  };
};
