/**
 * Where keyboard focus goes when the Terms window (components/TermsGate.tsx) closes and nothing else
 * holds it: the window opened by itself on arrival, so there is no button to go back to, or what
 * opened it has gone. Without this, keyboard and screen-reader users would land on the page itself
 * and have to find their place again.
 *
 * In order: the line that replaced the ways in (after "Cancel"), else the heading of the way in now
 * showing (after accepting) in the app, the payment page or the extension. A heading taken this way
 * can hold focus but isn't added to the Tab order, and shows no focus ring (it isn't a control).
 *
 * Plain DOM only (no React), so the node tests can run it against a stand-in document.
 */
export const TERMS_FOCUS_AFTER = ["[data-terms-landing]", ".gate h2", ".gate h3", "main h1", "main h2"] as const;

/** The parts of an element used here. */
export type FocusTarget = Pick<HTMLElement, "getClientRects" | "closest" | "hasAttribute" | "setAttribute" | "focus">;
/** The parts of the document used here. */
export type FocusDoc = { activeElement: unknown; body: unknown; querySelectorAll(sel: string): ArrayLike<FocusTarget> };

/** Moves focus to the first visible match of TERMS_FOCUS_AFTER, unless something already holds it. Returns what took it. */
export function focusAfterTerms(doc: FocusDoc = document as unknown as FocusDoc): FocusTarget | null {
  const now = doc.activeElement as { isConnected?: boolean } | null;
  if (now && now !== doc.body && now.isConnected !== false) return null;
  for (const sel of TERMS_FOCUS_AFTER) {
    const el = Array.from(doc.querySelectorAll(sel)).find((e) => e.getClientRects().length > 0 && !e.closest("[inert]"));
    if (!el) continue;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.setAttribute("data-focus-landing", "");
    el.focus({ preventScroll: true });
    return el;
  }
  return null;
}
