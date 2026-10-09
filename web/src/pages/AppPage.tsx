import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { Header } from "../components/Header";
import { EyesTile } from "../components/EyesTile";
import { Wallets, useEngine, useWalletLike, isMobile, isIOS, phantomBrowse, solflareBrowse } from "../lib/wallet";
import { engine, fmt, lockWaits, type State } from "../lib/engine";
import { short, conn, confirmSig } from "../lib/net";
import { readHandOff } from "../lib/prefill";
import { onBuyFrom, onSellFrom } from "../lib/buyfrom";
import { PublicKey } from "@solana/web3.js";

async function faucet(owner: string) {
  try {
    const sig = await conn().requestAirdrop(new PublicKey(owner), 10_000_000_000);
    await confirmSig(sig, "airdrop");
    await engine.refreshPublic();
  } catch (e) {
    engine.reportError((e as Error).message);
  }
}
import { warmUp } from "../lib/zk";
import { ShieldForm, SendForm } from "../components/app/Forms";
import { BuyTab, SellTab, OrdersPanel } from "../components/app/Orders";
import { WaitingRoom, DepositAddresses, ActivityList, Records, CopyLink, ScheduledPayments, Deliveries, WalletPays } from "../components/app/Panels";
import { WalletsTab, WalletsSummary, goWallets } from "../components/app/Wallets";
import { batchLive, batchOnTab } from "../components/app/Batch";
import { DeliveryCheck } from "../components/app/DeliveryCheck";
import { PaymentRequests } from "../components/app/Requests";
import { KeyStart, NewAccount, KeyRestore, SavedKey, KeyPanel } from "../components/app/KeyAccount";
import { Icon } from "../components/Icon";
import { WalletChip } from "../components/app/WalletChip";
import { TabActive } from "../components/app/TabActive";
import { ShieldFirst } from "../components/app/ShieldFirst";

type Tab = "shield" | "send" | "buy" | "sell" | "wallets";
const TABS: [Tab, string][] = [
  ["shield", "Shield"],
  ["send", "Send"],
  ["buy", "Buy"],
  ["sell", "Sell"],
  ["wallets", "Wallets"],
];

/** The top of the main card into view, unless it's on screen already (nothing moves for no reason). */
const toCard = () => {
  const card = document.querySelector(".main-card");
  if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ behavior: "smooth", block: "start" });
};

export default function AppPage() {
  return (
    <Wallets>
      <AppInner />
    </Wallets>
  );
}

function AppInner() {
  const st = useEngine();
  const wallet = useWalletLike();
  const { publicKey, disconnect } = useWallet();
  // "#send&to=…" carries a payment request's details: read once, then cleared from the address bar
  const [hand] = useState(readHandOff);
  const [tab, setTab] = useState<Tab>(() => TABS.find(([k]) => k === hand)?.[0] ?? "shield");
  // the owner's delivery check (/app#delivery-check), linked from nowhere
  const [check, setCheck] = useState(hand === "delivery-check");
  useEffect(() => {
    const on = () => {
      if (location.hash === "#delivery-check") setCheck(true);
      // a link to a tab ("Add SOL in the Shield tab") opens it
      const t = TABS.find(([k]) => `#${k}` === location.hash)?.[0];
      if (!t) return;
      setTab(t);
      document.querySelector(".main-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // a tab's form mounts on its first visit and then stays (hidden when another tab is picked), so a half-filled form survives a switch;
  // the list starts over with each account (Lock and sign-out clear the fingerprint), so an unlock mounts only the tab on screen
  const [visits, setVisits] = useState<{ fp: string | null; tabs: Tab[] }>({ fp: null, tabs: [] });
  const fp = st.fingerprint;
  if (visits.fp !== fp || !visits.tabs.includes(tab)) setVisits({ fp, tabs: visits.fp === fp ? [...visits.tabs, tab] : [tab] });
  const seen = visits.fp === fp ? visits.tabs : [tab];

  useEffect(() => {
    document.title = "VisionSwap · App";
    void engine.loadPool();
    // a key kept in plain text by an older version gets sealed to this browser straight away
    void engine.protectSavedKey();
  }, []);
  useEffect(() => engine.setOwner(publicKey?.toBase58() ?? null), [publicKey]);
  // leaving mid-trade could leave it half done: the browser asks first (closing a phone tab may not, which is why a buy can always be resumed)
  // and so could leaving while a payment from the wallet waits to go (it picks up next time, but sooner is better)
  const paying = st.pays.some((p) => (p.status === "paying" || p.status === "waiting") && Date.now() - p.created < 30 * 60_000);
  // and so could leaving while a Wallets-tab action runs or waits its turn, or a batch across wallets has wallets still to go
  const batching = batchLive(st.batch) && !st.batch.paused && !st.batchAway;
  const busy = (!!st.busy && !st.busy.bg && st.busy.kind !== "sync" && st.busy.kind !== "unlock") || paying || st.spots.length > 0 || batching;
  useEffect(() => {
    if (!busy) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [busy]);
  useEffect(() => {
    if (st.unlocked) void warmUp();
  }, [st.unlocked]);
  // "Buy a token" on Vision wallets opens the Buy tab, spending from those wallets; "Sell" on a holding opens Sell with it picked
  useEffect(() => {
    const offBuy = onBuyFrom((i) => {
      if (!i.length) return;
      setTab("buy");
      toCard();
    });
    const offSell = onSellFrom(() => {
      setTab("sell");
      toCard();
    });
    return () => {
      offBuy();
      offSell();
    };
  }, []);
  useEffect(() => {
    if (!check && TABS.some(([t]) => t === tab)) history.replaceState(null, "", `#${tab}`);
  }, [tab, check]);
  // buys spend the private balance: opening Buy with nothing shielded yet (and nothing on its way in) shows how to start (sends can come from the wallet)
  const empty =
    st.unlocked &&
    st.total > 0 &&
    st.synced >= st.total &&
    !st.syncing &&
    !(st.busy && !st.busy.bg) &&
    st.balance === 0n &&
    !st.waiting.length &&
    !st.deposits.some((d) => d.lamports > 0n) &&
    !st.vision.some((v) => v.lamports > 0n || v.tokens.some((t) => t.amount > 0n));
  const [shieldFirst, setShieldFirst] = useState(false);
  const askedOn = useRef<Tab | null>(null);
  useEffect(() => {
    if (tab === "shield" || check) {
      askedOn.current = null;
      return;
    }
    if (tab !== "buy" || !empty || askedOn.current === tab) return;
    // a moment's wait, so a balance still being read never brings it up
    const t = setTimeout(() => {
      askedOn.current = tab;
      setShieldFirst(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [tab, empty, check]);
  // the tabs move with the arrow keys, Home and End, like any tab row
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex(([t]) => t === tab);
    const n = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    setTab(TABS[n][0]);
    tabRefs.current[n]?.focus();
  };
  // where the messages show: when it's scrolled out of view (a phone, down at the panels), they show at the bottom of the screen too
  const [spot, setSpot] = useState<HTMLElement | null>(null);
  const spotSeen = useInView(spot);
  // the busy step itself, not just any sliver of the card: it can sit out of view while the card still shows
  const [stepEl, setStepEl] = useState<HTMLElement | null>(null);
  const stepSeen = useInView(stepEl);
  // (a Wallets-tab action shows its steps on its own row, and a batch on its card, so the dock never covers them for it)
  const onCard = !!st.busy?.spot && (st.busy.spot === "batch" ? batchOnTab(st.batch, tab) : tab === "wallets");
  const dockBusy = st.busy && (st.busy.bg || !stepSeen) && !onCard ? st.busy : null;
  // a Wallets-tab action's result is on its row, and on a phone repeated here for a moment
  const phone = useMedia("(max-width: 560px)");
  const said = phone && st.lastSaid ? (st.said[st.lastSaid] ?? null) : null;
  const dockOn = !spotSeen && !!(dockBusy || st.error || st.notice || said);

  const net = st.pool?.network;
  return (
    <div className={`page app-page${dockOn ? " dock-on" : ""}`}>
      <Header variant="app" right={<WalletChip st={st} />} />
      <main className="wrap app-main">
        {net && net !== "mainnet" && (
          <p className="net-badge">
            {net === "localnet" ? "Local test network. Nothing here is real money." : "Devnet. Test funds only."}
            {publicKey && (
              <button type="button" className="link-btn faucet" onClick={() => faucet(publicKey.toBase58())}>
                Add 10 test SOL
              </button>
            )}
          </p>
        )}
        <div className="app-grid">
          <section className="main-card">
            <BalanceHead
              st={st}
              onDisconnect={publicKey ? () => disconnect().catch(() => {}) : undefined}
              onLock={st.account === "key" && !publicKey ? () => engine.closeKeyAccount(false) : undefined}
            />
            <div ref={setSpot} className="feedback-spot" aria-hidden="true" />
            {/* a Wallets-tab action shows on its own row there (a batch on its card): nothing above the list moves */}
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
            {st.update && (
              <div className="banner info" role="status">
                <span>VisionSwap has been updated. Refresh the page to send. Nothing was spent.</span>
                <button type="button" className="btn small-btn" onClick={() => location.reload()}>
                  Refresh
                </button>
              </div>
            )}
            {st.notice && (!st.busy || st.busy.bg) && (
              <div className="banner good" role="status">
                <span>
                  <strong>{st.notice.title}.</strong> {st.notice.text}
                  {st.notice.wallets && tab !== "wallets" && (
                    <>
                      {" "}
                      <a className="link-btn" href="#wallets" onClick={goWallets}>
                        Open Wallets
                      </a>
                    </>
                  )}
                  {st.notice.sig && st.pool && (
                    <>
                      {st.notice.wallets && tab !== "wallets" ? " · " : " "}
                      <CopyLink sig={st.notice.sig} network={st.pool.network} />
                    </>
                  )}
                </span>
                <button type="button" aria-label="Dismiss" onClick={() => engine.clearNotice()}>
                  ×
                </button>
              </div>
            )}
            {st.poolError && !st.pool ? (
              <div className="gate">
                <p>The pool can't be reached right now.</p>
                <p className="muted">{st.poolError}</p>
                <button className="btn ghost" onClick={() => engine.loadPool()}>
                  Try again
                </button>
              </div>
            ) : !st.unlocked ? (
              publicKey ? (
                <UnlockGate st={st} />
              ) : (
                <ConnectGate st={st} />
              )
            ) : !st.pool ? (
              <div className="gate">
                <p className="muted">Loading the pool…</p>
              </div>
            ) : check ? (
              <DeliveryCheck
                st={st}
                onClose={() => {
                  setCheck(false);
                  history.replaceState(null, "", `#${tab}`);
                }}
              />
            ) : (
              <>
                <div className="tabs" role="tablist" aria-label="What to do" onKeyDown={onTabKey}>
                  {TABS.map(([t, label], i) => (
                    <button
                      key={t}
                      ref={(el) => {
                        tabRefs.current[i] = el;
                      }}
                      type="button"
                      role="tab"
                      id={`tab-${t}`}
                      aria-controls={`panel-${t}`}
                      aria-selected={tab === t}
                      tabIndex={tab === t ? 0 : -1}
                      className={tab === t ? "on" : ""}
                      onClick={() => setTab(t)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {TABS.map(([t]) => (
                  <div key={t} className="tab-panel" role="tabpanel" id={`panel-${t}`} aria-labelledby={`tab-${t}`} hidden={tab !== t}>
                    <TabActive.Provider value={tab === t}>
                      {seen.includes(t) &&
                        (t === "shield" ? (
                          <ShieldForm st={st} wallet={wallet} />
                        ) : t === "send" ? (
                          <SendForm st={st} wallet={wallet} />
                        ) : t === "buy" ? (
                          <BuyTab st={st} />
                        ) : t === "sell" ? (
                          <SellTab st={st} />
                        ) : (
                          <WalletsTab st={st} />
                        ))}
                    </TabActive.Provider>
                  </div>
                ))}
              </>
            )}
            {st.busy && !st.busy.bg && <BusyCard st={st} stepRef={setStepEl} />}
            {shieldFirst && (
              <ShieldFirst
                hasWallet={st.account === "wallet"}
                wallet={st.publicLamports}
                wait={engine.waitLabel()}
                onShield={() => {
                  setShieldFirst(false);
                  setTab("shield");
                  document.querySelector(".main-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                onClose={() => setShieldFirst(false)}
              />
            )}
          </section>
          <aside className="side">
            {st.unlocked ? (
              <>
                <WalletPays st={st} />
                <WalletsSummary st={st} />
                <OrdersPanel st={st} />
                <Deliveries st={st} />
                <ScheduledPayments st={st} />
                <PaymentRequests st={st} />
                <WaitingRoom st={st} wallet={wallet} />
                <DepositAddresses st={st} />
                <ActivityList st={st} />
                <Records st={st} />
                <KeyPanel st={st} />
                <PrivacyNotes />
              </>
            ) : (
              <PrivacyNotes />
            )}
          </aside>
        </div>
      </main>
      {dockOn && <Dock st={st} busy={dockBusy} said={said} />}
    </div>
  );
}

/** Whether a media query matches now (and follows it). */
function useMedia(q: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia !== "undefined" && matchMedia(q).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(q);
    const f = () => setOn(m.matches);
    f();
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, [q]);
  return on;
}

/** Whether an element is on screen (true until known, so nothing flashes in on load). */
function useInView(el: HTMLElement | null): boolean {
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { rootMargin: "-64px 0px 0px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [el]);
  return seen;
}

/**
 * The step, result or problem of an action, at the bottom of the screen while the top of the main
 * card is out of view: a tap on Cancel down in the panels gets its answer right there. The banners
 * in the card stay the ones screen readers hear, so this repeats them quietly.
 */
function Dock({ st, busy, said }: { st: State; busy: State["busy"]; said: State["said"][string] | null }) {
  const tone = busy ? "" : st.error ? " bad" : st.notice ? " good" : said ? (said.ok ? " good" : " bad") : "";
  return (
    <div className={`dock${tone}`}>
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

function BalanceHead({ st, onDisconnect, onLock }: { st: State; onDisconnect?: () => void; onLock?: () => void }) {
  // an action the person started finishes on this account first (the engine would hold the lock until then), so Lock waits for it
  const running = lockWaits(st);
  return (
    <div className="bal-head">
      <div className="bal-mascot">
        <EyesTile shield={st.unlocked ? 1 : 0} compact />
      </div>
      <div className="bal-text">
        <span className="eyebrow">Private balance</span>
        <strong className="bal-num">{st.unlocked ? `${fmt(st.balance)} SOL` : "Locked"}</strong>
        {st.unlocked && st.solUsd != null && st.balance > 0n && (
          <span className="bal-usd">≈ ${((Number(st.balance) / 1e9) * st.solUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
        )}
        <span className="muted small bal-sub">
          {st.unlocked
            ? st.syncing
              ? "Reading the pool…"
              : `${st.notes.length} note${st.notes.length === 1 ? "" : "s"} · ${st.synced.toLocaleString("en-US")} in the pool${st.locked > 0n ? ` · ${fmt(st.locked, 4)} SOL scheduled` : ""}`
            : st.owner
              ? `Wallet ${short(st.owner)}`
              : "No wallet connected"}
        </span>
      </div>
      {onDisconnect ? (
        <button className="link-btn disc" onClick={onDisconnect}>
          Disconnect
        </button>
      ) : (
        onLock && (
          <button className="link-btn disc" onClick={onLock} disabled={running} title={running ? "You can lock once this finishes" : undefined}>
            Lock
          </button>
        )
      )}
    </div>
  );
}

type Way = "choose" | "wallet" | "qr" | "key";

/**
 * Where /app?start=… sends someone: straight to the QR path, the key path or the wallet list. Someone
 * who signed in with a passkey here before starts at signing in, one tap away.
 */
function startWay(): Way {
  const s = new URLSearchParams(location.search).get("start");
  if (s === "qr" || s === "key" || s === "wallet") return s;
  return engine.usedPasskey() && !engine.hasSavedKey() ? "key" : "choose";
}

/**
 * The first screen: two equal ways in. A wallet signs once to open a private account; without a
 * wallet, a private key made on this device opens it and a QR code takes SOL from anywhere.
 */
function ConnectGate({ st }: { st: State }) {
  const { wallets, select, connecting } = useWallet();
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const mobile = isMobile();
  const [way, setWay] = useState<Way>(startWay);
  const back = () => setWay("choose");
  return (
    <div className="gate">
      {way === "choose" && (
        <>
          <SavedKey st={st} />
          <h2>Open VisionSwap</h2>
          <p className="muted">Two ways in. Both give you the same private balance, with private sends, buys and sells.</p>
          <div className="ways" role="list">
            <button type="button" role="listitem" className="way" onClick={() => setWay("wallet")}>
              <span className="way-ico">
                <Icon name="wallet" />
              </span>
              <span className="way-txt">
                <strong>Connect a wallet</strong>
                <span>Phantom, Solflare, Backpack and more. Sign once, then shield straight from your wallet.</span>
              </span>
              <span className="way-go" aria-hidden="true">
                →
              </span>
            </button>
            <button type="button" role="listitem" className="way qr" onClick={() => setWay("qr")}>
              <span className="way-ico">
                <Icon name="qr" />
              </span>
              <span className="way-txt">
                <strong>No wallet? Deposit by QR code</strong>
                <span>Get a private account and your own QR code. Send SOL from any wallet or exchange. Nothing to connect.</span>
              </span>
              <span className="way-go" aria-hidden="true">
                →
              </span>
            </button>
          </div>
          <p className="small center">
            Already have a VisionSwap account without a wallet?{" "}
            <button type="button" className="link-btn" onClick={() => setWay("key")}>
              Open it
            </button>
          </p>
        </>
      )}
      {way === "wallet" && (
        <>
          <WalletChoices installed={installed} mobile={mobile} connecting={connecting} select={select} />
          <button type="button" className="link-btn" onClick={back}>
            ← Other ways in
          </button>
        </>
      )}
      {way === "qr" && (
        <>
          <QrSteps />
          <NewAccount st={st} onBack={back} onOpen={() => setWay("key")} step="Step 1 of 3" />
        </>
      )}
      {way === "key" && <KeyRestore st={st} onBack={back} />}
      <p className="tiny">
        By connecting a wallet or opening a private account, you agree to the{" "}
        <a href="/terms" target="_blank" rel="noreferrer noopener">
          Terms of use
        </a>
        .
      </p>
    </div>
  );
}

/** What the no-wallet path looks like, before the key is shown. */
function QrSteps() {
  return (
    <ol className="qr-steps">
      <li className="on">
        <b>1</b>Secure your account
      </li>
      <li>
        <b>2</b>Send SOL to your QR code
      </li>
      <li>
        <b>3</b>Trade and send privately
      </li>
    </ol>
  );
}

function WalletChoices({
  installed,
  mobile,
  connecting,
  select,
}: {
  installed: ReturnType<typeof useWallet>["wallets"];
  mobile: boolean;
  connecting: boolean;
  select: ReturnType<typeof useWallet>["select"];
}) {
  return (
    <>
      <h2>Connect a wallet</h2>
      <p className="muted">Use the wallet you already have. VisionSwap never asks for your seed phrase.</p>
      {installed.length > 0 ? (
        <ul className="wallet-list">
          {installed.map((w) => (
            <li key={w.adapter.name}>
              <button type="button" disabled={connecting} onClick={() => select(w.adapter.name)}>
                <img src={w.adapter.icon} alt="" width={32} height={32} />
                <span>{w.adapter.name}</span>
                <small>{w.readyState === WalletReadyState.Installed ? "Detected" : "Available"}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : mobile ? (
        <div className="deeplinks">
          <p>Open VisionSwap inside your wallet app:</p>
          <a className="btn" href={phantomBrowse()}>
            Open in Phantom
          </a>
          <a className="btn ghost" href={solflareBrowse()}>
            Open in Solflare
          </a>
          {isIOS() && <p className="tiny">On iPhone, wallets connect from their own built-in browser.</p>}
        </div>
      ) : (
        <div className="deeplinks">
          <p>No Solana wallet was found in this browser.</p>
          <a className="btn" href="https://phantom.com/download" target="_blank" rel="noreferrer noopener">
            Get Phantom
          </a>
          <a className="btn ghost" href="https://solflare.com/download" target="_blank" rel="noreferrer noopener">
            Get Solflare
          </a>
        </div>
      )}
      {connecting && <p className="muted">Waiting for your wallet…</p>}
    </>
  );
}

function UnlockGate({ st }: { st: State }) {
  const wallet = useWalletLike();
  const { wallet: w } = useWallet();
  const first = st.owner ? !engine.hasUnlockedBefore(st.owner) : true;
  const canSign = !!wallet;
  return (
    <div className="gate">
      {w && st.owner && (
        <p className="connected-as">
          <img src={w.adapter.icon} alt="" width={22} height={22} />
          <span>
            <strong>{w.adapter.name}</strong> connected
          </span>
          <span className="mono muted">{short(st.owner)}</span>
          {st.publicLamports != null && <span className="muted">{fmt(st.publicLamports, 4)} SOL</span>}
        </p>
      )}
      <h2>{first ? "Open your private account" : "Unlock your private account"}</h2>
      <p>
        Your wallet signs one message. That signature becomes the key to your private balance and your Vision wallets. It never leaves
        this browser and doesn't cost anything.
      </p>
      {first && <p className="muted">The first time, your wallet asks twice, to make sure it always signs the same way.</p>}
      {st.owner && (
        <p className="small">
          Curious what this wallet already gives away?{" "}
          <a href={`/check?a=${st.owner}`} className="link-btn">
            Check its exposure
          </a>
        </p>
      )}
      {!canSign && <p className="warn">{w?.adapter.name ?? "This wallet"} can't sign messages, so it can't open a VisionSwap account.</p>}
      <button className="btn violet wide" disabled={!canSign || !!st.busy} onClick={() => wallet && engine.unlock(wallet)}>
        {first ? "Sign to open" : "Sign to unlock"}
      </button>
      <details className="key-alt">
        <summary>Rather not sign? Use a private key instead</summary>
        <KeyStart st={st} />
      </details>
      <p className="tiny">
        Only sign this message inside VisionSwap. Anyone who has the signature can spend your private balance. By continuing, you agree
        to the{" "}
        <a href="/terms" target="_blank" rel="noreferrer noopener">
          Terms of use
        </a>
        .
      </p>
    </div>
  );
}

function BusyCard({ st, stepRef }: { st: State; stepRef?: (el: HTMLElement | null) => void }) {
  return (
    <div className="busy" role="status">
      <div className="busy-in" ref={stepRef}>
        <div className="busy-mascot">
          <EyesTile shield={1} compact />
        </div>
        <p className="busy-step">{st.busy!.step}</p>
        {st.busy!.detail && <p className="muted small">{st.busy!.detail}</p>}
        <span className="spinner" aria-hidden="true" />
      </div>
    </div>
  );
}

function PrivacyNotes() {
  return (
    <section className="panel notes">
      <header>
        <h3>Staying private</h3>
      </header>
      <ul>
        <li>Wait a while between shielding and spending. The busier the pool, the better.</li>
        <li>Spend amounts that differ from what you shielded. Round numbers blend in.</li>
        <li>Never send back to the wallet you shielded from.</li>
        <li>Shield and spend in different sittings, ideally from a different network or through a VPN. Like any website, ours can see the connections it receives, even though it keeps no logs.</li>
        <li>Your spending and viewing keys never leave this browser. Nothing on our side can spend or freeze your private balance.</li>
      </ul>
    </section>
  );
}
