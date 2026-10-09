import { useEffect, useState, type ReactNode } from "react";
import { XLink } from "./XLink";

export function Header({ variant = "site", right }: { variant?: "site" | "app"; right?: ReactNode }) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className={`hdr ${scrolled ? "scrolled" : ""} ${variant}`}>
      <div className="wrap hdr-in">
        <a href="/" className="brand" aria-label="VisionSwap home" onClick={() => setOpen(false)}>
          <img src="/favicon-64.png" alt="" width={30} height={30} />
          <span>VisionSwap</span>
        </a>
        <nav className={`nav ${open ? "open" : ""}`} aria-label="Main">
          <a href="/#how" onClick={() => setOpen(false)}>
            How it works
          </a>
          <a href="/check" onClick={() => setOpen(false)}>
            Exposure check
          </a>
          <a href="/#fees" onClick={() => setOpen(false)}>
            Fees
          </a>
          <a href="/tokenomics" onClick={() => setOpen(false)}>
            Tokenomics
          </a>
          <a href="/docs" onClick={() => setOpen(false)}>
            Docs
          </a>
          <XLink className="nav-x" onClick={() => setOpen(false)} />
          {variant === "site" && (
            <a href="/app" className="btn nav-cta" onClick={() => setOpen(false)}>
              Open app
            </a>
          )}
        </nav>
        {right && <div className="hdr-right">{right}</div>}
        <button
          className={`burger ${open ? "x" : ""}`}
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <i />
          <i />
        </button>
      </div>
    </header>
  );
}
