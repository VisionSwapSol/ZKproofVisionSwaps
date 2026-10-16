import { useEffect, useRef } from "react";

/** The browser's CloseWatcher (Chrome 126+): the Android Back button and Esc ask it to close. */
type Watcher = { onclose: ((e: Event) => void) | null; destroy(): void };
type WatcherCtor = new () => Watcher;

/**
 * While `open`, the phone's Back button (and Esc) closes this menu, panel or sub-screen instead of
 * leaving the page: in the Android app, Back steps out of what's open first, then closes the app.
 * Uses the browser's CloseWatcher, so no history entries are added; where there is none, nothing changes.
 */
export function useCloseRequest(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const Ctor = (globalThis as { CloseWatcher?: WatcherCtor }).CloseWatcher;
    if (!open || typeof Ctor !== "function") return;
    let w: Watcher;
    try {
      w = new Ctor();
    } catch {
      return;
    }
    w.onclose = () => latest.current();
    return () => w.destroy();
  }, [open]);
}
