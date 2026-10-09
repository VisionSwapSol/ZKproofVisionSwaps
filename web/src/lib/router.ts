import { useEffect, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());
window.addEventListener("popstate", notify);

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin) {
    location.href = url.href;
    return;
  }
  if (opts.replace) history.replaceState(null, "", url.pathname + url.search + url.hash);
  else history.pushState(null, "", url.pathname + url.search + url.hash);
  notify();
  if (url.hash) {
    // a hash can carry details ("#send&to=…"), which isn't an element id: then there's nothing to scroll to
    requestAnimationFrame(() => {
      try {
        document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ behavior: "smooth" });
      } catch {
        /* not an id */
      }
    });
  } else {
    window.scrollTo({ top: 0 });
  }
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}

/** Intercepts clicks on same-origin <a> links so the app never reloads. */
export function useLinkInterception() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest("a");
      if (!a || a.target || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("mailto:") || href.startsWith("http")) return;
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.hash) return; // in-page anchor
      e.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
