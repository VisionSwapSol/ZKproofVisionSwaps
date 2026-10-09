import { useEffect, useMemo, useState } from "react";
import { engine, fmt, fmtUp, type State } from "../../lib/engine";
import { parseSol } from "../../lib/net";
import { qrMatrix, qrPath } from "../../lib/qr";
import { isMobile } from "../../lib/wallet";
import { copyText } from "./Panels";
import { AmountField } from "./AmountField";
import { useTabActive } from "./TabActive";

/** Lamports as a plain decimal SOL amount ("1.5"), the way Solana Pay links want it. */
function solText(l: bigint): string {
  const whole = l / 1_000_000_000n;
  const frac = (l % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function QrCode({ text, size = 232, label }: { text: string; size?: number; label: string }) {
  const m = useMemo(() => qrMatrix(text, "M"), [text]);
  const n = m.length + 8;
  return (
    <svg className="qr-svg" viewBox={`0 0 ${n} ${n}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={qrPath(m, 4)} fill="#14072b" />
    </svg>
  );
}

/**
 * Shield by QR code: a deposit address that belongs to this private account.
 * SOL sent to it from any wallet or exchange is screened and moved into the
 * waiting room automatically, then joins the private balance.
 */
export function QrDeposit({ st }: { st: State }) {
  const [amt, setAmt] = useState("");
  const [copied, setCopied] = useState(false);
  const pool = st.pool!;
  const address = engine.depositAddress(st.qrIndex);
  const lamports = parseSol(amt);
  const min = engine.minReceive();
  const here = st.deposits.find((d) => d.index === st.qrIndex);
  const bal = here?.lamports ?? 0n;
  const mobile = isMobile();
  const delayMin = Math.max(1, Math.round((Number(pool.depositDelaySlots) * 0.4) / 60));
  // the pool isn't taking deposits (paused, or full for now): what arrives waits here until it is
  const closed = pool.depositsPaused || (pool.tvlRoom != null && BigInt(pool.tvlRoom) < BigInt(pool.minDeposit));
  const eta = engine.moveEta(st.qrIndex) ?? 0;
  // watched closely only while on screen (the Shield tab stays mounted behind the others)
  const active = useTabActive();
  useEffect(() => {
    if (!active) return;
    engine.watchQr(true);
    return () => engine.watchQr(false);
  }, [st.qrIndex, active]);
  const request = lamports && lamports > 0n ? `solana:${address}?amount=${solText(lamports)}&label=VisionSwap` : null;
  const tooSmall = lamports && min != null && lamports > 0n && lamports < min;
  const copy = async () => {
    setCopied(await copyText(address));
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="form qr-form">
      {st.account === "key" && st.balance === 0n && st.notes.length === 0 && st.waiting.length === 0 && (
        <span className="eyebrow">Step 2 of 3 · Send SOL to your QR code</span>
      )}
      <ClosedNote st={st} />
      <p className="qr-lead">
        Send SOL to this address from any wallet or exchange (SOL only: tokens like USDC don't go into the private balance). As soon as it
        arrives, it's screened and moves into your private balance by itself.
      </p>
      <div className="qr-card">
        <div className="qr-frame">
          <QrCode text={request ?? address} label={request ? "QR code asking for the amount below" : "QR code of your deposit address"} />
        </div>
        <div className="qr-side">
          <span className="eyebrow">Your deposit address</span>
          <p className="qr-addr mono" translate="no">
            {address}
          </p>
          <div className="qr-actions">
            <button type="button" className="btn ghost small-btn" onClick={copy}>
              {copied ? "Copied" : "Copy address"}
            </button>
            {mobile && (
              <a className="btn ghost small-btn" href={request ?? `solana:${address}`}>
                Open in wallet app
              </a>
            )}
          </div>
          <p className="tiny">Only your private account holds this address's key, so only you can move what arrives.</p>
        </div>
      </div>

      <div className={`qr-status${bal > 0n ? " got" : ""}`} role="status" aria-live="polite">
        {here?.held && bal > 0n ? (
          <span>
            <strong>{fmt(bal, 6)} SOL</strong>{" "}
            {here.held === "returned"
              ? "came back to this address from the waiting room. Choose what to do with it under Deposit addresses."
              : here.held === "refused"
                ? "here can't go into the pool: it came from an address that doesn't pass screening. You can send it out under Deposit addresses."
                : "is waiting at this address. Move it into the pool under Deposit addresses."}
          </span>
        ) : bal === 0n || min == null ? (
          <>
            <span className="spinner small" aria-hidden="true" />
            <span>Waiting for SOL to arrive…</span>
          </>
        ) : bal < min ? (
          <span>
            <strong>{fmt(bal, 6)} SOL</strong> arrived. Send at least <strong>{fmtUp(min - bal)} SOL</strong> more to the same address to reach
            the smallest deposit.
          </span>
        ) : closed ? (
          <span>
            <strong>{fmt(bal, 6)} SOL</strong> arrived and is safe at this address. It moves into the pool by itself once the pool takes deposits again.
          </span>
        ) : here?.wait ? (
          <span>
            <strong>{fmt(bal, 6)} SOL</strong> arrived and is safe at this address. {here.wait}
          </span>
        ) : eta > 45_000 ? (
          <span>
            <strong>{fmt(bal, 6)} SOL</strong> arrived. It moves into the pool in about {Math.ceil(eta / 60_000)} min.
          </span>
        ) : (
          <>
            <span className="spinner small" aria-hidden="true" />
            <span>
              <strong>{fmt(bal, 6)} SOL</strong> arrived. Moving it into the pool…
            </span>
          </>
        )}
      </div>

      <AmountField label="Amount to ask for" hint="Optional" value={amt} onChange={setAmt} placeholder="Any amount" />
      {tooSmall ? (
        <p className="warn">Ask for at least {fmtUp(min!)} SOL: that's the smallest deposit plus its fees.</p>
      ) : (
        request && <p className="tiny">Wallets that read Solana Pay codes fill in this amount. From an exchange, clear it and send to the plain address.</p>
      )}

      <dl className="rows">
        <div>
          <dt>Smallest amount to send</dt>
          <dd>{min != null ? `${fmtUp(min)} SOL` : "…"}</dd>
        </div>
        {engine.depositFeeBps() > 0 && (
          <div>
            <dt>Pool fee ({(engine.depositFeeBps() / 100).toLocaleString("en-US")}%)</dt>
            <dd className="txt">taken from what arrives</dd>
          </div>
        )}
        <div>
          <dt>Waiting room</dt>
          <dd>about {delayMin} minute{delayMin === 1 ? "" : "s"}</dd>
        </div>
      </dl>
      <p className="tiny">
        You can close this page: SOL that arrives while you're away moves into your private balance the next time you open your account. Each
        deposit gets a fresh address, and older ones keep working. The network fee and a {st.rent ? fmt(st.rent.pending, 4) : "small"} SOL
        account deposit also come from what arrives; the account deposit returns to this address when your SOL joins the pool. Anyone can see
        which wallet paid this address. That's expected: what happens next is the private part.{" "}
        <button type="button" className="link-btn" onClick={() => engine.newDepositAddress()}>
          Use a new address
        </button>
      </p>
    </div>
  );
}

/** Said before asking for SOL when the pool isn't taking deposits right now: what arrives stays safe and moves in later. */
export function ClosedNote({ st }: { st: State }) {
  const pool = st.pool;
  if (!pool) return null;
  if (pool.depositsPaused) return <p className="warn">Deposits are paused right now. SOL sent here stays safe at the address and moves in once they reopen.</p>;
  if (pool.tvlRoom != null && BigInt(pool.tvlRoom) < BigInt(pool.minDeposit)) {
    return <p className="warn">The pool is full for now. SOL sent here stays safe at the address and moves in once there's room.</p>;
  }
  return null;
}
