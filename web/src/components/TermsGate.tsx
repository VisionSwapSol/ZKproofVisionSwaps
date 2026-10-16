import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { TermsSections } from "./TermsBody";
import { IS_EXTENSION } from "../lib/platform";
import { useCloseRequest } from "../lib/closereq";
import { focusAfterTerms } from "../lib/termsfocus";
import {
  TERMS_ACKS,
  TERMS_CHANGES,
  TERMS_EFFECTIVE,
  TERMS_SETTINGS_CHANGE,
  TERMS_VERSION,
  majorOf,
  terms,
  type TermsAck,
  type TermsStatus,
  type TermsSurface,
} from "../lib/terms";
import { longDate } from "../seo/pages";
import { termsDoc, termsHash, termsText } from "../legal/terms-doc";
import { legalRev } from "../legal/settings";
import { loadLegal, shownLegal, useLegal } from "../legal/useLegal";
import "../styles/legal.css";

/**
 * This device's acceptance of the Terms in force: "current", "needed" (never accepted here) or "updated".
 * It also asks /api/legal once, so a change to the operator's legal settings (who the Terms are with,
 * the law, the courts, arbitration) asks for the Terms again here too.
 */
export function useTermsStatus(): TermsStatus {
  useEffect(() => {
    void loadLegal();
  }, []);
  return useSyncExternalStore(terms.subscribe, () => terms.status(), () => "needed");
}

/** Where this copy of VisionSwap runs: the extension, the Android app (the website, installed full screen) or the website. */
export function termsSurface(): TermsSurface {
  if (IS_EXTENSION) return "extension";
  try {
    if (/Android/i.test(navigator.userAgent) && matchMedia("(display-mode: standalone)").matches) return "android";
  } catch {
    /* no matchMedia */
  }
  return "web";
}

/** Saves the Terms in force as a text file. */
export function saveTermsCopy(text: string, version = TERMS_VERSION) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = `VisionSwap-Terms-of-Use-v${version}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * The Terms window (click-wrap). Shown before any way into an account: connecting a wallet, a wallet's
 * signature, a private key, a passkey, a saved sign-in, the extension and the Android app; and before a
 * wallet connects to pay a payment link. The person ticks three boxes, each a separate statement, and
 * selects "Agree and continue"; the button does nothing until every box is ticked. "Cancel" (or Esc, or
 * Back on Android) closes it without accepting. What is kept, on this device only, is in lib/terms.ts.
 */
export function TermsGate({ onAccept, onCancel, purpose = "account" }: { onAccept: () => void; onCancel: () => void; purpose?: "account" | "pay" }) {
  const status = useTermsStatus();
  const info = useLegal();
  const settings = shownLegal(info).legal;
  const doc = useMemo(() => termsDoc(settings), [settings]);
  const [ticked, setTicked] = useState<Record<TermsAck, boolean>>({ terms: false, eligible: false, risks: false });
  const [full, setFull] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const checkRefs = useRef<Record<TermsAck, HTMLInputElement | null>>({ terms: null, eligible: null, risks: null });
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const id = useId();
  const all = TERMS_ACKS.every((a) => ticked[a]);
  const updated = status === "updated";
  // asked again for the same major version: what changed is the operator's legal settings, not the text's version
  const settingsOnly = updated && majorOf(terms.read()?.v ?? "") === majorOf(TERMS_VERSION);
  const changes = settingsOnly ? [TERMS_SETTINGS_CHANGE] : TERMS_CHANGES;
  const arb = !!settings.arbitration;

  // Back (in the Android app) and Esc mean Cancel
  useCloseRequest(true, () => cancel.current());

  // the page behind is out of reach while the window is open; focus starts on the title and goes back where it was
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    const bodyOverflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    titleRef.current?.focus({ preventScroll: true });
    return () => {
      if (root) root.inert = wasInert;
      document.body.style.overflow = bodyOverflow;
      if (opener && opener !== document.body && opener.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
      // nothing to go back to (the window opened by itself on arrival, or what opened it is gone): once the page has
      // settled, focus goes to what took the window's place, so keyboard and screen-reader users never land on nothing
      requestAnimationFrame(() => focusAfterTerms());
    };
  }, []);

  // Tab stays inside the window; Esc cancels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel.current();
        return;
      }
      if (e.key !== "Tab") return;
      const box = boxRef.current;
      if (!box) return;
      const items = Array.from(box.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]:not([tabindex="-1"])')).filter(
        (el) => !el.hasAttribute("disabled") && el.getClientRects().length > 0,
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first || document.activeElement === titleRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const tick = (a: TermsAck, on: boolean) => {
    setTicked((t) => ({ ...t, [a]: on }));
    setErr(null);
  };

  const agree = () => {
    const missing = TERMS_ACKS.find((a) => !ticked[a]);
    if (missing) {
      setErr("Tick all three boxes to continue.");
      checkRefs.current[missing]?.focus();
      return;
    }
    if (!info) {
      setErr("The Terms are still loading. Try again in a moment.");
      return;
    }
    try {
      terms.accept({ hash: termsHash(doc), rev: info.ok ? legalRev(info.legal) : "", acks: TERMS_ACKS, surface: termsSurface() });
    } catch (e) {
      setErr((e as Error).message);
      return;
    }
    onAccept();
  };

  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );

  return createPortal(
    <div className="tg-back">
      <div
        ref={boxRef}
        className="tg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-intro`}
      >
        <div className="tg-scroll">
          <header className="tg-head">
            <span className="tg-ico" aria-hidden="true">
              <Icon name="doc" size={24} />
            </span>
            <p className="tg-eyebrow">
              Terms of use · Version {TERMS_VERSION} · Effective {longDate(TERMS_EFFECTIVE)}
            </p>
            <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1}>
              {updated ? "We've updated our Terms" : "Before you start"}
            </h2>
            <p id={`${id}-intro`} className="tg-intro">
              {purpose === "pay"
                ? "Paying from a connected wallet uses VisionSwap's website, so its Terms of use apply. Please read these points, then accept the Terms to continue."
                : "VisionSwap is self-custody software for private payments and trading on Solana. Please read these points, then accept the Terms of use to continue."}
            </p>
          </header>

          {updated && (
            <section className="tg-changes" aria-label="What's changed">
              <p className="tg-label">What's changed</p>
              <ul>
                {changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </section>
          )}

          <ul className="tg-points">
            <li>
              <Icon name="key" size={20} />
              <span>
                <strong>You hold your keys.</strong> Your account's keys are made on your device from your wallet's signature, a passkey
                or a VisionSwap private key. We never receive your spending or viewing keys, and nobody can recover them for you. If you
                place an order, our order service holds that order's key and can trade the amount you set aside for it.
              </span>
            </li>
            <li>
              <Icon name="undo" size={20} />
              <span>
                <strong>Payments are final.</strong> Once a transaction is on Solana, nobody, including us, can reverse it.
              </span>
            </li>
            <li>
              <Icon name="proof" size={20} />
              <span>
                <strong>New, unaudited and upgradeable.</strong> The program has not been independently audited, and the VisionSwap team
                can upgrade it and change its settings. You could lose some or all of what you deposit.
              </span>
            </li>
            <li>
              <Icon name="eyeOff" size={20} />
              <span>
                <strong>Privacy has limits.</strong> Amounts, timing and address reuse can still link activity on-chain.
              </span>
            </li>
            <li>
              <Icon name="shield" size={20} />
              <span>
                <strong>Deposits are screened.</strong> They wait in a public waiting room and can be refused, held or sent back to the
                address they came from.
              </span>
            </li>
            <li>
              <Icon name="flag" size={20} />
              <span>
                <strong>Risks, liability and claims.</strong> You take on these risks and release claims that arise from them (section 16).
                Our liability is limited, and claims can only be brought individually and within one year
                {arb ? ", generally by arbitration unless you opt out" : ""} (sections 17 and 21). Some rights can't be limited (section
                18).
              </span>
            </li>
          </ul>
          <p className="tg-note">This is a summary. The Terms of use are the agreement.</p>

          <div className="tg-links">
            <button type="button" className="tg-link" aria-expanded={full} aria-controls={`${id}-full`} onClick={() => setFull((v) => !v)}>
              {full ? "Hide the full Terms" : "Read the full Terms here"}
            </button>
            <a className="tg-link" href="/terms" target="_blank" rel="noreferrer noopener">
              Open the Terms in a new tab<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a className="tg-link" href="/privacy" target="_blank" rel="noreferrer noopener">
              Privacy policy<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <button type="button" className="tg-link" onClick={() => saveTermsCopy(termsText(doc))}>
              Save a copy
            </button>
          </div>
          {full && (
            <div id={`${id}-full`} className="tg-full prose terms" role="region" aria-label="Full Terms of use" tabIndex={0}>
              <p className="tg-full-notice">{doc.notice}</p>
              <TermsSections doc={doc} inWindow />
            </div>
          )}

          <fieldset className="tg-checks">
            <legend className="tg-label">To continue, confirm each statement</legend>
            <label className="tg-check">
              <input
                ref={(el) => {
                  checkRefs.current.terms = el;
                }}
                type="checkbox"
                name="terms-terms"
                checked={ticked.terms}
                onChange={(e) => tick("terms", e.target.checked)}
              />
              <span>
                I agree to the {link("/terms", "Terms of use")}, and I've seen how my data is handled in the {link("/privacy", "Privacy policy")}.
              </span>
            </label>
            <label className="tg-check">
              <input
                ref={(el) => {
                  checkRefs.current.eligible = el;
                }}
                type="checkbox"
                name="terms-eligible"
                checked={ticked.eligible}
                onChange={(e) => tick("eligible", e.target.checked)}
              />
              <span>
                I'm 18 or older (or the age of majority where I live, if higher). I'm not a sanctioned person or acting for one, and I'm not
                in, and don't live in, a place where VisionSwap isn't offered (Terms, section 2).
              </span>
            </label>
            <label className="tg-check">
              <input
                ref={(el) => {
                  checkRefs.current.risks = el;
                }}
                type="checkbox"
                name="terms-risks"
                checked={ticked.risks}
                onChange={(e) => tick("risks", e.target.checked)}
              />
              <span>
                I know that I alone control my keys and backups and nobody can recover them, that transactions can't be reversed, and that the
                program, its proofs or the app can fail, so I could lose some or all of what I deposit (Terms, section 10).
              </span>
            </label>
          </fieldset>
        </div>

        <footer className="tg-foot">
          <p className="tg-assent">
            By selecting <strong>Agree and continue</strong>, you accept the Terms of use (version {TERMS_VERSION}, effective{" "}
            {longDate(TERMS_EFFECTIVE)}).
          </p>
          <p className="tg-err" role="alert" aria-live="assertive">
            {err}
          </p>
          <div className="tg-btns">
            <button type="button" className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className={`btn violet${all ? "" : " tg-off"}`}
              aria-disabled={!all}
              aria-describedby={all ? undefined : `${id}-hint`}
              onClick={agree}
            >
              Agree and continue
            </button>
          </div>
          {!all && (
            <p id={`${id}-hint`} className="sr-only">
              Tick all three boxes first.
            </p>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * What shows in place of the ways in while the Terms aren't accepted on this device (after "Cancel",
 * or behind the window): a calm line and one way back to the window, never a loop of pop-ups.
 */
export function TermsWall({ onReview, updated }: { onReview: () => void; updated: boolean }) {
  return (
    <div className="tg-wall">
      <span className="tg-ico" aria-hidden="true">
        <Icon name="doc" size={24} />
      </span>
      {/* takes the focus when the window closes without accepting (focusAfterTerms) */}
      <h2 tabIndex={-1} data-terms-landing="">
        {updated ? "Our Terms of use have changed" : "Accept the Terms to open VisionSwap"}
      </h2>
      <p className="muted">
        {updated
          ? `Please review version ${TERMS_VERSION} of the Terms of use and accept it to open your account on this device. Until then, what you hold stays where it is.`
          : IS_EXTENSION
            ? "Before you open a private account in this extension, please review and accept the Terms of use. You do this once here, and again if the Terms change materially."
            : "Before you connect a wallet or open a private account, please review and accept the Terms of use. You do this once on each device, and again if the Terms change materially."}
      </p>
      <button type="button" className="btn violet" onClick={onReview}>
        Review the Terms
      </button>
    </div>
  );
}
