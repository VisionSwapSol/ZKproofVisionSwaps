/**
 * Handing off to a wallet app on an Android phone (the Mobile Wallet Adapter) is a page opening another
 * app, which Chrome allows only within 5 seconds of the visitor's tap (its "transient user activation").
 * The adapter opens the wallet a few hundred milliseconds after the tap, unless the page's main thread is
 * busy. Building a WebGL scene (the mascot on the signing overlay) compiles shaders on that thread, and a
 * phone with a slow graphics driver can take longer than the whole 5 seconds: the wallet then never opens
 * and the adapter reports "Found no installed wallet". So on Android that work waits until the hand-off
 * is over: until the page comes back on screen after the wallet, or until the tap can no longer open
 * anything anyway.
 */

/** Longer than Chrome's 5-second window, so nothing that could still open the wallet waits behind the work. */
export const WALLET_HANDOFF_MS = 6000;

/** How long to hold back heavy work started by a tap: only where a tap can hand off to a wallet app (Android). */
export const handoffDefer = (userAgent: string | null | undefined): number => (userAgent && /Android/i.test(userAgent) ? WALLET_HANDOFF_MS : 0);

/** The parts of `document` this needs. */
export type VisibilityDoc = {
  visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
};

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
};

/**
 * Runs `start` once: right away when `ms` is 0; otherwise after `ms`, or as soon as the page comes back
 * on screen after being hidden (the wallet was in front), whichever is first, and never while the page
 * is hidden. Returns a function that cancels it.
 */
export function afterHandoff(start: () => void, ms: number, doc: VisibilityDoc, timers: Timers = globalThis as unknown as Timers): () => void {
  if (ms <= 0) {
    start();
    return () => {};
  }
  let done = false;
  let wasHidden = doc.visibilityState === "hidden";
  let timer: unknown = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (timer != null) timers.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", onChange);
    start();
  };
  function onChange() {
    if (doc.visibilityState === "hidden") wasHidden = true;
    else if (wasHidden || timer == null) finish();
  }
  doc.addEventListener("visibilitychange", onChange);
  timer = timers.setTimeout(() => {
    timer = null;
    if (doc.visibilityState !== "hidden") finish();
    // still hidden: onChange starts it when the page is back on screen
  }, ms);
  return () => {
    done = true;
    if (timer != null) timers.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", onChange);
  };
}
