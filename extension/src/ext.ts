// The side panel's ties to the browser: opening pages in new tabs, and the account link the
// background worker keeps for it (see link.ts).
import { useEffect, useState } from "react";
import { SITE } from "../../web/src/lib/platform";
import { engine } from "../../web/src/lib/engine";
import { LINK_TTL_MS, PENDING_KEY, freshPending, type Pending } from "./link";

/** This page is the extension opened in a tab ("Open in a tab"), not the side panel. */
export const IN_TAB = new URLSearchParams(location.search).has("tab");

/** Opens a page in a new tab; the panel itself never navigates away. */
export function openUrl(url: string) {
  try {
    void chrome.tabs.create({ url }).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** A page of the website ("/docs", "/app#extension"), in a new tab. */
export const openSite = (path: string) => openUrl(`${SITE}${path}`);

/** Where "Open in a tab" leaves the open account for the new tab, in memory, for a few seconds. */
const HANDOFF_KEY = "tabHandoff";
const HANDOFF_MS = 30_000;

/**
 * The extension itself in a tab: the same page, centred. An account open here opens there too, without
 * asking for the key again: it's handed over through the extension's own memory-only storage, which the
 * new tab reads once and clears.
 */
export async function openInTab() {
  const key = engine.privateKey();
  if (key) {
    await chrome.storage.session.set({ [HANDOFF_KEY]: { key, at: Date.now() } }).catch(() => {});
    // never left behind: gone after a few seconds even if the tab never read it
    setTimeout(() => void chrome.storage.session.remove(HANDOFF_KEY).catch(() => {}), HANDOFF_MS);
  }
  openUrl(chrome.runtime.getURL("sidepanel.html?tab=1"));
}

/** In a tab opened by "Open in a tab": the account handed over, if any (read once, then cleared). */
export async function takeHandoff(): Promise<string | null> {
  try {
    const p = (await chrome.storage.session.get(HANDOFF_KEY))[HANDOFF_KEY];
    if (p === undefined) return null;
    await chrome.storage.session.remove(HANDOFF_KEY);
    return freshPending(p, Date.now()) && Date.now() - p.at < HANDOFF_MS ? p.key : null;
  } catch {
    return null;
  }
}

export async function readPending(): Promise<Pending | null> {
  try {
    const p = (await chrome.storage.session.get(PENDING_KEY))[PENDING_KEY];
    if (freshPending(p, Date.now())) return p;
    if (p !== undefined) await clearPending();
  } catch {
    /* not available */
  }
  return null;
}

export async function clearPending() {
  try {
    await chrome.storage.session.remove(PENDING_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The account link waiting to be opened, followed live (it can arrive while the panel is open), until it expires. */
export function usePendingLink(): [Pending | null, () => void] {
  const [p, setP] = useState<Pending | null>(null);
  useEffect(() => {
    let dead = false;
    const read = () => void readPending().then((v) => !dead && setP(v));
    read();
    const on = (changes: Record<string, chrome.storage.Change>, area: string) => {
      if (area === "session" && PENDING_KEY in changes) read();
    };
    chrome.storage.onChanged.addListener(on);
    return () => {
      dead = true;
      chrome.storage.onChanged.removeListener(on);
    };
  }, []);
  // it goes from the screen by itself once it's too old to open
  useEffect(() => {
    if (!p) return;
    const t = setTimeout(() => {
      setP(null);
      void clearPending();
    }, Math.max(0, p.at + LINK_TTL_MS - Date.now()));
    return () => clearTimeout(t);
  }, [p]);
  const clear = () => {
    setP(null);
    void clearPending();
  };
  return [p, clear];
}
