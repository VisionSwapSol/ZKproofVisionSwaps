import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { engine, fmt, fmtDown, fmtUp, solText, autoSlippage, visionReserve, WHEN_LABEL, type State, type WalletLike, type When, type SelfPayer } from "../../lib/engine";
import { conn, lookup, parseSol, parseUnits, formatUnits, short } from "../../lib/net";
import { normAmount } from "../../lib/amount";
import { ls } from "../../lib/idb";
import { SPEEDS, SPEED_CAP, speedOf, type Speed } from "../../lib/trade";
import { copyText } from "../../lib/copy";
import { sendPrefill, clearSendPrefill } from "../../lib/prefill";
import { buyFromVision, useBuyFrom, onSellFrom, sellPicked } from "../../lib/buyfrom";
import { allOfIt, eachAmounts, partMin, shareOf, splitAmounts, BATCH_MAX } from "../../lib/batch";
import { approvalOf, batchWarnings, checkSay, costSay, driftLabel, pctText, type TradeGuard } from "../../lib/guard";
import { clampDrift, lastRate, DRIFT_CHOICES, DRIFT_DEFAULT_BPS, IMPACT_BLOCK_PCT, type TradeCheck } from "@visionswap/sdk";
import { secureRandom } from "../../lib/poll";
import { PacingControl, batchLive, batchWallets, toBatchCard, usePacing } from "./Batch";
import { ConfirmButton } from "./Panels";
import { TokenPicker, TokenIcon, type Token } from "./TokenPicker";
import { useTokenMeta } from "../../lib/tokenmeta";
import { bucketAmount, sawNoRoute, sawRoute, stuckToken, probeTooSoon, NO_ROUTE_GAP_MS } from "../../lib/tokenfacts";
import { QrDeposit } from "./Qr";
import { RequestLink } from "./Requests";
import { AmountField } from "./AmountField";
import { useTabActive } from "./TabActive";
import { EMPTY_WARN } from "./ShieldFirst";
import { useWalletLike } from "../../lib/wallet";
import { IS_EXTENSION } from "../../lib/platform";
import { ListedWarning } from "./Listed";
import { LARGE_SHARE_BPS, NEAR_SWEPT_TEXT, NEAR_TEXT, WALLET_NEAR_TEXT, largeShareText } from "../../lib/privacy";

export { AmountField };

const SOL_MINT = "So11111111111111111111111111111111111111112";
const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

export function Rows({ rows }: { rows: [string, string, string?][] }) {
  return (
    <dl className="rows">
      {rows.map(([k, v, cls]) => (
        <div key={k} className={cls}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ─────────────── Shield ───────────────

export function ShieldForm({ st, wallet }: { st: State; wallet: WalletLike | null }) {
  const [mode, setMode] = useState<"wallet" | "qr" | "link">(wallet ? "wallet" : "qr");
  useEffect(() => {
    if (!wallet && mode === "wallet") setMode("qr");
  }, [wallet, mode]);
  const tabs: ["wallet" | "qr" | "link", string][] = [...(wallet ? ([["wallet", "From this wallet"]] as ["wallet", string][]) : []), ["qr", "By QR code"], ["link", "Payment link"]];
  return (
    <>
      <div className={`seg seg-${tabs.length}`} role="group" aria-label="Add SOL">
        {tabs.map(([k, l]) => (
          <button key={k} type="button" aria-pressed={mode === k} className={mode === k ? "on" : ""} onClick={() => setMode(k)}>
            {l}
          </button>
        ))}
      </div>
      {mode === "wallet" && wallet ? <WalletShield st={st} wallet={wallet} /> : mode === "link" ? <RequestLink st={st} /> : <QrDeposit st={st} />}
    </>
  );
}

function WalletShield({ st, wallet }: { st: State; wallet: WalletLike }) {
  const [amt, setAmt] = useState("");
  const lamports = parseSol(amt);
  const pool = st.pool!;
  const delayMin = engine.slotMinutes(Number(pool.depositDelaySlots));
  // the exact most this wallet can shield: amount + fee + waiting-room rent + network fee, keeping the wallet open
  const maxPublic = engine.maxShield();
  const min = BigInt(pool.minDeposit);
  const max = BigInt(pool.maxDeposit);
  const fee = lamports ? engine.depositFee(lamports) : 0n;
  const room = pool.tvlRoom != null ? BigInt(pool.tvlRoom) : null;
  const problem =
    lamports == null || lamports === 0n
      ? null
      : lamports < min
        ? `The smallest deposit is ${fmt(min)} SOL.`
        : lamports > max
          ? `The largest single deposit is ${fmt(max)} SOL. Shield the rest in a second deposit.`
          : room != null && lamports > room
            ? `The pool can take ${fmt(room, 6)} SOL more right now.`
            : st.publicLamports != null && st.rent && engine.shieldCost(lamports) + engine.walletKeep() > st.publicLamports
              ? maxPublic != null && maxPublic >= min
                ? `That's more than this wallet holds after fees. The most it can shield is ${fmt(maxPublic, 6)} SOL.`
                : "This wallet doesn't hold enough SOL to shield after fees."
              : null;
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!lamports || problem) return;
        // cleared only once it went: a tap while something else runs does nothing, and keeps the amount
        await engine
          .shield(wallet, lamports)
          .then((sig) => {
            if (sig) setAmt("");
          })
          .catch(() => {});
      }}
    >
      <AmountField
        label="Move into your private balance"
        hint={st.publicLamports != null ? `Wallet: ${fmt(st.publicLamports)} SOL` : undefined}
        value={amt}
        onChange={setAmt}
        max={maxPublic != null && maxPublic >= min ? formatUnits(maxPublic, 9, 9) : null}
      />
      <p className="note">
        Deposits wait about {delayMin} minute{delayMin === 1 ? "" : "s"} in a public waiting room while they're screened, then join the
        pool. Anyone can see this deposit came from your wallet. That's expected: what happens next is the private part.
      </p>
      {lamports && !problem && engine.depositFeeBps() > 0 ? (
        <Rows
          rows={[
            [`Pool fee (${pct(engine.depositFeeBps())})`, `${fmt(fee, 6)} SOL`],
            ["Taken from your wallet", `${fmt(lamports + fee, 6)} SOL`, "total"],
          ]}
        />
      ) : null}
      {problem && <p className="warn">{problem}</p>}
      <button className="btn violet wide" disabled={!lamports || !!problem || !!st.busy || pool.depositsPaused}>
        {pool.depositsPaused ? "Deposits are paused" : lamports ? `Shield ${fmt(lamports)} SOL` : "Shield"}
      </button>
      <p className="tiny">
        Plus Solana's network fee, a fraction of a cent, and a {st.rent ? fmt(st.rent.pending, 4) : "small"} SOL account deposit that comes back
        to your wallet when your SOL joins the pool.
        {engine.depositFeeBps() > 0 ? " If you take the deposit back before it joins the pool, the pool fee comes back too." : ""}
      </p>
    </form>
  );
}

/** SOL this wallet shielded that is still in the waiting room (not a payment's), and about how many minutes until all of it has joined. */
function ownWaiting(st: State): { amount: bigint; min: number } {
  const mine = st.waiting.filter((w) => w.depositor === st.owner && !st.pays.some((p) => p.inner === w.inner));
  const left = mine.reduce((m, w) => Math.max(m, w.readyAt != null ? Number(w.readyAt) - st.slot : 0), 0);
  return { amount: mine.reduce((s, w) => s + w.amount, 0n), min: engine.slotMinutes(left, true) };
}

/** What a buy form says when the private balance is short: SOL on its way in, an empty balance, or `notEnough`. AddSol follows it. */
export function shortText(st: State, notEnough: string): string {
  const w = ownWaiting(st);
  if (w.amount > 0n) return `${fmt(w.amount)} SOL is joining your private balance, about ${w.min} min left.`;
  if (st.balance === 0n) return st.account === "wallet" ? "Your private balance is empty right now." : EMPTY_WARN;
  return notEnough;
}

/**
 * For a buy the private balance is short of (it needs `need` from it): the difference straight from
 * the connected wallet in one approval, rounded up to 0.0001 SOL, at least the smallest deposit and
 * at most what the wallet can shield. SOL already in the waiting room counts. The form keeps what's
 * typed. Without a wallet (or SOL in it for the smallest deposit), the way to the Shield tab; an empty
 * key account's warning already says so.
 */
export function AddSol({ st, need }: { st: State; need: bigint }) {
  const wallet = useWalletLike();
  const short = need - engine.spendable() - ownWaiting(st).amount;
  if (short <= 0n || (st.account !== "wallet" && st.balance === 0n)) return null;
  const min = BigInt(st.pool?.minDeposit ?? 0);
  const most = engine.maxShield();
  let add = ((short + 99_999n) / 100_000n) * 100_000n;
  if (add < min) add = min;
  if (most != null && add > most) add = most;
  const can = st.account === "wallet" && !!wallet;
  // (what the wallet holds isn't known yet: the button shows in a moment)
  if (can && most == null) return null;
  if (!can || add < min) {
    return (
      <a className="link-btn" href="#shield">
        {IS_EXTENSION ? "Add SOL with Receive" : "Add SOL in the Shield tab"}
      </a>
    );
  }
  return (
    <button type="button" className="link-btn" disabled={!!st.busy || !!st.pool?.depositsPaused} onClick={() => void engine.shield(wallet, add).catch(() => {})}>
      Add {solText(add)} SOL from my wallet
    </button>
  );
}

// ─────────────── Send ───────────────

type Recipient = { id: number; to: string; amt: string; mine: number | null };
const WHENS: { v: When; label: string }[] = [
  { v: "now", label: "Now" },
  { v: "15m", label: "15 min" },
  { v: "1h", label: "1 hour" },
  { v: "24h", label: "24 hours" },
];
/** Paying from the wallet: the payment goes once its deposit has joined the private balance. */
const WALLET_WHENS: { v: When; label: string }[] = [
  { v: "now", label: "As soon as it's ready" },
  { v: "15m", label: "15 minutes" },
  { v: "1h", label: "1 hour" },
  { v: "24h", label: "24 hours" },
];
/** The timing last picked for a payment from the wallet, on this device. */
const WHEN_WALLET = "vs:when-wallet";
const validAddress = (a: string) => {
  try {
    return a.trim() ? new PublicKey(a.trim()).toBase58() : null;
  } catch {
    return null;
  }
};

/** The most payments one press of the button sends. */
const MAX_ROWS = 20;

/**
 * Private sends: one recipient or several (each its own payment), sent now or at random moments
 * within a window, and, if the relayer is ever down, sent yourself. Each payment leaves the list as
 * soon as it has gone (or been scheduled), so pressing the button again only sends the rest. With a
 * wallet connected, one payment can come straight from the wallet instead: it pays one deposit, and
 * the payment goes by itself once that joins the private balance (engine.payFromWallet).
 */
export function SendForm({ st, wallet }: { st: State; wallet?: WalletLike | null }) {
  // recipients the sender confirmed (an address only a program signs for, or one like an earlier recipient's)
  const okOff = useRef(new Set<string>());
  const okLook = useRef(new Set<string>());
  const confirmedFor = (a: string) => ({ ...(okOff.current.has(a) ? { offCurveOk: true } : {}), ...(okLook.current.has(a) ? { lookalikeOk: true } : {}) });
  // what runs again once the sender confirms a recipient: this form's send, or "Send it myself"
  const again = useRef<(() => void) | null>(null);
  const [rows, setRows] = useState<Recipient[]>(() => {
    // a payment request's "Pay privately from it" fills in the first payment, once
    const p = sendPrefill();
    return [{ id: 1, to: p?.to ?? "", amt: p?.amount ?? "", mine: null }];
  });
  useEffect(() => clearSendPrefill(), []);
  const [when, setWhen] = useState<When>("now");
  const offered = st.pool?.sendLater ?? [];
  // where it's paid from: picked once the balance is known (or something is typed), never switched by itself after that
  const touched = useRef(false);
  const [from, setFrom] = useState<"wallet" | "private" | null>(null);
  const nextId = () => Math.max(...rows.map((r) => r.id)) + 1;
  const update = (id: number, patch: Partial<Recipient>) => {
    touched.current = true;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const remove = (id: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs));
  const addMine = () => {
    const base = engine.nextVisionIndex();
    const taken = rows.filter((r) => r.mine !== null).map((r) => r.mine!);
    let i = base;
    while (taken.includes(i)) i++;
    setRows((rs) => [...rs, { id: nextId(), to: engine.visionAddress(i), amt: "", mine: i }]);
  };
  /** fresh wallets this form has claimed for a payment (they stay its own) */
  const claimed = useRef(new Set<number>());
  /** rows whose fresh wallet was swapped when the button was pressed: told why nothing went yet */
  const [swapped, setSwapped] = useState<number[]>([]);
  /** A fresh wallet picked here that a buy has used since moves to the next unused one, so a payment never lands where a buy did. */
  const refreshMine = (rs: Recipient[]) => {
    const ok = (i: number) => claimed.current.has(i) || engine.visionFree(i);
    const keep = new Set(rs.filter((r) => r.mine !== null && ok(r.mine)).map((r) => r.mine!));
    if (rs.every((r) => r.mine === null || keep.has(r.mine))) return rs;
    let i = engine.nextVisionIndex();
    return rs.map((r) => {
      if (r.mine === null || keep.has(r.mine)) return r;
      while (keep.has(i)) i++;
      keep.add(i);
      return { ...r, mine: i, to: engine.visionAddress(i) };
    });
  };
  useEffect(() => setRows(refreshMine), [st.vision]);
  // a payment to an outside address leaves from a new one-time address, which must hold the rent minimum
  // the one-time sending address pays its own fee and must keep nothing or the rent minimum once that is taken: the amount is at least that
  const minPay = st.rent?.wallet ?? 890_880n;
  const spendable = engine.spendable();
  const canWallet = st.account === "wallet" && !!wallet;
  const relayer = !!st.pool?.relayer;
  const synced = st.total > 0 && st.synced >= st.total && !st.syncing;
  // the private balance when it covers the smallest private send, else the wallet
  const fallback = spendable >= engine.quotePay(minPay).withdraw ? "private" : "wallet";
  const typed = touched.current;
  useEffect(() => {
    if (canWallet && from == null && (synced || typed)) setFrom(fallback);
  }, [canWallet, from, synced, typed, fallback]);
  const fromWallet = canWallet && relayer && (from ?? fallback) === "wallet";
  const [pickW, setPickW] = useState<When | null>(() => ls.get<When | null>(WHEN_WALLET, null));
  // a random moment within 15 minutes by default: harder to match to the deposit by when it lands
  const whenWallet: When = pickW && (pickW === "now" || offered.includes(pickW)) ? pickW : offered.includes("15m") ? "15m" : "now";
  const parsed = rows.map((r) => ({ ...r, addr: validAddress(r.to), lamports: parseSol(r.amt) }));
  const ready = parsed.every((r) => r.addr && r.lamports && r.lamports > 0n);
  const quotes = parsed.map((r) => (r.lamports && r.lamports > 0n ? engine.quoteFor(r.addr, r.lamports) : null));
  const sum = (f: (q: NonNullable<(typeof quotes)[number]>) => bigint) => quotes.reduce((s, q) => s + (q ? f(q) : 0n), 0n);
  const later = when !== "now";
  const many = rows.length > 1 && !fromWallet;
  // several payments "now" leave one by one over two minutes, through the relayer
  const spread = !later && many && offered.includes("2m");
  const prep = (later || spread) && ready ? engine.prepCost(quotes.map((q) => q!.withdraw), later) : 0n;
  // one payment sent now from a balance in several pieces: the joins it needs run just before it
  const joinsFirst = !later && !many && ready && quotes[0] ? engine.mergePlan(quotes[0].withdraw).merges : 0;
  const total = sum((q) => q.withdraw) + prep;
  const tooMuch = total > spendable;
  const dupes = new Set(parsed.map((r) => r.addr).filter((a, i, all) => a && all.indexOf(a) !== i));
  // a single payment names its amount on the button, so a mistyped amount is seen before it goes
  const one = !many && parsed[0]?.lamports ? `${fmt(parsed[0].lamports, 9)} SOL ` : "";
  const label = later ? (many ? `Schedule ${rows.length} payments` : `Schedule ${one}payment`) : many ? `Send ${rows.length} payments` : `Send ${one}privately`;
  const own = st.locked - st.aside;
  const outside = parsed.map((r) => !!r.addr && !engine.ownKeypairFor(r.addr));
  const small = parsed.some((r, i) => outside[i] && r.lamports != null && r.lamports > 0n && r.lamports < minPay);
  const perPay = quotes.reduce((m, q) => (q && q.relayerFee + q.deliveryFee > m ? q.relayerFee + q.deliveryFee : m), 0n);
  const ask = st.ask && parsed.some((r) => r.addr === st.ask!.address) ? st.ask : null;
  // paying from the wallet: one outside address, and one deposit of a standard size that covers it (what the payment doesn't use stays private as change)
  const w0 = parsed[0];
  const sized = fromWallet && w0.lamports && w0.lamports >= minPay ? engine.walletPayDeposit(w0.lamports) : null;
  const deposit = sized && "deposit" in sized ? sized.deposit : null;
  const change = sized && "deposit" in sized ? sized.change : 0n;
  const wq = deposit != null ? engine.quotePay(w0.lamports!) : null;
  const walletMost = fromWallet ? engine.walletPayMax() : null;
  // said under the address
  const wAddrProblem = !fromWallet
    ? null
    : w0.addr && w0.addr === st.owner
      ? "That's the wallet you're paying from. Pick another address."
      : w0.addr && engine.ownKeypairFor(w0.addr)
        ? "That's a wallet of this account's own. Pay it from your private balance instead."
        : null;
  const wProblem = !fromWallet
    ? null
    : sized && "problem" in sized
      ? `That's more than one payment from your wallet can be right now.${sized.most > 0n ? ` Try ${fmtDown(sized.most, 6)} SOL or less.` : ""}`
      : deposit != null && st.publicLamports != null && st.rent && engine.shieldCost(deposit) + engine.walletKeep() > st.publicLamports
        ? walletMost != null && walletMost >= minPay
          ? `That takes a standard deposit of ${fmt(deposit, 9)} SOL, more than this wallet holds after fees. Try ${fmtDown(walletMost, 6)} SOL or less.`
          : "This wallet doesn't hold enough SOL for that after fees."
        : null;
  const wReady = fromWallet && !!w0.addr && deposit != null && !wProblem && !wAddrProblem;
  const paused = !!st.pool?.depositsPaused;
  const waitLabel = engine.waitLabel();
  // what the pool holds is read (public, the same for everyone) once there is an amount to weigh against it (VS-15)
  const anyAmount = parsed.some((r) => r.lamports && r.lamports > 0n);
  useEffect(() => {
    if (anyAmount) void engine.refreshPoolValue();
  }, [anyAmount]);
  // gentle notes (VS-04, VS-15): a payment close in size to a recent deposit of this account's, or one taking most of
  // what the pool holds, is easier to match on the chain; each suggests a later time and holds nothing back
  const typedRows = parsed.filter((r) => r.lamports && r.lamports > 0n).slice(0, fromWallet ? 1 : MAX_ROWS);
  const nearSrc = fromWallet ? null : (typedRows.map((r) => engine.nearDepositFor(r.addr, r.lamports!)).find((x) => x)?.src ?? null);
  const nearText = fromWallet
    ? w0.lamports && deposit != null && engine.walletPayNear(w0.lamports)
      ? WALLET_NEAR_TEXT
      : null
    : nearSrc
      ? nearSrc === "vision"
        ? NEAR_SWEPT_TEXT
        : NEAR_TEXT
      : null;
  const share = typedRows.reduce<number | null>((m, r) => {
    const s = engine.poolShare(r.addr, r.lamports!);
    return s == null ? m : Math.max(m ?? 0, s);
  }, null);
  const shareText = share != null && share >= LARGE_SHARE_BPS ? largeShareText(Math.round(share / 100)) : null;
  // the later times offered here: the button picks the shortest one
  const laterPick: When | null = (["15m", "1h", "24h"] as When[]).find((v) => offered.includes(v)) ?? null;
  const goLater =
    laterPick && (fromWallet ? whenWallet === "now" : when === "now")
      ? () => {
          if (!fromWallet) return setWhen(laterPick);
          ls.set(WHEN_WALLET, laterPick);
          setPickW(laterPick);
        }
      : null;
  const submit = async () => {
    again.current = () => void submit();
    if (!ready || tooMuch || dupes.size || small) return;
    // a fresh wallet used meanwhile is swapped first: the new address shows before anything goes
    const fresh = refreshMine(rows);
    setSwapped(fresh.filter((r, i) => r.mine !== rows[i].mine).map((r) => r.id));
    if (fresh !== rows) return setRows(fresh);
    parsed.forEach((r) => {
      if (r.mine === null) return;
      claimed.current.add(r.mine);
      engine.claimVision(r.mine);
    });
    const ids = parsed.map((r) => r.id);
    // a payment with an outcome leaves the list at once: a second press can never pay it again
    const gone = (i: number) =>
      setRows((rs) => {
        const left = rs.filter((r) => r.id !== ids[i]);
        return left.length ? left : [{ id: Math.max(...ids) + 1, to: "", amt: "", mine: null }];
      });
    await engine
      .sendMany(
        parsed.map((r) => ({ to: r.addr!, amount: r.lamports!, fresh: r.mine !== null, ...confirmedFor(r.addr!) })),
        when,
        gone,
      )
      .then(() => setRows([{ id: 1, to: "", amt: "", mine: null }]))
      .catch(() => {});
  };
  const payWallet = async () => {
    again.current = () => void payWallet();
    if (!wallet || !wReady || !w0.addr || !w0.lamports) return;
    // the form empties once the wallet has paid: the payment is listed under Payments on their way
    await engine
      .payFromWallet(wallet, { to: w0.addr, amount: w0.lamports, ...confirmedFor(w0.addr) }, whenWallet)
      .then((sig) => sig && setRows([{ id: 1, to: "", amt: "", mine: null }]))
      .catch(() => {});
  };
  // an account without a wallet and nothing in it yet: the way in is a QR code
  if (st.account === "key" && synced && st.balance === 0n) {
    return (
      <div className="form send-empty">
        <p>Add SOL by QR code from any wallet or exchange, then send from here.</p>
        <a className="btn violet wide" href="#shield">
          Show my QR code
        </a>
      </div>
    );
  }
  const whens = fromWallet ? WALLET_WHENS : WHENS;
  const whenOn = fromWallet ? whenWallet : when;
  return (
    <form
      className="form send-form"
      onSubmit={(e) => {
        e.preventDefault();
        void (fromWallet ? payWallet() : submit());
      }}
    >
      {canWallet && (
        <div className="when">
          <span className="when-title">Pay from</span>
          <div className="seg seg-2" role="group" aria-label="Pay from">
            <button
              type="button"
              aria-pressed={fromWallet}
              className={fromWallet ? "on" : ""}
              disabled={!relayer}
              title={relayer ? undefined : "Paying from your wallet needs the relayer, which isn't available right now."}
              onClick={() => setFrom("wallet")}
            >
              Your wallet<small>{st.publicLamports != null ? `${fmt(st.publicLamports)} SOL` : "\u00a0"}</small>
            </button>
            <button type="button" aria-pressed={!fromWallet} className={!fromWallet ? "on" : ""} onClick={() => setFrom("private")}>
              Private balance<small>{fmt(spendable)} SOL</small>
            </button>
          </div>
          {!relayer && <p className="tiny">Paying from your wallet needs the relayer, which isn't available right now. You can still send from your private balance yourself, below.</p>}
        </div>
      )}
      <div className="recips">
        {(fromWallet ? parsed.slice(0, 1) : parsed).map((r, i) => (
          <div className={`recip${many ? " boxed" : ""}`} key={r.id}>
            <label className="field">
              <span className="field-top">
                <span>{many ? `Payment ${i + 1}` : "Send to"}</span>
                {many && (
                  <button type="button" className="link-btn small" onClick={() => remove(r.id)}>
                    Remove
                  </button>
                )}
              </span>
              <input
                className="addr mono"
                value={r.to}
                onChange={(e) => update(r.id, { to: e.target.value.trim(), mine: null })}
                placeholder="Any Solana address"
                spellCheck={false}
                autoComplete="off"
                readOnly={r.mine !== null}
              />
            </label>
            {r.mine !== null && <p className="mine-tag">Vision wallet #{r.mine + 1} (yours) · it shows in the Wallets tab as soon as it's paid</p>}
            {r.mine !== null && swapped.includes(r.id) && <p className="warn">A buy used the fresh wallet picked here, so this new one takes its place. Check it, then press the button again to send.</p>}
            {r.to && !r.addr && <p className="warn">That doesn't look like a Solana address.</p>}
            {r.addr && r.mine === null && <ListedWarning to={r.addr} />}
            {i === 0 && wAddrProblem && <p className="warn">{wAddrProblem}</p>}
            {!fromWallet && r.addr && r.addr === st.owner && <p className="warn">This is the wallet you shielded from. Sending back to it ties the two together again.</p>}
            {r.addr && dupes.has(r.addr) && !fromWallet && <p className="warn">This address is in the list twice.</p>}
            {outside[i] && r.lamports != null && r.lamports > 0n && r.lamports < minPay && <p className="warn">The smallest private send is {fmtUp(minPay, 5)} SOL.</p>}
            <AmountField
              label="They receive"
              value={r.amt}
              onChange={(v) => update(r.id, { amt: v })}
              max={
                fromWallet
                  ? walletMost != null && walletMost >= minPay
                    ? solText(walletMost)
                    : null
                  : !many && engine.maxSendable() > 0n
                    ? solText(engine.maxSendable())
                    : null
              }
              hint={i === 0 ? (fromWallet ? (st.publicLamports != null ? `Wallet: ${fmt(st.publicLamports)} SOL` : undefined) : `Available: ${fmt(spendable)} SOL`) : undefined}
            />
          </div>
        ))}
        {fromWallet ? (
          <p className="tiny">Several payments at once go from your private balance.</p>
        ) : (
          <>
            <div className="recip-add">
              <button
                type="button"
                className="chip-btn"
                disabled={rows.length >= MAX_ROWS}
                onClick={() => setRows((rs) => [...rs, { id: nextId(), to: "", amt: "", mine: null }])}
              >
                + Add a recipient
              </button>
              <button type="button" className="chip-btn" disabled={rows.length >= MAX_ROWS} onClick={addMine}>
                + A fresh wallet of mine
              </button>
            </div>
            {rows.length >= MAX_ROWS && <p className="tiny">Up to {MAX_ROWS} payments at a time.</p>}
          </>
        )}
      </div>

      <div className="when">
        <span className="when-title">When it goes out</span>
        <div className={`seg when-seg${fromWallet ? " two" : ""}`} role="radiogroup" aria-label="When it goes out">
          {whens.map(({ v, label: l }) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={whenOn === v}
              className={whenOn === v ? "on" : ""}
              disabled={v !== "now" && !offered.includes(v)}
              title={v !== "now" && !offered.includes(v) ? "Sending later needs the relayer, which isn't available right now." : undefined}
              onClick={() => {
                if (!fromWallet) return setWhen(v);
                ls.set(WHEN_WALLET, v);
                setPickW(v);
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <p className="tiny when-note">
          {fromWallet
            ? whenWallet === "now"
              ? `It goes out as soon as it joins your private balance, about ${waitLabel} after you pay.${offered.length ? " A later time is the more private choice: the payment then goes out at a random moment, which is harder to match to your deposit." : ""}`
              : `It goes out at a random moment within ${WHEN_LABEL[whenWallet]} of joining your private balance. That's the more private choice: its timing is much harder to match to your deposit.`
            : later
              ? `${many ? "Each payment goes" : "It goes"} out at a random moment within ${WHEN_LABEL[when]}. Once ${many ? "they show" : "it shows"} Scheduled under Scheduled payments, you can close this page, or cancel before then.`
              : spread
                ? "They go out one by one at random moments over the next 2 minutes, so they don't land together. Once they show Scheduled under Scheduled payments, you can close this page."
                : !offered.length
                  ? "Sending later needs the relayer, which isn't available right now."
                  : "Sending later, at a random moment, makes your payment harder to match to your deposit by when it lands."}
        </p>
        <PrivacyNotes texts={[nearText, shareText]} onLater={goLater} />
      </div>

      {fromWallet && wq && deposit != null && (
        <>
          <Rows
            rows={[
              ["They receive", `${fmt(w0.lamports!, 9)} SOL`],
              ["Pool fees", `${fmt(engine.depositFee(deposit) + wq.protocolFee, 6)} SOL`],
              ["Relayer and network", `${fmt(wq.relayerFee + wq.deliveryFee, 6)} SOL`],
              ["Stays in your private balance", `${fmt(change, 6)} SOL`],
              ["Taken from your wallet", `${fmt(deposit + engine.depositFee(deposit), 6)} SOL`, "total"],
            ]}
          />
          <p className="tiny">
            Your wallet deposits a standard amount, {fmt(deposit, 9)} SOL, rather than the payment's exact cost, so the deposit doesn't mirror the
            payment. The {fmt(change, 6)} SOL it doesn't use stays in your private balance
            {whenWallet === "now" ? ", ready for your next payment." : ", free to spend once the payment has gone out."}
          </p>
        </>
      )}
      {!fromWallet && joinsFirst > 0 && offered.includes("15m") && (
        <p className="tiny">
          Your private balance is in several pieces, so sending now first joins them, one pool transaction per join, right before the payment. A
          later time is the more private choice: the joins are spaced out, and the payment goes at a random moment afterwards.
        </p>
      )}
      {!fromWallet && ready && (
        <Rows
          rows={[
            ...(many ? ([["Payments", `${rows.length}, each its own transaction`, "txt"]] as [string, string, string][]) : []),
            [`Pool fee (${pct(engine.feeBps())})`, `${fmt(sum((q) => q.protocolFee), 6)} SOL`],
            [many ? "Relayer and network (each)" : "Relayer and network", `${fmt(perPay, 6)} SOL`],
            ...(prep > 0n ? ([[later ? "Setting aside the exact amount" : "Preparing separate notes", `${fmt(prep, 6)} SOL`]] as [string, string][]) : []),
            ["Taken from your private balance", `${fmt(total, 6)} SOL`, "total"],
          ]}
        />
      )}
      {fromWallet && wProblem && <p className="warn">{wProblem}</p>}
      {!fromWallet && own > 0n && <p className="tiny">{fmt(own)} SOL is set aside for scheduled payments and can't be spent until they go out or you cancel them.</p>}
      {!fromWallet && st.aside > 0n && <p className="tiny">{fmt(st.aside)} SOL is set aside for a scheduled payment made on another of your devices.</p>}
      {!fromWallet && tooMuch && ready && (
        <p className="warn">
          {st.balance > 0n
            ? "Not enough private balance for that, including fees."
            : canWallet && relayer
              ? 'Your private balance is empty. Choose "Your wallet" above to pay straight from your wallet.'
              : EMPTY_WARN}
        </p>
      )}
      {many && parsed.some((r, i) => outside[i] && r.lamports != null && r.lamports > 0n && r.lamports < 100_000_000n) && (
        <p className="tiny">Each part arrives as its own deposit. Exchanges usually credit deposits of 0.1 SOL or more.</p>
      )}
      {ask && (
        <AskBox
          ask={ask}
          onYes={() => {
            (ask.kind === "off-curve" ? okOff : okLook).current.add(ask.address);
            engine.clearAsk();
            again.current?.();
          }}
          onNo={() => engine.clearAsk()}
        />
      )}
      {fromWallet ? (
        <>
          <button className="btn violet wide" disabled={!wReady || paused || !!st.busy || st.update || !!ask}>
            {paused ? "Deposits are paused" : `Pay ${one}privately`}
          </button>
          <p className="tiny">
            Your wallet approves one deposit. It joins your private balance in about {waitLabel}, then goes to the recipient from the pool as a
            standard SOL transfer, so the payment itself comes from the pool, not your wallet. Keep this page open until it's handed to the relayer; if you
            close it, it picks up next time you open VisionSwap on this device.
          </p>
          <p className="tiny">
            Plus Solana's network fee, a fraction of a cent, and a {st.rent ? fmt(st.rent.pending, 4) : "small"} SOL account deposit that comes back
            to your wallet when your SOL joins the pool.
          </p>
        </>
      ) : (
        <>
          <button className="btn violet wide" disabled={!ready || tooMuch || dupes.size > 0 || small || !!st.busy || st.update || !!ask}>
            {label}
          </button>
          <p className="tiny">
            A relayer submits {many ? "each payment" : "it"} for you, so your wallet never shows up next to the payment. Every private payment to
            another wallet or an exchange arrives as a standard SOL transfer from a one-time sending address; if an exchange asks, give it the
            Transaction ID from your activity.
          </p>
          <SelfSend
            st={st}
            to={parsed[0]?.addr ?? null}
            amount={parsed[0]?.lamports ?? null}
            single={!many}
            confirmed={confirmedFor}
            again={again}
          />
        </>
      )}
    </form>
  );
}

/**
 * Notes before a payment that would be easy to match on the chain (VS-04, VS-15): said calmly, with a
 * way to send it later instead while "Now" is picked. Nothing is held back: the choice stays the sender's.
 */
function PrivacyNotes({ texts, onLater }: { texts: (string | null)[]; onLater: (() => void) | null }) {
  const shown = texts.filter((t): t is string => !!t);
  if (!shown.length) return null;
  return (
    <div className="privacy-notes" role="note">
      {shown.map((t) => (
        <p className="tiny" key={t}>
          {t}
        </p>
      ))}
      {onLater && (
        <button type="button" className="link-btn small" onClick={onLater}>
          Send it later instead
        </button>
      )}
    </div>
  );
}

type FeeWallet = { index: number; address: string; lamports: bigint; used: boolean };

/**
 * The backup for a relayer outage: the person's own fee payer submits the payment. The proof
 * names that payer, and the payment pays it back, so it only needs a little SOL up front. Each
 * payment sent this way gets a new fee wallet of its own.
 */
/** A recipient to confirm before the payment goes: an address only a program signs for, or one that looks like an earlier recipient's. */
function AskBox({ ask, onYes, onNo }: { ask: NonNullable<State["ask"]>; onYes: () => void; onNo: () => void }) {
  return (
    <div className="ask-box" role="group" aria-label="Check the recipient">
      <p className="small">{ask.text}</p>
      {ask.kind === "lookalike" && ask.similar ? (
        <dl className="ask-addrs">
          <div>
            <dt>This payment</dt>
            <dd className="mono">{ask.address}</dd>
          </div>
          <div>
            <dt>You paid before</dt>
            <dd className="mono">{ask.similar}</dd>
          </div>
        </dl>
      ) : (
        <p className="mono ask-one">{ask.address}</p>
      )}
      <div className="ask-actions">
        <button type="button" className="btn small-btn" onClick={onYes}>
          {ask.kind === "lookalike" ? "It's the right address" : "Continue"}
        </button>
        <button type="button" className="link-btn" onClick={onNo}>
          Edit the address
        </button>
      </div>
    </div>
  );
}

function SelfSend({
  st,
  to,
  amount,
  single,
  confirmed,
  again,
}: {
  st: State;
  to: string | null;
  amount: bigint | null;
  single: boolean;
  /** the recipients the sender confirmed, read when the payment goes (never as they were when the form last drew) */
  confirmed: (address: string) => { offCurveOk?: boolean; lookalikeOk?: boolean };
  again: { current: (() => void) | null };
}) {
  const [open, setOpen] = useState(() => !!st.pool && !st.pool.relayer);
  const [payer, setPayer] = useState<string | null>(null);
  const [fees, setFees] = useState<FeeWallet[] | null>(null);
  const [copied, setCopied] = useState(false);
  const need = engine.selfCost() + 1_000_000n;
  // the relayer can fund a fee wallet from the private balance while it still works
  const canFund = !!st.pool?.relayer && engine.spendable() > need * 2n;
  const active = useTabActive();
  const ready = open && st.unlocked;
  // the account's fee wallets, looked up once when the panel opens (and again after a payment, or on "Try again")
  const sentCount = st.activity.length;
  const [feesErr, setFeesErr] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!ready) return;
    let dead = false;
    setFeesErr(false);
    engine
      .feeWallets()
      .then((w) => !dead && setFees(w))
      .catch(() => !dead && setFeesErr(true));
    return () => {
      dead = true;
    };
  }, [ready, sentCount, retry]);
  // a first lookup that failed tries again by itself every 20 s while the panel is on screen (a failed
  // re-lookup keeps the list already shown, and waits for the next payment or "Try again")
  const haveFees = !!fees;
  useEffect(() => {
    if (!ready || !feesErr || haveFees || !active) return;
    const t = setInterval(() => !document.hidden && setRetry((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, [ready, feesErr, haveFees, active]);
  const fresh = fees?.find((f) => !f.used && f.index === engine.gasIndex()) ?? null;
  // the fee wallet picked (or the fresh one) is re-read every few seconds while it is being funded and on screen
  const watched = payer?.startsWith("g") ? fees?.find((f) => `g${f.index}` === payer) : fresh;
  const funding = !!watched && watched.lamports < need;
  useEffect(() => {
    if (!ready || !watched || !funding || !active) return;
    let dead = false;
    const read = () => {
      if (document.hidden) return;
      conn()
        .getBalance(new PublicKey(watched.address), "confirmed")
        .then((l) => !dead && setFees((fs) => fs?.map((f) => (f.index === watched.index ? { ...f, lamports: BigInt(l) } : f)) ?? fs))
        .catch(() => {});
    };
    const t = setInterval(read, 5000);
    // back on the tab: catch up at once
    const back = () => !document.hidden && read();
    document.addEventListener("visibilitychange", back);
    return () => {
      dead = true;
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
    };
  }, [ready, watched?.address, funding, active]);
  // only fee wallets that never sent a payment: a second payment from one would show the same payer as the first
  // (and never a Vision wallet, whose trades would then be tied to this payment)
  const usedBefore = (fees ?? []).filter((f) => f.used);
  const choices: [string, string, boolean][] = (fees ?? [])
    .filter((f) => !f.used)
    .map((f) => [`g${f.index}`, `${f.index === engine.gasIndex() ? "A new fee wallet" : `Fee wallet #${f.index + 1}`} · ${fmt(f.lamports, 4)} SOL`, f.lamports >= need] as [string, string, boolean]);
  // until one is picked: a fee wallet that's ready, else the new one
  const chosen = (payer && choices.some(([k]) => k === payer) ? payer : null) ?? choices.find(([, , ok]) => ok)?.[0] ?? (fresh ? `g${fresh.index}` : null);
  const pick = choices.find(([k]) => k === chosen);
  const gas = chosen?.startsWith("g") ? fees?.find((f) => `g${f.index}` === chosen) : null;
  const go = () => {
    if (!to || !amount || !chosen) return;
    again.current = go;
    const p: SelfPayer = { kind: "gas", index: Number(chosen.slice(1)) };
    void engine
      .sendSelf(to, amount, p, confirmed(to))
      .then(() => setPayer(null))
      .catch(() => {});
  };
  return (
    <details className="self-send" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Relayer down? Send it yourself</summary>
      <div className="self-body">
        <p className="small">
          If the relayer is out of service but this page works, a fee wallet of yours can submit the payment instead. It needs about {fmtUp(need, 4)} SOL up
          front and gets its costs back from the payment. The money still comes from the pool, and each payment you send this way uses a new fee wallet.
          If your balance has to be joined first, the same fee wallet sends those joins too, so they show the same payer on the chain as the payment.
        </p>
        {!!st.pool?.relayer && (
          <p className="small muted">
            Tip: you can fund a fee wallet ahead of time, while the relayer works (“Fund it from my private balance” below), so it's ready if you ever need it.
          </p>
        )}
        {usedBefore.some((f) => f.lamports > 0n) && (
          <p className="small muted">
            Fee wallets that already sent a payment aren't offered again: a second payment from one would show both came from the same person.
          </p>
        )}
        {!single && <p className="warn">Send it yourself takes one payment at a time: keep just one recipient.</p>}
        {!fees &&
          (feesErr ? (
            <p className="small warn">
              Couldn't look up your fee wallets just now.{" "}
              <button type="button" className="link-btn" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </button>
            </p>
          ) : (
            <p className="small muted">Looking up your fee wallets…</p>
          ))}
        <div className="payer-list" role="radiogroup" aria-label="Fee payer">
          {choices.map(([k, l, ok]) => (
            <label key={k} className={`payer${chosen === k ? " on" : ""}`}>
              <input type="radio" name="payer" checked={chosen === k} onChange={() => setPayer(k)} />
              <span>{l}</span>
              {!ok && <em>needs {fmtUp(need, 4)} SOL</em>}
            </label>
          ))}
        </div>
        {gas && gas.lamports < need && (
          <div className="gas-box">
            <span className="small muted">
              Send about {fmtUp(need, 4)} SOL to this fee wallet with a withdrawal from an exchange
              {canFund ? ", or use “Fund it from my private balance”" : ""}. Don't send it from the wallet you add SOL to
              VisionSwap with: that would show this payment came from you. It gets its costs back from the payment.
            </span>
            <code className="mono" translate="no">
              {gas.address}
            </code>
            <div className="gas-actions">
              <button
                type="button"
                className="btn ghost small-btn"
                onClick={async () => {
                  setCopied(await copyText(gas.address));
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? "Copied" : "Copy address"}
              </button>
              {canFund && (
                <button
                  type="button"
                  className="btn ghost small-btn"
                  disabled={!!st.busy}
                  onClick={() => void engine.fundFeeWallet(gas.index, need).catch(() => {})}
                >
                  Fund it from my private balance
                </button>
              )}
            </div>
          </div>
        )}
        <button type="button" className="btn ghost wide" disabled={!single || !to || !amount || !pick?.[2] || !!st.busy || st.update} onClick={go}>
          Send it myself
        </button>
      </div>
    </details>
  );
}

// ─────────────── Buy ───────────────

type Quote = { inAmount: string; outAmount: string; minOut: string; priceImpactPct: number; route: string[]; feeBps: number; transferFeeBps?: number; check?: TradeCheck };

/** The price tolerance setting: "auto" or a fixed number of bps. */
type SlipMode = "auto" | number;
const resolveSlip = (mode: SlipMode, t: { mint: string; liquidity?: number | null } | null | undefined) => (mode === "auto" ? autoSlippage(t) : mode);

/** The trade checks' settings on this device: how far a batch's price may move, and whether trades moving the price more than 15% may be asked about. */
type GuardPrefs = { driftBps: number; unlocked: boolean };
function useGuardPrefs(): [GuardPrefs, (p: Partial<GuardPrefs>) => void] {
  const [p, set] = useState<GuardPrefs>(() => ({ driftBps: clampDrift(ls.get<number>("vs:drift", DRIFT_DEFAULT_BPS)), unlocked: ls.get<boolean>("vs:bigmoves", false) === true }));
  return [
    p,
    (x) => {
      const next = { ...p, ...x, driftBps: clampDrift(x.driftBps ?? p.driftBps) };
      ls.set("vs:drift", next.driftBps);
      ls.set("vs:bigmoves", next.unlocked);
      set(next);
    },
  ];
}

/**
 * What a quote's check says about the trade: the taxes and launch curve built into the route, and
 * a note, a question or a refusal when its price is off (see guard.ts). An older server with no
 * check: the token's own tax and the price impact, as before.
 */
function TaxNote({ q, symbol, mint, side, unlocked }: { q: Quote; symbol: string; mint: string; side: "buy" | "sell"; unlocked: boolean }) {
  const c = q.check;
  const others = c ? [...Object.keys(c.taxes), ...(c.curve ? [c.curve.pair] : []), ...Object.keys(c.taxSoon ?? {})].filter((m) => m !== mint) : [];
  const meta = useTokenMeta([...new Set(others)]);
  const name = (m: string) => (m === mint ? symbol : (meta[m]?.symbol ?? short(m)));
  if (!c) {
    const tax = q.transferFeeBps ?? 0;
    const impact = Math.max(0, q.priceImpactPct - tax / 100);
    return (
      <>
        {tax > 0 && (
          <p className="muted small tax-note">
            {symbol} charges a {pct(tax)} tax on every transfer. It's taken by the token itself, and the amount above already allows for it.
          </p>
        )}
        {impact > 3 && <p className="warn">This trade moves the price by {impact.toFixed(1)}%. Consider a smaller amount.</p>}
      </>
    );
  }
  const say = checkSay(c, { symbol, side, unlocked });
  const cost = costSay(c, name);
  return (
    <>
      {cost && <p className={cost.warn ? "small warn tax-note" : "muted small tax-note"}>{cost.text}</p>}
      {say && <p className="warn">{say.text}</p>}
    </>
  );
}

/** The quote's fine print, always in view on one quiet line: what arrives and the least that may, how far the price is from the market, and the route. */
function QuoteFacts({ q, expected, minOut }: { q: Quote; expected: string; minOut: string }) {
  const impact = q.check ? q.check.impactPct : Math.max(0, q.priceImpactPct - (q.transferFeeBps ?? 0) / 100);
  const market = q.check?.marketPct;
  return (
    <dl className="quote-facts">
      <div>
        <dt>Expected</dt>
        <dd className="num">{expected}</dd>
      </div>
      <div>
        <dt>Minimum you'll receive</dt>
        <dd className="num">{minOut}</dd>
      </div>
      <div>
        <dt>Price impact</dt>
        <dd className="num">{q.check?.impactUnknown ? "can't tell right now" : impact < 0.01 ? "under 0.01%" : `${impact.toFixed(2)}%`}</dd>
      </div>
      {q.check && (
        <div>
          <dt>Against the market price</dt>
          <dd className="num">{market == null ? "no market price found" : market <= 0.5 ? "in line" : `${pctText(market)} less`}</dd>
        </div>
      )}
      <div>
        <dt>Route</dt>
        <dd>{q.route.slice(0, 3).join(" → ") || "Jupiter"}</dd>
      </div>
    </dl>
  );
}

/** A token symbol short enough for a button on a small phone; the full one goes in the button's title. */
export const shortSym = (s: string) => (s.length > 12 ? `${s.slice(0, 11)}…` : s);

/** A fresh price about every 15 seconds while the form is on screen and nothing else is going on. */
const REQUOTE_MS = 15_000;

function useQuote(params: { inputMint: string; outputMint: string; amount: bigint | null; slippageBps: number; side: "buy" | "sell" } | null, onScreen: boolean) {
  // a form kept on a tab that isn't showing doesn't refresh its price
  const live = useTabActive() && onScreen;
  const [q, setQ] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const at = useRef(0);
  const flying = useRef(false);
  const shownKey = useRef("");
  const key = params && params.amount ? `${params.inputMint}|${params.outputMint}|${params.amount}|${params.slippageBps}|${params.side}` : "";
  // refreshing: one request at a time, none while the tab is hidden, and straight away on coming back to a stale one
  useEffect(() => {
    if (!key || !live) return;
    const due = () => !document.hidden && !flying.current && Date.now() - at.current >= REQUOTE_MS;
    const t = setInterval(() => due() && setTick((n) => n + 1), 3_000);
    const back = () => due() && setTick((n) => n + 1);
    document.addEventListener("visibilitychange", back);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", back);
    };
  }, [key, live]);
  useEffect(() => {
    const fresh = key !== shownKey.current;
    if (fresh) {
      shownKey.current = key;
      setQ(null);
      setErr(null);
    }
    if (!params || !params.amount) return;
    let dead = false;
    const t = setTimeout(
      async () => {
        flying.current = true;
        if (fresh) setLoading(true);
        try {
          const qs = {
            inputMint: params.inputMint,
            outputMint: params.outputMint,
            amount: params.amount!.toString(),
            slippageBps: String(params.slippageBps),
            side: params.side,
          };
          // Jupiter's allowance is shared: when it is busy, wait as long as the server asks and ask again
          let r: Quote | null = null;
          for (let attempt = 0; !r; attempt++) {
            try {
              r = await lookup<Quote>("/api/swap/quote", qs);
            } catch (e) {
              const { status, retryAfter } = e as { status?: number; retryAfter?: number | null };
              const wait = retryAfter ? retryAfter * 1000 : 2500 + attempt * 1500;
              // a refresh that can't get through just keeps the price shown (the buy checks it again before anything moves)
              if (dead || !fresh || status !== 429 || attempt >= 3 || wait > 30_000) throw e;
              await new Promise((res) => setTimeout(res, wait));
              if (dead) return;
            }
          }
          if (!dead) {
            setQ(r);
            setErr(null);
          }
        } catch (e) {
          if (!dead && fresh) setErr((e as Error).message);
        } finally {
          at.current = Date.now();
          flying.current = false;
          if (!dead) setLoading(false);
        }
      },
      fresh ? 350 : 0,
    );
    return () => {
      dead = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return { q, err, loading };
}

const SLIP_PRESETS: SlipMode[] = ["auto", 50, 100, 300, 500, 1000];

/** The speed picked last time, on this device. */
function useSpeed(): [Speed, (s: Speed) => void] {
  const [speed, set] = useState<Speed>(() => speedOf(ls.get<string>("vs:speed", "normal")));
  return [
    speed,
    (s) => {
      ls.set("vs:speed", s);
      set(s);
    },
  ];
}

/**
 * Price room and speed, tucked into one small row: the summary shows what's set, and opening it
 * offers presets, a custom room (0.1% to 25%) and the speed.
 */
function TradeSettings({
  mode,
  bps,
  onMode,
  speed,
  onSpeed,
  prefs,
  onPrefs,
  batch,
}: {
  mode: SlipMode;
  bps: number;
  onMode: (v: SlipMode) => void;
  speed: Speed;
  onSpeed: (s: Speed) => void;
  prefs: GuardPrefs;
  onPrefs: (p: Partial<GuardPrefs>) => void;
  /** several wallets: the batch price guard is offered */
  batch: boolean;
}) {
  // open or closed as it was left last time, on this device
  const [open, setOpen] = useState(() => ls.get<boolean>("vs:tradeset", false));
  const [custom, setCustom] = useState(typeof mode === "number" && !SLIP_PRESETS.includes(mode) ? String(mode / 100) : "");
  const typed = normAmount(custom);
  const n = typed ? Number(typed) : NaN;
  const bad = custom !== "" && !(n >= 0.1 && n <= 25);
  const label = SPEEDS.find((s) => s.v === speed)!.label;
  return (
    <details
      className="trade-set"
      open={open}
      onToggle={(e) => {
        const o = (e.target as HTMLDetailsElement).open;
        setOpen(o);
        ls.set("vs:tradeset", o);
      }}
    >
      <summary>
        <span>
          Price room <strong>{mode === "auto" ? `Auto · ${pct(bps)}` : pct(bps)}</strong>
        </span>
        <span>
          Speed <strong>{label}</strong>
        </span>
      </summary>
      <div className="trade-set-body">
        <div className="slip" role="radiogroup" aria-label="Price room">
          <span>Price room</span>
          {SLIP_PRESETS.map((v) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={mode === v}
              className={mode === v ? "on" : ""}
              onClick={() => {
                setCustom("");
                onMode(v);
              }}
            >
              {v === "auto" ? "Auto" : pct(v)}
            </button>
          ))}
          <label className={`slip-custom${typeof mode === "number" && !SLIP_PRESETS.includes(mode) ? " on" : ""}`}>
            <input
              inputMode="decimal"
              placeholder="Custom"
              aria-label="Custom price room in percent"
              value={custom}
              onChange={(e) => {
                const v = e.target.value.slice(0, 5);
                setCustom(v);
                const t = normAmount(v);
                const x = t ? Number(t) : NaN;
                if (x >= 0.1 && x <= 25) onMode(Math.round(x * 100));
              }}
            />
            %
          </label>
        </div>
        {bad && <p className="field-hint">Choose between 0.1% and 25%.</p>}
        {!bad && bps < 30 && <p className="muted small">With this little room, a moving price can stop the trade from going through.</p>}
        <div className="slip" role="radiogroup" aria-label="Speed">
          <span>Speed</span>
          {SPEEDS.map((s) => (
            <button key={s.v} type="button" role="radio" aria-checked={speed === s.v} className={speed === s.v ? "on" : ""} onClick={() => onSpeed(s.v)}>
              {s.label}
            </button>
          ))}
        </div>
        <p className="muted small">
          {speed === "normal"
            ? "Normal pays the usual small network fee. A try that doesn't land is retried with a little more."
            : `${label} pays a network priority fee of at most ${fmt(SPEED_CAP[speed], 4)} SOL, so the trade lands sooner when Solana is busy.`}
        </p>
        {batch && (
          <>
            <div className="slip" role="radiogroup" aria-label="Batch price guard">
              <span>Batch price guard</span>
              {DRIFT_CHOICES.map((v) => (
                <button key={v} type="button" role="radio" aria-checked={prefs.driftBps === v} className={prefs.driftBps === v ? "on" : ""} onClick={() => onPrefs({ driftBps: v })}>
                  {driftLabel(v)}
                </button>
              ))}
            </div>
            <p className="muted small">
              A batch pauses and asks you if a wallet's price is more than {prefs.driftBps / 100}% worse than the price you approved, and no wallet can
              get less than that.
            </p>
          </>
        )}
        <label className="check">
          <input type="checkbox" checked={prefs.unlocked} onChange={(e) => onPrefs({ unlocked: e.target.checked })} />
          <span>
            Allow trades that move the price more than {IMPACT_BLOCK_PCT}%
            <span className="check-hint">Off unless you turn it on. Such a trade still asks you first, and a route priced far from the market is never made.</span>
          </span>
        </label>
      </div>
    </details>
  );
}

/** The price a batch's last wallet gets (it pays the most: the batch's earlier wallets move the price first), from the whole quote and one without its part. */
function lastRateOf(q: Quote | null, q2: Quote | null) {
  if (!q) return null;
  return lastRate({ in: BigInt(q.inAmount), out: BigInt(q.outAmount) }, q2 ? { in: BigInt(q2.inAmount), out: BigInt(q2.outAmount) } : null);
}

/** The plain warnings before a batch into a thin, new or fast-moving token, one line each. */
function BatchRisk({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="batch-risk">
      {lines.map((l) => (
        <p key={l} className="small warn">
          {l}
        </p>
      ))}
    </div>
  );
}

/** "Spread across N new wallets": how many new Vision wallets one buy from the private balance can fill. */
const SPREAD = [1, 2, 3, 5, 10];

export function BuyForm({ st }: { st: State }) {
  const [token, setToken] = useState<Token | null>(null);
  const [amt, setAmt] = useState("");
  const [mode, setMode] = useState<SlipMode>("auto");
  const [speed, setSpeed] = useSpeed();
  const [pacing, setPacing] = usePacing();
  const [prefs, setPrefs] = useGuardPrefs();
  const [vary, setVary] = useState(true);
  const [spread, setSpread] = useState(1);
  const [each, setEach] = useState<"same" | "all">("same");
  // "Buy a token" on Vision wallets (a row, or the ticked ones): those wallets pay instead of the private balance
  const picked = useBuyFrom();
  const [payWith, setPayWith] = useState<"private" | "vision">(picked.length ? "vision" : "private");
  const [ticked, setTicked] = useState<number[]>(picked);
  useEffect(() => {
    if (!picked.length) return;
    setPayWith("vision");
    setTicked(picked);
    setAmt("");
  }, [picked]);

  // wallets that can buy with their own SOL (none an unfinished batch still has to do), in their fixed order
  const spoken = batchWallets(st.batch);
  const ready = st.vision.filter((v) => engine.buyable(v) && !spoken.includes(v.index)).sort((a, b) => a.index - b.index);
  // the choice stays put while a batch has the wallets busy (it never turns into a private-balance buy by itself)
  const vision = payWith === "vision" && (ready.length > 0 || spoken.length > 0);
  const chosen = vision ? ready.filter((v) => ticked.includes(v.index)) : [];
  const reserve = visionReserve(token?.program);
  const rooms = chosen.map((v) => (v.lamports > reserve ? v.lamports - reserve : 0n));
  const lamports = parseSol(amt);
  const all = vision && each === "all";
  const n = vision ? chosen.length : spread;
  const multi = n > 1;
  const sweepMin = engine.sweepMin();
  // the least each part may be: with "Vary each amount a little" no part goes below it when the amount allows
  const least = partMin(sweepMin, reserve);
  // what each wallet spends, picked once for what's typed, so the figures shown are the ones used
  const chosenKey = chosen.map((v) => (all ? `${v.index}:${v.lamports}` : v.index)).join(",");
  const parts = useMemo(() => {
    if (vision) {
      if (all) return allOfIt(chosen.map((v) => v.lamports), reserve);
      return lamports && lamports > 0n && chosen.length ? eachAmounts(lamports, chosen.length, vary && chosen.length > 1, secureRandom, lamports >= least ? least : 0n) : [];
    }
    return lamports && lamports > 0n ? splitAmounts(lamports, spread, vary && spread > 1, secureRandom, least) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vision, all, chosenKey, reserve, lamports, vary, spread, least]);
  const total = parts.reduce((s, a) => s + a, 0n);
  // one quote for the whole buy, and (several wallets) one without the last wallet's part: the difference is the
  // price the last wallet gets, which every wallet's turn is then held to
  const slip = resolveSlip(mode, token);
  const { q, err, loading } = useQuote(token && total > 0n ? { inputMint: SOL_MINT, outputMint: token.mint, amount: total, slippageBps: slip, side: "buy" } : null, !st.busy);
  const lastPart = multi && parts.length > 1 ? parts[parts.length - 1] : 0n;
  const { q: q2 } = useQuote(token && lastPart > 0n && total > lastPart ? { inputMint: SOL_MINT, outputMint: token.mint, amount: total - lastPart, slippageBps: slip, side: "buy" } : null, !st.busy);
  const last = multi ? lastRateOf(q, q2) : null;
  const sym0 = token ? shortSym(token.symbol) : "";
  const say = token ? checkSay(q?.check, { symbol: sym0, side: "buy", unlocked: prefs.unlocked }) : null;
  const curvePair = useTokenMeta(q?.check?.curve ? [q.check.curve.pair] : [])[q?.check?.curve?.pair ?? ""]?.symbol ?? (q?.check?.curve ? short(q.check.curve.pair) : null);
  const risks = multi && token ? batchWarnings({ symbol: token.symbol, liquidity: token.liquidity, created: token.created, change1h: token.change1h, inUsd: q?.check?.inUsd, curvePair }) : [];

  // from the private balance: one payment into each new wallet, its amount plus the wallet's reserve
  const sends = !vision ? parts.map((a) => engine.quoteSend(a + reserve)) : [];
  const withdraw = sends.reduce((s, x) => s + x.withdraw, 0n);
  const biggest = sends.reduce((m, x) => (x.withdraw > m ? x.withdraw : m), 0n);
  // a balance in many pieces is joined first, and each join costs a relayer fee: counted before anything is paid
  const plan = sends.length ? engine.mergePlan(multi ? biggest : withdraw) : null;
  const taken = withdraw + (plan?.ok ? plan.cost : 0n);
  const over = vision ? parts.findIndex((a, i) => a > rooms[i]) : -1;
  const tooMuch = vision ? over >= 0 : !!plan && (!plan.ok || taken > engine.spendable());
  const small = multi && parts.some((a) => a < least);
  const most = vision ? (chosen.length === 1 ? rooms[0] : 0n) : multi ? 0n : engine.maxSpend(reserve);
  const tiny = !multi && !!lamports && sweepMin != null && lamports + reserve < sweepMin;
  const batchBusy = multi && batchLive(st.batch);
  const sym = token ? shortSym(token.symbol) : "";
  const next = chosen.length === 1 ? chosen[0].index + 1 : engine.nextVisionIndex() + 1;
  const names = engine.visionNames();
  const allTicked = ready.length > 0 && ready.slice(0, BATCH_MAX).every((v) => ticked.includes(v.index));
  // one batch takes up to BATCH_MAX wallets (more can be ticked from the Wallets tab)
  const tooMany = n > BATCH_MAX ? n - BATCH_MAX : 0;
  const blocked = !token || !parts.length || total <= 0n || tooMuch || small || batchBusy || !!st.busy || !q || (vision && !chosen.length) || tooMany > 0 || say?.tone === "stop";
  /** The buy, once the person has said yes to what its review asked (if it asked anything). */
  const go = async (said: boolean) => {
    if (blocked || !token || !q) return;
    const minOut = BigInt(q.minOut);
    const approval = approvalOf(q.check, { said, unlocked: prefs.unlocked });
    if (!multi) {
      const guard: TradeGuard = { ...approval, ...(q.check ? { taxes: q.check.taxes } : {}) };
      const o = { speed, minOut, symbol: sym, guard };
      await (vision
            ? engine.buyFrom(chosen[0].index, token.mint, parts[0], slip, mode === "auto", token.program, o)
          : engine.buy(token.mint, parts[0], slip, mode === "auto", token.program, o)
      )
        .then(() => {
          setAmt("");
          if (vision) buyFromVision([]);
        })
        .catch(() => {});
      return;
    }
    // every wallet's turn is held to the last wallet's price as shown, within the batch price guard
    const ref = last ?? { in: BigInt(q.inAmount), out: BigInt(q.outAmount) };
    const ok = engine.startBatch({
      kind: vision ? "buyFrom" : "buyNew",
      pacing,
      mint: token.mint,
      symbol: token.symbol,
      decimals: token.decimals,
      program: token.program,
      slippageBps: slip,
      auto: mode === "auto",
      speed,
      ...(all ? { all: true } : {}),
      refIn: ref.in.toString(),
      refOut: ref.out.toString(),
      driftBps: prefs.driftBps,
      unlocked: prefs.unlocked,
      ...(approval.okLoss != null ? { okLoss: approval.okLoss } : {}),
      ...(approval.okNoPrice ? { okNoPriceAt: 0 } : {}),
      ...(q.check ? { taxes: q.check.taxes } : {}),
      items: parts.map((a, k) => ({
        ...(vision ? { index: chosen[k].index } : {}),
        amount: a.toString(),
        status: "waiting" as const,
      })),
    });
    if (!ok) return;
    setAmt("");
    setTicked([]);
    buyFromVision([]);
    toBatchCard();
  };
  const buyLabel = !token ? "Buy privately" : multi ? (vision ? `Buy ${sym} with ${n} wallets` : `Buy ${sym} in ${n} new wallets`) : `Buy ${sym} privately`;
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        // only the Buy button buys: never an Enter typed into the token search
        if (document.activeElement?.closest(".tok-pop")) return;
        // a review that asks something is answered on its button, never by Enter
        if (say?.tone === "ask") return;
        await go(false);
      }}
    >
      {(ready.length > 0 || vision) && (
        <div className="when">
          <span className="when-title">Pay with</span>
          <div className="seg seg-2" role="group" aria-label="Pay with">
            <button type="button" aria-pressed={!vision} className={!vision ? "on" : ""} onClick={() => setPayWith("private")}>
              Private balance<small>{fmt(engine.spendable())} SOL</small>
            </button>
            <button type="button" aria-pressed={vision} className={vision ? "on" : ""} disabled={!ready.length} onClick={() => setPayWith("vision")}>
              My Vision wallets ({ready.length})
              <small>
                {ready.length
                  ? `${fmt(
                      ready.reduce((s, v) => s + v.lamports, 0n),
                      4,
                    )} SOL in them`
                  : "busy in a batch"}
              </small>
            </button>
          </div>
        </div>
      )}
      <div className="field">
        <span className="field-top">
          <span>Token</span>
        </span>
        <TokenPicker value={token} onChange={setToken} />
      </div>
      {vision && (
        <div className="field">
          <span className="field-top">
            <span>Wallets to buy with</span>
            {ready.length > 1 && (
              <button type="button" className="link-btn small" onClick={() => setTicked(allTicked ? [] : ready.slice(0, BATCH_MAX).map((v) => v.index))}>
                {allTicked ? "Clear" : "Select all"}
              </button>
            )}
          </span>
          <ul className="pick">
            {ready.map((v) => {
              const k = chosen.findIndex((c) => c.index === v.index);
              const room = v.lamports > reserve ? v.lamports - reserve : 0n;
              const full = k < 0 && chosen.length >= BATCH_MAX;
              return (
                <li key={v.index}>
                  <label className={`pick-row${k >= 0 ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={k >= 0}
                      disabled={full}
                      onChange={(e) => setTicked(e.target.checked ? [...ticked, v.index] : ticked.filter((i) => i !== v.index))}
                    />
                    <span className="pick-name">
                      Vision wallet #{v.index + 1}
                      {names[v.index] && <span className="vw-label"> · {names[v.index]}</span>}
                    </span>
                    <span className="pick-amt num">{k >= 0 && parts[k] != null ? `spends ${fmt(parts[k], 4)} SOL` : `${fmt(room, 4)} SOL to spend`}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {!ready.length && <p className="muted small">Your Vision wallets are busy in a batch (its progress is in the Wallets tab). They can buy again once it ends.</p>}
          {ready.length > BATCH_MAX && <p className={tooMany > 0 ? "small warn" : "tiny"}>Up to {BATCH_MAX} wallets in one go{tooMany > 0 ? `: untick ${tooMany}.` : "."}</p>}
        </div>
      )}
      {vision && chosen.length > 0 && (
        <div className="seg seg-2" role="group" aria-label="How much each wallet spends">
          <button type="button" aria-pressed={!all} className={!all ? "on" : ""} onClick={() => setEach("same")}>
            Same in each
          </button>
          <button type="button" aria-pressed={all} className={all ? "on" : ""} onClick={() => setEach("all")}>
            All of it
          </button>
        </div>
      )}
      {all ? (
        <p className="muted small">
          Each wallet spends all its SOL except {fmt(reserve, 4)} SOL, which it keeps for its fees: {fmt(total, 4)} SOL in all.
        </p>
      ) : (
        <AmountField
          label={
            vision
              ? chosen.length > 1
                ? "SOL from each wallet"
                : chosen.length
                  ? `Spend from Vision wallet #${chosen[0].index + 1}`
                  : "SOL to spend"
              : multi
                ? "Total to spend"
                : "Spend from your private balance"
          }
          value={amt}
          onChange={setAmt}
          hint={vision ? (chosen.length === 1 ? `In it: ${fmt(chosen[0].lamports)} SOL` : undefined) : `Available: ${fmt(engine.spendable())} SOL`}
          max={most >= 1_000n ? formatUnits(most, 9, 6) : null}
        />
      )}
      {!vision && (
        <div className="slip chips spread" role="radiogroup" aria-label="Spread across new wallets">
          <span>Spread across new wallets</span>
          {SPREAD.map((v) => (
            <button key={v} type="button" role="radio" aria-checked={spread === v} className={spread === v ? "on" : ""} onClick={() => setSpread(v)}>
              {v}
            </button>
          ))}
        </div>
      )}
      {token && total > 0n ? (
        <div className="quote">
          {loading && <p className="muted">Asking Jupiter for the best route…</p>}
          {err && <p className="warn">{err}</p>}
          {q && (
            <p className="quote-out">
              <TokenIcon t={token} size={22} />
              <span>
                About <strong>{formatUnits(BigInt(q.outAmount), token.decimals, 6)}</strong> {token.symbol}
                {multi ? ` across ${n} wallets` : ""}
              </span>
            </p>
          )}
          {q && <TaxNote q={q} symbol={token.symbol} mint={token.mint} side="buy" unlocked={prefs.unlocked} />}
        </div>
      ) : null}
      {q && token && total > 0n ? (
        <QuoteFacts
          q={q}
          expected={`${formatUnits(BigInt(q.outAmount), token.decimals, 6)} ${token.symbol}`}
          minOut={`${formatUnits(BigInt(q.minOut), token.decimals, 6)} ${token.symbol}`}
        />
      ) : null}
      {q && token && last && lastPart > 0n ? (
        <Rows
          rows={[
            [
              "The last wallet's price",
              `about ${formatUnits((lastPart * last.out) / last.in, token.decimals, 4)} ${sym} for its ${fmt(lastPart, 4)} SOL${
                BigInt(q.outAmount) > 0n && last.out * BigInt(q.inAmount) < BigInt(q.outAmount) * last.in
                  ? `, ${pctText((1 - Number(last.out * BigInt(q.inAmount)) / Number(BigInt(q.outAmount) * last.in)) * 100)} less per SOL than the average`
                  : ""
              }`,
              "txt",
            ],
          ]}
        />
      ) : null}
      {multi && q && <p className="tiny">Every wallet's turn is held to that price: one more than {prefs.driftBps / 100}% worse pauses the batch and asks you first.</p>}
      <BatchRisk lines={risks} />
      <TradeSettings mode={mode} bps={slip} onMode={setMode} speed={speed} onSpeed={setSpeed} prefs={prefs} onPrefs={setPrefs} batch={multi} />
      {multi && <PacingControl pacing={pacing} setPacing={setPacing} vary={vary} setVary={all ? undefined : setVary} trade />}
      {vision && total > 0n ? (
        <Rows
          rows={
            multi
              ? [
                  ["Pool fee", "None: this SOL is already in your wallets", "txt"],
                  ["Kept in each wallet for its fees", `${fmt(reserve, 4)} SOL`],
                  [`Spent from ${n} wallets`, `${fmt(total, 6)} SOL`, "total"],
                ]
              : [
                  ["Pool fee", "None: this SOL is already in the wallet", "txt"],
                  ["Kept in the Vision wallet for its fees", `${fmt(reserve, 4)} SOL`],
                  [`Spent from Vision wallet #${chosen[0].index + 1}`, `${fmt(total, 6)} SOL`, "total"],
                ]
          }
        />
      ) : null}
      {!vision && sends.length > 0 && (
        <Rows
          rows={[
            ...(multi ? ([["New Vision wallets", `${n} · about ${fmt(total / BigInt(n), 4)} SOL in each`, "txt"]] as [string, string, string?][]) : []),
            [
              `Pool fee (${pct(engine.feeBps())})`,
              `${fmt(
                sends.reduce((s, x) => s + x.protocolFee, 0n),
                6,
              )} SOL`,
            ],
            [
              multi ? `Relayer and network (${n} payments)` : "Relayer and network",
              `${fmt(
                sends.reduce((s, x) => s + x.relayerFee, 0n),
                6,
              )} SOL`,
            ],
            ...(plan && plan.ok && plan.merges > 0
              ? ([[`Joining your balance first (${plan.merges} step${plan.merges === 1 ? "" : "s"})`, `${fmt(plan.cost, 6)} SOL`]] as [string, string][])
              : []),
            multi ? [`Kept in each wallet for its fees (× ${n})`, `${fmt(reserve * BigInt(n), 4)} SOL`] : ["Kept in the Vision wallet for its fees", `${fmt(reserve, 4)} SOL`],
            ["Taken from your private balance", `${fmt(taken, 6)} SOL`, "total"],
          ]}
        />
      )}
      {!vision && multi && sends.length > 0 && <p className="tiny">What each wallet keeps for its fees comes back when it's emptied.</p>}
      {tooMuch && (
        <p className="warn">
          {vision
            ? `Vision wallet #${chosen[over].index + 1} keeps ${fmt(reserve, 4)} SOL for its fees, so the most it can spend is ${formatUnits(rooms[over], 9, 6)} SOL.`
            : shortText(st, `Not enough private balance for that, including fees.${!multi && most >= 1_000n ? ` The most you can spend is ${formatUnits(most, 9, 6)} SOL.` : ""}`)}
          {!vision && sends.length > 0 && (
            <>
              {" "}
              <AddSol st={st} need={taken} />
            </>
          )}
        </p>
      )}
      {small && !tooMuch && (
        <p className="warn">
          {all
            ? `Each wallet needs at least ${fmtUp(least + reserve, 3)} SOL in it to buy along with others, so it can move back to your private balance later. Untick the smaller ones.`
            : `Each wallet's part must be at least ${fmtUp(least, 3)} SOL, so it can move back to your private balance later.${!vision && lamports ? ` With this total, use up to ${Math.max(1, Number(lamports / least))} wallet${lamports / least === 1n ? "" : "s"}.` : ""}`}
        </p>
      )}
      {tiny && sweepMin != null && (
        <p className="muted small">
          A buy this small can't go back into the pool on its own when you sell. Buys of about {fmtUp(sweepMin - reserve, 3)} SOL or more can.
        </p>
      )}
      {batchBusy && <p className="muted small">Another batch is running. Wait for it to end, or stop it, before starting this one.</p>}
      {say?.tone === "ask" ? (
        <ConfirmButton className="btn violet wide" label={buyLabel} ask={say.ask!} yes="Yes, buy" no="Go back" disabled={blocked} onYes={() => void go(true)} />
      ) : (
        <button type="submit" className="btn violet wide" disabled={blocked} title={token ? `Buy ${token.symbol} privately` : undefined}>
          {buyLabel}
        </button>
      )}
      <p className="tiny">
        {multi
          ? vision
            ? "Each wallet buys with its own SOL, one after another. The tokens stay in each wallet."
            : "Each part is paid from the pool into its own new Vision wallet and buys there, one after another, so they're harder to link to you and to each other."
          : vision
            ? chosen.length
              ? `The token lands in Vision wallet #${next}, where the SOL already is.`
              : "Tick the wallets to buy with. The token lands in each one, where the SOL already is."
            : `The token lands in Vision wallet #${next}, a fresh address funded from the pool, not from the wallet you shielded from.`}
      </p>
    </form>
  );
}

// ─────────────── Sell ───────────────

type Holding = { index: number; address: string; mint: string; amount: bigint; decimals: number };

/**
 * Whether a holding can't be sold at all, so "Clear this token" may be offered. Asked only when
 * there are signs (no route for the amount typed, or no price and no market): a quote for a small
 * slice of the holding, again 2 minutes later. Any route for any amount means it can sell.
 */
function useStuck(h: Holding | undefined, signs: boolean): boolean {
  const active = useTabActive();
  const [, bump] = useState(0);
  const key = h && signs ? `${h.mint}|${h.amount}` : "";
  useEffect(() => {
    if (!key || !active || !h) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = async () => {
      // a probe sent moments ago (the signs came and went while typing) isn't sent again: the next one keeps its 2-min spacing
      const since = document.hidden ? null : probeTooSoon(h.mint);
      if (!document.hidden && since == null) {
        // (rounded to one significant digit: the exact holding never goes in a quote)
        const slice = bucketAmount(h.amount / 100n > 0n ? h.amount / 100n : h.amount);
        try {
          await lookup("/api/swap/quote", { inputMint: h.mint, outputMint: SOL_MINT, amount: slice.toString(), slippageBps: 500, side: "sell" });
          sawRoute(h.mint);
        } catch (e) {
          // only a plain "no route" counts; a busy service or a network error says nothing either way
          if (/no route/i.test((e as Error).message)) sawNoRoute(h.mint);
        }
      }
      if (dead) return;
      bump((n) => n + 1);
      if (!stuckToken(h.mint)) timer = setTimeout(probe, NO_ROUTE_GAP_MS + 5_000 - (since ?? 0));
    };
    void probe();
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [key, active]);
  return !!h && signs && stuckToken(h.mint);
}

export function SellForm({ st }: { st: State }) {
  // wrapped SOL (a filled order's proceeds) isn't a token to sell: "Move back to private balance" brings it home
  const holdings: Holding[] = st.vision.flatMap((v) =>
    v.tokens.filter((t) => t.mint !== SOL_MINT).map((t) => ({ index: v.index, address: v.address, mint: t.mint, amount: t.amount, decimals: t.decimals })),
  );
  const meta = useTokenMeta(holdings.map((h) => h.mint));
  // "Sell" on a holding in the Wallets tab picks it here
  const [pick, setPick] = useState<string>(sellPicked);
  const [amt, setAmt] = useState("");
  useEffect(
    () =>
      onSellFrom((p) => {
        setPick(p);
        setAmt("");
      }),
    [],
  );
  const [mode, setMode] = useState<SlipMode>("auto");
  const [speed, setSpeed] = useSpeed();
  const [pacing, setPacing] = usePacing();
  const [prefs, setPrefs] = useGuardPrefs();
  // one wallet's holding, or the same share of every wallet holding this token
  const [scope, setScope] = useState<"one" | "all">("one");
  const [share, setShare] = useState<number | null>(null);
  const h = holdings.find((x) => `${x.index}:${x.mint}` === pick) ?? holdings[0];
  // the wallets holding the same token (not ones an unfinished batch still has to do; a live order on it means one at a time)
  const spoken = batchWallets(st.batch);
  const holders = h ? holdings.filter((x) => x.mint === h.mint && !spoken.includes(x.index)).sort((a, b) => a.index - b.index) : [];
  const free = holders.filter((x) => !engine.orderClash(x.index, x.mint, x.amount));
  const clean = free.slice(0, BATCH_MAX);
  const across = scope === "all" && clean.length >= 2;
  const parts = across && share ? clean.map((x) => shareOf(x.amount, share)) : [];
  const sum = parts.reduce((s, a) => s + a, 0n);
  const raw = across ? (sum > 0n ? sum : null) : h ? parseUnits(amt, h.decimals) : null;
  const sellTok = h ? { mint: h.mint, liquidity: meta[h.mint]?.liquidity } : null;
  const slip = resolveSlip(mode, sellTok);
  const { q, err, loading } = useQuote(h && raw ? { inputMint: h.mint, outputMint: SOL_MINT, amount: raw, slippageBps: slip, side: "sell" } : null, !st.busy);
  // several wallets: a quote without the last wallet's share too, for the price the last one gets
  const lastShare = across && parts.length > 1 ? parts[parts.length - 1] : 0n;
  const { q: q2 } = useQuote(h && lastShare > 0n && sum > lastShare ? { inputMint: h.mint, outputMint: SOL_MINT, amount: sum - lastShare, slippageBps: slip, side: "sell" } : null, !st.busy);
  const last = across ? lastRateOf(q, q2) : null;
  const t = h ? meta[h.mint] : undefined;
  const sym1 = t?.symbol ?? short(h?.mint ?? "");
  const say = h ? checkSay(q?.check, { symbol: sym1, side: "sell", unlocked: prefs.unlocked }) : null;
  const curveMeta = useTokenMeta(q?.check?.curve ? [q.check.curve.pair] : []);
  const curvePair = q?.check?.curve ? (curveMeta[q.check.curve.pair]?.symbol ?? short(q.check.curve.pair)) : null;
  const risks = across && t ? batchWarnings({ symbol: sym1, liquidity: t.liquidity, created: t.created, change1h: t.change1h, inUsd: q?.check?.inUsd, curvePair }) : [];
  // a token with no route at all (a spam airdrop, a rug) can be cleared for its account's rent; never while a quote shows it sells
  const unsellable = useStuck(h, !q && ((!!err && /no route/i.test(err)) || (!!t && t.price == null && !t.liquidity)));

  if (!holdings.length) {
    return (
      <div className="form empty-state">
        <p>Nothing to sell yet.</p>
        <p className="muted">Tokens you buy privately live in Vision wallets. When you sell from here, the SOL goes straight back into your private balance.</p>
      </div>
    );
  }
  const tooMuch = !across && h && raw && raw > h.amount;
  // what really goes back into the pool, worked out the way the move itself does it (each wallet's own, added up)
  const backs = across && q ? parts.map((a, k) => engine.sellPreview(clean[k].index, h!.mint, a, (BigInt(q.outAmount) * a) / sum, speed)) : [];
  const back =
    h && raw && q && !tooMuch
      ? across
        ? backs.some((x) => x == null)
          ? null
          : backs.reduce((s: bigint, x) => s + (x ?? 0n), 0n)
        : engine.sellPreview(h.index, h.mint, raw, BigInt(q.outAmount), speed)
      : null;
  const stays = !across && back === 0n;
  const symbol = t?.symbol ?? short(h?.mint ?? "");
  // a live order in this wallet: what the sale does to it is said here, and asked before selling
  const clash = !across && h && raw && !tooMuch ? engine.orderClash(h.index, h.mint, raw) : null;
  const setPart = (share: bigint) => h && setAmt(formatUnits((h.amount * share) / 100n, h.decimals, h.decimals).replace(/,/g, ""));
  const batchBusy = across && batchLive(st.batch);
  const sellOne = async (said: boolean) => {
    if (!h || !raw || tooMuch || !q) return;
    const guard: TradeGuard = { ...approvalOf(q.check, { said, unlocked: prefs.unlocked }), ...(q.check ? { taxes: q.check.taxes } : {}) };
    await engine
      .sell(h.index, h.mint, raw, slip, mode === "auto", { speed, minOut: BigInt(q.minOut), orders: !!clash, guard, symbol: shortSym(symbol) })
      .then(() => setAmt(""))
      .catch(() => {});
  };
  const sellOff = !h || !raw || !!tooMuch || !!st.busy || !q || (across && (!share || batchBusy)) || say?.tone === "stop";
  /** A sale from several wallets, each held to the last wallet's price as shown, within the batch price guard. */
  const sellAcross = (said: boolean) => {
    if (!h || !raw || tooMuch || !q || !share || batchBusy || st.busy || say?.tone === "stop") return;
    const approval = approvalOf(q.check, { said, unlocked: prefs.unlocked });
    const ref = last ?? { in: BigInt(q.inAmount), out: BigInt(q.outAmount) };
    const ok = engine.startBatch({
      kind: "sell",
      pacing,
      mint: h.mint,
      symbol,
      decimals: h.decimals,
      slippageBps: slip,
      auto: mode === "auto",
      speed,
      refIn: ref.in.toString(),
      refOut: ref.out.toString(),
      driftBps: prefs.driftBps,
      unlocked: prefs.unlocked,
      ...(approval.okLoss != null ? { okLoss: approval.okLoss } : {}),
      ...(approval.okNoPrice ? { okNoPriceAt: 0 } : {}),
      ...(q.check ? { taxes: q.check.taxes } : {}),
      items: clean.map((x, k) => ({
        index: x.index,
        amount: parts[k].toString(),
        before: x.amount.toString(),
        status: "waiting" as const,
      })),
    });
    if (ok) {
      setShare(null);
      toBatchCard();
    }
  };
  // what the sell button asks first: a live order the sale changes, a price the review wants a yes for, or both
  const askText = [clash?.text, say?.tone === "ask" ? say.ask : null].filter(Boolean).join(" ");
  const asks = !!clash || say?.tone === "ask";
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!h || !raw || tooMuch || !q) return;
        // a review that asks something is answered on its button, never by Enter
        if (say?.tone === "ask") return;
        if (across) return sellAcross(false);
        // a live order in the wallet: asked in place, by the button below
        if (clash) return;
        await sellOne(false);
      }}
    >
      <label className="field">
        <span className="field-top">
          <span>Sell from</span>
        </span>
        <select
          className="select"
          value={h ? `${h.index}:${h.mint}` : ""}
          onChange={(e) => {
            setPick(e.target.value);
            setAmt("");
          }}
        >
          {holdings.map((x) => (
            <option key={`${x.index}:${x.mint}`} value={`${x.index}:${x.mint}`}>
              Vision wallet #{x.index + 1} · {formatUnits(x.amount, x.decimals, 4)} {meta[x.mint]?.symbol ?? short(x.mint)}
            </option>
          ))}
        </select>
      </label>
      {h && clean.length >= 2 && (
        <div className="seg seg-2" role="group" aria-label="Which wallets sell">
          <button type="button" aria-pressed={!across} className={!across ? "on" : ""} onClick={() => setScope("one")}>
            Vision wallet #{h.index + 1} only
          </button>
          <button type="button" aria-pressed={across} className={across ? "on" : ""} onClick={() => setScope("all")}>
            All wallets holding {shortSym(symbol)} ({clean.length})
          </button>
        </div>
      )}
      {across ? (
        <>
          <div className="slip chips" role="radiogroup" aria-label="Share of each wallet's holding">
            <span>Of each wallet's holding</span>
            {[25, 50, 75, 100].map((p) => (
              <button key={p} type="button" role="radio" aria-checked={share === p} className={share === p ? "on" : ""} onClick={() => setShare(p)}>
                {p}%
              </button>
            ))}
          </div>
          <Rows
            rows={clean.map((x, k) => [
              `Vision wallet #${x.index + 1}`,
              `${formatUnits(parts[k] ?? x.amount, x.decimals, 4)} ${shortSym(symbol)}${share ? "" : " held"}`,
            ])}
          />
          {free.length > clean.length && <p className="muted small">Up to {BATCH_MAX} wallets in one go: the first {BATCH_MAX} by number sell here.</p>}
          {holders.length > free.length && (
            <p className="muted small">Wallets with a live order on {symbol} are left out here: sell from them one at a time.</p>
          )}
        </>
      ) : (
        <div className="field-group">
          <AmountField
            label="Amount"
            unit={t?.symbol ?? "tokens"}
            value={amt}
            onChange={setAmt}
            max={h ? formatUnits(h.amount, h.decimals, h.decimals).replace(/,/g, "") : null}
          />
          {h && (
            <div className="move-chips" role="group" aria-label="Part of the holding">
              {[25n, 50n, 75n, 100n].map((p) => (
                <button key={String(p)} type="button" className="chip-btn small" onClick={() => setPart(p)}>
                  {String(p)}%
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {raw ? (
        <div className="quote">
          {loading && <p className="muted">Asking Jupiter for the best route…</p>}
          {err && <p className="warn">{err}</p>}
          {q && (
            <p className="quote-out">
              <span>
                {back != null && back > 0n ? (
                  <>
                    About <strong>{fmt(back, 6)}</strong> SOL back into your private balance{across ? `, from ${clean.length} wallets` : ""}
                  </>
                ) : (
                  <>
                    About <strong>{fmt(BigInt(q.outAmount), 6)}</strong> SOL from the sale
                  </>
                )}
              </span>
            </p>
          )}
          {q && stays && h && (
            <p className="muted small">
              This sale's SOL stays in Vision wallet #{h.index + 1} for now: with what the wallet keeps for fees, it's below the smallest deposit.{" "}
              {raw < h.amount
                ? 'Sell more, or all of it, then use "Move back to private balance" in the Wallets tab.'
                : "It goes back with the rest if the wallet is funded again."}
            </p>
          )}
          {q && h && <TaxNote q={q} symbol={t?.symbol ?? "This token"} mint={h.mint} side="sell" unlocked={prefs.unlocked} />}
        </div>
      ) : null}
      {q && raw ? <QuoteFacts q={q} expected={`${fmt(BigInt(q.outAmount), 6)} SOL`} minOut={`${fmt(BigInt(q.minOut), 6)} SOL`} /> : null}
      {q && h && last && lastShare > 0n ? (
        <Rows rows={[["The last wallet's price", `about ${fmt((lastShare * last.out) / last.in, 6)} SOL for its ${formatUnits(lastShare, h.decimals, 4)} ${shortSym(symbol)}`, "txt"]]} />
      ) : null}
      {across && q && (
        <p className="tiny">Every wallet's sale is held to that price: one more than {prefs.driftBps / 100}% worse pauses the batch and asks you first.</p>
      )}
      <BatchRisk lines={risks} />
      <TradeSettings mode={mode} bps={slip} onMode={setMode} speed={speed} onSpeed={setSpeed} prefs={prefs} onPrefs={setPrefs} batch={across} />
      {across && <PacingControl pacing={pacing} setPacing={setPacing} trade />}
      {q && engine.depositFeeBps() > 0 && <Rows rows={[[`Pool fee (${pct(engine.depositFeeBps())})`, "taken as the SOL goes back into the pool", "txt"]]} />}
      {q && q.feeBps > 0 && <Rows rows={[[`Swap fee (${pct(q.feeBps)})`, "taken from the SOL you receive", "txt"]]} />}
      {tooMuch && <p className="warn">That's more than the Vision wallet holds.</p>}
      {clash && <p className="muted small">{clash.text}</p>}
      {batchBusy && <p className="muted small">Another batch is running. Wait for it to end, or stop it, before starting this one.</p>}
      {asks ? (
        <ConfirmButton
          className="btn violet wide"
          label={across ? (share ? `Sell ${share}% from ${clean.length} wallets` : `Sell from ${clean.length} wallets`) : "Sell privately"}
          ask={say?.tone === "ask" ? askText : `${askText} Sell anyway?`}
          yes="Yes, sell"
          no="Don't sell"
          disabled={sellOff}
          onYes={() => (across ? sellAcross(true) : void sellOne(true))}
        />
      ) : (
        <button className="btn violet wide" disabled={sellOff}>
          {across ? (share ? `Sell ${share}% from ${clean.length} wallets` : `Sell from ${clean.length} wallets`) : "Sell privately"}
        </button>
      )}
      {across ? (
        <p className="tiny">Each wallet sells its share, one after another, and its SOL moves back to your private balance right after its sale.</p>
      ) : (
        !stays && <p className="tiny">After the sale, the SOL is moved back into the pool and joins your private balance once its waiting time is over.</p>
      )}
      {unsellable && h && (
        <details className="tiny">
          <summary>Can't sell this token?</summary>
          <p>
            No market takes {symbol} right now, even a small part of it. If you don't want it, you can clear it and get back its account's
            rent.{" "}
            <ConfirmButton
              label="Clear this token"
              ask={`This burns all ${formatUnits(h.amount, h.decimals, 4)} ${symbol} in Vision wallet #${h.index + 1}. If the token has any value, it's lost for good: a market may take it later, and a smaller amount may still sell. You only get back about 0.002 SOL of account rent. Burn it?`}
              yes="Yes, burn it"
              disabled={!!st.busy}
              onYes={() => void engine.clearToken(h.index, h.mint).catch(() => {})}
            />
          </p>
        </details>
      )}
    </form>
  );
}
