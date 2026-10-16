import { lazy, Suspense, useState } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { OWNERSHIP_PREFIX, verifyOwnership, type OwnershipCheck } from "../lib/ownership";
import "../lib/features"; // (declares the build-time switch __VS_RECEIPTS__)
import { PAGES, longDate } from "../seo/pages";
import "../styles/legal.css";

/** The receipt checker: in the bundle only when receipts are switched on (lib/features.ts: the test stays here, so the bundler can drop it). */
const ReceiptCheck = typeof __VS_RECEIPTS__ === "boolean" && __VS_RECEIPTS__ ? lazy(() => import("../components/ReceiptCheck")) : null;

/**
 * /verify: checks, in the browser, that a Solana address signed a message (P1-2), the way an exchange
 * confirms that its customer controls a wallet. Nothing typed into that check is sent anywhere (the
 * receipt checker, while receipts are switched on, reads the chain through the RPC it is given).
 */
export default function VerifyPage() {
  const [address, setAddress] = useState("");
  const [message, setMessage] = useState("");
  const [signature, setSignature] = useState("");
  const [result, setResult] = useState<OwnershipCheck | null>(null);
  const check = (e: React.FormEvent) => {
    e.preventDefault();
    setResult(verifyOwnership({ address, message, signature }));
  };
  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap prose terms">
        <h1>Check an ownership proof</h1>
        <p className="lede">
          Exchanges sometimes ask a customer to show that they control the wallet a transfer comes from or goes to. In the VisionSwap app,
          you can sign the exchange's message with a Vision wallet, a deposit address or your connected wallet. Anyone can check the
          result here, in their own browser: nothing typed into this check is sent anywhere.
        </p>
        <p className="muted">Last updated {longDate(PAGES.verify.updated)}.</p>

        <form className="verify-form" onSubmit={check}>
          <label>
            Address
            <input className="mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <label>
            Message (the exchange's text, with or without the first line the app adds)
            <textarea value={message} onChange={(e) => setMessage(e.target.value)} spellCheck={false} />
          </label>
          <label>
            Signature (base58, hex or base64)
            <input className="mono" value={signature} onChange={(e) => setSignature(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <span>
            <button type="submit" className="btn violet" disabled={!address.trim() || !message.trim() || !signature.trim()}>
              Check the signature
            </button>
          </span>
        </form>
        {result && (
          <div className={`verify-out ${result.ok ? "ok" : "bad"}`} role="status">
            {result.ok ? (
              <p>
                <strong>The signature is valid.</strong> The address <span className="mono">{result.address}</span> signed this message. It
                shows control of that one address, at the time it was signed.
              </p>
            ) : (
              <p>
                <strong>Not a valid proof.</strong> {result.why}
              </p>
            )}
          </div>
        )}

        <h2 id="how">How it works</h2>
        <ul>
          <li>
            The app signs the text <code>{OWNERSHIP_PREFIX.trim()}</code>, then a new line, then the exchange's message, as UTF-8, with the
            address's own ed25519 key: the same kind of signature a Solana wallet makes when it signs a message.
          </li>
          <li>
            The first line means the signature can never be mistaken for a transaction or any other message, so signing it can't move
            funds.
          </li>
          <li>
            To check it with your own tools, verify the ed25519 signature over that exact text with the address's public key (the address,
            decoded from base58). Any standard ed25519 library does it.
          </li>
          <li>
            A valid signature shows that someone with the address's key signed the message. It says nothing else about the address, the
            person or where the funds came from.
          </li>
        </ul>

        <h2 id="make">Making a proof</h2>
        <p>
          In the app, open <strong>Wallets</strong>, then <strong>More</strong> on a Vision wallet, and choose <strong>Prove control</strong>.
          For a deposit address or the wallet you connected, use <strong>Prove I control an address</strong> under{" "}
          <strong>Your records</strong>. Paste the exchange's message, sign, and copy the address, the signed message and the signature
          back to the exchange.
        </p>

        {ReceiptCheck && (
          <Suspense fallback={null}>
            <ReceiptCheck />
          </Suspense>
        )}

        <p>
          Nothing on this page is legal or compliance advice. See also the <a href="/compliance">Compliance</a> and{" "}
          <a href="/security">Security</a> pages.
        </p>
      </main>
      <Footer />
    </div>
  );
}
