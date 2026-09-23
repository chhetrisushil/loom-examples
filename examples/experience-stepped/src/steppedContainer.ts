import type {
  DomContainerHandle,
  DomContainerProps,
  DomContainerRenderer,
} from "@loom-ui/renderer-lit/dom";

// This app's own container renderer, registered under the role "stepped" on
// `DomRenderOptions.containers` (Blueprint IR 2.2.0 `Layout.role`, loom ADR 0099). The adapter
// keeps everything it owns for a plain container — `body`, the children's mount, keyed
// reconcile, reorder, placement, subscriptions and the focus pin; this renderer owns only its
// chrome (progress dots + Back/Next, mounted into `host` beside `body`) and which of the
// children it is handed are visible. It never adds, removes, reorders or restyles a child of
// `body` — visibility is the only thing it sets on a child element.
//
// Accessibility (design Q3): the step not shown carries `hidden` (out of the accessibility tree
// and tab order) AND `inert` + `aria-hidden="true"` (belt and braces — `hidden` alone already
// does this in every modern engine, but the pair is what the seam's contract calls for and what
// an app animating a step out, instead of hiding it outright, would rely on `inert` for). The
// shown step carries none of the three. Back/Next are real `<button>`s with accessible names;
// the step position is `aria-live="polite"` so a screen reader announces a page without the app
// moving focus itself.
//
// Chrome state — which step is current — lives in this closure and survives exactly as long as
// the container does: a role change or a container remount (its widgets keyed by ordinal, type
// and role) drops it, the same rule as a widget's own user-entered DOM state.

const stepLabel = (props: DomContainerProps, index: number): string =>
  props.children[index]?.node.title || `Step ${index + 1}`;

const hide = (el: HTMLElement): void => {
  el.hidden = true;
  el.setAttribute("inert", "");
  el.setAttribute("aria-hidden", "true");
};
const show = (el: HTMLElement): void => {
  el.hidden = false;
  el.removeAttribute("inert");
  el.removeAttribute("aria-hidden");
};

export function steppedContainer(): DomContainerRenderer {
  const renderer: DomContainerRenderer = (host, initial) => {
    let props = initial;
    let current = 0;

    const nav = document.createElement("nav");
    nav.dataset.chrome = "stepped";
    nav.setAttribute("aria-label", "Onboarding steps");

    const dots = document.createElement("ol");
    dots.dataset.chromePart = "dots";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.textContent = "Back";
    backBtn.dataset.chromeAction = "back";

    const position = document.createElement("span");
    position.dataset.chromePart = "position";
    position.setAttribute("aria-live", "polite");

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.textContent = "Next";
    nextBtn.dataset.chromeAction = "next";

    nav.append(dots, backBtn, position, nextBtn);
    host.insertBefore(nav, props.body);

    const clamp = (): void => {
      const last = props.children.length - 1;
      if (current > last) current = Math.max(0, last);
      if (current < 0) current = 0;
    };

    const render = (): void => {
      clamp();
      const n = props.children.length;
      props.children.forEach((child, i) =>
        i === current ? show(child.element) : hide(child.element)
      );
      dots.replaceChildren(
        ...props.children.map((_, i) => {
          const dot = document.createElement("li");
          dot.textContent = stepLabel(props, i);
          if (i === current) dot.setAttribute("aria-current", "step");
          return dot;
        })
      );
      position.textContent =
        n === 0 ? "" : `Step ${current + 1} of ${n}: ${stepLabel(props, current)}`;
      backBtn.disabled = current === 0;
      nextBtn.disabled = n === 0 || current >= n - 1;
    };

    backBtn.addEventListener("click", () => {
      if (current > 0) {
        current -= 1;
        render();
      }
    });
    nextBtn.addEventListener("click", () => {
      if (current < props.children.length - 1) {
        current += 1;
        render();
      }
    });

    render();

    const handle: DomContainerHandle = {
      update(updated) {
        props = updated;
        render();
      },
      dispose() {
        // Undo everything this chrome set on the children it was handed. The adapter guarantees
        // only that visibility is restored when IT drops the chrome after a throw — a normal
        // dispose (role cleared, container remounted, handle torn down) is this renderer's own
        // job, and doing it unconditionally here is what makes that guarantee unnecessary to
        // lean on.
        for (const child of props.children) show(child.element);
        nav.remove();
      },
    };
    return handle;
  };
  return renderer;
}
