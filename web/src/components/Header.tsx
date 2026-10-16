import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { XLink } from "./XLink";
import { TOKEN_LAUNCH_ENABLED } from "../lib/token-launch";
import { useCloseRequest } from "../lib/closereq";

export function Header({ variant = "site", right }: { variant?: "site" | "app"; right?: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLElement>(null);
  const wasOpen = useRef(false);
  const closeMenu = () => setOpen(false);

  // Back (in the Android app) or Esc closes the open menu first
  useCloseRequest(open, () => setOpen(false));
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const root = document.getElementById("root");
    const wasInert = root?.inert;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    // The portalled menu is outside root; the page behind it is not interactive.
    if (root) root.inert = true;
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
      if (root) root.inert = wasInert ?? false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const focusables = () => Array.from(
      menu?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [],
    ).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
    const focusFrame = requestAnimationFrame(() => focusables()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (event.key === "Tab") {
        const items = focusables();
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || !menu?.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !menu?.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    const onResize = () => {
      if (window.matchMedia("(min-width: 1025px)").matches) {
        setOpen(false);
        requestAnimationFrame(() => brandRef.current?.focus({ preventScroll: true }));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open && wasOpen.current) {
      const target = triggerRef.current?.getClientRects().length ? triggerRef.current : brandRef.current;
      target?.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [open]);

  const mobileMenu = open
    ? createPortal(
        <div className="mobile-menu-layer">
          <button className="mobile-menu-backdrop" aria-label="Close navigation menu" onClick={closeMenu} tabIndex={-1} />
          <section id="mobile-site-navigation" className="mobile-menu-panel" role="dialog" aria-modal="true" aria-label="Site navigation" ref={menuRef}>
            <button className="mobile-menu-surface-dismiss" type="button" aria-label="Close navigation menu" tabIndex={-1} onClick={closeMenu} />
            <div className="mobile-menu-top">
              <a href="/" className="mobile-menu-brand" onClick={closeMenu}>
                <img src="/favicon-64.png" alt="" width={30} height={30} />
                <span>VisionSwap</span>
              </a>
              <button type="button" className="mobile-menu-close" onClick={closeMenu} aria-label="Close menu">
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <nav className="mobile-menu-links" aria-label="Main">
              <a href="/#how" onClick={closeMenu}><span>01</span>How it works</a>
              <a href="/check" onClick={closeMenu}><span>02</span>Exposure check</a>
              <a href="/#fees" onClick={closeMenu}><span>03</span>Fees</a>
              {TOKEN_LAUNCH_ENABLED && <a href="/tokenomics" onClick={closeMenu}><span>04</span>Tokenomics</a>}
              <a href="/docs" onClick={closeMenu}><span>{TOKEN_LAUNCH_ENABLED ? "05" : "04"}</span>Docs</a>
              <a href="/security" onClick={closeMenu}><span>{TOKEN_LAUNCH_ENABLED ? "06" : "05"}</span>Security</a>
              <a href="/support" onClick={closeMenu}><span>{TOKEN_LAUNCH_ENABLED ? "07" : "06"}</span>Support</a>
              <XLink className="nav-x" onClick={closeMenu} />
              {variant === "site" && <a href="/app" className="btn nav-cta" onClick={closeMenu}>Open app</a>}
            </nav>
          </section>
        </div>,
        document.body,
      )
    : null;

  return (
    <header className={`hdr ${scrolled ? "scrolled" : ""} ${variant}`}>
      <div className="wrap hdr-in">
        <a href="/" className="brand" aria-label="VisionSwap home" ref={brandRef} onClick={() => setOpen(false)}>
          <img src="/favicon-64.png" alt="" width={30} height={30} />
          <span>VisionSwap</span>
        </a>
        <nav className="nav" aria-label="Main">
          <a href="/#how">
            How it works
          </a>
          <a href="/check">
            Exposure check
          </a>
          <a href="/#fees">
            Fees
          </a>
          {TOKEN_LAUNCH_ENABLED && (
            <a href="/tokenomics">
              Tokenomics
            </a>
          )}
          <a href="/docs">
            Docs
          </a>
          <a href="/security">Security</a>
          <a href="/support">Support</a>
          <XLink className="nav-x" />
          {variant === "site" && (
            <a href="/app" className="btn nav-cta">
              Open app
            </a>
          )}
        </nav>
        {right && <div className="hdr-right">{right}</div>}
        <button
          className={`burger ${open ? "x" : ""}`}
          ref={triggerRef}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls={open ? "mobile-site-navigation" : undefined}
          onClick={() => setOpen((v) => !v)}
        >
          <i />
          <i />
        </button>
      </div>
      {mobileMenu}
    </header>
  );
}
