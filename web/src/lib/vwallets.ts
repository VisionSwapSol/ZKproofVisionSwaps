// Vision wallets in plain words: their names, the line said after paying them, the status each row
// shows, and the amounts "+ Fund new wallets" sends. Pure, so the tests can pin them down.

/** "Vision wallet #4" for index 3. */
export const walletName = (i: number) => `Vision wallet #${i + 1}`;

/** "#1–#7", "#2 and #5", "#1, #3 and #4": wallet numbers (indexes + 1), sorted, each once. */
export function walletNumbers(indexes: number[]): string {
  const n = [...new Set(indexes)].sort((a, b) => a - b).map((i) => i + 1);
  if (n.length === 1) return `#${n[0]}`;
  if (n.length > 2 && n[n.length - 1] - n[0] === n.length - 1) return `#${n[0]}–#${n[n.length - 1]}`;
  return `${n
    .slice(0, -1)
    .map((x) => `#${x}`)
    .join(", ")} and #${n[n.length - 1]}`;
}

/** "Vision wallet #4" or "Vision wallets #1–#7". */
export const walletsName = (indexes: number[]) => `${new Set(indexes).size === 1 ? "Vision wallet" : "Vision wallets"} ${walletNumbers(indexes)}`;

/**
 * What to say after paying the person's own Vision wallets: where the SOL is (or is going), and
 * what can be done with it there. `landed`: the SOL is there already (paid now), not on its way.
 */
export function ownPaidText(indexes: number[], landed: boolean): string {
  const one = new Set(indexes).size === 1;
  if (one) {
    return landed
      ? `Your SOL is in ${walletsName(indexes)}. Use it, move it back, or export its key in the Wallets tab.`
      : `Your SOL is going to ${walletsName(indexes)}. Find it in the Wallets tab: buy with it, move the SOL back, or export its key.`;
  }
  return landed
    ? `Your SOL is in ${walletsName(indexes)}. Find them in the Wallets tab: buy with them, move the SOL back, or export their keys.`
    : `Your SOL is going to ${walletsName(indexes)}. Find them in the Wallets tab: buy with them, move the SOL back, or export their keys.`;
}

export type WalletStatus = "arriving" | "finish" | "tokens" | "ready" | "small" | "empty";

/** The status chip of a wallet row: its words and tone (the job-chip tones). */
export const STATUS_CHIP: Record<WalletStatus, [string, "good" | "wait" | "bad" | "mute"]> = {
  ready: ["Ready to use", "good"],
  tokens: ["Holds tokens", "wait"],
  finish: ["Buy to finish", "bad"],
  small: ["Too small to move", "mute"],
  arriving: ["Arriving", "wait"],
  empty: ["Empty", "mute"],
};

/**
 * A wallet's status: SOL still on its way to it (and nothing there yet), a buy to finish, tokens
 * held, too little SOL to move into the pool on its own, ready, or empty.
 */
export function walletStatus(w: { lamports: bigint; tokens: number; finishable: boolean; arriving: boolean; sweepMin: bigint | null }): WalletStatus {
  if (w.lamports === 0n && !w.tokens) return w.arriving ? "arriving" : "empty";
  if (w.finishable) return "finish";
  if (w.tokens) return "tokens";
  if (w.sweepMin != null && w.lamports < w.sweepMin) return "small";
  return "ready";
}

/** Up to this many new wallets at once from "+ Fund new wallets". */
export const FUND_MAX = 10;
/** The least each new wallet gets: enough to buy with, or to move back into the pool, later. */
export const FUND_MIN = 20_000_000n;
/** How far "Vary each amount a little" moves an amount, in basis points (3%). */
export const VARY_BPS = 300;

/**
 * `n` amounts of about `each` lamports: all exactly `each`, or with `vary`, each moved by up to
 * VARY_BPS either way and rounded to 0.0001 SOL (so they read like amounts a person picked).
 * `rnd` gives numbers in [0, 1). Never below `floor`.
 */
export function fundAmounts(each: bigint, n: number, vary: boolean, rnd: () => number = Math.random, floor = 0n): bigint[] {
  return Array.from({ length: n }, () => {
    if (!vary) return each;
    const bps = BigInt(Math.round((rnd() * 2 - 1) * VARY_BPS));
    let a = each + (each * bps) / 10_000n;
    a -= a % 100_000n;
    return a < floor ? floor : a;
  });
}
