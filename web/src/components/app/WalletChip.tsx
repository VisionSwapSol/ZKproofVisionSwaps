import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { fmt, type State } from "../../lib/engine";
import { short } from "../../lib/net";
import { copyText } from "./Panels";
import { useCloseRequest } from "../../lib/closereq";

/** The connected wallet, always in view: icon, address and balance, with a small panel for details. */
export function WalletChip({ st }: { st: State }) {
  const { wallet, publicKey, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  // Back (in the Android app) closes the panel first
  useCloseRequest(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    // the panel's first action takes the focus, so the keyboard goes straight on from the chip
    first.current?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  if (!publicKey || !wallet) return null;
  const addr = publicKey.toBase58();
  return (
    <div
      className="wchip-box"
      ref={box}
      onKeyDown={(e) => {
        // Escape closes this panel only, and the focus goes back to the chip
        if (e.key !== "Escape" || !open) return;
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button ref={trigger} type="button" className="wchip" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <span className="wchip-dot" aria-hidden="true" />
        <img src={wallet.adapter.icon} alt="" width={20} height={20} />
        <span className="mono">{short(addr)}</span>
        {st.publicLamports != null && <span className="wchip-bal">{fmt(st.publicLamports, 3)} SOL</span>}
      </button>
      {open && (
        <div className="wpop" role="dialog" aria-label="Connected wallet">
          <div className="wpop-top">
            <img src={wallet.adapter.icon} alt="" width={36} height={36} />
            <div>
              <strong>{wallet.adapter.name}</strong>
              <span className="wpop-status">
                <i aria-hidden="true" /> Connected
              </span>
            </div>
          </div>
          <p className="wpop-addr mono">{addr}</p>
          <dl className="wpop-rows">
            <div>
              <dt>In this wallet</dt>
              <dd>{st.publicLamports != null ? `${fmt(st.publicLamports, 4)} SOL` : "…"}</dd>
            </div>
            <div>
              <dt>Private balance</dt>
              <dd>{st.unlocked ? `${fmt(st.balance, 4)} SOL` : "Locked"}</dd>
            </div>
          </dl>
          <div className="wpop-actions">
            <button
              ref={first}
              type="button"
              className="btn ghost small-btn"
              onClick={async () => {
                setCopied(await copyText(addr));
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
            <button
              type="button"
              className="btn ghost small-btn"
              disabled={!!st.busy}
              onClick={() => {
                setOpen(false);
                disconnect().catch(() => {});
              }}
            >
              Disconnect
            </button>
          </div>
          {st.busy && <p className="tiny wpop-wait">Disconnect when the current step has finished.</p>}
        </div>
      )}
    </div>
  );
}
