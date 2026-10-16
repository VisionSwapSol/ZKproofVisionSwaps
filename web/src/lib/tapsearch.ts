import { useEffect } from "react";

/**
 * Chrome on Android has "Touch to Search": a tap on plain text opens Google's "Tap to see search
 * results" panel, which sends the tapped words and the text around them to Google. On the app's
 * pages that text can be balances, addresses and payment messages.
 *
 * Chrome only offers a tap to Touch to Search when the page left the tap unhandled: Google's guide
 * for sites lists a click handler that calls preventDefault() as one way to keep it off
 * (https://developer.chrome.com/blog/tap-to-search), and Blink's GestureManager::HandleGestureTap
 * only calls ShowUnhandledTapUIIfNeeded when the tap's mouse and click events went unhandled.
 * So a finger tap on plain text is marked handled here, after every other listener has run.
 *
 * What stays exactly as it was: taps on links, buttons, form fields, labels and summaries (their
 * own action must happen, and Chrome never searches from them anyway), mouse and keyboard clicks,
 * every browser but Chrome on Android, and selecting text: a long press still selects, so addresses
 * and keys can still be copied by hand next to their Copy buttons. A long-press selection can still
 * show Chrome's panel; that is the visitor's own Chrome setting (the Docs say how to turn it off).
 */
export const NATIVE_ACTION =
  'a[href], area[href], button, input, select, textarea, summary, option, audio[controls], video[controls], [contenteditable]:not([contenteditable="false"])';

type TapLike = {
  defaultPrevented: boolean;
  pointerType?: string;
  target: EventTarget | null;
};

/** Whether this click is a finger tap on plain text, which Chrome would hand to Touch to Search. */
export function claimsTap(e: TapLike): boolean {
  if (e.defaultPrevented || e.pointerType !== "touch") return false;
  const t = e.target as { closest?: (s: string) => unknown } | null;
  if (!t || typeof t.closest !== "function") return false;
  if (t.closest(NATIVE_ACTION)) return false;
  // a label's tap checks its box or focuses its field
  const label = t.closest("label") as { control?: unknown } | null;
  return !label?.control;
}

/** Chrome on Android (and the Android app, which is Chrome): the only place Touch to Search exists. */
export const hasTouchToSearch = (ua: string | null | undefined) => !!ua && /Android/i.test(ua);

/** Keeps Chrome's Touch to Search from opening on taps on this page's plain text (see above). */
export function useNoTouchToSearch() {
  useEffect(() => {
    if (!hasTouchToSearch(globalThis.navigator?.userAgent)) return;
    const onClick = (e: MouseEvent) => {
      if (claimsTap({ defaultPrevented: e.defaultPrevented, pointerType: (e as PointerEvent).pointerType, target: e.target })) e.preventDefault();
    };
    // on window, bubbling: it runs after the page's own handlers (React's, the router's), which never see it
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, []);
}
