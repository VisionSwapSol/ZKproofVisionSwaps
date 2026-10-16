import { useEffect, useState } from "react";
import { useEngine } from "../../web/src/lib/wallet";
import { engine, type State } from "../../web/src/lib/engine";
import { SITE } from "../../web/src/lib/platform";
import { warmUp } from "../../web/src/lib/zk";
import { KeyRestore, NewAccount } from "../../web/src/components/app/KeyAccount";
import { IN_TAB, openSite, openUrl, takeHandoff, usePendingLink } from "./ext";
import type { Pending } from "./link";
import { Glyph } from "./Glyph";
import { Unlocked } from "./Unlocked";
import { LinkPrompt } from "./LinkPrompt";
import { BusyCard, NetBadge, type Screen } from "./parts";
import { TermsGate, TermsWall, useTermsStatus } from "../../web/src/components/TermsGate";
import { TERMS_VERSION, hasCurrentAcceptance, terms } from "../../web/src/lib/terms";
import { Restricted, useRegion } from "../../web/src/components/Restricted";

/** "#shield" and the other tab links inside the app's forms, as the panel's own screens. */
const HASH_SCREENS: Record<string, Screen> = { shield: "receive", send: "send", buy: "swap", sell: "swap", wallets: "wallets" };

/**
 * One click handler for every link in the panel: a tab link ("#shield") opens that screen, a page
 * of the website ("/docs") and any other web address open in a new tab. Nothing navigates the
 * panel itself away.
 */
function useLinks(go: (s: Screen, hash: string) => void) {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || a.hasAttribute("download")) return;
      const href = a.getAttribute("href");
      if (!href || href.startsWith("blob:") || href.startsWith("mailto:")) return;
      e.preventDefault();
      if (href.startsWith("#")) {
        const s = HASH_SCREENS[href.slice(1)];
        if (s) go(s, href.slice(1));
        return;
      }
      let url: URL;
      try {
        url = new URL(href, `${SITE}/`);
      } catch {
        return;
      }
      if (url.protocol === "https:" || url.protocol === "http:") openUrl(url.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [go]);
}

export function Panel() {
  const st = useEngine();
  const [link, clearLink] = usePendingLink();
  const [screen, setScreen] = useState<Screen>("home");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [go] = useState(() => (s: Screen, hash: string) => {
    setScreen(s);
    if (hash === "buy" || hash === "sell") setSide(hash);
    window.scrollTo({ top: 0 });
  });
  useLinks(go);
  useEffect(() => {
    document.title = "VisionSwap";
    void engine.loadPool();
    // a key kept in plain text by an older version gets sealed straight away (the website does the same)
    void engine.protectSavedKey();
    // "Open in a tab" from the side panel: the account open there opens here too ("saved" leaves any kept sign-in as it is),
    // once the Terms in force are accepted in the extension (the side panel and its tab share that record)
    if (IN_TAB)
      void takeHandoff().then((key) => {
        if (!key) return;
        const go = () => {
          if (!engine.get().unlocked) engine.openWithKey(key, false, "saved").catch(() => {});
        };
        if (hasCurrentAcceptance()) return go();
        const off = terms.subscribe(() => {
          if (!hasCurrentAcceptance()) return;
          off();
          go();
        });
      });
  }, []);
  useEffect(() => {
    if (st.unlocked) void warmUp();
    else setScreen("home");
  }, [st.unlocked]);
  // leaving mid-action could leave it half done: in a tab, the browser asks first (as on the website)
  const busy = (!!st.busy && !st.busy.bg && st.busy.kind !== "sync" && st.busy.kind !== "unlock") || st.spots.length > 0;
  useEffect(() => {
    if (!busy) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [busy]);
  // not offered where this connection comes from (the server says so, or refused a request with 451): that screen comes
  // before everything else, the Terms window included
  const regionInfo = useRegion();
  return (
    <div className={`ext${IN_TAB ? " in-tab" : ""}`}>
      {regionInfo.restricted ? (
        <main className="ext-locked">
          <div className="ext-brand">
            <img src="/icons/icon-128.png" alt="" width={44} height={44} />
            <span>VisionSwap</span>
          </div>
          <Restricted info={regionInfo} heading="h1" />
        </main>
      ) : st.unlocked && st.pool ? (
        <Unlocked st={st} screen={screen} setScreen={setScreen} side={side} setSide={setSide} link={link} clearLink={clearLink} />
      ) : (
        <Locked st={st} link={link} clearLink={clearLink} />
      )}
    </div>
  );
}

/**
 * The first screen: the ways into a private account. Any account (one opened with a wallet, a
 * passkey or a key) can come from visionswap.net with one click; a key opens one here; or a new
 * one is made here. An account kept on this device ("Keep me signed in") unlocks first.
 */
function Locked({ st, link, clearLink }: { st: State; link: Pending | null; clearLink: () => void }) {
  const [way, setWay] = useState<"choose" | "import" | "create">("choose");
  const [err, setErr] = useState<string | null>(null);
  const saved = engine.hasSavedKey();
  const back = () => setWay("choose");
  // the Terms window comes before every way into an account here too: unlock, import, create and a linked account
  const termsStatus = useTermsStatus();
  const [termsOpen, setTermsOpen] = useState(true);
  if (termsStatus !== "current") {
    return (
      <main className="ext-locked">
        <div className="ext-brand">
          <img src="/icons/icon-128.png" alt="" width={44} height={44} />
          <span>VisionSwap</span>
        </div>
        <TermsWall updated={termsStatus === "updated"} onReview={() => setTermsOpen(true)} />
        {link && <p className="small muted ext-terms">An account linked from visionswap.net is waiting: you can open it here once you accept.</p>}
        {termsOpen && <TermsGate onAccept={() => setTermsOpen(false)} onCancel={() => setTermsOpen(false)} />}
      </main>
    );
  }
  return (
    <main className="ext-locked">
      <div className="ext-brand">
        <img src="/icons/icon-128.png" alt="" width={44} height={44} />
        <span>VisionSwap</span>
      </div>
      <NetBadge st={st} />
      {st.error && !st.busy && (
        <div className="banner bad" role="alert">
          <span>{st.error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => engine.clearError()}>
            ×
          </button>
        </div>
      )}
      {st.poolError && !st.pool && (
        <div className="banner bad" role="alert">
          <span>
            <strong>VisionSwap can't be reached right now.</strong>
            {st.poolError && !/reach/i.test(st.poolError) ? ` ${st.poolError}` : ""}
          </span>
          <button type="button" className="btn small-btn" onClick={() => engine.loadPool()}>
            Try again
          </button>
        </div>
      )}
      {st.unlocked && !st.pool && <p className="muted">Loading the pool…</p>}
      {link && <LinkPrompt st={st} link={link} clear={clearLink} />}
      {way === "choose" && (
        <>
          <h1 className="ext-h1">{saved ? "Welcome back" : "Open your private account"}</h1>
          <p className="muted ext-lead">Private sends and private trading on Solana. Your keys stay in this browser.</p>
          {saved && (
            <div className="ext-unlock">
              <p className="small">Your private account is saved on this device.</p>
              <button
                type="button"
                className="btn violet wide"
                disabled={!!st.busy}
                onClick={() => {
                  setErr(null);
                  engine.openSavedKey().catch((e: Error) => setErr(e.message));
                }}
              >
                <Glyph name="lock" size={18} /> Unlock
              </button>
              {err && <p className="warn">{err}</p>}
            </div>
          )}
          {saved && <p className="eyebrow ext-or">Or another account</p>}
          <div className="ways" role="list">
            <button type="button" role="listitem" className="way" onClick={() => openSite("/app#extension")}>
              <span className="way-ico">
                <Glyph name="link" />
              </span>
              <span className="way-txt">
                <strong>Use my VisionSwap account</strong>
                <span>Open it on visionswap.net with your wallet, passkey or key, then link it here with one click.</span>
              </span>
              <span className="way-go" aria-hidden="true">
                <Glyph name="out" size={18} />
              </span>
            </button>
            <button type="button" role="listitem" className="way" onClick={() => setWay("import")}>
              <span className="way-ico">
                <Glyph name="key" />
              </span>
              <span className="way-txt">
                <strong>Import a private key</strong>
                <span>Paste the vsk1… key of an account you made without a wallet.</span>
              </span>
              <span className="way-go" aria-hidden="true">
                →
              </span>
            </button>
            <button type="button" role="listitem" className="way qr" onClick={() => setWay("create")}>
              <span className="way-ico">
                <Glyph name="plus" />
              </span>
              <span className="way-txt">
                <strong>Create a new private account</strong>
                <span>Made in this browser. Add SOL by QR code from any wallet or exchange.</span>
              </span>
              <span className="way-go" aria-hidden="true">
                →
              </span>
            </button>
          </div>
        </>
      )}
      {way === "import" && <KeyRestore st={st} onBack={back} />}
      {way === "create" && <NewAccount st={st} onBack={back} onOpen={() => setWay("import")} />}
      <p className="tiny ext-terms">
        You accepted the <a href="/terms">Terms of use</a> (version {TERMS_VERSION}) in this extension. How your data is handled:{" "}
        <a href="/privacy">Privacy policy</a>.
      </p>
      {st.busy && !st.busy.bg && <BusyCard st={st} />}
    </main>
  );
}
