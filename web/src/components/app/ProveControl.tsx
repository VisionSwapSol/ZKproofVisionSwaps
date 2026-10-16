import { useState } from "react";
import { engine, type State } from "../../lib/engine";
import { useWalletLike } from "../../lib/wallet";
import { copyText } from "../../lib/copy";
import { short } from "../../lib/net";
import { OWNERSHIP_MAX, ownershipTextProblem, type OwnershipProof } from "../../lib/ownership";
import { siteOrigin } from "../../lib/platform";

type Who = { kind: "vision" | "deposit" | "wallet"; index: number; address: string; label: string };

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="link-btn"
      onClick={() =>
        void copyText(text).then((ok) => {
          setDone(ok);
          if (ok) setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? "Copied" : label}
    </button>
  );
}

/**
 * "Prove I control this address" (P1-2): signs an exchange's message with one address of this account
 * (a Vision wallet, a deposit address, or the connected wallet), prefixed so it can never be a
 * transaction (lib/ownership.ts). The proof stays on this device until the person copies it out; the
 * exchange checks it at /verify or with its own tools.
 *
 * `fixed`: one address only (a Vision wallet's row). Otherwise the person picks the address.
 */
export function ProveControl({
  st,
  fixed,
  onDone,
  onProof,
}: {
  st: State;
  fixed?: { kind: "vision" | "deposit"; index: number; address: string };
  onDone?: () => void;
  /** hears each proof made (a payment receipt can carry it) */
  onProof?: (p: OwnershipProof) => void;
}) {
  const wallet = useWalletLike();
  const choices: Who[] = fixed
    ? [{ ...fixed, label: short(fixed.address, 5) }]
    : [
        ...(wallet ? [{ kind: "wallet" as const, index: 0, address: wallet.publicKey.toBase58(), label: `Connected wallet (${short(wallet.publicKey.toBase58(), 4)})` }] : []),
        ...st.deposits.map((d) => ({ kind: "deposit" as const, index: d.index, address: d.address, label: `Deposit address ${short(d.address, 4)}` })),
        ...st.vision.map((v) => ({ kind: "vision" as const, index: v.index, address: v.address, label: `Vision wallet #${v.index + 1} (${short(v.address, 4)})` })),
      ];
  const [pick, setPick] = useState(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [proof, setProof] = useState<OwnershipProof | null>(null);
  const who = choices[Math.min(pick, choices.length - 1)];
  if (!who) return <p className="small muted">There's no address of yours to sign with yet.</p>;
  const sign = async () => {
    setErr(null);
    setProof(null);
    const why = ownershipTextProblem(text);
    if (why) return setErr(why);
    setBusy(true);
    try {
      const p = await engine.proveControl(who.kind, who.index, text, wallet);
      setProof(p);
      onProof?.(p);
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't sign that message.");
    } finally {
      setBusy(false);
    }
  };
  const verifyAt = `${siteOrigin()}/verify`;
  return (
    <div className="prove">
      {!fixed && choices.length > 1 && (
        <label className="field">
          <span className="field-top">
            <span>Address</span>
          </span>
          <select
            value={pick}
            onChange={(e) => {
              setPick(Number(e.target.value));
              setProof(null);
            }}
          >
            {choices.map((c, i) => (
              <option key={`${c.kind}${c.index}`} value={i}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span className="field-top">
          <span>The exchange's message</span>
        </span>
        <textarea
          value={text}
          maxLength={OWNERSHIP_MAX}
          onChange={(e) => {
            setText(e.target.value);
            setProof(null);
          }}
          placeholder="Paste the text the exchange asked you to sign"
          spellCheck={false}
        />
      </label>
      <span>
        <button type="button" className="btn ghost small-btn" disabled={busy || !text.trim()} onClick={() => void sign()}>
          {busy ? "Signing…" : who.kind === "wallet" ? "Sign with my wallet" : "Sign"}
        </button>
      </span>
      {err && <p className="small warn">{err}</p>}
      {proof && (
        <div className="small" role="status">
          <p>
            <strong>Address</strong> <span className="mono">{proof.address}</span> <CopyBtn text={proof.address} label="Copy" />
          </p>
          <p>
            <strong>Signed message</strong> <CopyBtn text={proof.message} label="Copy" />
          </p>
          <pre className="mono">{proof.message}</pre>
          <p>
            <strong>Signature</strong> <span className="mono">{proof.signature}</span> <CopyBtn text={proof.signature} label="Copy" />
          </p>
          <p className="tiny">
            The exchange can check it at{" "}
            <a href="/verify" target="_blank" rel="noreferrer noopener">
              {verifyAt.replace(/^https?:\/\//, "")}
            </a>{" "}
            or with any ed25519 tool. It shows only that you control this one address; it can't move anything.
            {onDone && (
              <>
                {" "}
                <button type="button" className="link-btn" onClick={onDone}>
                  Done
                </button>
              </>
            )}
          </p>
        </div>
      )}
      {!proof && (
        <p className="tiny">
          What gets signed starts with "VisionSwap ownership proof:", then the exchange's text, so the signature can't be used for anything
          else. Nothing is sent to VisionSwap.
        </p>
      )}
    </div>
  );
}
