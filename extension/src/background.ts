// The extension's background worker. It does two small things: the toolbar icon opens the side
// panel, and it takes the account link sent by visionswap.net (see link.ts). Nothing here ever
// writes the key anywhere but chrome.storage.session, and nothing here logs anything.
import { DEV_ORIGINS, PENDING_KEY, SITE_ORIGIN, linkKey } from "./link";

const ORIGINS = import.meta.env.VITE_EXT_DEV === "1" ? [SITE_ORIGIN, ...DEV_ORIGINS] : [SITE_ORIGIN];

// a click on the toolbar icon opens the side panel (kept by Chrome; set again on every start, which is harmless)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  const key = linkKey(message, sender.origin, ORIGINS);
  if (!key) {
    reply({ ok: false });
    return;
  }
  // the panel opens straight away, while the click that sent this still counts as the person's own
  // action (Chrome opens a side panel only for one); if it can't, the website says to click the icon
  const windowId = sender.tab?.windowId;
  const opened = windowId != null ? chrome.sidePanel.open({ windowId }).then(() => true, () => false) : Promise.resolve(false);
  // memory only (gone when the browser closes), readable by the extension's own pages only; the panel
  // offers it for two minutes and removes it once it's opened or turned down
  const saved = chrome.storage.session.set({ [PENDING_KEY]: { key, at: Date.now() } }).then(() => true, () => false);
  void Promise.all([saved, opened]).then(([ok, panel]) => reply(ok ? { ok: true, panel } : { ok: false }));
  return true;
});
