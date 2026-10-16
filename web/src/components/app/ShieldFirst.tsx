import { useEffect, useRef } from "react";
import { Icon } from "../Icon";
import { fmt } from "../../lib/engine";
import { IS_EXTENSION } from "../../lib/platform";
import { useCloseRequest } from "../../lib/closereq";
import { useFocusTrap } from "./Sheet";

/** What a form says when its amount is more than an empty private balance. */
export const EMPTY_WARN = IS_EXTENSION
  ? "Your private balance is empty. Add SOL first (Receive, on the home screen), then come back."
  : "Your private balance is empty. Shield SOL first (the Shield tab at the top), then come back.";

/**
 * Buys spend the private balance, never the connected wallet's SOL (sends can come straight from
 * the wallet). Someone who heads for Buy with nothing shielded yet is shown the way in. `wait` is
 * how long the waiting room takes, in words; `hasWallet` is off for an account opened with a key.
 */
export function ShieldFirst({
  hasWallet,
  wallet,
  wait,
  onShield,
  onClose,
}: {
  hasWallet: boolean;
  wallet: bigint | null;
  wait: string;
  onShield: () => void;
  onClose: () => void;
}) {
  const go = useRef<HTMLButtonElement>(null);
  // Tab stays in the pop-up while it's open
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box);
  // the page re-renders often (balance, prices): focus is set once, when it opens
  const close = useRef(onClose);
  close.current = onClose;
  // Back (in the Android app) closes this pop-up, not the app
  useCloseRequest(true, () => close.current());
  useEffect(() => {
    go.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <div className="sf-back" onClick={onClose}>
      <div ref={box} className="sf" role="dialog" aria-modal="true" aria-labelledby="sf-title" onClick={(e) => e.stopPropagation()}>
        <span className="sf-ico">
          <Icon name="shield" size={26} />
        </span>
        <h2 id="sf-title">Add SOL to trade privately</h2>
        <p className="sf-lead">
          Private buys come from your private balance, so each token lands in a fresh Vision wallet with no tie to{" "}
          {hasWallet ? "your wallet" : "where your SOL came from"}. Add SOL once, then trade as often as you like.
        </p>
        <ol className="sf-steps">
          <li>
            <b>Shield</b>
            <span>
              {hasWallet ? "Move SOL in from your wallet, or by QR code from any wallet or exchange." : "Add SOL by QR code from any wallet or exchange."} Ready
              in about {wait}.
            </span>
          </li>
          <li>
            <b>Trade privately</b>
            <span>Buy and sell, plus limit orders, DCA, take-profits and stop-losses.</span>
          </li>
          <li>
            <b>Send any time</b>
            <span>Pay any wallet or exchange address from the Send tab{hasWallet ? ", even straight from your wallet" : ""}.</span>
          </li>
        </ol>
        {wallet != null && wallet > 0n && <p className="sf-note">Your wallet holds {fmt(wallet)} SOL, ready to shield.</p>}
        <div className="sf-btns">
          <button ref={go} type="button" className="btn violet wide" onClick={onShield}>
            Shield SOL now
          </button>
          <button type="button" className="btn ghost wide" onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
