// Amounts in plain words, the same on every screen: SOL as the engine writes it, dollars rounded the
// way a wallet shows them, and the "hide amounts" mask. Pure, so the tests can pin them down.

/**
 * "0.4081" for 408_100_000 lamports: the same text as the engine's `fmt`. A plain number is SOL
 * (not lamports), for totals worked out in floating point (the SOL a token is worth, say).
 */
export function solStr(l: bigint | number, digits = 4): string {
  const sol = typeof l === "bigint" ? Number(l) / 1e9 : l;
  return sol.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** "$148.14", "<$0.01" for a few tenths of a cent, "$0.00" for nothing, "$12,346" (no cents) from $10,000 up. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a < 0.005) return `${sign}<$0.01`;
  if (a >= 10_000) return `${sign}$${a.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `${sign}$${a.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What an amount shows as while amounts are hidden. */
export const MASK = "••••";

// a wallet number ("#4", "#13–#22"), a clock time ("2:14 PM") or a length of time ("2 minutes", "about 8 min")
// is never an amount; every other number is
const KEEP = /^(?:#|\d{1,2}:\d{2}\s?[AP]M$|\d+(?:\.\d+)?\s?(?:seconds?|sec|s|minutes?|min|hours?|h|days?)$)/;
const NUMBER =
  /#\d+(?:\s?[–-]\s?#\d+)?|\b\d{1,2}:\d{2}\s?[AP]M\b|\b\d+(?:\.\d+)?\s?(?:seconds?|sec|s|minutes?|min|hours?|h|days?)\b|(?:[≈~]\s?)?\$?\d[\d,]*(?:\.\d+)?/g;

/**
 * A line of text with its amounts hidden: every number becomes •••• (a dollar sign and a leading
 * "≈" with it), except wallet numbers, clock times and lengths of time. It errs toward hiding: a
 * number left showing could be an amount, an extra •••• is only a little less to read.
 */
export function maskText(s: string): string {
  return s.replace(NUMBER, (m) => (KEEP.test(m) ? m : MASK));
}
