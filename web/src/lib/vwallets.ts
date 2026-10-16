// Vision wallets in plain words: their names, the line said after paying them, the status each row
// shows, and the amounts "+ Fund new wallets" sends. Pure, so the tests can pin them down.
import { secureRandom } from "./poll";

/** "Vision wallet #4" for index 3. */
export const walletName = (i: number) => `Vision wallet #${i + 1}`;

/**
 * "#1–#7", "#2 and #5", "#1, #3 and #4", "#1–#9 and #11": wallet numbers (indexes + 1), sorted, each
 * once, with every run of three or more in a row written as a range.
 */
export function walletNumbers(indexes: number[]): string {
  const n = [...new Set(indexes)].sort((a, b) => a - b).map((i) => i + 1);
  const parts: string[] = [];
  for (let k = 0; k < n.length; ) {
    let end = k;
    while (end + 1 < n.length && n[end + 1] === n[end] + 1) end++;
    if (end - k >= 2) {
      parts.push(`#${n[k]}–#${n[end]}`);
      k = end + 1;
    } else {
      parts.push(`#${n[k]}`);
      k++;
    }
  }
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
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

/**
 * The Wallets header's line: "12 wallets · 0.3627 SOL + 3 tokens ≈ $106.07 · 10 arriving". The dollar
 * figure is for everything listed (the SOL and the tokens), so the tokens are named before it, never
 * read as the SOL's price. Tokens with no price yet (`unpriced`) aren't in it, and it says so: "≈ $85.82
 * + 1 without a price". No figure without dollar values (`usd` null). `sol` and `usd` come written
 * already; `masked` hides the amounts.
 */
export function walletsLine(o: { wallets: number; sol: string; tokens: number; usd: string | null; unpriced?: number; coming: number; masked: boolean }): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  let text = o.wallets ? `${plural(o.wallets, "wallet", "wallets")} · ${o.masked ? "••••" : o.sol} SOL` : "None yet";
  if (o.wallets && !o.masked) {
    if (o.tokens) text += ` + ${plural(o.tokens, "token", "tokens")}`;
    if (o.usd) text += ` ≈ ${o.usd}${o.unpriced ? ` + ${o.unpriced} without a price` : ""}`;
  }
  return text + (o.coming ? ` · ${o.coming} arriving` : "");
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
 * `n` amounts of about `each` lamports: all exactly `each`, or with `vary`, each moved on its own by
 * up to VARY_BPS either way, to the lamport: no shared rounding grid that would mark them as one
 * batch. `rnd` gives numbers in [0, 1) (the secure random source unless a test passes its own).
 * Never below `floor`.
 */
export function fundAmounts(each: bigint, n: number, vary: boolean, rnd: () => number = secureRandom, floor = 0n): bigint[] {
  return Array.from({ length: n }, () => {
    if (!vary) return each;
    // parts per 10^12, so the variation runs to single lamports (a coarser scale would leave every amount on one grid)
    const ppt = BigInt(Math.round((rnd() * 2 - 1) * VARY_BPS * 1e8));
    const a = each + (each * ppt) / 1_000_000_000_000n;
    return a < floor ? floor : a;
  });
}

/**
 * A Vision wallet as the selection bar sees it. `tokens` counts its token accounts, empty ones too
 * (as `engine.buyable` and `walletStatus` do: a wallet with any token account keeps its fee reserve and
 * can't "send all"); `busy`: its own action or a running batch has it.
 */
export type BulkWallet = { index: number; lamports: bigint; tokens: number; buyable: boolean; finish: boolean; busy: boolean };
/** Why a selected wallet sits out an action. */
export type BulkWhy = "tokens" | "finish" | "low" | "small" | "busy";
/** One action over the selected wallets: the ones that can (by number), those that go now (one batch) and next time, and the rest with why. */
export type BulkPart = { ok: number[]; now: number[]; later: number[]; left: { index: number; why: BulkWhy }[] };

/**
 * What each of the selection bar's actions does with the selected wallets. `sweepMin` is the least a
 * wallet can move back into the pool on its own (null while unknown); `max` wallets go in one batch.
 */
export function bulkPlan(ws: BulkWallet[], sweepMin: bigint | null, max = 10): { buy: BulkPart; move: BulkPart; send: BulkPart } {
  const sorted = [...ws].sort((a, b) => a.index - b.index);
  const part = (why: (w: BulkWallet) => BulkWhy | null): BulkPart => {
    const ok: number[] = [];
    const left: BulkPart["left"] = [];
    for (const w of sorted) {
      const y = w.busy ? "busy" : why(w);
      if (y) left.push({ index: w.index, why: y });
      else ok.push(w.index);
    }
    return { ok, now: ok.slice(0, max), later: ok.slice(max), left };
  };
  const big = (w: BulkWallet) => sweepMin == null || w.lamports >= sweepMin;
  return {
    buy: part((w) => (w.buyable ? null : w.tokens > 0 ? "tokens" : w.finish ? "finish" : "low")),
    move: part((w) => (w.tokens > 0 || big(w) ? null : "small")),
    // (what's left in a wallet too small to move back is never sent on in a batch: a public transfer ties it to wherever it goes)
    send: part((w) => (w.tokens === 0 && w.lamports > 0n && big(w) ? null : w.tokens > 0 ? "tokens" : "small")),
  };
}

/** What a bar button says under its name: "9 wallets" when every selected wallet can, "7 of 9" when some can, "None". */
export function bulkCount(p: BulkPart, selected: number): string {
  const n = p.ok.length;
  if (!n) return "None";
  if (n >= selected) return `${n} wallet${n === 1 ? "" : "s"}`;
  return `${n} of ${selected}`;
}

const WHY_ORDER: BulkWhy[] = ["busy", "tokens", "finish", "low", "small"];

/** Why the wallets left out of an action sit it out: one sentence per reason, naming the wallets. */
export function bulkWhyText(action: "buy" | "move" | "send", left: BulkPart["left"]): string[] {
  const out: string[] = [];
  for (const why of WHY_ORDER) {
    const idx = left.filter((l) => l.why === why).map((l) => l.index);
    if (!idx.length) continue;
    const one = new Set(idx).size === 1;
    const who = walletsName(idx);
    const v = (singular: string, plural: string) => (one ? singular : plural);
    if (why === "busy") out.push(`${who} ${v("is", "are")} busy with another action. ${v("It", "They")} can go when that ends.`);
    else if (why === "tokens" && action === "buy") out.push(`${who} already ${v("holds", "hold")} a token.`);
    else if (why === "tokens") out.push(`${who} ${v("holds", "hold")} tokens. Sending all is for wallets that hold only SOL.`);
    else if (why === "finish") out.push(`${who} ${v("has a buy to finish: open it", "have a buy to finish: open each one")} to finish or move the SOL back.`);
    else if (why === "low") out.push(`${who} ${v("has", "have")} too little SOL to buy with.`);
    else if (action === "move") out.push(`${who} ${v("holds less than the smallest deposit, so it stays as it is", "hold less than the smallest deposit, so they stay as they are")}.`);
    else out.push(`${who} ${v("holds only a small leftover. Open the wallet", "hold only a small leftover. Open each wallet")} to send it on its own.`);
  }
  return out;
}
