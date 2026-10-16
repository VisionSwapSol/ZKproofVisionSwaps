import { useEffect, useRef, useState } from "react";
import { engine, lockWaits, type State } from "../../web/src/lib/engine";
import { API } from "../../web/src/lib/config";
import { accountTag } from "../../web/src/lib/device";
import { onBuyFrom, onSellFrom } from "../../web/src/lib/buyfrom";
import { ShieldForm, SendForm } from "../../web/src/components/app/Forms";
import { BuyTab, SellTab, OrdersPanel } from "../../web/src/components/app/Orders";
import { WaitingRoom, DepositAddresses, ActivityList, Records, CopyLink, ScheduledPayments, Deliveries, WalletPays } from "../../web/src/components/app/Panels";
import { WalletsTab } from "../../web/src/components/app/Wallets";
import { batchOnTab } from "../../web/src/components/app/Batch";
import { PaymentRequests } from "../../web/src/components/app/Requests";
import { KeyPanel } from "../../web/src/components/app/KeyAccount";
import { TabActive, useTabActive } from "../../web/src/components/app/TabActive";
import { ShieldFirst } from "../../web/src/components/app/ShieldFirst";
import { useMasked } from "../../web/src/lib/masked";
import type { ActivityFilter } from "../../web/src/lib/activity";
import { IN_TAB, openInTab, openSite } from "./ext";
import { Glyph, type GlyphName } from "./Glyph";
import { LinkPrompt } from "./LinkPrompt";
import { BusyCard, type Screen } from "./parts";
import type { Pending } from "./link";
import { Home } from "./Home";

const SCREENS: Screen[] = ["home", "receive", "send", "swap", "wallets", "activity", "settings"];
const NAV: [Screen, string, GlyphName][] = [
  ["home", "Home", "home"],
  ["swap", "Swap", "swap"],
  ["wallets", "Wallets", "wallets"],
  ["activity", "Activity", "activity"],
  ["settings", "Settings", "settings"],
];
/** Screens opened from Home's buttons: they show a title with a way back, and Home stays lit below. */
const TITLES: Partial<Record<Screen, string>> = { receive: "Receive", send: "Send" };

/** Whether an element is on screen (true until known, so nothing flashes in on load). */
function useInView(el: HTMLElement | null): boolean {
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: "-60px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return seen;
}

/**
 * The open account: a header with the account and a menu, one screen at a time, and the bottom
 * navigation. Each screen's forms mount on its first visit and then stay (hidden while another
 * shows), so a half-filled form survives a switch, as the website's tabs do.
 */
export function Unlocked({
  st,
  screen,
  setScreen,
  side,
  setSide,
  link,
  clearLink,
}: {
  st: State;
  screen: Screen;
  setScreen: (s: Screen) => void;
  side: "buy" | "sell";
  setSide: (s: "buy" | "sell") => void;
  link: Pending | null;
  clearLink: () => void;
}) {
  const fp = st.fingerprint;
  const [visits, setVisits] = useState<{ fp: string | null; screens: Screen[] }>({ fp: null, screens: [] });
  if (visits.fp !== fp || !visits.screens.includes(screen)) setVisits({ fp, screens: visits.fp === fp ? [...visits.screens, screen] : [screen] });
  const seen = visits.fp === fp ? visits.screens : [screen];
  const go = (s: Screen) => {
    setScreen(s);
    window.scrollTo({ top: 0 });
  };
  // "Buy a token" on a Vision wallet opens Swap on Buy, spending from it; "Sell" on a holding opens it on Sell
  useEffect(() => {
    const offBuy = onBuyFrom((i) => {
      if (!i.length) return;
      setSide("buy");
      go("swap");
    });
    const offSell = onSellFrom(() => {
      setSide("sell");
      go("swap");
    });
    return () => {
      offBuy();
      offSell();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // buys spend the private balance: opening Swap with nothing in it yet shows how to start, once per visit
  const empty =
    st.total > 0 &&
    st.synced >= st.total &&
    !st.syncing &&
    !(st.busy && !st.busy.bg) &&
    st.balance === 0n &&
    !st.waiting.length &&
    !st.deposits.some((d) => d.lamports > 0n) &&
    !st.vision.some((v) => v.lamports > 0n || v.tokens.some((t) => t.amount > 0n));
  const [shieldFirst, setShieldFirst] = useState(false);
  const asked = useRef(false);
  useEffect(() => {
    if (screen !== "swap" || side !== "buy" || !empty || asked.current) return;
    const t = setTimeout(() => {
      asked.current = true;
      setShieldFirst(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [screen, side, empty]);

  // where the messages show: at the top of the screen, and repeated just above the navigation while that's scrolled away
  const [spot, setSpot] = useState<HTMLElement | null>(null);
  const spotSeen = useInView(spot);
  const [stepEl, setStepEl] = useState<HTMLElement | null>(null);
  const stepSeen = useInView(stepEl);
  // (a Wallets action shows its steps on its own row, and a batch on its card, so the dock never covers them)
  const onCard = !!st.busy?.spot && (st.busy.spot === "batch" ? batchOnTab(st.batch, screen === "swap" ? side : screen) : screen === "wallets");
  const dockBusy = st.busy && (st.busy.bg || !stepSeen) && !onCard ? st.busy : null;
  const said = st.lastSaid ? (st.said[st.lastSaid] ?? null) : null;
  const dockOn = !spotSeen && !!(dockBusy || st.error || st.notice || said);
  // a message coming up at the bottom never covers the control the keyboard is on: that moves up above it
  useEffect(() => {
    if (!dockOn) return;
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || !el.matches(":focus-visible") || el.closest(".dock, .ext-nav, .vw-bulk, .sheet, .ext-top")) return;
    const f = requestAnimationFrame(() => {
      const d = document.querySelector(".dock");
      if (d && el.getBoundingClientRect().bottom > d.getBoundingClientRect().top) el.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(f);
  }, [dockOn]);

  const title = TITLES[screen];
  const navOn = (s: Screen) => (s === "home" ? screen === "home" || !!title : screen === s);
  // Esc on Receive or Send, with nothing open over it: back to Home (a sheet or a menu takes Esc first)
  useEffect(() => {
    if (!title) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".sheet, .ext-menu, .tg-back, .sf-back, .ext .busy, .confirm")) return;
      go("home");
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);
  return (
    <>
      <Top st={st} go={go} />
      <main className={`ext-main${dockOn ? " dock-on" : ""}`}>
        {title && (
          <div className="ext-title">
            <button type="button" className="ext-icon-btn" aria-label="Back to Home" onClick={() => go("home")}>
              <Glyph name="back" />
            </button>
            <h2>{title}</h2>
          </div>
        )}
        <div ref={setSpot} className="feedback-spot" aria-hidden="true" />
        {link && <LinkPrompt st={st} link={link} clear={clearLink} />}
        {st.busy?.bg && !onCard && (
          <p className="bg-line" role="status">
            <span className="spinner small" aria-hidden="true" />
            <span>{st.busy.step}</span>
          </p>
        )}
        {st.error && (
          <div className="banner bad" role="alert">
            <span>{st.error}</span>
            <button type="button" aria-label="Dismiss" onClick={() => engine.clearError()}>
              ×
            </button>
          </div>
        )}
        {st.update && <UpdateBanner />}
        {st.notice && (!st.busy || st.busy.bg) && (
          <div className="banner good" role="status">
            <span>
              <strong>{st.notice.title}.</strong> {st.notice.text}
              {st.notice.wallets && screen !== "wallets" && (
                <>
                  {" "}
                  <button type="button" className="link-btn" onClick={() => go("wallets")}>
                    Open Wallets
                  </button>
                </>
              )}
              {st.notice.sig && st.pool && (
                <>
                  {st.notice.wallets && screen !== "wallets" ? " · " : " "}
                  <CopyLink sig={st.notice.sig} network={st.pool.network} />
                </>
              )}
            </span>
            <button type="button" aria-label="Dismiss" onClick={() => engine.clearNotice()}>
              ×
            </button>
          </div>
        )}
        {SCREENS.map(
          (s) =>
            seen.includes(s) && (
              <div key={s} className={`tab-panel ext-screen ext-${s}`} hidden={screen !== s}>
                <TabActive.Provider value={screen === s}>
                  {s === "home" ? (
                    <Home st={st} go={go} />
                  ) : s === "receive" ? (
                    <Receive st={st} />
                  ) : s === "send" ? (
                    <div className="ext-card">
                      <SendForm st={st} wallet={null} />
                    </div>
                  ) : s === "swap" ? (
                    <Swap st={st} side={side} setSide={setSide} />
                  ) : s === "wallets" ? (
                    <WalletsTab st={st} />
                  ) : s === "activity" ? (
                    <Activity st={st} />
                  ) : (
                    <Settings st={st} />
                  )}
                </TabActive.Provider>
              </div>
            ),
        )}
        {st.busy && !st.busy.bg && <BusyCard st={st} stepRef={setStepEl} />}
        {shieldFirst && (
          <ShieldFirst
            hasWallet={false}
            wallet={null}
            wait={engine.waitLabel()}
            onShield={() => {
              setShieldFirst(false);
              go("receive");
            }}
            onClose={() => setShieldFirst(false)}
          />
        )}
      </main>
      {dockOn && <Dock st={st} busy={dockBusy} said={said} />}
      <nav className="ext-nav" aria-label="VisionSwap">
        {NAV.map(([s, label, icon]) => (
          <button key={s} type="button" className={navOn(s) ? "on" : ""} aria-current={navOn(s) ? "page" : undefined} onClick={() => go(s)}>
            <Glyph name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

/** The header: the open account (Private), Lock, and a short menu. */
function Top({ st, go }: { st: State; go: (s: Screen) => void }) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const tag = st.fingerprint ? accountTag(st.fingerprint) : "";
  // an action the person started finishes on this account first, so Lock waits for it (as on the website)
  const running = lockWaits(st);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);
  const pick = (f: () => void) => () => {
    setMenu(false);
    f();
  };
  // Lock while an action runs: a short line under the header says when it can (a greyed-out button says nothing)
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), 4000);
    return () => clearTimeout(t);
  }, [hint]);
  const lock = () => (running ? setHint(true) : engine.closeKeyAccount(false));
  return (
    <>
      <header className="ext-top">
        <div className="ext-acct-box" ref={box}>
          <button type="button" className="ext-acct" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
            <span className="ext-avatar" aria-hidden="true">
              {tag.slice(0, 2)}
            </span>
            <span className="ext-acct-txt">
              <strong>Account {tag}</strong>
              <span className="ext-private">
                <Glyph name="shield" size={12} /> Private
              </span>
            </span>
            <Glyph name="chevron" size={16} className="ext-acct-chev" />
          </button>
          {menu && (
            <div className="ext-menu" role="menu">
              {!IN_TAB && (
                <button type="button" role="menuitem" onClick={pick(() => void openInTab())}>
                  <Glyph name="tab" size={18} /> Open in a tab
                </button>
              )}
              <button type="button" role="menuitem" onClick={pick(() => openSite("/"))}>
                <Glyph name="out" size={18} /> Open visionswap.net
              </button>
              <button type="button" role="menuitem" aria-disabled={running || undefined} onClick={pick(lock)}>
                <Glyph name="lock" size={18} /> Lock
              </button>
              <button type="button" role="menuitem" onClick={pick(() => go("settings"))}>
                <Glyph name="key" size={18} /> Sign out…
              </button>
            </div>
          )}
        </div>
        <button type="button" className="ext-icon-btn" aria-label="Lock" title={running ? "You can lock once this step finishes" : "Lock"} aria-disabled={running || undefined} onClick={lock}>
          <Glyph name="lock" />
        </button>
      </header>
      {hint && (
        <p className="ext-lock-hint" role="status">
          You can lock once this step finishes.
        </p>
      )}
    </>
  );
}

/** The website's message for a page that needs a newer version, with the extension's own way to get it. */
function UpdateBanner() {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <div className="banner info" role="status">
      <span>{said ?? "VisionSwap has been updated. The extension updates itself shortly; until then, send from visionswap.net. Nothing was spent."}</span>
      <button
        type="button"
        className="btn small-btn"
        onClick={() =>
          chrome.runtime
            .requestUpdateCheck()
            .then((r) => (r.status === "update_available" ? chrome.runtime.reload() : setSaid("No newer version is ready yet. Chrome installs it as soon as it is.")))
            .catch(() => setSaid("Chrome couldn't check just now. It installs updates by itself."))
        }
      >
        Check
      </button>
    </div>
  );
}

/** The step, result or problem of an action, just above the navigation while the top of the screen is scrolled away. */
function Dock({ st, busy, said }: { st: State; busy: State["busy"]; said: State["said"][string] | null }) {
  const tone = busy ? "" : st.error ? " bad" : st.notice ? " good" : said ? (said.ok ? " good" : " bad") : "";
  return (
    <div className={`dock ext-dock${tone}`}>
      {busy ? (
        <p className="dock-row">
          <span className="spinner small" aria-hidden="true" />
          <span>{busy.step}</span>
        </p>
      ) : st.error ? (
        <p className="dock-row">
          <span className="dock-text">{st.error}</span>
          <button type="button" className="dock-x" aria-label="Dismiss" onClick={() => engine.clearError()}>
            ×
          </button>
        </p>
      ) : st.notice ? (
        <>
          <p className="dock-row">
            <span className="dock-text">
              <strong>{st.notice.title}.</strong> {st.notice.text}
            </span>
            <button type="button" className="dock-x" aria-label="Dismiss" onClick={() => engine.clearNotice()}>
              ×
            </button>
          </p>
          {st.notice.sig && st.pool && (
            <p className="dock-link">
              <CopyLink sig={st.notice.sig} network={st.pool.network} />
            </p>
          )}
        </>
      ) : (
        said && (
          <p className="dock-row">
            <span className="dock-text">{said.ok ? said.text : `Didn't go through: ${said.text}`}</span>
            <button type="button" className="dock-x" aria-label="Dismiss" onClick={() => engine.hideSaid()}>
              ×
            </button>
          </p>
        )
      )}
    </div>
  );
}

/**
 * Receive: the account's QR deposit address and payment links. A browser wallet can't connect inside
 * an extension, so shielding from one happens on visionswap.net, into this same account.
 */
function Receive({ st }: { st: State }) {
  return (
    <>
      <div className="ext-card">
        <ShieldForm st={st} wallet={null} />
      </div>
      <div className="ext-card ext-fromwallet">
        <strong>Add SOL from a browser wallet</strong>
        <p className="small muted">
          Wallet extensions work on websites, not inside other extensions. On visionswap.net, open this same account (with your wallet, or with
          this account's key) and add SOL from your wallet. It shows up here.
        </p>
        <button type="button" className="btn ghost wide" onClick={() => openSite("/app#shield")}>
          <Glyph name="out" size={16} /> Shield from your wallet
        </button>
      </div>
    </>
  );
}

/** Swap: buy (now, limit, DCA) or sell (now, take profit / stop loss), from the private balance and Vision wallets. */
function Swap({ st, side, setSide }: { st: State; side: "buy" | "sell"; setSide: (s: "buy" | "sell") => void }) {
  const active = useTabActive();
  const [seen, setSeen] = useState<("buy" | "sell")[]>([side]);
  if (!seen.includes(side)) setSeen([...seen, side]);
  return (
    <div className="ext-card ext-swap">
      <div className="seg seg-2 ext-swap-seg" role="group" aria-label="Buy or sell">
        <button type="button" aria-pressed={side === "buy"} className={side === "buy" ? "on" : ""} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button type="button" aria-pressed={side === "sell"} className={side === "sell" ? "on" : ""} onClick={() => setSide("sell")}>
          Sell
        </button>
      </div>
      {seen.includes("buy") && (
        <div hidden={side !== "buy"}>
          <TabActive.Provider value={active && side === "buy"}>
            <BuyTab st={st} />
          </TabActive.Provider>
        </div>
      )}
      {seen.includes("sell") && (
        <div hidden={side !== "sell"}>
          <TabActive.Provider value={active && side === "sell"}>
            <SellTab st={st} />
          </TabActive.Provider>
        </div>
      )}
    </div>
  );
}

const CHIPS: [ActivityFilter, string][] = [
  ["all", "All"],
  ["moves", "Moves"],
  ["trades", "Trades"],
  ["sends", "Sends"],
];

/** Activity: what's on its way now (each panel shows only when it has something), then the history by day. */
function Activity({ st }: { st: State }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  return (
    <div className="ext-stack ext-activity">
      {/* (the heading shows only while a panel below it has something: see ext.css) */}
      <section className="ext-progress" aria-label="In progress">
        <h3 className="ext-h3">In progress</h3>
        <WaitingRoom st={st} wallet={null} />
        <DepositAddresses st={st} />
        <ScheduledPayments st={st} />
        <Deliveries st={st} />
        <WalletPays st={st} />
        <OrdersPanel st={st} />
        <PaymentRequests st={st} />
      </section>
      <section className="ext-history" aria-label="History">
        <div className="ext-list-top">
          <h3 className="ext-h3">History</h3>
          <span className="small muted">Kept on this device only</span>
        </div>
        {st.activity.length > 0 && (
          <div
            className="ext-chips"
            role="radiogroup"
            aria-label="Show"
            onKeyDown={(e) => {
              // one stop for the keyboard, the arrows pick (as radio buttons go)
              const i = CHIPS.findIndex(([f]) => f === filter);
              const n = e.key === "ArrowRight" || e.key === "ArrowDown" ? i + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? CHIPS.length - 1 : null;
              if (n == null) return;
              e.preventDefault();
              const k = (n + CHIPS.length) % CHIPS.length;
              setFilter(CHIPS[k][0]);
              (e.currentTarget.children[k] as HTMLElement | undefined)?.focus();
            }}
          >
            {CHIPS.map(([f, label]) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={filter === f}
                tabIndex={filter === f ? 0 : -1}
                className={filter === f ? "on" : ""}
                onClick={() => setFilter(f)}
              >
                {filter === f && <Glyph name="check" size={14} />}
                {label}
              </button>
            ))}
          </div>
        )}
        <ActivityList st={st} grouped filter={filter} pageSize={20} />
      </section>
    </div>
  );
}

/** "Hide amounts": kept on this device only, for Home, Wallets and the activity history. */
function PrivacyPanel() {
  const [masked, setMasked] = useMasked();
  return (
    <section className="panel ext-privacy">
      <header>
        <h3>Privacy</h3>
      </header>
      <button type="button" role="switch" aria-checked={masked} className="ext-switch-row" onClick={() => setMasked(!masked)}>
        <span className="ext-switch-text">
          <strong>Hide amounts</strong>
          <span className="small muted">Shows •••• instead of amounts on Home, Wallets and your activity history. Kept on this device only.</span>
        </span>
        <span className="ext-switch" aria-hidden="true">
          <i />
        </span>
      </button>
    </section>
  );
}

const apiHost = () => {
  try {
    return new URL(API).host;
  } catch {
    return "visionswap.net";
  }
};

function Settings({ st }: { st: State }) {
  const version = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "";
    }
  })();
  return (
    <div className="ext-stack">
      <PrivacyPanel />
      <KeyPanel st={st} />
      <Records st={st} />
      <section className="panel ext-about">
        <header>
          <h3>VisionSwap</h3>
          <span className="muted">Extension {version}</span>
        </header>
        <div className="ext-links">
          {!IN_TAB && (
            <button type="button" className="ext-row" onClick={() => void openInTab()}>
              <Glyph name="tab" size={18} /> Open in a tab
            </button>
          )}
          <button type="button" className="ext-row" onClick={() => openSite("/")}>
            <Glyph name="out" size={18} /> visionswap.net
          </button>
          <button type="button" className="ext-row" onClick={() => openSite("/docs")}>
            <Glyph name="out" size={18} /> Docs
          </button>
          <button type="button" className="ext-row" onClick={() => openSite("/support#contact")}>
            <Glyph name="out" size={18} /> Support and contact
          </button>
          <button type="button" className="ext-row" onClick={() => openSite("/terms")}>
            <Glyph name="out" size={18} /> Terms of use
          </button>
          <button type="button" className="ext-row" onClick={() => openSite("/privacy")}>
            <Glyph name="out" size={18} /> Privacy policy
          </button>
        </div>
        <p className="tiny">
          Your keys and history stay in this browser. The extension talks only to {apiHost()}.
        </p>
      </section>
    </div>
  );
}
