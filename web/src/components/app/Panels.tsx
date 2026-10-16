import { lazy, Suspense, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { DELIVERY_FEE } from "@visionswap/sdk";
import { engine, fmt, fmtDown, PAY_OPEN_TEXT, WINDOW_LABEL, type Activity, type Job, type State, type WalletLike, type WalletPay } from "../../lib/engine";
import { payOpen } from "../../lib/walletpay";
import { goAtOf, isLive } from "../../lib/jobs";
import { explorer, formatUnits, short } from "../../lib/net";
import { TokenIcon } from "./TokenPicker";
import { copyText } from "../../lib/copy";
import { useTokenMeta } from "../../lib/tokenmeta";
import { checkedText } from "../../lib/hops";
import { walletsName } from "../../lib/vwallets";
import { groupByDay, pageOf, type ActivityFilter } from "../../lib/activity";
import { useMasked } from "../../lib/masked";
import { maskText } from "../../lib/money";
import "../../lib/features"; // (declares the build-time switch __VS_RECEIPTS__)
import { ProveControl } from "./ProveControl";
import { ListedWarning } from "./Listed";

/** Payment receipts: in the build only when switched on (lib/features.ts: the test stays here, so the bundler can drop it). */
const ReceiptMaker = typeof __VS_RECEIPTS__ === "boolean" && __VS_RECEIPTS__ ? lazy(() => import("./Receipt").then((m) => ({ default: m.ReceiptMaker }))) : null;

/** Whether a typed wallet address parses, so a malformed one is caught before the confirm (the engine checks again before sending). */
export const looksLikeAddress = (a: string) => {
  try {
    new PublicKey(a);
    return true;
  } catch {
    return false;
  }
};

/** Said under an address box while what's typed isn't a wallet address. */
// (an address on the published sanctions list is told here at once, checked in the browser)
const BadAddress = ({ to }: { to: string }) =>
  to && !looksLikeAddress(to) ? <p className="small warn">That doesn't look like a Solana address.</p> : <ListedWarning to={to || null} />;

const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export { copyText };

/**
 * Which row action was tapped, so its own button says what is happening ("Moving…") while the
 * action runs: on a phone the main card, where the steps show, can be far up the page.
 */
export function useTapped(st: State) {
  const [tapped, setTapped] = useState<string | null>(null);
  useEffect(() => {
    if (!st.busy) setTapped(null);
  }, [st.busy]);
  return {
    tap: (key: string, run: () => Promise<unknown>) => {
      setTapped(key);
      run().catch(() => {});
    },
    say: (key: string, idle: string, going: string) => (tapped === key && st.busy && !st.busy.bg ? going : idle),
  };
}

/**
 * A row action that can't be undone: the first tap asks, right there, and a second confirms.
 * Nothing pops up over the page.
 */
export function ConfirmButton({
  label,
  ask,
  yes,
  no = "Keep it",
  onYes,
  disabled,
  className = "link-btn",
}: {
  label: string;
  ask: string;
  yes: string;
  no?: string;
  onYes: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  return (
    <span
      className="confirm"
      role="group"
      aria-label={ask}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        setAsking(false);
      }}
    >
      <span className="confirm-q">{ask}</span>
      <button
        type="button"
        className="btn small-btn confirm-yes"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onYes();
        }}
      >
        {yes}
      </button>
      <button type="button" className="link-btn" autoFocus onClick={() => setAsking(false)}>
        {no}
      </button>
    </span>
  );
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [shown, setShown] = useState<string | null>(null);
  return (
    <button
      type="button"
      className="link-btn"
      onClick={async () => {
        setShown((await copyText(text)) ? "Copied" : "Couldn't copy");
        setTimeout(() => setShown(null), 1600);
      }}
    >
      {shown ?? label}
    </button>
  );
}

export function WaitingRoom({ st, wallet }: { st: State; wallet: WalletLike | null }) {
  const { tap, say } = useTapped(st);
  const delay = Number(st.pool?.depositDelaySlots ?? 0);
  if (!st.waiting.length) return null;
  return (
    <section className="panel">
      <header>
        <h3>Joining your private balance</h3>
        <span className="muted">In the waiting room: screened, then added in about {engine.waitLabel()}</span>
      </header>
      <ul className="waiting">
        {st.waiting.map((w) => {
          const left = w.readyAt != null ? Number(w.readyAt) - st.slot : 0;
          const done = left <= 0;
          const p = delay > 0 ? Math.min(1, Math.max(0, 1 - left / delay)) : 1;
          const mins = engine.slotMinutes(left, true);
          return (
            <li key={w.inner}>
              <div className="w-top">
                <strong>{fmt(w.amount)} SOL</strong>
                <span className="muted">
                  {w.vision !== null
                    ? `from Vision wallet #${w.vision + 1}`
                    : w.hop
                      ? "from a sending address of yours"
                      : w.deposit !== null
                      ? w.deposit === st.qrIndex
                        ? "from your deposit address"
                        : `from deposit address #${w.deposit + 1}`
                      : "from your wallet"}{" "}
                  · {done ? "joining the pool" : `about ${mins} min left`}
                </span>
              </div>
              <div className="bar">
                <i style={{ width: `${Math.round(p * 100)}%` }} />
              </div>
              <div className="w-actions">
                {done && left < -300 && (
                  <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`add${w.inner}`, () => engine.settleNow(w, wallet))}>
                    {say(`add${w.inner}`, "Add it to the pool now", "Adding…")}
                  </button>
                )}
                <ConfirmButton
                  label={say(`back${w.inner}`, "Take it back", "Taking it back…")}
                  ask={`Take back ${fmt(w.amount)} SOL?`}
                  yes="Yes, take it back"
                  disabled={!!st.busy}
                  onYes={() => tap(`back${w.inner}`, () => engine.refund(w, wallet))}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Deposit addresses that hold SOL: what's on its way into the pool, what came
 * back from the waiting room, and leftovers too small to deposit. Tokens sent
 * to one by mistake are listed too, so they can be reached with its key.
 */
export function DepositAddresses({ st }: { st: State }) {
  // each address keeps its own open form and typed address: finishing one never closes or clears another's
  const [open, setOpen] = useState<number[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [reveal, setReveal] = useState<number | null>(null);
  const { tap, say } = useTapped(st);
  const min = engine.minReceive();
  const list = st.deposits.filter((d) => d.lamports > 0n || d.tokens.length > 0);
  const meta = useTokenMeta(list.flatMap((d) => d.tokens.map((t) => t.mint)));
  if (!list.length) return null;
  return (
    <section className="panel">
      <header>
        <h3>Deposit addresses</h3>
        <span className="muted">Yours, for shielding by QR code</span>
      </header>
      <ul className="vision">
        {list.map((d) => {
          const enough = min != null && d.lamports >= min;
          const to = drafts[d.index] ?? "";
          const setTo = (v: string) => setDrafts((x) => ({ ...x, [d.index]: v }));
          const sendable = d.lamports > 5_000n ? d.lamports - 5_000n : 0n;
          const label = d.index === st.qrIndex ? "your deposit address" : `deposit address #${d.index + 1}`;
          // what's left after a deposit (often its waiting-room account deposit, come back): it waits for this address's next one
          const leftover = !enough && !d.held;
          return (
            <li key={d.index}>
              <div className="v-top">
                <span className="v-name">#{d.index + 1}</span>
                <span className="mono muted">{short(d.address, 5)}</span>
                <Copy text={d.address} />
                <span className="v-sol">{fmt(d.lamports, 6)} SOL</span>
              </div>
              {d.tokens.length > 0 && (
                <div className="v-tokens">
                  {d.tokens.map((t) => {
                    const m = meta[t.mint];
                    return (
                      <span key={t.account} className="chip">
                        <TokenIcon t={m ?? { icon: null, symbol: "?" }} size={18} />
                        {formatUnits(t.amount, t.decimals, 4)} {m?.symbol ?? short(t.mint)}
                      </span>
                    );
                  })}
                </div>
              )}
              {d.tokens.length > 0 && (
                <p className="small muted">
                  Only SOL moves into your private balance, so these tokens stay at this address. They're yours: export this address's key and
                  import it into any Solana wallet app to use them there.
                </p>
              )}
              {d.lamports > 0n && (
                <p className="small muted">
                  {d.held === "returned"
                    ? "This came back from the waiting room. Move it into the pool again, or send it to a wallet."
                    : d.held === "refused"
                      ? "Screening turned this down because of where it came from. Try again, or send it to a brand-new wallet of yours to clear the address: payments that arrive after that move in as usual."
                      : d.held === "failed"
                        ? "Moving this into the pool didn't go through. Try again, or send it to a wallet."
                        : enough && d.wait
                          ? d.wait
                          : enough
                            ? (engine.moveEta(d.index) ?? 0) > 45_000
                              ? `Arrived. It moves into the pool in about ${Math.ceil(engine.moveEta(d.index)! / 60_000)} min, one payment at a time, while this page is open on screen. Tap Move into the pool to send it now.`
                              : "Arrived. It moves into the pool by itself in a moment."
                            : min != null
                              ? `Too little for a deposit on its own: send ${fmt(min - d.lamports, 6)} SOL more to this address and it all goes in together. Part of it may be the account deposit that came back when your last deposit joined the pool.`
                              : ""}
                </p>
              )}
              <div className="v-actions">
                {enough && (
                  <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`mv${d.index}`, () => engine.moveDeposit(d.index))}>
                    {say(`mv${d.index}`, d.held === "refused" || d.held === "failed" ? "Try again" : "Move into the pool", "Moving…")}
                  </button>
                )}
                {d.lamports > 0n && (
                  <button
                    type="button"
                    className="link-btn"
                    aria-expanded={open.includes(d.index)}
                    onClick={() => setOpen((o) => (o.includes(d.index) ? o.filter((x) => x !== d.index) : [...o, d.index]))}
                  >
                    Send to a wallet
                  </button>
                )}
                <button type="button" className="link-btn" onClick={() => setReveal(reveal === d.index ? null : d.index)}>
                  {reveal === d.index ? "Hide key" : "Export key"}
                </button>
              </div>
              {open.includes(d.index) && (
                <div className="send-out">
                  <input
                    className="addr mono"
                    value={to}
                    onChange={(e) => setTo(e.target.value.trim())}
                    placeholder="Wallet address to send it to"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <BadAddress to={to} />
                  {looksLikeAddress(to) && engine.paidBefore(to, d.address) && (
                    <p className="small warn">Another of your addresses already sent SOL to this one. Sending from this address too shows on the chain that both belong to the same person.</p>
                  )}
                  {leftover && (
                    <p className="small warn">
                      Sending what's left here to a wallet you use shows on the chain that this deposit address and that wallet belong together. You can
                      also leave it: it goes into the pool with this address's next deposit.
                    </p>
                  )}
                  <ConfirmButton
                    className="btn ghost small-btn"
                    label={say(`out${d.index}`, `Send all ${fmt(sendable, 6)} SOL`, "Sending…")}
                    ask={`Send ${fmt(sendable, 6)} SOL from ${label} to ${short(to, 5)}? This is an ordinary transfer and can't be undone.`}
                    yes="Yes, send it"
                    disabled={!to || !looksLikeAddress(to) || !!st.busy}
                    onYes={() =>
                      tap(`out${d.index}`, () =>
                        engine.sendFromDeposit(d.index, to).then(() => {
                          // only this address's form closes, and only its own address is cleared
                          setOpen((o) => o.filter((x) => x !== d.index));
                          setDrafts((x) => ({ ...x, [d.index]: "" }));
                        }),
                      )
                    }
                  />
                  <p className="tiny">
                    An ordinary transfer from this address, not a private one. The network fee comes out of it.
                    {d.tokens.length ? " The tokens stay here, reachable with this address's key." : ""}
                  </p>
                </div>
              )}
              {reveal === d.index && (
                <div className="secret">
                  <p className="warn">
                    Anyone with this key controls this deposit address. Import it into another Solana wallet app only if you want to use the
                    address there.
                  </p>
                  <code className="mono">{engine.exportDeposit(d.index)}</code>
                  <Copy text={engine.exportDeposit(d.index)} label="Copy key" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Copies an explorer link instead of opening it: opening Solscan from here
 * would show Solscan this visitor's IP address next to a private payment.
 * People can paste the link wherever they're comfortable.
 */
export function CopyLink({ sig, network, label = "Copy transaction link" }: { sig: string; network: string; label?: string }) {
  return (
    <span title="Copies a Solscan link. Opening an explorer shows it your IP address, so paste it in a private window or through a VPN if that matters to you.">
      <Copy text={explorer(sig, network)} label={label} />
    </span>
  );
}

const clock = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-US", today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};
const JOB_STATUS: Record<Job["status"], [string, string]> = {
  scheduled: ["Scheduled", "wait"],
  sending: ["Going out", "wait"],
  delivering: ["Delivering…", "wait"],
  waiting: ["Ready to finish", "wait"],
  stale: ["Needs a fresh proof", "wait"],
  sent: ["Sent", "good"],
  failed: ["Not sent", "bad"],
  cancelled: ["Cancelled", "mute"],
  unclear: ["Check activity", "mute"],
};

/** When a job goes, in a few words, beside its status (anything longer goes in jobNote, on a line of its own). */
function jobLine(j: Job, refreshing: boolean): string {
  if (refreshing) return "making a fresh proof…";
  if (j.ripening && j.status === "stale") return `by ${clock(j.latest)} at the latest`;
  switch (j.status) {
    case "scheduled":
      return Date.now() > j.latest ? "still trying" : `within ${WINDOW_LABEL[j.window]} · by ${clock(j.latest)}`;
    case "sending":
      return "going out now";
    case "delivering":
      return "a standard SOL transfer";
    case "waiting":
      return "finishes while the app is open";
    case "sent":
      return "by the relayer";
    default:
      return "";
  }
}

/** What a job is waiting for, or why it stopped: a full-width line under the row. */
function jobNote(j: Job): string | null {
  switch (j.status) {
    case "scheduled":
    case "waiting":
      return j.note ?? null;
    case "stale": {
      if (j.confirm) return `The pool fee changed: ${engine.addressName(j.to)} would get ${fmt(BigInt(j.confirm.amount))} SOL.`;
      if (j.ripening) {
        const left = engine.ripeIn(j);
        return `Its notes are new, so it is handed to the relayer once ${left ? `about ${left} more note${left === 1 ? " (a deposit or payment by anyone) has" : "s (deposits and payments by anyone) have"}` : "more notes have"} joined the pool, or sent at ${clock(goAtOf(j))}, a moment picked at random within its window, if that hasn't happened by then. Either way it needs VisionSwap open until it shows Scheduled.`;
      }
      return j.note ?? "A fresh proof is made for it while this page is open.";
    }
    case "failed":
    case "unclear":
      return j.error ?? null;
    default:
      return null;
  }
}

/** Who a payment goes to: one of this account's own Vision wallets by name, anyone else by short address. */
function ToName({ to }: { to: string }) {
  const i = engine.visionIndexOf(to);
  if (i == null) return <span className="mono muted job-to">to {short(to)}</span>;
  return <span className="muted job-to">to Vision wallet #{i + 1} (yours)</span>;
}

/** A failed payment that can simply be sent again (not one refused, or whose SOL went elsewhere). */
const canRetry = (j: Job) => j.status === "failed" && !/can't receive|another payment|spent|check your activity/i.test(j.error ?? "");

const PAY_STATUS: Record<WalletPay["status"], [string, string]> = {
  paying: ["Approve", "wait"],
  waiting: ["Joining", "wait"],
  sending: ["Sending", "wait"],
  scheduled: ["Handed over", "good"],
  sent: ["Sent", "good"],
  returned: ["Not sent", "mute"],
  cancelled: ["Stopped", "mute"],
  "needs-you": ["Needs you", "bad"],
};

/**
 * Payments made straight from the wallet on this device (kept here only): from the wallet's
 * approval, through the waiting room, until the relayer has them, and how each ended. One that
 * waits for its owner says why, with the choices it has.
 */
export function WalletPays({ st }: { st: State }) {
  const { tap, say } = useTapped(st);
  if (!st.pays.length) return null;
  const going = st.pays.filter((p) => payOpen(p.status)).length;
  const delay = Number(st.pool?.depositDelaySlots ?? 0);
  return (
    <section className="panel">
      <header>
        <h3>Payments on their way</h3>
        <span className="muted">{going ? `${going} going` : st.pays.some((p) => p.status === "scheduled") ? "Handed over" : "All done"}</span>
      </header>
      <ul className="jobs">
        {st.pays.map((p) => {
          const w = p.status === "waiting" ? st.waiting.find((x) => x.inner === p.inner) : undefined;
          // a handed-over payment is the scheduled payment made for it: its line follows that one
          const job = p.status === "scheduled" ? st.jobs.find((j) => j.to === p.to && j.amount === p.amount && j.created >= (p.sendingAt ?? 0)) : undefined;
          // one whose note is still too new to prove for later isn't at the relayer yet
          const ripening = !!job?.ripening && job.status === "stale";
          const [chip, tone] = ripening ? ["Preparing", "wait"] : PAY_STATUS[p.status];
          const left = w?.readyAt != null ? Number(w.readyAt) - st.slot : 0;
          const line =
            p.status === "paying"
              ? p.sig
                ? "Confirming your payment"
                : "Approve in your wallet"
              : p.status === "waiting"
                ? left > 0
                  ? `Joining your private balance, about ${engine.slotMinutes(left, true)} min left`
                  : st.pool && !st.pool.relayer
                    ? "Waiting for the relayer to come back"
                    : "Joining your private balance"
                : p.status === "sending"
                  ? "Sending privately"
                  : p.status === "scheduled"
                    ? job?.status === "sent"
                      ? "Sent privately"
                      : job?.status === "cancelled"
                        ? "Cancelled under Scheduled payments; its SOL is in your private balance"
                        : ripening
                          ? `Handed to the relayer by ${clock(goAtOf(job!))} · keep VisionSwap open`
                          : job && isLive(job.status) && job.latest > Date.now()
                          ? `Handed to the relayer · goes out by ${clock(job.latest)}`
                          : "Handed to the relayer · see Scheduled payments"
                    : p.status === "sent"
                      ? "Handed to the relayer"
                      : "";
          const most = p.ask === "fees" ? engine.payFeesMost(p) : 0n;
          const note =
            p.status !== "needs-you"
              ? (p.text ?? null)
              : p.ask === "late" || (p.ask === "fees" && most >= BigInt(p.amount))
                ? `Your payment to ${short(p.to)} is ready.`
                : p.ask === "fees"
                  ? `The fees went up since you paid, so its SOL now covers ${fmtDown(most, 6)} SOL to ${short(p.to)}.`
                  : p.ask === "unsure"
                    ? "Check your activity before sending again."
                    : (p.text ?? null);
          const go = p.status === "needs-you" && p.ask !== "unsure" && (p.ask !== "fees" || most > 0n);
          return (
            <li key={p.id} className={`job ${tone}`}>
              <div className="job-main">
                <strong className="num">{fmt(BigInt(p.amount))} SOL</strong>
                <ToName to={p.to} />
              </div>
              <div className="job-side">
                <span className={`job-chip ${tone}`}>{chip}</span>
                {line && <span className="small muted">{line}</span>}
              </div>
              {w && delay > 0 && (
                <div className="bar job-bar">
                  <i style={{ width: `${Math.round(Math.min(1, Math.max(0, 1 - left / delay)) * 100)}%` }} />
                </div>
              )}
              {note && <p className="small muted job-note">{note}</p>}
              <div className="job-actions">
                {go && (
                  <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`pay${p.id}`, () => engine.sendPayNow(p.id))}>
                    {say(
                      `pay${p.id}`,
                      p.ask === "fees"
                        ? `Send ${fmtDown(most, 6)} SOL now`
                        : p.ask === "confirm"
                          ? p.confirm === "lookalike"
                            ? "It's the right address"
                            : "Continue"
                          : p.ask === "error"
                            ? "Try again"
                            : "Send it now",
                      "Sending…",
                    )}
                  </button>
                )}
                {p.status === "waiting" && (
                  <ConfirmButton label="Stop and keep it private" ask="Stop this payment? The SOL stays in your private balance." yes="Yes, stop it" no="Don't stop" onYes={() => engine.stopPay(p.id)} />
                )}
                {p.status === "needs-you" && p.ask !== "unsure" && (
                  <button type="button" className="link-btn" onClick={() => engine.stopPay(p.id)}>
                    Keep it in my private balance
                  </button>
                )}
                {(!payOpen(p.status) || p.ask === "unsure") && (
                  <button type="button" className="link-btn" onClick={() => engine.dismissPay(p.id)}>
                    Dismiss
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {st.pays.some((p) => p.status === "paying" || p.status === "waiting") && <p className="tiny">{PAY_OPEN_TEXT}</p>}
    </section>
  );
}

/** Payments waiting to go out at their random moment, and how the recent ones went. */
export function ScheduledPayments({ st }: { st: State }) {
  const { tap, say } = useTapped(st);
  const [each, setEach] = useState(false);
  if (!st.jobs.length && st.aside === 0n) return null;
  // four or more still to go to this account's own Vision wallets (funding several, say) fold into one row; each can be shown, with its Cancel
  const toOwn = st.jobs.filter((j) => (j.status === "scheduled" || j.status === "sending" || j.status === "stale") && engine.visionIndexOf(j.to) != null);
  const foldLive = toOwn.length >= 4;
  const live = st.jobs.filter((j) => j.status === "scheduled" || j.status === "sending" || j.status === "stale" || j.status === "delivering" || j.status === "waiting").length;
  // three or more that went out fold into one line (funding several wallets would fill the column otherwise); Activity keeps each one's link
  const sent = st.jobs.filter((j) => j.status === "sent" && !j.cancelPending);
  const fold = sent.length >= 3;
  const own = sent.map((j) => engine.visionIndexOf(j.to));
  const allOwn = own.every((i) => i != null);
  return (
    <section className="panel">
      <header>
        <h3>Scheduled payments</h3>
        <span className="muted">{live ? `${live} waiting` : "All done"}</span>
      </header>
      <ul className="jobs">
        {st.aside > 0n && (
          <li className="job wait">
            <div className="job-main">
              <strong>{fmt(st.aside)} SOL</strong>
              <span className="muted small">set aside for a scheduled payment made on another of your devices</span>
            </div>
            <div className="job-side">
              <span className="job-chip wait">Set aside</span>
            </div>
            <div className="job-actions">
              <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap("aside", () => engine.cancelAside())}>
                {say("aside", "Cancel that payment", "Cancelling…")}
              </button>
            </div>
          </li>
        )}
        {fold && (
          <li className="job good">
            <div className="job-main">
              <strong className="num">{fmt(sent.reduce((s, j) => s + BigInt(j.amount), 0n))} SOL</strong>
              <span className="muted small job-to">{allOwn ? `to ${walletsName(own as number[])} (yours)` : `in ${sent.length} payments`}</span>
            </div>
            <div className="job-side">
              <span className="job-chip good">{sent.length} sent</span>
            </div>
            <div className="job-actions">
              <button type="button" className="link-btn" onClick={() => sent.forEach((j) => engine.dismissJob(j.id))}>
                Dismiss all
              </button>
            </div>
          </li>
        )}
        {foldLive && (
          <li className="job wait">
            <div className="job-main">
              <strong className="num">{fmt(toOwn.reduce((s, j) => s + BigInt(j.amount), 0n))} SOL</strong>
              <span className="muted small job-to">to {walletsName(toOwn.map((j) => engine.visionIndexOf(j.to)!))} (yours)</span>
            </div>
            <div className="job-side">
              <span className="job-chip wait">{toOwn.length} scheduled</span>
              <span className="small muted">by {clock(Math.max(...toOwn.map((j) => j.latest)))}</span>
            </div>
            <div className="job-actions">
              <button type="button" className="link-btn" aria-expanded={each} onClick={() => setEach(!each)}>
                {each ? "Hide them" : "Show each"}
              </button>
            </div>
          </li>
        )}
        {(fold ? st.jobs.filter((j) => !sent.includes(j)) : st.jobs)
          .filter((j) => !foldLive || each || !toOwn.includes(j))
          .map((j) => {
          const [label, tone] = j.ripening && j.status === "stale" ? ["Preparing", "wait"] : JOB_STATUS[j.status];
          const late = j.status === "scheduled" && Date.now() > j.latest;
          const line = jobLine(j, st.refreshingJob === j.id);
          const note = jobNote(j);
          return (
            <li key={j.id} className={`job ${tone}`}>
              <div className="job-main">
                <strong className="num">{fmt(BigInt(j.amount))} SOL</strong>
                <ToName to={j.to} />
              </div>
              <div className="job-side">
                <span className={`job-chip ${tone}`}>{late ? "Running late" : label}</span>
                {line && <span className="small muted">{line}</span>}
              </div>
              {note && <p className="small muted job-note">{note}</p>}
              <div className="job-actions">
                {j.status === "stale" && j.confirm && (
                  <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`ok${j.id}`, () => engine.confirmJob(j.id))}>
                    {say(`ok${j.id}`, "Send it", "Making a fresh proof…")}
                  </button>
                )}
                {/* waiting or needing a fresh proof: it can always be called off, even while something else runs */}
                {(j.status === "scheduled" || j.status === "stale" || st.cancellingJobs.includes(j.id)) && (
                  <button type="button" className="link-btn" disabled={st.cancellingJobs.includes(j.id)} onClick={() => void engine.cancelJob(j.id)}>
                    {st.cancellingJobs.includes(j.id) ? "Cancelling…" : "Cancel"}
                  </button>
                )}
                {j.status === "sent" && j.signature && j.hop && <Copy text={j.signature} label="Copy Transaction ID" />}
                {(j.status === "sent" || j.status === "sending") && j.signature && st.pool && <Copy text={explorer(j.signature, st.pool.network)} label="Copy link" />}
                {canRetry(j) && (
                  <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`re${j.id}`, () => engine.retryJob(j.id))}>
                    {say(`re${j.id}`, "Try again", "Sending…")}
                  </button>
                )}
                {/* a cancel the relayer hasn't confirmed yet stays listed (the app keeps calling it off), so it can't be dismissed */}
                {j.cancelPending && !st.cancellingJobs.includes(j.id) && <span className="small muted">Confirming with the relayer…</span>}
                {(j.status === "sent" || j.status === "failed" || j.status === "cancelled" || j.status === "unclear") && !j.cancelPending && (
                  <button type="button" className="link-btn" onClick={() => engine.dismissJob(j.id)}>
                    Dismiss
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="tiny">
        Each payment's proof is held by the relayer, which can send that exact payment or none at all. If it never goes out, its SOL stays yours. If the
        pool gets busy, opening VisionSwap lets your app refresh a payment's proof; the relayer also sends it a little early rather than late.
      </p>
    </section>
  );
}

/**
 * A payment's delivery, under its activity line: the Transaction ID the recipient (or an exchange)
 * looks it up by (`id`, the delivery's own, once it is known to have landed), the one-time address it
 * came from, and a message signed by that address for an exchange that asks the sender to show it controls it.
 */
function DeliveryFacts({ a, id }: { a: Activity & { delivery: { hop: string; to: string } }; id: string | null }) {
  const [signing, setSigning] = useState(false);
  const [text, setText] = useState("");
  const [signed, setSigned] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="a-delivery">
      {id ? (
        <p className="small">
          <span className="muted">Transaction ID (for the recipient or exchange): </span>
          <span className="mono a-id">{short(id, 8)}</span> <Copy text={id} />
        </p>
      ) : (
        <p className="small muted">Delivering. Its Transaction ID shows here as soon as it lands.</p>
      )}
      <p className="small">
        <span className="muted">Sending address: </span>
        <span className="mono">{short(a.delivery.hop, 6)}</span> <Copy text={a.delivery.hop} />
      </p>
      {!signing ? (
        <button type="button" className="link-btn" onClick={() => setSigning(true)}>
          Sign a message from the sending address
        </button>
      ) : (
        <div className="sign-box">
          <label className="field">
            <span className="small muted">The message the exchange asked you to sign</span>
            <textarea className="text-in sign-in" rows={3} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          </label>
          <div className="ask-actions">
            <button
              type="button"
              className="btn small-btn"
              onClick={() => {
                try {
                  setErr(null);
                  setSigned(engine.signFromSender(a.delivery.hop, text));
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Sign it
            </button>
            <button type="button" className="link-btn" onClick={() => setSigning(false)}>
              Close
            </button>
          </div>
          {err && <p className="small warn">{err}</p>}
          {signed && (
            <p className="small">
              <span className="muted">Signature: </span>
              <span className="mono a-id">{short(signed, 8)}</span> <Copy text={signed} />
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * This account's sending addresses holding SOL: a delivery to finish (it runs by itself when it
 * can), SOL that came back to one after its delivery (an exchange returning a deposit, say), or one
 * whose history can't be told (never finished on a guess, but never out of reach either).
 */
export function Deliveries({ st }: { st: State }) {
  const { tap, say } = useTapped(st);
  const [onward, setOnward] = useState<string | null>(null);
  const [to, setTo] = useState("");
  if (!st.hops.length) return null;
  const finish = st.hops.filter((h) => h.kind === "finish");
  // SOL that came back, and ones whose history can't be told: either way the owner picks where it goes
  const back = st.hops.filter((h) => h.kind !== "finish");
  // what a delivery from a sending address passes on (it pays its own fee)
  const net = (lamports: bigint) => (lamports > DELIVERY_FEE ? lamports - DELIVERY_FEE : 0n);
  return (
    <section className="panel">
      <header>
        <h3>Deliveries</h3>
        <span className="muted">{finish.length ? `${finish.length} ready to finish` : back.some((h) => h.kind === "look") ? "Needs a look" : "SOL came back"}</span>
      </header>
      <ul className="jobs">
        {finish.length > 0 && (
          <li className="job wait">
            <div className="job-main">
              <strong>
                {finish.length === 1 ? "1 delivery is ready to finish" : `${finish.length} deliveries are ready to finish`}
                {finish.length === 1 && finish[0].to ? `: ${fmt(net(finish[0].lamports))} SOL to ${short(finish[0].to)}` : ""}
              </strong>
              <span className="muted small">It runs by itself while the app is open; this sends it now.</span>
            </div>
            <div className="job-actions">
              {finish.map((h) =>
                h.to ? (
                  <button key={h.hop} type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`fin${h.hop}`, () => engine.finishHop(h.hop))}>
                    {say(`fin${h.hop}`, finish.length > 1 ? `Finish ${fmt(net(h.lamports))} SOL to ${short(h.to)}` : "Finish now", "Delivering…")}
                  </button>
                ) : null,
              )}
            </div>
          </li>
        )}
        {back.map((h) => (
          <li key={h.hop} className="job good">
            <div className="job-main">
              <strong className="num">{fmt(h.lamports)} SOL</strong>
              <span className="muted small">
                {h.kind === "look"
                  ? `${h.to ? `wait at the sending address of your payment to ${short(h.to)}` : "wait at a sending address of yours"}. Its history couldn't be read, so whether that delivery already went can't be told and nothing is sent on a guess. Move it into your private balance, send it somewhere else, or try finishing again later.`
                  : h.to
                    ? `arrived at the sending address of your payment to ${short(h.to)}`
                    : "arrived at a sending address of yours"}
              </span>
            </div>
            <div className="job-actions">
              {h.kind === "look" && h.to && (
                <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`fin${h.hop}`, () => engine.finishHop(h.hop))}>
                  {say(`fin${h.hop}`, "Try finishing again", "Delivering…")}
                </button>
              )}
              <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => tap(`in${h.hop}`, () => engine.returnToPool(h.hop))}>
                {say(`in${h.hop}`, "Move to my private balance", "Moving…")}
              </button>
              <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => setOnward(onward === h.hop ? null : h.hop)}>
                Send it somewhere else
              </button>
            </div>
            {onward === h.hop && (
              <div className="onward">
                <input className="addr mono" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="Any Solana address" spellCheck={false} autoComplete="off" />
                <BadAddress to={to} />
                <button
                  type="button"
                  className="btn small-btn"
                  disabled={!to || !looksLikeAddress(to) || !!st.busy}
                  onClick={() =>
                    tap(`on${h.hop}`, () =>
                      engine.sendHopOnward(h.hop, to).then(() => {
                        setOnward(null);
                        setTo("");
                      }),
                    )
                  }
                >
                  {say(`on${h.hop}`, "Send it", "Sending…")}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="tiny">Each payment leaves from a one-time sending address that only this account holds the key for, so nothing is ever stuck there.</p>
    </section>
  );
}

/** A round mark for each kind of activity: SOL moving in or out of the private balance, a payment, a trade. */
const KIND_PATH: Record<Activity["kind"], string> = {
  shield: "M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z M8.5 12l2.4 2.4L15.8 9.6",
  sweep: "M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z M8.5 12l2.4 2.4L15.8 9.6",
  merge: "M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z M8.5 12l2.4 2.4L15.8 9.6",
  refund: "M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z M8.5 12l2.4 2.4L15.8 9.6",
  send: "M12 19V5 M6 11l6-6 6 6",
  buy: "M4 8h13l-3.5-3.5 M20 16H7l3.5 3.5",
  sell: "M4 8h13l-3.5-3.5 M20 16H7l3.5 3.5",
};
const timeOf = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export function ActivityList({ st, grouped = false, filter = "all", pageSize = 12 }: { st: State; grouped?: boolean; filter?: ActivityFilter; pageSize?: number }) {
  const [masked] = useMasked();
  const [shown, setShown] = useState(pageSize);
  if (grouped) return <ActivityGroups st={st} filter={filter} shown={shown} more={() => setShown(shown + pageSize)} masked={masked} />;
  if (!st.activity.length) return null;
  // a delivery's Transaction ID is its own transfer's, as the ledger on this device knows it (never the pool spend's)
  const legs = engine.deliveryIds();
  const idOf = (a: Activity & { delivery: { hop: string; onward?: boolean } }) => {
    // SOL that came back and was sent on: that transfer's own ID, never the original delivery's
    if (a.delivery.onward) return a.sig ?? null;
    const l = legs.get(a.delivery.hop);
    return l?.tx2 ?? (a.sig && a.sig !== l?.tx1 ? a.sig : null);
  };
  return (
    <section className="panel">
      <header>
        <h3>Activity</h3>
        <span className="muted">Kept on this device only</span>
      </header>
      <ul className="activity">
        {st.activity.slice(0, 12).map((a) => (
          <li key={a.t + a.text}>
            <span className={`dot ${a.kind}`} />
            <span className="a-text">{masked ? maskText(a.text) : a.text}</span>
            <span className="muted a-when">{ago(a.t)}</span>
            {a.sig && st.pool && (
              <span title="Copies a Solscan link without opening it, so the explorer never sees your IP from here.">
                <Copy text={explorer(a.sig, st.pool.network)} label="Copy link" />
              </span>
            )}
            {a.delivery && <DeliveryFacts a={a as Activity & { delivery: { hop: string; to: string } }} id={idOf(a as Activity & { delivery: { hop: string } })} />}
          </li>
        ))}
      </ul>
      <div className="panel-foot">
        <ConfirmButton label="Clear this list" ask="Clear the list on this device?" yes="Yes, clear it" onYes={() => engine.clearActivity()} />
      </div>
    </section>
  );
}

/** The activity history by day, under the chosen chip, a page at a time (the extension's Activity screen). */
function ActivityGroups({ st, filter, shown, more, masked }: { st: State; filter: ActivityFilter; shown: number; more: () => void; masked: boolean }) {
  const legs = engine.deliveryIds();
  const idOf = (a: Activity & { delivery: { hop: string; onward?: boolean } }) => {
    if (a.delivery.onward) return a.sig ?? null;
    const l = legs.get(a.delivery.hop);
    return l?.tx2 ?? (a.sig && a.sig !== l?.tx1 ? a.sig : null);
  };
  const page = pageOf(st.activity, filter, shown);
  if (!page.items.length) {
    return (
      <p className="small muted activity-empty">
        {st.activity.length ? "Nothing of this kind yet." : "Nothing here yet. Your moves, trades and sends show here, kept on this device only."}
      </p>
    );
  }
  return (
    <div className="activity-g">
      {groupByDay(page.items, Date.now()).map((g) => (
        <section key={g.label} className="activity-day" aria-label={g.label}>
          <h4 className="activity-day-h">{g.label}</h4>
          <ul className="activity activity-rows">
            {g.items.map((a) => (
              <li key={a.t + a.text}>
                <span className={`a-ico ${a.kind}`} aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d={KIND_PATH[a.kind]} />
                  </svg>
                </span>
                <span className="a-text">{masked ? maskText(a.text) : a.text}</span>
                <span className="muted a-when">{timeOf(a.t)}</span>
                {a.sig && st.pool && (
                  <span className="a-link" title="Copies a Solscan link without opening it, so the explorer never sees your IP from here.">
                    <Copy text={explorer(a.sig, st.pool.network)} label="Copy link" />
                  </span>
                )}
                {a.delivery && <DeliveryFacts a={a as Activity & { delivery: { hop: string; to: string } }} id={idOf(a as Activity & { delivery: { hop: string } })} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {page.more && (
        <button type="button" className="link-btn activity-more" onClick={more}>
          Show more
        </button>
      )}
      <div className="panel-foot">
        <ConfirmButton label="Clear this list" ask="Clear the list on this device?" yes="Yes, clear it" onYes={() => engine.clearActivity()} />
      </div>
    </div>
  );
}

export function Records({ st }: { st: State }) {
  const [withKey, setWithKey] = useState(false);
  // ticking "Include my viewing key" asks first: once shared, it can't be taken back
  const [askKey, setAskKey] = useState(false);
  const [prove, setProve] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const download = () => {
    const blob = new Blob([engine.statement(withKey)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `visionswap-statement-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  if (!st.unlocked) return null;
  return (
    <section className="panel">
      <header>
        <h3>Your records</h3>
        <span className="muted">For an exchange or an accountant</span>
      </header>
      <p className="small muted">
        Download a statement of your private notes. Whoever you give it to can check that each note exists on-chain, and for notes that
        came straight from a deposit, which wallet made it. It can't spend anything, and it doesn't prove which notes are still unspent.
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={withKey}
          onChange={(e) => {
            if (e.target.checked) setAskKey(true);
            else setWithKey(false);
          }}
        />
        <span>Include my viewing key: lets the holder see every note you've received, before and after today. It can't be taken back.</span>
      </label>
      {askKey && (
        <div className="vk-ask" role="group" aria-label="Include your viewing key?">
          <p className="small">
            <strong>Share your viewing key?</strong> Whoever holds it can see every note this account has received or will receive, with
            amounts, for as long as you use the account. It can't be taken back.
            {ReceiptMaker ? " To show where one payment came from, a payment receipt (below) shares far less." : ""} If you share it, you
            can open a new account afterwards: notes it receives can't be seen with this key.
          </p>
          <div className="vk-row">
            <button
              type="button"
              className="btn small-btn"
              onClick={() => {
                setWithKey(true);
                setAskKey(false);
              }}
            >
              Include it
            </button>
            <button type="button" className="link-btn" autoFocus onClick={() => setAskKey(false)}>
              Leave it out
            </button>
          </div>
        </div>
      )}
      <button type="button" className="btn ghost small-btn" onClick={download}>
        Download statement
      </button>
      <div className="records-hops">
        <button type="button" className="link-btn" aria-expanded={prove} onClick={() => setProve(!prove)}>
          Prove I control an address
        </button>
        {prove && (
          <>
            <p className="small muted">
              For an exchange that asks you to show an address is yours: sign its message with your connected wallet, a deposit address or a
              Vision wallet.
            </p>
            <ProveControl st={st} />
          </>
        )}
      </div>
      {ReceiptMaker && (
        <div className="records-hops">
          <button type="button" className="link-btn" aria-expanded={receipt} onClick={() => setReceipt(!receipt)}>
            Prove where one payment came from
          </button>
          {receipt && (
            <Suspense fallback={null}>
              <ReceiptMaker st={st} />
            </Suspense>
          )}
        </div>
      )}
      <CheckSendingAddresses />
    </section>
  );
}

/**
 * Every sending address of this account read straight from the chain, on the owner's tap: finds SOL an
 * exchange returned months after a delivery, or a delivery left unfinished long ago, once the relayer's
 * list no longer shows it. Anything found appears under Deliveries.
 */
function CheckSendingAddresses() {
  const [state, setState] = useState<{ going: boolean; said?: string; err?: string }>({ going: false });
  const run = () => {
    setState({ going: true });
    engine
      .checkAllHops()
      .then((r) => setState({ going: false, said: checkedText(r) }))
      .catch((e) => setState({ going: false, err: (e as Error)?.message || "Couldn't read them just now. Try again in a minute." }));
  };
  return (
    <div className="records-hops">
      <p className="small muted">
        Waiting on a deposit an exchange said it returned? This reads every one-time sending address of yours, however old, and lists any
        holding SOL under Deliveries. The site's network connection sees these addresses asked about together, so it only runs when you tap.
      </p>
      <button type="button" className="btn ghost small-btn" disabled={state.going} onClick={run}>
        {state.going ? "Checking…" : "Check all my sending addresses"}
      </button>
      {state.said && <p className="small">{state.said}</p>}
      {state.err && <p className="small warn">{state.err}</p>}
    </div>
  );
}
