import { Window } from "happy-dom";

/**
 * `start` runs under plain Node, but loom-ui's DOM renderer wants a `document`. Install happy-dom's
 * (the same DOM the tests run in) on `globalThis` BEFORE anything imports the renderer.
 */
export function installDom(): void {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g || key.startsWith("_")) continue;
    try {
      g[key] = (win as unknown as Record<string, unknown>)[key];
    } catch {
      // read-only host property: leave Node's own
    }
  }
  g.window = win;
  g.document = win.document;
  g.customElements = win.customElements;
  g.HTMLElement = win.HTMLElement;
  g.KeyboardEvent = win.KeyboardEvent;
  g.MutationObserver = win.MutationObserver;
}
