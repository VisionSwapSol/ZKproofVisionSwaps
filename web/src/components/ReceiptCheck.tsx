import { useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { MAINNET_PROGRAM_ID, Pool, receiptTxFrom, verifyReceipt, type ReceiptCheck as Check } from "@visionswap/sdk";
import { api, conn } from "../lib/net";

const sol = (l: bigint) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

/**
 * The payment-receipt checker on /verify (P1-1): only in the build while receipts are switched on
 * (lib/features.ts). It reads the receipt's transactions from the RPC the verifier chooses; left empty,
 * VisionSwap's own gateway, which then sees (in memory, never logged) which deposit and payment are
 * read together.
 */
export default function ReceiptCheck() {
  const [text, setText] = useState("");
  const [rpc, setRpc] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Check | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setResult(null);
    let receipt: unknown;
    try {
      receipt = JSON.parse(text);
    } catch {
      return setErr("That isn't a receipt file: paste the whole file, as it was downloaded.");
    }
    setBusy(true);
    try {
      const c = rpc.trim() ? new Connection(rpc.trim(), "confirmed") : conn();
      const programId = await api<{ programId?: string }>("/api/pool/info")
        .then((i) => i.programId ?? MAINNET_PROGRAM_ID)
        .catch(() => MAINNET_PROGRAM_ID);
      const pool = new Pool(new PublicKey(programId));
      const cfg = await c.getAccountInfo(pool.config, "confirmed").catch(() => null);
      const guard = cfg ? pool.decodeConfig(cfg.data).guard.toBase58() : undefined;
      setResult(
        await verifyReceipt(receipt, async (sig) => receiptTxFrom(await c.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 })), {
          programId,
          guard,
        }),
      );
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't check it just now.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <h2 id="receipt">Check a payment receipt</h2>
      <p>
        A payment receipt shows one payment from the pool, the notes it spent and the deposits they came from. This checks it against the
        chain, in your browser.
      </p>
      <form className="verify-form" onSubmit={(e) => void check(e)}>
        <label>
          Receipt (the file's contents)
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </label>
        <label>
          RPC address (optional)
          <input className="mono" value={rpc} onChange={(e) => setRpc(e.target.value)} placeholder="https://your-own-node.example" spellCheck={false} />
        </label>
        <p className="tiny">
          Left empty, the transactions are read through VisionSwap's own connection to Solana, which then sees which deposit and payment are
          read together. Your own RPC address avoids that.
        </p>
        <span>
          <button type="submit" className="btn violet" disabled={busy || !text.trim()}>
            {busy ? "Checking…" : "Check the receipt"}
          </button>
        </span>
      </form>
      {err && <p className="warn">{err}</p>}
      {result && (
        <div className={`verify-out ${result.ok ? "ok" : "bad"}`} role="status">
          {!result.ok ? (
            <>
              <p>
                <strong>Not a valid receipt.</strong>
              </p>
              <ul>
                {result.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p>
                <strong>The receipt is valid.</strong> {sol(result.payment!.withdraw)} SOL left the pool in{" "}
                <span className="mono">{result.payment!.tx}</span> to <span className="mono">{result.payment!.recipient}</span>.
                {result.payment!.delivery && (
                  <>
                    {" "}
                    It was delivered as {sol(result.payment!.delivery.lamports)} SOL to <span className="mono">{result.payment!.delivery.to}</span>.
                  </>
                )}
              </p>
              <p>{result.payment!.complete ? "All of it came from the notes below." : "It spent the notes below; its change wasn't opened, so other notes may have paid for part of it."}</p>
              <ul>
                {result.sources.map((s, i) => (
                  <li key={i}>
                    {s.kind === "deposit" ? (
                      <>
                        {sol(s.amount)} SOL deposited by <span className="mono">{s.depositor}</span>,{" "}
                        {s.pass ? (s.pass.current ? "with a screening pass from the pool's screening key" : "with a screening pass from another key") : "without a screening pass"}.
                      </>
                    ) : s.kind === "received" ? (
                      <>{sol(s.amount)} SOL received privately inside the pool: the trail stops there.</>
                    ) : (
                      <>{sol(s.amount)} SOL from an earlier payment of the same account, not opened.</>
                    )}
                  </li>
                ))}
              </ul>
              {result.bound.length > 0 && <p className="small">Ownership proven for: {result.bound.join(", ")}.</p>}
            </>
          )}
        </div>
      )}
    </>
  );
}
