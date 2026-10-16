import { useState } from "react";
import { engine, fmt, fmtUp, solText, type DepositView, type PayRequest, type State } from "../../lib/engine";
import { parseSol, short } from "../../lib/net";
import { copyText } from "../../lib/copy";
import { ClosedNote, QrCode } from "./Qr";
import { AmountField } from "./AmountField";

/** A link anyone can pay: it lands on a fresh deposit address and moves into the private balance. */
export function RequestLink({ st }: { st: State }) {
  const [amt, setAmt] = useState("");
  const [note, setNote] = useState("");
  const [made, setMade] = useState<PayRequest | null>(null);
  const [making, setMaking] = useState(false);
  const lamports = parseSol(amt);
  const min = engine.minReceive();
  const tooSmall = !!lamports && min != null && lamports < min;
  if (made) return <RequestCard r={made} onNew={() => setMade(null)} />;
  return (
    <div className="form req-form">
      <ClosedNote st={st} />
      <p className="qr-lead">
        Ask someone for SOL with a link. They pay from any wallet or exchange, and it moves into your private balance. They never see your private
        balance or your other wallets.
      </p>
      <AmountField label="Amount" hint="Optional" value={amt} onChange={setAmt} placeholder="Any amount" />
      <label className="field">
        <span className="field-top">
          <span>What it's for</span>
          <span className="muted">Optional, shown to the payer</span>
        </span>
        <input className="text-in" value={note} onChange={(e) => setNote(e.target.value.slice(0, 80))} placeholder="Dinner, rent, an invoice number…" autoComplete="off" />
      </label>
      {tooSmall && <p className="warn">Ask for at least {fmtUp(min!)} SOL: that's the smallest deposit plus its fees.</p>}
      <button
        className="btn violet wide"
        disabled={tooSmall || !st.unlocked || making}
        onClick={() => {
          setMaking(true);
          engine
            .createRequest(lamports && lamports > 0n ? lamports : null, note)
            .then(setMade, (e) => engine.reportError((e as Error).message))
            .finally(() => setMaking(false));
        }}
      >
        {making ? "Making a fresh address…" : lamports && !tooSmall ? `Create a link for ${fmt(lamports, 9)} SOL` : "Create payment link"}
      </button>
      <p className="tiny">
        A link is for one person or one bill: make a new link for each person you ask, so every payer gets an address of their own and
        nobody's payment sits next to anyone else's. Anything below{" "}
        {min != null ? `${fmtUp(min)} SOL` : "the smallest deposit"} waits at the address until more arrives. Paid links move into the pool
        one at a time, a few minutes apart.
      </p>
    </div>
  );
}

function RequestCard({ r, onNew }: { r: PayRequest; onNew?: () => void }) {
  const link = engine.requestLink(r);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="form req-made">
      <span className="eyebrow">Payment link ready</span>
      <div className="req-card">
        <div className="qr-frame">
          <QrCode text={link} size={196} label="QR code of the payment link" />
        </div>
        <div className="req-side">
          <strong className="req-amount">{r.amount ? `${solText(BigInt(r.amount))} SOL` : "Any amount"}</strong>
          {r.note && <span className="req-note">“{r.note}”</span>}
          <code className="req-link mono" translate="no">
            {link}
          </code>
          <div className="qr-actions">
            <button
              type="button"
              className="btn ghost small-btn"
              onClick={async () => {
                setCopied(await copyText(link));
                setTimeout(() => setCopied(false), 1600);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            {canShare && (
              <button
                type="button"
                className="btn ghost small-btn"
                onClick={() => navigator.share({ title: "VisionSwap payment request", text: r.note || "Pay me on VisionSwap", url: link }).catch(() => {})}
              >
                Share
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="tiny">You can close this page. When it's paid, it moves into your private balance the next time you open VisionSwap. Track it under Payment requests.</p>
      {onNew && (
        <button type="button" className="link-btn" onClick={onNew}>
          Make another link
        </button>
      )}
    </div>
  );
}

type Status = { label: string; tone: "good" | "wait" | "bad" | "mute"; text: string };

/**
 * Where a request stands, from what moved in (counted when it moved) and what is at its address
 * now. An amount within a hair of the request counts as paid (rounding, a wallet's own maths);
 * anything short says by how much, and SOL that can't go in says so instead of "Arriving".
 */
function requestStatus(r: PayRequest, d: DepositView | undefined, min: bigint | null): Status {
  const got = BigInt(r.received);
  const at = d?.lamports ?? 0n;
  const want = r.amount ? BigInt(r.amount) : null;
  // 0.1% or 0.00001 SOL, whichever is more: never enough to call a real shortfall paid
  const slack = want ? (want / 1000n > 10_000n ? want / 1000n : 10_000n) : 0n;
  const paid = want ? got + slack >= want : got > 0n;
  const movable = min != null && at >= min;
  if (d?.held === "refused" && at > 0n) return { label: "Refused", tone: "bad", text: `${fmt(at, 6)} SOL can't go in: see Deposit addresses` };
  if (d?.held === "returned" && at > 0n) return { label: "Returned", tone: "bad", text: `${fmt(at, 6)} SOL came back: see Deposit addresses` };
  if (d?.held === "failed" && at > 0n) return { label: "Needs a look", tone: "bad", text: `${fmt(at, 6)} SOL waiting: see Deposit addresses` };
  if (paid) return { label: "Paid", tone: "good", text: `${fmt(got)} SOL received${movable ? ` · ${fmt(at)} SOL more arriving` : ""}` };
  if (movable) return { label: "Arriving", tone: "wait", text: `${fmt(at)} SOL at the address` };
  if (got > 0n && want) {
    // what is left must reach the smallest deposit together with what already waits at the address
    const short = want - got;
    const topUp = min != null && at + short < min ? min - at : short;
    return { label: "Part paid", tone: "wait", text: `${fmt(got)} SOL received · short by ${fmtUp(short)} SOL${topUp > short ? `, send at least ${fmtUp(topUp)} SOL to finish` : ""}` };
  }
  if (at > 0n) return { label: "Too small", tone: "wait", text: `${fmt(at, 6)} SOL at the address${min != null ? ` · needs ${fmtUp(min - at)} SOL more to move in` : ""}` };
  return { label: "Waiting", tone: "mute", text: "not paid yet" };
}

/** The payment links made on this device, and what each has received. */
export function PaymentRequests({ st }: { st: State }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!st.requests.length) return null;
  const min = engine.minReceive();
  return (
    <section className="panel">
      <header>
        <h3>Payment requests</h3>
        <span className="muted">Kept on this device</span>
      </header>
      <ul className="jobs reqs">
        {st.requests.map((r) => {
          const d = st.deposits.find((x) => x.index === r.index);
          const s = requestStatus(r, d, min);
          return (
            <li key={r.index} className={`job ${s.tone}`}>
              <div className="job-main">
                <strong className="num">{r.amount ? `${solText(BigInt(r.amount))} SOL` : "Any amount"}</strong>
                <span className="muted small">{r.note || `to ${short(r.address)}`}</span>
              </div>
              <div className="job-side">
                <span className={`job-chip ${s.tone}`}>{s.label}</span>
                <span className="small muted">{s.text}</span>
              </div>
              {d && d.tokens.length > 0 && <p className="small muted job-note">Tokens arrived, not SOL: see Deposit addresses.</p>}
              <div className="job-actions">
                <button type="button" className="link-btn" onClick={() => setOpen(open === r.index ? null : r.index)}>
                  {open === r.index ? "Hide link" : "Show link"}
                </button>
                <button type="button" className="link-btn" onClick={() => engine.removeRequest(r.index)}>
                  Remove
                </button>
              </div>
              {open === r.index && (
                <div className="req-inline">
                  <RequestCard r={r} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <p className="tiny">Removing a request only hides it here. Its address stays yours: anything paid to it later still moves into your private balance.</p>
    </section>
  );
}
