/**
 * Paying an outside address straight from the connected wallet (Send, "Pay from: Your wallet"),
 * kept apart from the engine so the rules can be tested on their own.
 *
 * The wallet makes one deposit of a standard size (see depositSizes): the smallest one that covers
 * what the payment spends and still leaves some change, never the payment's exact amount. Once the
 * deposit joins the private balance, this page proves the payment from that note and the relayer
 * sends it, like any private payment: the rest of the note comes back as change, a normal note of
 * the private balance. No cut, no join, for a payment now or later. What ties the deposit to its
 * recipient is kept on this device only (see WalletPay), never sent to the server.
 */
import type { When } from "./engine";

/**
 * "paying": the wallet is asked to sign the deposit (or it is on its way); "waiting": it landed and
 * waits in the waiting room; "sending": handed to the send (now, or scheduled). The rest are ends:
 * "returned" (the waiting room sent the deposit back to the wallet), "cancelled" (taken back, or
 * stopped by its owner: the SOL stays private) and "needs-you" (it waits for its owner's choice).
 */
export type PayStatus = "paying" | "waiting" | "sending" | "sent" | "scheduled" | "returned" | "cancelled" | "needs-you";

/**
 * Why a payment waits for its owner: it is over a day old, the fees went up past what its note
 * covers, its SOL was spent with no record of this payment (check the activity before sending
 * again), its recipient needs confirming again, or the send didn't go (`text` says why).
 */
export type PayAsk = "late" | "fees" | "unsure" | "confirm" | "error";

/** One payment from the wallet, kept on this device only (ls `vs:walletpay:<fingerprint>`). */
export type WalletPay = {
  id: string;
  created: number;
  to: string;
  /** lamports the recipient gets */
  amount: string;
  when: When;
  offCurveOk?: boolean;
  lookalikeOk?: boolean;
  /** the wallet that paid, the deposit's note (its inner, as hex) and its amount */
  depositor: string;
  inner: string;
  D: string;
  /** the deposit's transaction and its blockhash's last valid block height, known once the wallet signed */
  sig?: string;
  lvh?: number;
  status: PayStatus;
  /** when it was last handed to the send: a delivery or scheduled payment started since then is this one */
  sendingAt?: number;
  ask?: PayAsk;
  /** said on its row: why it stopped, or how it ended */
  text?: string;
  /** "confirm": what the recipient needs confirming */
  confirm?: "off-curve" | "lookalike";
  /** a scheduled one: when it goes out at the latest */
  latest?: number;
};

/**
 * Whether a payment from the wallet still counts on its deposit's note to pay it (it hasn't gone, ended
 * or handed it to a scheduled payment): no other spend takes that note along as its second input.
 */
export const holdsItsNote = (p: Pick<WalletPay, "status">) => p.status === "paying" || p.status === "waiting" || p.status === "sending" || p.status === "needs-you";

/**
 * Whether a refund the chain shows for a payment's deposit (by its inner) is that deposit's own: the
 * same depositor and amount, at or after the payment was made. The waiting-room account is found by
 * its inner alone, so someone else who deposited with the same inner (it is public once sent) and
 * then took theirs back must never make this payment look refunded.
 */
export function refundIsOurs(e: { depositor: string; amount: bigint; inner: bigint }, p: Pick<WalletPay, "depositor" | "D" | "inner" | "created">, blockTime: number | null | undefined): boolean {
  if (e.inner !== BigInt("0x" + p.inner) || e.depositor !== p.depositor || e.amount !== BigInt(p.D)) return false;
  // (two minutes of room for clocks that disagree)
  return blockTime == null || blockTime * 1000 >= p.created - 120_000;
}

/** After a day, a payment that hasn't gone asks its owner first. */
export const PAY_LATE_MS = 24 * 3_600_000;
/** Finished ones stay listed for two days. */
export const PAY_KEEP_MS = 48 * 3_600_000;

/** Still going, or waiting for its owner. */
export const payOpen = (s: PayStatus) => s === "paying" || s === "waiting" || s === "sending" || s === "needs-you";

/**
 * The largest amount a payment can deliver from a note of `note` lamports: the largest `a` with
 * withdrawOf(a) <= note (0 when none). `withdrawOf` is what a payment of `a` spends, which grows by
 * at least one lamport with each lamport of `a`.
 */
export function payoutFor(note: bigint, withdrawOf: (a: bigint) => bigint): bigint {
  let lo = 0n;
  let hi = note; // a payment always spends more than it delivers
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (withdrawOf(mid) <= note) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * The standard deposit sizes a payment from the wallet picks from: 1, 2, 3 and 5 times each power
 * of ten, from 0.001 SOL up (… 0.01, 0.02, 0.03, 0.05, 0.1 … 1, 2, 3, 5, 10, 20, 30 … SOL). Round
 * sizes like these are what people deposit anyway, and one size covers many payment amounts, so
 * the deposit doesn't give its payment's amount away.
 */
const SIZE_STEPS = [1n, 2n, 3n, 5n];
const SIZE_BASE = 1_000_000n;

/** Every standard size from the smallest up to `most` lamports, smallest first. */
export function depositSizes(most: bigint): bigint[] {
  const out: bigint[] = [];
  for (let p = SIZE_BASE; SIZE_STEPS[0] * p <= most; p *= 10n) for (const s of SIZE_STEPS) if (s * p <= most) out.push(s * p);
  return out;
}

/** The smallest standard size of at least `x` lamports. */
export function sizeAtLeast(x: bigint): bigint {
  for (let p = SIZE_BASE; ; p *= 10n) for (const s of SIZE_STEPS) if (s * p >= x) return s * p;
}

/**
 * The least change a payment from the wallet leaves of its deposit: 0.5% of the deposit (at least
 * one lamport). A deposit is never spent whole, so its note always comes back as change.
 */
export const CHANGE_MIN_BPS = 50n;
/** "Max" leaves a change of its own, somewhere between 0.5% and 2.5% of the deposit (see maxChange). */
export const CHANGE_MAX_BPS = 250n;

export const leastChange = (size: bigint) => {
  const c = (size * CHANGE_MIN_BPS) / 10_000n;
  return c > 0n ? c : 1n;
};

/**
 * The change "Max" leaves of a deposit of `size`: `u` (a random number in [0, 1), drawn once and
 * kept, so the Max amount doesn't jump around) of the way from the least change to 2.5% of it.
 */
export function maxChange(size: bigint, u: number): bigint {
  const lo = leastChange(size);
  const hi = (size * CHANGE_MAX_BPS) / 10_000n;
  if (hi <= lo) return lo;
  const f = Math.min(Math.max(u, 0), 0.999_999);
  return lo + ((hi - lo) * BigInt(Math.floor(f * 1_000_000))) / 1_000_000n;
}

type SizeOpts = {
  /** what a payment of `a` spends from the private balance (fees included) */
  withdrawOf: (a: bigint) => bigint;
  /** the pool's smallest deposit, and the most one deposit can be right now */
  min: bigint;
  max: bigint;
  /** the change the largest payment leaves of a deposit of that size (by default the least change) */
  spare?: (size: bigint) => bigint;
};

/**
 * The largest payment one deposit from the wallet can make right now: from the largest standard
 * size within the pool's limits, less the change it leaves (`spare`). Null when no standard size
 * fits the limits at all.
 */
export function walletMost(o: SizeOpts): { size: bigint; most: bigint } | null {
  const sizes = depositSizes(o.max).filter((s) => s >= o.min);
  const size = sizes[sizes.length - 1];
  if (size == null) return null;
  const spare = o.spare ? o.spare(size) : leastChange(size);
  const keep = spare > leastChange(size) ? spare : leastChange(size);
  return { size, most: size > keep ? payoutFor(size - keep, o.withdrawOf) : 0n };
}

/**
 * The deposit that pays `amount` from the wallet: the smallest standard size that covers what the
 * payment spends and leaves at least the least change (and is at least the pool's smallest
 * deposit), with that change. Or why it can't: over the most one deposit can be right now (`most`
 * is the largest payment that fits, see walletMost).
 */
export function walletDeposit(amount: bigint, o: SizeOpts): { deposit: bigint; change: bigint } | { problem: "big"; most: bigint } {
  const spend = o.withdrawOf(amount);
  let size = sizeAtLeast(spend > o.min ? spend : o.min);
  while (size - spend < leastChange(size)) size = sizeAtLeast(size + 1n);
  if (size > o.max) return { problem: "big", most: walletMost(o)?.most ?? 0n };
  return { deposit: size, change: size - spend };
}

/**
 * What the app sees of a payment now: whether its note is in the pool (and still unspent and free
 * here), whether its deposit is still in the waiting room, what the payment spends at today's fees,
 * and whether a delivery or scheduled payment to its recipient was started since it went to "sending".
 * `sig` and `fate` are what the chain said, once asked ("look"): of the deposit's transaction, and
 * of a deposit gone from the waiting room with no note to show for it.
 */
export type PayView = {
  now: number;
  settled: boolean;
  unspent: boolean;
  waiting: boolean;
  need: bigint;
  recorded: "sent" | "scheduled" | null;
  sig?: "landed" | "failed" | "dropped" | "unknown";
  fate?: "refunded" | "returned" | "unknown";
};

/** "spent": its SOL was spent here before it went; "refunded" / "returned": taken back, or sent back by the waiting room. */
export type PayStep =
  | { do: "wait" }
  | { do: "fire" }
  | { do: "look" }
  | { do: "drop" }
  | { do: "set"; status: PayStatus; ask?: PayAsk; why?: "spent" | "refunded" | "returned" };

/** What to do next with a payment that is paying, waiting or sending (the others have ended, or wait for their owner). */
export function nextStep(p: WalletPay, v: PayView): PayStep {
  // fees first: a late payment whose fees also went up offers what its note still covers
  const ready = (): PayStep =>
    v.need > BigInt(p.D)
      ? { do: "set", status: "needs-you", ask: "fees" }
      : v.now - p.created > PAY_LATE_MS
        ? { do: "set", status: "needs-you", ask: "late" }
        : { do: "fire" };
  if (p.status === "paying") {
    if (v.settled || v.waiting) return { do: "set", status: "waiting" };
    // never signed (the page closed while the wallet asked): nothing was sent
    if (!p.sig) return { do: "drop" };
    if (!v.sig) return { do: "look" };
    if (v.sig === "landed") return { do: "set", status: "waiting" };
    // refused, or its blockhash ran out with it nowhere: nothing was taken
    return v.sig === "unknown" ? { do: "wait" } : { do: "drop" };
  }
  if (p.status === "waiting") {
    if (v.settled) return v.unspent ? ready() : { do: "set", status: "cancelled", why: "spent" };
    if (v.waiting) return { do: "wait" };
    // gone from the waiting room with no note yet: taken back, or the pool data hasn't caught up
    if (!v.fate) return { do: "look" };
    if (v.fate === "refunded") return { do: "set", status: "cancelled", why: "refunded" };
    if (v.fate === "returned") return { do: "set", status: "returned", why: "returned" };
    return { do: "wait" };
  }
  if (p.status === "sending") {
    // never sent twice: a payment already started finishes through the deliveries and scheduled payments
    if (v.recorded) return { do: "set", status: v.recorded };
    if (v.settled && v.unspent) return ready();
    if (v.settled) return { do: "set", status: "needs-you", ask: "unsure" };
    return { do: "wait" };
  }
  return { do: "wait" };
}
