import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Inline, TermsSections } from "../components/TermsBody";
import { saveTermsCopy } from "../components/TermsGate";
import { TERMS_EFFECTIVE, TERMS_VERSION, terms, type TermsRecord } from "../lib/terms";
import { termsDoc, termsHash, termsText } from "../legal/terms-doc";
import { TERMS_ARCHIVE } from "../legal/archive";
import { shownLegal, useLegal } from "../legal/useLegal";
import { PAGES, longDate } from "../seo/pages";
import "../styles/legal.css";

/** This device's record of accepting the Terms (read in the browser only; the page as built says nothing about anyone). */
function useRecord(): TermsRecord | null {
  const raw = useSyncExternalStore(
    terms.subscribe,
    () => JSON.stringify(terms.read()),
    () => "null",
  );
  return useMemo(() => JSON.parse(raw) as TermsRecord | null, [raw]);
}

/**
 * The Terms of use. The text itself lives in legal/terms-doc.ts, the one source for this page, the
 * Terms window people accept in the app, and the published archive (web/public/legal).
 */
export default function TermsPage() {
  const info = useLegal();
  // until /api/legal answers (and in the page as built): the default settings, which the archived text has too
  const settings = shownLegal(info).legal;
  const doc = useMemo(() => termsDoc(settings), [settings]);
  const hash = useMemo(() => termsHash(doc), [doc]);
  // a legal setting other than the defaults (who we are, the law, the courts, arbitration, another contact) makes it differ from the archived copy
  const configured = hash !== TERMS_ARCHIVE.find((v) => v.version === TERMS_VERSION)?.sha256;
  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap prose terms">
        <h1>Terms of use</h1>
        <p className="muted">
          Version {TERMS_VERSION}, in effect from {longDate(TERMS_EFFECTIVE)}. Last updated {longDate(PAGES.terms.updated)}.
        </p>
        <p className="legal-meta">
          <span>Fingerprint (SHA-256 of the text):</span> <code>{hash}</code>
        </p>
        <div className="legal-tools">
          <button type="button" className="btn ghost small-btn" onClick={() => saveTermsCopy(termsText(doc))}>
            Save a copy
          </button>
          <button type="button" className="btn ghost small-btn" onClick={() => window.print()}>
            Print
          </button>
          <a className="btn ghost small-btn" href="#versions">
            All versions
          </a>
        </div>

        <p className="legal-notice">
          <Inline text={doc.notice} />
        </p>

        <div className="keypoints">
          <p>The main points</p>
          <ul>
            {doc.summary.map((s) => (
              <li key={s}>
                <Inline text={s} />
              </li>
            ))}
          </ul>
          <p className="tiny">This box is a summary. The numbered sections below are the agreement.</p>
        </div>

        <TermsSections doc={doc} />

        <h2 id="versions">Versions of these Terms</h2>
        <p>
          Every version of these Terms as published, with the fingerprint of its text. The record your device keeps when you accept holds
          the fingerprint of the text you were shown, so you can match it to a version here.
          {configured &&
            " The published text of the current version has the operator's details in sections 1, 21 and 24 as they are by default; with the details in force today, its fingerprint is the one at the top of this page."}
        </p>
        <ul className="legal-versions">
          {[...TERMS_ARCHIVE].reverse().map((v) => (
            <li key={v.version}>
              <strong>Version {v.version}</strong>
              {v.version === TERMS_VERSION ? ", in force" : `, ${v.note}`} ({longDate(v.date)}):{" "}
              <a href={v.file} target="_blank" rel="noreferrer noopener">
                full text
              </a>
              , SHA-256 <code>{v.sha256}</code>
            </li>
          ))}
        </ul>

        <Receipt />
      </main>
      <Footer />
    </div>
  );
}

/** "Your acceptance on this device": what this browser keeps, and a way to save or remove it. */
function Receipt() {
  const rec = useRecord();
  const [removed, setRemoved] = useState(false);
  // "Remove it" takes its button away: the line saying what happened takes the focus, so keyboard and
  // screen-reader users hear the result instead of landing on nothing
  const result = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (removed && !rec) result.current?.focus();
  }, [removed, rec]);
  const download = () => {
    if (!rec) return;
    const body = JSON.stringify({ kind: "visionswap-terms-acceptance", ...rec, terms: TERMS_ARCHIVE.find((v) => v.version === rec.v)?.file ?? null }, null, 2);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    a.download = `visionswap-terms-acceptance-${rec.at.slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  return (
    <section className="legal-box no-print" id="your-acceptance" aria-labelledby="your-acceptance-title">
      <h3 id="your-acceptance-title">Your acceptance on this device</h3>
      {rec ? (
        <>
          <p>This browser keeps the record below. It stays on this device: VisionSwap never receives it.</p>
          <dl className="legal-receipt">
            <dt>Version</dt>
            <dd>{rec.v}</dd>
            <dt>Accepted</dt>
            <dd>{new Date(rec.at).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}</dd>
            <dt>Fingerprint</dt>
            <dd>
              <code>{rec.hash}</code>
            </dd>
            <dt>Where</dt>
            <dd>{rec.surface === "extension" ? "The Chrome extension" : rec.surface === "android" ? "The Android app" : "The website"}</dd>
          </dl>
          <div className="legal-tools">
            <button type="button" className="btn ghost small-btn" onClick={download}>
              Download this record
            </button>
            <button
              type="button"
              className="btn ghost small-btn"
              onClick={() => {
                terms.forget();
                setRemoved(true);
              }}
            >
              Remove it
            </button>
          </div>
        </>
      ) : (
        <p ref={result} tabIndex={-1} className="legal-result">
          {removed
            ? "Removed. VisionSwap will ask you to accept the Terms again before an account opens on this device. Your funds aren't affected."
            : "No acceptance is recorded in this browser. VisionSwap asks you to accept the Terms before you connect a wallet or open an account here."}
        </p>
      )}
    </section>
  );
}
