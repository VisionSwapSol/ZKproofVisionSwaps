import { useState } from "react";
import { engine, type State } from "../../lib/engine";
import type { OwnershipProof } from "../../lib/ownership";
import { ProveControl } from "./ProveControl";

/**
 * "Prove where one payment came from" (P1-1), in Your records: only while RECEIPTS_ENABLED
 * (lib/features.ts). The person picks one private payment; the app makes a receipt showing that
 * payment, the notes it spent and the deposits they came from, and nothing else about the account.
 */
export function ReceiptMaker({ st }: { st: State }) {
  const payments = st.activity.filter((a) => a.kind === "send" && a.sig && !a.delivery?.onward).slice(0, 50);
  const [pick, setPick] = useState(0);
  const [outputs, setOutputs] = useState(true);
  const [depth, setDepth] = useState<number | null>(null);
  const [proof, setProof] = useState<OwnershipProof | null>(null);
  const [withProof, setWithProof] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [made, setMade] = useState(false);
  if (!payments.length) return <p className="small muted">Your private payments show here once you've made one on this device.</p>;
  const a = payments[Math.min(pick, payments.length - 1)];
  const make = async () => {
    setErr(null);
    setMade(false);
    setBusy(true);
    try {
      const r = await engine.receiptFor(a, { openOutputs: outputs, depth: depth ?? undefined, binding: withProof && proof ? [proof] : undefined });
      const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `visionswap-receipt-${new Date(a.t).toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      setMade(true);
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't make the receipt just now. Try again in a minute.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="prove">
      <p className="small muted">
        A receipt shows one payment, the notes it spent and the deposits they came from, and nothing else about your account: no viewing
        key, no other notes. Whoever you give it to can verify it with the public chain alone. Once shared it can't be taken back, but it covers only
        this payment.
      </p>
      <label className="field">
        <span className="field-top">
          <span>Payment</span>
        </span>
        <select value={pick} onChange={(e) => setPick(Number(e.target.value))}>
          {payments.map((p, i) => (
            <option key={`${p.sig}${i}`} value={i}>
              {new Date(p.t).toLocaleDateString()} · {p.text}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={outputs} onChange={(e) => setOutputs(e.target.checked)} />
        <span>Show that all of it came from these notes (opens the payment's change, so its amount is shown too)</span>
      </label>
      <label className="field">
        <span className="field-top">
          <span>How far back</span>
        </span>
        <select value={depth ?? "all"} onChange={(e) => setDepth(e.target.value === "all" ? null : Number(e.target.value))}>
          <option value="all">Back to the deposits (shows each of your own payments in between)</option>
          <option value="0">This payment only</option>
          <option value="1">One earlier payment of mine</option>
          <option value="2">Two earlier payments of mine</option>
        </select>
      </label>
      <p className="tiny">Each earlier payment of yours that the receipt opens shows its reader one more link between your own payments.</p>
      <label className="check">
        <input type="checkbox" checked={withProof} onChange={(e) => setWithProof(e.target.checked)} />
        <span>Add an ownership proof for the exchange's message (optional)</span>
      </label>
      {withProof && <ProveControl st={st} onProof={setProof} />}
      <span>
        <button type="button" className="btn ghost small-btn" disabled={busy || (withProof && !proof)} onClick={() => void make()}>
          {busy ? "Making the receipt…" : "Download receipt"}
        </button>
      </span>
      {busy && <p className="tiny">The app first downloads the pool's whole transaction list, the same for everyone, so nobody learns which payment this is.</p>}
      {made && (
        <p className="small">
          Saved. It can be checked at <a href="/verify#receipt">/verify</a> or with the VisionSwap SDK against any Solana node.
        </p>
      )}
      {err && <p className="small warn">{err}</p>}
    </div>
  );
}
