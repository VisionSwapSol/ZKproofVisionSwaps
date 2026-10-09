import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Icon } from "../components/Icon";
import { QrCode } from "../components/app/Qr";
import { AmountField } from "../components/app/AmountField";
import { CopyLink } from "../components/app/Panels";
import { Wallets, isMobile, useEngine } from "../lib/wallet";
import { conn, confirmSig, parseSol, sendAndConfirm, short, signatureOf, StillPending } from "../lib/net";
import { copyText } from "../lib/copy";
import { engine, fmtUp, solText } from "../lib/engine";

type Req = { to: string; amount: bigint | null; note: string };

/** The request lives after "#" in the link, so no server ever sees who asked whom for what. */
function readRequest(): Req | null {
  const q = new URLSearchParams(location.hash.replace(/^#/, ""));
  try {
    const to = new PublicKey(q.get("to") ?? "").toBase58();
    const amount = q.get("amount") ? parseSol(q.get("amount")!) : null;
    return { to, amount: amount && amount > 0n ? amount : null, note: (q.get("note") ?? "").slice(0, 80) };
  } catch {
    return null;
  }
}

/**
 * A payment request: pay it from any wallet, an exchange, or privately from VisionSwap. Anyone can
 * write such a link, so the page shows the address and the message as the requester's, never as
 * something VisionSwap vouches for.
 */
export default function PayPage() {
  useEffect(() => {
    document.title = "VisionSwap · Payment request";
  }, []);
  return (
    <Wallets>
      <div className="page pay-page">
        <Header />
        <main>
          <PayBody />
        </main>
        <Footer />
      </div>
    </Wallets>
  );
}

/** A payment that has been sent from this page: its id is known before it goes out, so it's never paid twice. */
type Sent = { sig: string; blockhash?: string; state: "confirming" | "slow" | "done" };

function PayBody() {
  const req = useMemo(readRequest, []);
  const st = useEngine();
  const [amt, setAmt] = useState(req?.amount ? solText(req.amount) : "");
  const [copied, setCopied] = useState<"address" | "amount" | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a link that has been paid before says so, so nobody pays twice by accident
  const [seen, setSeen] = useState(false);
  const [again, setAgain] = useState(false);
  const { wallets, select, wallet, publicKey, connecting, connected, sendTransaction, signTransaction, disconnect } = useWallet();
  // a wallet error shown here stays here: one left over from the app isn't shown to the payer, and one from here never turns up in the app afterwards (cleared before the first paint)
  useLayoutEffect(() => {
    engine.clearError();
    return () => engine.clearError();
  }, []);
  useEffect(() => {
    void engine.loadPool();
    if (!req?.amount) return;
    conn()
      .getSignaturesForAddress(new PublicKey(req.to), { limit: 1 }, "confirmed")
      .then((s) => setSeen(s.length > 0))
      .catch(() => {});
  }, [req]);
  const lamports = req?.amount ?? parseSol(amt);
  // the least the address can take in: less would sit there and never reach the private balance
  const min = engine.minReceive();
  const below = !!lamports && min != null && lamports < min;
  if (!req) {
    return (
      <section className="pay-wrap">
        <div className="pay-card">
          <h1>This payment link isn't complete.</h1>
          <p className="muted">Ask the person who sent it for a fresh link.</p>
        </div>
      </section>
    );
  }
  const asked = lamports && !below ? lamports : null;
  const uri = `solana:${req.to}${asked ? `?amount=${solText(asked)}&label=${encodeURIComponent("Payment request")}${req.note ? `&message=${encodeURIComponent(req.note)}` : ""}` : ""}`;
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const plain = (e: unknown) => {
    const m = (e as Error)?.message ?? "";
    if (/reject|cancel|declin/i.test(m)) return "Cancelled in your wallet.";
    if (/for rent/i.test(m)) return "That's less than this address can receive. Try a larger amount.";
    return m || "The payment didn't go through.";
  };
  // after a hiccup, look again: done, certainly not sent (pay again), or still unknown
  const settle = async (s: Sent, wait: Promise<unknown>) => {
    try {
      await wait;
      setSent({ ...s, state: "done" });
    } catch (e) {
      if (e instanceof StillPending) setSent({ ...s, state: "slow" });
      else {
        setSent(null);
        setErr(plain(e));
      }
    }
  };
  const pay = async () => {
    if (!publicKey || !asked) return;
    setErr(null);
    setBusy(true);
    try {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(req.to), lamports: asked }));
      const bh = await conn().getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      tx.feePayer = publicKey;
      if (signTransaction) {
        // signed first, so the payment's id is known before it's sent: a lost reply can't lead to paying twice
        const signed = await signTransaction(tx);
        // the blockhash the wallet really signed (a wallet may refresh it), so expiry is judged right
        const s: Sent = { sig: signatureOf(signed), blockhash: signed.recentBlockhash ?? bh.blockhash, state: "confirming" };
        setSent(s);
        await settle(s, sendAndConfirm(signed, "payment"));
      } else {
        // the wallet signs and sends it, so the blockhash it used isn't known: never call it dropped, only confirmed or still unknown
        const sig = await sendTransaction(tx, conn());
        const s: Sent = { sig, state: "confirming" };
        setSent(s);
        await settle(s, confirmSig(sig, "payment", 90_000));
      }
    } catch (e) {
      setErr(plain(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (what: "address" | "amount", text: string) => {
    setCopied((await copyText(text)) ? what : null);
    setTimeout(() => setCopied(null), 1600);
  };
  const network = st.pool?.network;
  return (
    <section className="pay-wrap">
      <div className="pay-card">
        <span className="eyebrow">Payment request</span>
        <h1>{req.amount ? `Pay ${solText(req.amount)} SOL` : "Send SOL"}</h1>
        <p className="pay-to">
          To <code className="mono">{short(req.to, 6)}</code>
        </p>
        {req.note && (
          <div className="pay-note">
            <span className="pay-note-tag">Their message</span>
            <p>{req.note}</p>
          </div>
        )}
        <p className="small muted">
          The person who sent you this link chose this address{req.note ? " and message" : ""}. VisionSwap doesn't check who it belongs to, so only pay
          people you know. VisionSwap never asks for a payment to verify, unlock or recover an account.
        </p>

        {sent?.state === "done" ? (
          <div className="pay-done" role="status">
            <span className="pay-check">
              <Icon name="check" />
            </span>
            <div>
              <strong>Paid. Thank you.</strong>
              <p className="small muted">
                {asked ? `${solText(asked)} SOL` : "Your SOL"} was sent to {short(req.to)}.
              </p>
            </div>
          </div>
        ) : sent ? (
          <div className="pay-pending" role="status" aria-live="polite">
            {sent.state === "confirming" ? (
              <p>
                <span className="spinner small" aria-hidden="true" /> Sent. Confirming on Solana…
              </p>
            ) : (
              <>
                <p>
                  Your payment was sent and may still be confirming. Check your wallet's activity before paying again: it shows there once it
                  lands.
                </p>
                <button
                  type="button"
                  className="btn ghost small-btn"
                  onClick={() => {
                    setSent({ ...sent, state: "confirming" });
                    void settle(sent, confirmSig(sent.sig, "payment", 30_000, sent.blockhash));
                  }}
                >
                  Check again
                </button>
              </>
            )}
            {network && <CopyLink sig={sent.sig} network={network} />}
          </div>
        ) : seen && !again ? (
          <div className="pay-pending" role="status">
            <p>This link has already received a payment. If that was you, there's nothing more to do.</p>
            <button type="button" className="btn ghost small-btn" onClick={() => setAgain(true)}>
              Pay anyway
            </button>
          </div>
        ) : (
          <div className="pay-grid">
            <div className="pay-qr">
              <QrCode text={uri} size={220} label="QR code to pay this request" />
              <span className="small muted">Scan with any Solana wallet</span>
            </div>
            <div className="pay-ways">
              {!req.amount && (
                <AmountField label="Amount" hint={min != null ? `At least ${fmtUp(min)} SOL` : undefined} value={amt} onChange={setAmt} />
              )}
              {below && (
                <p className="warn">
                  {req.amount ? "This link asks for less than the smallest payment that can reach their private balance. " : ""}The smallest payment here is {fmtUp(min!)} SOL.
                </p>
              )}
              {isMobile() && (
                <a className="btn violet wide" href={uri}>
                  Open in my wallet app
                </a>
              )}
              {connected && publicKey ? (
                <>
                  <button className="btn violet wide" disabled={!asked || busy} onClick={pay}>
                    {busy ? "Waiting for your wallet…" : `Pay ${asked ? `${solText(asked)} SOL ` : ""}with ${wallet?.adapter.name ?? "my wallet"}`}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      // the last wallet's errors go with it
                      setErr(null);
                      engine.clearError();
                      disconnect().catch(() => {});
                    }}
                  >
                    Use a different wallet
                  </button>
                </>
              ) : installed.length ? (
                <div className="pay-wallets">
                  <span className="small muted">Pay with a browser wallet:</span>
                  {installed.map((w) => (
                    <button
                      key={w.adapter.name}
                      type="button"
                      className="pay-wallet"
                      disabled={connecting}
                      onClick={() => {
                        // picking a wallet connects it (autoConnect); its errors come back through the engine
                        setErr(null);
                        engine.clearError();
                        select(w.adapter.name);
                      }}
                    >
                      <img src={w.adapter.icon} alt="" width={24} height={24} />
                      {connecting && wallet?.adapter.name === w.adapter.name ? "Connecting…" : w.adapter.name}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="pay-addr">
                <span className="small muted">Or send SOL to this address from any wallet or exchange:</span>
                <code className="mono" translate="no">
                  {req.to}
                </code>
                <div className="pay-copy">
                  <button type="button" className="btn ghost small-btn" onClick={() => copy("address", req.to)}>
                    {copied === "address" ? "Copied" : "Copy address"}
                  </button>
                  {req.amount && (
                    <button type="button" className="btn ghost small-btn" onClick={() => copy("amount", solText(req.amount!))}>
                      {copied === "amount" ? "Copied" : `Copy amount`}
                    </button>
                  )}
                </div>
                <span className="tiny pay-fine">
                  SOL only, not tokens like USDC.
                  {req.amount
                    ? ` Exchanges often take their fee from the amount: make sure ${solText(req.amount)} SOL arrives.`
                    : min != null
                      ? ` Send at least ${fmtUp(min)} SOL.`
                      : ""}
                </span>
              </div>
              {err ? <p className="warn">{err}</p> : !connected && !connecting && st.error ? <p className="warn">{st.error}</p> : null}
            </div>
          </div>
        )}
        {!sent && (!seen || again) && (
          <div className="pay-private">
            <Icon name="eyeOff" />
            <p className="small">
              Have a VisionSwap balance?{" "}
              <a href={`/app#send&to=${req.to}${asked ? `&amount=${solText(asked)}` : ""}`}>Pay privately from it</a>, so your own wallet never shows
              up either.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
