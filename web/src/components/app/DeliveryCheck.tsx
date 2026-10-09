import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { engine, fmt, type State } from "../../lib/engine";
import { parseSol, short } from "../../lib/net";
import { ls } from "../../lib/idb";
import { copyText } from "../../lib/copy";
import { AmountField } from "./AmountField";

/** One check: the shape asked for, the one that landed (`went`, read from the chain; null while it hasn't been seen landing), and its IDs. */
type Result = { shape: "l1" | "n2"; went?: "l1" | "n2" | null; to: string; amount: string; tx2: string; tx1: string; at: number };

const key = (fp: string | null) => `vs:dcheck:${fp ?? ""}`;
const looksLikeAddress = (a: string) => {
  try {
    new PublicKey(a);
    return true;
  } catch {
    return false;
  }
};

/**
 * The owner's delivery check, at /app#delivery-check (not linked anywhere): one small private
 * payment to an exchange deposit address, delivered in one shape only, to see that the exchange
 * credits it. L1 is the shape of every payment sent now; N2 (on a durable nonce) is the shape of
 * payments sent later and of split payments. The results stay on this device.
 */
export function DeliveryCheck({ st, onClose }: { st: State; onClose: () => void }) {
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("0.05");
  const [results, setResults] = useState<Result[]>(() => ls.get<Result[]>(key(st.fingerprint), []));
  const [copied, setCopied] = useState<string | null>(null);
  const lamports = parseSol(amt);
  const ok = looksLikeAddress(to) && !!lamports && lamports > 0n;
  const run = async (shape: "l1" | "n2") => {
    if (!ok) return;
    const paid = await engine.deliveryCheck(to, lamports!, shape).catch(() => undefined);
    if (!paid) return;
    const next = [{ shape, went: paid.went, to, amount: lamports!.toString(), tx2: paid.sig, tx1: paid.tx1, at: Date.now() }, ...results].slice(0, 30);
    setResults(next);
    ls.set(key(st.fingerprint), next);
  };
  const copy = async (k: string, text: string) => {
    if (await copyText(text)) setCopied(k);
    setTimeout(() => setCopied(null), 1600);
  };
  return (
    <div className="form dcheck">
      <h2>Delivery check</h2>
      <p className="small muted">
        Sends a small private payment to a deposit address, delivered in one shape, so you can see the exchange credit it. L1 is how every payment sent now
        arrives. N2 is how payments sent later, and split payments, arrive.
      </p>
      <label className="field">
        <span className="field-top">
          <span>Deposit address</span>
        </span>
        <input className="addr mono" value={to} onChange={(e) => setTo(e.target.value.trim())} placeholder="Paste a SOL deposit address" spellCheck={false} autoComplete="off" />
      </label>
      {to && !looksLikeAddress(to) && <p className="warn">That doesn't look like a Solana address.</p>}
      <AmountField label="Amount" value={amt} onChange={setAmt} />
      <div className="dcheck-actions">
        <button type="button" className="btn violet" disabled={!ok || !!st.busy || st.update} onClick={() => void run("l1")}>
          Send as L1
        </button>
        <button type="button" className="btn ghost" disabled={!ok || !!st.busy || st.update} onClick={() => void run("n2")}>
          Send as N2
        </button>
      </div>
      {results.length > 0 && (
        <ul className="jobs">
          {results.map((r) => (
            <li key={r.at} className="job good">
              <div className="job-main">
                <strong className="num">
                  {r.shape.toUpperCase()} · {fmt(BigInt(r.amount))} SOL
                </strong>
                <span className="mono muted job-to">to {short(r.to)}</span>
                {!r.tx2 && <span className="small muted">Delivery not seen landing yet: see your activity</span>}
                {r.tx2 && r.went && r.went !== r.shape && <span className="small muted">Arrived as {r.went.toUpperCase()}: run it again for {r.shape.toUpperCase()}</span>}
              </div>
              <div className="job-side">
                <span className="small muted">{new Date(r.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
              </div>
              <div className="job-actions">
                {r.tx2 && (
                  <button type="button" className="link-btn" onClick={() => void copy(`id${r.at}`, r.tx2)}>
                    {copied === `id${r.at}` ? "Copied" : "Copy Transaction ID"}
                  </button>
                )}
                <button type="button" className="link-btn" onClick={() => void copy(`p${r.at}`, r.tx1)}>
                  {copied === `p${r.at}` ? "Copied" : "Copy pool payment ID"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="link-btn" onClick={onClose}>
        ← Back to the app
      </button>
    </div>
  );
}
