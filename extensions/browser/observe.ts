import type { BrowserTab, ObservedElement } from "./types.js";

const REF_ATTRIBUTE = "data-pi-browser-ref";
const INTERACTIVE_SELECTOR = "a[href], button, input, textarea, select, summary, [role], [contenteditable='true'], [tabindex]:not([tabindex='-1'])";

export async function observe(tab: BrowserTab, includeAll = false): Promise<ObservedElement[]> {
  const elements = await tab.page.locator(includeAll ? "body *" : INTERACTIVE_SELECTOR).evaluateAll((nodes, attribute) => {
    document.querySelectorAll(`[${attribute}]`).forEach((node) => node.removeAttribute(attribute));
    const observed: ObservedElement[] = [];
    for (const [index, node] of nodes.slice(0, 200).entries()) {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none") continue;
      const ref = `e${index + 1}`;
      element.setAttribute(attribute, ref);
      observed.push({
        ref,
        role: element.getAttribute("role"),
        name: element.getAttribute("aria-label") ?? (element as HTMLInputElement).name ?? "",
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 160),
        disabled: (element as HTMLButtonElement).disabled === true,
      });
    }
    return observed;
  }, REF_ATTRIBUTE);

  tab.refs = new Map(elements.map((element) => [element.ref, `[${REF_ATTRIBUTE}="${element.ref}"]`]));
  return elements;
}

export function selectorFor(tab: BrowserTab, ref?: string, selector?: string): string {
  if (selector) return selector;
  if (!ref) throw new Error("Provide selector or a ref from browser_observe.");
  const resolved = tab.refs.get(ref);
  if (!resolved) throw new Error(`Unknown or stale ref ${JSON.stringify(ref)}. Call browser_observe again.`);
  return resolved;
}

export function selectorForAction(tab: BrowserTab, action: string, ref?: string, selector?: string): string | undefined {
  if ((action === "scroll" || action === "wait" || action === "screenshot") && !ref && !selector) return undefined;
  return selectorFor(tab, ref, selector);
}
