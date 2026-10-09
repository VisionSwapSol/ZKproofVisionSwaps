/**
 * Paying an outside address straight from the connected wallet (Send, "Pay from: Your wallet"),
 * kept apart from the engine so the rules can be tested on their own.
 *
 * The wallet makes one deposit of exactly what the payment spends, so its note is spent whole: no
 * cut, no join, for a payment now or later. Once the deposit joins the private balance, this page
 * proves the payment and the relayer sends it, like any private payment. What ties the deposit to
 * its recipient is kept on this device only (see WalletPay), never sent to the server.
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
 * The deposit that pays `amount` from the wallet: exactly what the payment spends. Or why it can't:
 * under the pool's smallest deposit (`least` is the smallest payment that reaches it), or over the
 * most one deposit can be right now (`most` is the largest payment that fits).
 */
export function walletDeposit(
  amount: bigint,
  o: { withdrawOf: (a: bigint) => bigint; min: bigint; max: bigint },
): { deposit: bigint } | { problem: "small"; least: bigint } | { problem: "big"; most: bigint } {
  const deposit = o.withdrawOf(amount);
  if (deposit < o.min) {
    let least = payoutFor(o.min, o.withdrawOf);
    if (least === 0n || o.withdrawOf(least) < o.min) least++;
    return { problem: "small", least };
  }
  if (deposit > o.max) return { problem: "big", most: payoutFor(o.max, o.withdrawOf) };
  return { deposit };
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
