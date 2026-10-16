import { useEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
let cancelAnchorScroll: (() => void) | undefined;

/** Wait for lazy pages to mount before finding a section linked from another page. */
function scrollToHash(hash: string) {
  cancelAnchorScroll?.();
  if (!hash) return;
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return;
  }
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let observer: MutationObserver | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const cleanup = () => {
    observer?.disconnect();
    if (timeout !== undefined) clearTimeout(timeout);
    cancelAnimationFrame(frame);
    cancelAnchorScroll = undefined;
  };
  cancelAnchorScroll = cleanup;
  const find = () => {
    const target = document.getElementById(id);
    if (!target || target.getClientRects().length === 0) return false;
    // Allow the mobile menu to close and its scroll lock to clear first.
    frame = requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: reduceMotion ? "instant" : "smooth", block: "start" });
      cleanup();
    });
    observer?.disconnect();
    return true;
  };
  // Wait for React to switch pages: the old page can have an identically named section.
  frame = requestAnimationFrame(() => {
    if (!find()) {
      observer = new MutationObserver(find);
      observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });
      timeout = setTimeout(cleanup, 5000);
    }
  });
}

// (the build-time prerender runs this module without a window)
if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    notify();
    cancelAnchorScroll?.();
    if (location.hash) scrollToHash(location.hash);
  });

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin) {
    location.href = url.href;
    return;
  }
  const before = location.href;
  const old = new URL(before);
  if (opts.replace) history.replaceState(null, "", url.pathname + url.search + url.hash);
  else history.pushState(null, "", url.pathname + url.search + url.hash);
  cancelAnchorScroll?.();
  notify();
  // a link to another part of this same page ("#wallets" in a message) changes only the hash: pushState fires no
  // hashchange, so it's fired here, as the browser would have (the app page switches tabs on it)
  if (old.pathname === url.pathname && old.search === url.search && old.hash !== url.hash) {
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: before, newURL: location.href }));
  }
  if (url.hash) {
    scrollToHash(url.hash);
  } else {
    window.scrollTo({ top: 0 });
  }
}

/** The address the build-time prerender is writing a page for (never set in a browser). */
let serverPath: string | undefined;
export function setServerPath(path: string) {
  serverPath = path;
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
    // the prerender's address; in a browser taking over a prerendered page, the address it shows
    () => serverPath ?? location.pathname,
  );
}

/** Intercepts clicks on same-origin <a> links so the app never reloads. */
export function useLinkInterception() {
  useEffect(() => {
    if (location.hash) scrollToHash(location.hash);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest("a");
      if (!a || a.target || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("mailto:") || href.startsWith("http")) return;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return;
      e.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      cancelAnchorScroll?.();
    };
  }, []);
}
