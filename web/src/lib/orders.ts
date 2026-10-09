/**
 * Order helpers that need no network: which keys an order may use, prices written as plain
 * decimals, take-profit steps, what an order row says, and how a manual sale meets a live order.
 */
import { PublicKey } from "@solana/web3.js";
import { normAmount } from "./amount";
import type { Order } from "./engine";

/**
 * Order keys come from the account, a few per Vision wallet: key #n belongs to wallet
 * floor(n / KEY_SLOTS). Any device can then tell its own order permissions on-chain.
 */
export const KEY_SLOTS = 64;

export function keySlots(vision: number): number[] {
  return Array.from({ length: KEY_SLOTS }, (_, k) => vision * KEY_SLOTS + k);
}

/** A key for a new order in this wallet, never one a known order there uses (so cancelling one can't touch another). */
export function pickKeyN(vision: number, taken: Iterable<number>, rand: () => number = Math.random): number {
  const used = new Set(taken);
  const slots = keySlots(vision);
  const free = slots.filter((n) => !used.has(n));
  const from = free.length ? free : slots;
  return from[Math.min(from.length - 1, Math.floor(rand() * from.length))];
}

/** Who a token account lets trade for it, and how much, from its raw data (the same place for both token programs). */
export function tokenDelegate(d: Uint8Array): { delegate: string | null; delegated: bigint } {
  if (d.length < 129) return { delegate: null, delegated: 0n };
  const has = d[72] === 1 && d[73] === 0 && d[74] === 0 && d[75] === 0;
  let x = 0n;
  for (let k = 128; k >= 121; k--) x = (x << 8n) | BigInt(d[k]);
  return has ? { delegate: new PublicKey(d.subarray(76, 108)).toBase58(), delegated: x } : { delegate: null, delegated: 0n };
}

// ─── prices ───

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/** A USD price with enough digits for tiny tokens, never in exponent form: $0.0₆105 is 0.000000105. */
export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "–";
  if (n <= 0) return "$0";
  if (n >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toLocaleString("en-US", { maximumSignificantDigits: 3, useGrouping: false })}`;
  let zeros = Math.ceil(-Math.log10(n)) - 1;
  let digits = Math.round(n * 10 ** (zeros + 3));
  if (digits >= 1000) {
    zeros -= 1;
    digits = 100;
  }
  const sub = String(zeros)
    .split("")
    .map((c) => SUB[Number(c)])
    .join("");
  return `$0.0${sub}${String(digits).replace(/0+$/, "") || "0"}`;
}

/** A price for an editable box: always a plain decimal ("0.000000105"), which the box accepts. */
export function priceText(n: number): string {
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4, useGrouping: false });
}

/** A typed price, or null when it isn't one plain positive number. */
export function parsePrice(s: string): number | null {
  const t = normAmount(s);
  const v = t ? Number(t) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Why an order's prices would trade straight away at today's price, in plain words; null when they're fine. */
export function metNow(kind: Order["kind"], p: { tp?: (number | null)[]; sl?: number | null; buyBelow?: number | null }, now: number | null): string | null {
  if (now == null) return null;
  if (kind === "buy") return p.buyBelow != null && p.buyBelow >= now ? `That's at or above today's price (${usd(now)}), so it would buy straight away. Set it below ${usd(now)}.` : null;
  if (kind !== "sell") return null;
  if ((p.tp ?? []).some((x) => x != null && x <= now)) return `A take-profit at or below today's price (${usd(now)}) would sell straight away. Set it above ${usd(now)}.`;
  if (p.sl != null && p.sl >= now) return `A stop-loss at or above today's price (${usd(now)}) would sell straight away. Set it below ${usd(now)}.`;
  return null;
}

// ─── amounts and take-profit steps ───

/** pct% of an amount, in whole units. */
export const shareOf = (amount: bigint, pct: number): bigint => (amount * BigInt(Math.round(pct))) / 100n;

/** Take-profit steps for an order of `total`: each a share of it; steps that add up to 100% leave nothing out. */
export function legsFor(total: bigint, steps: { tpUsd: number; pct: number }[]): { tpUsd: number; amount: string }[] {
  const sum = steps.reduce((s, x) => s + Math.round(x.pct), 0);
  let given = 0n;
  return steps.map((x, i) => {
    const amount = sum === 100 && i === steps.length - 1 ? total - given : shareOf(total, x.pct);
    given += amount;
    return { tpUsd: x.tpUsd, amount: amount.toString() };
  });
}

/** Open take-profit steps resized to a new total, each keeping its share (the last takes the rounding). */
export function scaleLegs(legs: { tpUsd: number; amount: string }[], to: bigint): { tpUsd: number; amount: string }[] {
  const from = legs.reduce((s, l) => s + BigInt(l.amount), 0n);
  if (from === 0n) return legs;
  let given = 0n;
  return legs.map((l, i) => {
    const amount = i === legs.length - 1 ? to - given : (BigInt(l.amount) * to) / from;
    given += amount;
    return { tpUsd: l.tpUsd, amount: amount.toString() };
  });
}

/**
 * Open take-profit steps once what's left of an order goes from `from` down to `to`: steps that
 * covered all of it still do, and steps for part of it keep their share of what's left.
 */
export function shrinkLegs(legs: { tpUsd: number; amount: string }[], from: bigint, to: bigint): { tpUsd: number; amount: string }[] {
  const sum = legs.reduce((s, l) => s + BigInt(l.amount), 0n);
  if (sum >= from || from === 0n) return scaleLegs(legs, to);
  return legs.map((l) => ({ tpUsd: l.tpUsd, amount: ((BigInt(l.amount) * to) / from).toString() }));
}

/** Whether an order's open steps must be sent with a change of amount (several, or one for only part of what's left). */
export const stepsKept = (legs: { amount: string }[], left: bigint): boolean => legs.length > 1 || (legs.length === 1 && BigInt(legs[0].amount) < left);

/** What's left of an order to trade. */
export const leftOf = (o: Pick<Order, "amount" | "spent">): bigint => {
  const l = BigInt(o.amount) - BigInt(o.spent || "0");
  return l > 0n ? l : 0n;
};

const worth = (raw: bigint, decimals: number, price: number) => (Number(raw) / 10 ** decimals) * price;

/**
 * What a manual sale of `sell` (out of `held`) does to the live orders of that Vision wallet:
 * nothing, lowers a take-profit/stop-loss to what's left, or ends it. A DCA or limit buy in the
 * wallet always ends: the sale unwraps the wallet's SOL, which is what the order spends.
 */
export function sellClash(
  orders: Order[],
  vision: number,
  mint: string,
  held: bigint,
  sell: bigint,
  minSellUsd = 2,
): { order: Order; plan: "lower" | "cancel"; keep: bigint } | null {
  const live = orders.filter((o) => o.vision === vision && (o.status === "active" || o.status === "pending"));
  const buy = live.find((o) => o.kind !== "sell");
  if (buy) return { order: buy, plan: "cancel", keep: 0n };
  const o = live.find((x) => x.mint === mint);
  if (!o) return null;
  const rest = leftOf(o);
  const after = held > sell ? held - sell : 0n;
  if (after >= rest) return null;
  if (after === 0n || o.status === "pending") return { order: o, plan: "cancel", keep: 0n };
  const price = o.lastPrice ?? null;
  if (price != null) {
    if (worth(after, o.decimals, price) < minSellUsd / 2) return { order: o, plan: "cancel", keep: 0n };
    const open = (o.legs ?? []).filter((l) => !l.filled && l.tpUsd != null).map((l) => ({ tpUsd: l.tpUsd!, amount: l.amount }));
    if (stepsKept(open, rest)) {
      const scaled = shrinkLegs(open, rest, after);
      if (scaled.some((l) => worth(BigInt(l.amount), o.decimals, price) < (minSellUsd / 2) * 1.1)) return { order: o, plan: "cancel", keep: 0n };
    }
  }
  return { order: o, plan: "lower", keep: after };
}

// ─── what a row says ───

/** "12 s ago", "3 min ago", "2 h ago". */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** "in 40 s", "in 5 min", "in 3 h", "in 12 days". */
export function inTime(t: number, now = Date.now()): string {
  const s = Math.round((t - now) / 1000);
  if (s <= 5) return "any moment";
  if (s < 90) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} days`;
}

/** What the keeper is doing with a live order, when it's worth saying. */
export function stageText(o: Pick<Order, "status" | "stage" | "kind" | "error">): string | null {
  if (o.status !== "active") return null;
  switch (o.stage) {
    case "armed":
      return "The stop price was crossed. Checking once more before selling.";
    case "queued":
    case "trading":
    case "sending":
      return o.kind === "sell" ? "Selling now…" : "Buying now…";
    case "retrying":
      return o.error ? null : "Trying again shortly.";
    case "waiting":
      return o.error ? null : "Waiting a moment before trading.";
    default:
      return null;
  }
}

/** All fills together: what went in, what came out, and the average USD price per token when known. */
export function fillStats(o: Pick<Order, "kind" | "decimals" | "fills">): { spent: bigint; got: bigint; tokens: bigint; avgUsd: number | null; avgSol: number | null } {
  let spent = 0n;
  let got = 0n;
  let usdSum = 0;
  let usdTokens = 0;
  for (const f of o.fills) {
    const s = /^\d+$/.test(f.spent) ? BigInt(f.spent) : 0n;
    const g = /^\d+$/.test(f.got) ? BigInt(f.got) : 0n;
    spent += s;
    got += g;
    const toks = Number(o.kind === "sell" ? s : g) / 10 ** o.decimals;
    if (f.priceUsd != null && toks > 0) {
      usdSum += f.priceUsd * toks;
      usdTokens += toks;
    }
  }
  const tokens = o.kind === "sell" ? spent : got;
  const lamports = o.kind === "sell" ? got : spent;
  const t = Number(tokens) / 10 ** o.decimals;
  return { spent, got, tokens, avgUsd: usdTokens > 0 ? usdSum / usdTokens : null, avgSol: t > 0 && lamports > 0n ? Number(lamports) / 1e9 / t : null };
}

/** The keeper's answer for one order, as GET /api/orders gives it. */
export type OrderReply = {
  id: string;
  status: Order["status"];
  stage?: string | null;
  error?: string | null;
  fills?: Order["fills"];
  spent?: string;
  amount?: string;
  lastPrice?: number | null;
  priceAt?: number | null;
  noPriceSince?: number | null;
  armed?: boolean;
  peak?: number | null;
  stop?: number | null;
  legs?: { tpUsd: number | null; amount: string; filled: boolean }[] | null;
  dca?: { done: number; count: number; next: number; every: number; paused: boolean } | null;
  slippageBps?: number;
  slSlippageBps?: number | null;
  expires?: number;
  settling?: boolean;
};

/** How old a price can be and still say whether an order would trigger now (the server checks again at this age). */
export const PRICE_FRESH_MS = 120_000;

/**
 * One price from /api/price?at=1: {usd, age} with the age in ms, turned into a time on this
 * device's clock (so a clock set ahead of the server's doesn't age it). An `at` time is still read,
 * and a plain number from an older server counts as fetched just now.
 */
export function priceEntry(v: unknown, now = Date.now()): { usd: number; at: number } | null {
  if (typeof v === "number" && Number.isFinite(v)) return { usd: v, at: now };
  const e = v as { usd?: unknown; at?: unknown; age?: unknown } | null;
  if (!e || typeof e !== "object" || typeof e.usd !== "number" || !Number.isFinite(e.usd)) return null;
  const ok = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (ok(e.age)) return { usd: e.usd, at: now - Math.max(0, e.age) };
  return { usd: e.usd, at: ok(e.at) ? Math.min(e.at, now) : now };
}

/** A price too old to judge a trigger by. */
export const priceStale = (at: number | null, now = Date.now()) => at != null && now - at > PRICE_FRESH_MS;

/** An order with the keeper's latest news folded in. */
export function mergeReply(o: Order, r: OrderReply): Order {
  // an order handed back to the keeper: its counts start from zero there, so what came before is added
  const b = o.base;
  const before = BigInt(b?.spent ?? "0");
  const legs = r.legs ? [...(b?.legs ?? []), ...r.legs.map((l) => ({ tpUsd: l.tpUsd, amount: l.amount, filled: l.filled }))] : o.legs;
  const open = legs?.filter((l) => !l.filled && l.tpUsd != null) ?? [];
  const buys = b?.buys ?? 0;
  // the keeper reports the stop's room in effect: one equal to the price room is kept as "the same", so it follows that room
  const room = r.slippageBps ?? o.slippageBps;
  const sl = r.slSlippageBps ?? o.slSlippageBps;
  return {
    ...o,
    status: r.status,
    stage: r.stage ?? null,
    error: r.error ?? null,
    fills: r.fills ? [...(b?.fills ?? []), ...r.fills] : o.fills,
    spent: r.spent != null ? (before + BigInt(r.spent)).toString() : o.spent,
    amount: r.amount != null ? (before + BigInt(r.amount)).toString() : o.amount,
    lastPrice: r.lastPrice ?? o.lastPrice,
    priceAt: r.priceAt ?? o.priceAt,
    noPriceSince: r.noPriceSince ?? null,
    armed: !!r.armed,
    peak: r.peak ?? null,
    stop: r.stop ?? null,
    legs,
    tpUsd: o.kind === "sell" && r.legs ? (open.length ? Math.min(...open.map((l) => l.tpUsd!)) : undefined) : o.tpUsd,
    dca: o.dca && r.dca ? { ...o.dca, ...r.dca, done: r.dca.done + buys, count: r.dca.count + buys } : o.dca,
    slippageBps: r.slippageBps ?? o.slippageBps,
    slSlippageBps: o.kind === "sell" ? (sl != null && sl !== room ? sl : undefined) : o.slSlippageBps,
    expires: r.expires ?? o.expires,
    settling: !!r.settling,
  };
}

/** Did anything a person would see change? */
export function replyChanged(o: Order, n: Order): boolean {
  return (
    o.status !== n.status ||
    o.stage !== n.stage ||
    o.error !== n.error ||
    o.fills.length !== n.fills.length ||
    o.lastPrice !== n.lastPrice ||
    o.priceAt !== n.priceAt ||
    o.stop !== n.stop ||
    o.amount !== n.amount ||
    o.expires !== n.expires ||
    o.settling !== n.settling ||
    o.noPriceSince !== n.noPriceSince ||
    JSON.stringify(o.dca) !== JSON.stringify(n.dca) ||
    JSON.stringify(o.legs) !== JSON.stringify(n.legs)
  );
}
