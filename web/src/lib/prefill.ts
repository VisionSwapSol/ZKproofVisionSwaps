import { PublicKey } from "@solana/web3.js";
import { normAmount } from "./amount";

/**
 * "Pay privately from it" on a payment request opens /app#send&to=…&amount=…. The details
 * ride after "#" so no server reads them, and they leave the address bar as soon as the app
 * has read them: a reload, a new tab or a wallet's "open in app" link never carries them on.
 * Older links put them in the query (?send=…); those are read and cleared the same way.
 */
type Prefill = { to: string; amount: string };
let pending: Prefill | null = null;

/** Reads the hand-off once (if any), clears it from the address bar, and returns the tab named after "#". */
export function readHandOff(): string {
  const parts = location.hash.replace(/^#/, "").split(/[?&]/);
  const tab = parts[0];
  const q = new URLSearchParams(parts.slice(1).join("&"));
  const old = new URLSearchParams(location.search);
  const to = q.get("to") ?? old.get("send");
  const amount = q.get("amount") ?? (old.get("send") ? old.get("amount") : null);
  if (to != null || old.has("send")) {
    try {
      pending = { to: new PublicKey(to ?? "").toBase58(), amount: normAmount(amount ?? "") ?? "" };
    } catch {
      pending = null;
    }
  }
  // anything handed over leaves the address bar, even a half-made link (an amount with no recipient)
  if (parts.length > 1 || old.has("send") || old.has("amount")) {
    old.delete("send");
    old.delete("amount");
    const rest = old.toString();
    history.replaceState(null, "", `${location.pathname}${rest ? `?${rest}` : ""}#${tab || "send"}`);
  }
  return tab;
}

/** The recipient and amount handed over, until the Send form has used them. */
export function sendPrefill(): Prefill | null {
  return pending;
}

/** Called once the Send form has taken the prefill, so coming back to it starts empty. */
export function clearSendPrefill() {
  pending = null;
}
