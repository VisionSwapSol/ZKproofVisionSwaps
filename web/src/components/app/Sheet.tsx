import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useCloseRequest } from "../../lib/closereq";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Keeps Tab and Shift+Tab inside a pop-up while it is open: from its last control back to its first, and
 * from anywhere outside it (focus left on the page after a click on blank space, say) back into it. A
 * window of its own opened over it (the Terms, the busy cover) keeps its own keys.
 */
export function useFocusTrap(box: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const tab = (e: KeyboardEvent) => {
      const el = box.current;
      if (e.key !== "Tab" || e.defaultPrevented || !el) return;
      const at = document.activeElement as HTMLElement | null;
      const inside = !!at && el.contains(at);
      if (!inside && at && at !== document.body && at.closest("[aria-modal='true'], .tg-back, .busy")) return;
      const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.getClientRects().length);
      if (!all.length) return;
      const k = inside ? all.indexOf(at!) : -1;
      // (from the title, which takes focus on opening, or from outside: the first control, or the last going back)
      const next = e.shiftKey ? (k <= 0 ? all[all.length - 1] : all[k - 1]) : k === -1 || k === all.length - 1 ? all[0] : all[k + 1];
      e.preventDefault();
      next.focus();
    };
    window.addEventListener("keydown", tab, true);
    return () => window.removeEventListener("keydown", tab, true);
  }, [box]);
}

/**
 * A sheet over the page (a centred window from 600 px wide): one at a time, for a wallet's actions,
 * a token, or what to do with the selected wallets. Focus moves into it and stays there; Esc, the
 * phone's Back button, × or a tap outside closes it (a sub-panel's ‹ steps back first), and focus
 * returns to what opened it.
 *
 * Its body is the only part that scrolls, between the title and the footer (the confirm buttons), which
 * stay put: nothing ever sits under the footer. While there's more below, the footer casts a shadow over
 * the body's edge (`more`), so what reaches the fold reads as "scroll for more".
 */
export function Sheet({
  title,
  onClose,
  children,
  footer,
  onBack,
  className = "",
  icon,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** a back chevron before the title: the sheet shows a sub-panel */
  onBack?: () => void;
  className?: string;
  /** shown before the title (a token's icon, say) */
  icon?: React.ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  // whether the body holds more below what shows: on scrolling, on a resize, and after every render (its content changes)
  const look = useRef(() => {});
  look.current = () => {
    const b = body.current;
    if (b) setMore(b.scrollTop + b.clientHeight < b.scrollHeight - 2);
  };
  useLayoutEffect(() => look.current());
  useEffect(() => {
    const b = body.current;
    if (!b) return;
    const on = () => look.current();
    b.addEventListener("scroll", on, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(on);
    ro?.observe(b);
    return () => {
      b.removeEventListener("scroll", on);
      ro?.disconnect();
    };
  }, []);
  // the page re-renders often (balances, prices): the latest handlers, set up once
  const close = useRef(onClose);
  close.current = onClose;
  const back = useRef(onBack);
  back.current = onBack;
  const leave = () => (back.current ?? close.current)();
  useCloseRequest(true, leave);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    head.current?.focus({ preventScroll: true });
    document.documentElement.classList.add("sheet-open");
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const at = document.activeElement;
      // only for the sheet itself: the Terms window, the busy cover and a confirm asking in place keep their own Esc
      if (at && at !== document.body && !box.current?.contains(at)) return;
      if (at instanceof HTMLElement && at.closest(".confirm")) return;
      e.preventDefault();
      e.stopPropagation();
      (back.current ?? close.current)();
    };
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("keydown", esc, true);
      // (another sheet may open as this one closes: the class stays while any is open)
      if (!document.querySelector(".sheet")) document.documentElement.classList.remove("sheet-open");
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // a sub-panel opening or closing: focus goes to the title again
  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, [!!onBack]);

  useFocusTrap(box);

  return (
    <div className="sheet-back" onClick={() => close.current()}>
      <div
        ref={box}
        className={`sheet${footer && more ? " more" : ""} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          {onBack && (
            <button type="button" className="sheet-btn" aria-label="Back" onClick={onBack}>
              <span aria-hidden="true">‹</span>
            </button>
          )}
          {icon && <span className="sheet-icon">{icon}</span>}
          <h2 id={id} ref={head} tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="sheet-btn" aria-label="Close" onClick={() => close.current()}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div ref={body} className="sheet-body">
          {children}
        </div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
