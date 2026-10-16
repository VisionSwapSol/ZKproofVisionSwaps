// The trade checks as the app shows and keeps them: what a review says about a quote's price, what a
// batch keeps of the price that was approved, and why a batch or a buy stopped to ask. Pure, so the
// tests pin the words and the rules down. The checks themselves are in the SDK (tradeguard.ts).
import {
  needs,
  IMPACT_BLOCK_PCT,
  MARKET_BLOCK_PCT,
  COST_WARN_PCT,
  DRIFT_DEFAULT_BPS,
  type Approval,
  type Rate,
  type TradeCheck,
} from "@visionswap/sdk";

/** What a buy or sale carries into the engine about the price the person approved. */
export type TradeGuard = Approval & {
  /** the approved price (a batch: its last wallet's), and how far a turn may move from it (bps) */
  ref?: Rate;
  driftBps?: number;
  /** transfer taxes when approved, bps by mint */
  taxes?: Record<string, number>;
};

/** Why a batch (or a funded buy) stopped to ask, and what "Continue" then takes on. */
export type Hold = {
  why: "drift" | "market" | "noprice" | "tax" | "block";
  text: string;
  /** the item that waited */
  k?: number;
  /** drift: the new price, which "Continue" takes as the approved one */
  nowIn?: string;
  nowOut?: string;
  /** market: the loss (pct) "Continue" agrees to */
  loss?: number;
  /** tax: the taxes "Continue" agrees to */
  taxes?: Record<string, number>;
};

/**
 * A guard after the person said yes to what a hold asked: the new price becomes the approved one,
 * the loss they saw is agreed, the new tax is agreed, or (once) going without a market price.
 */
export function acceptHold(g: TradeGuard | undefined, h: Hold): TradeGuard {
  const base: TradeGuard = { ...g };
  switch (h.why) {
    case "drift":
      return h.nowIn && h.nowOut ? { ...base, ref: { in: BigInt(h.nowIn), out: BigInt(h.nowOut) } } : base;
    case "market":
      return { ...base, okLoss: Math.max(base.okLoss ?? 0, h.loss ?? 0) };
    case "noprice":
      return { ...base, okNoPrice: true };
    case "tax":
      return { ...base, taxes: { ...base.taxes, ...h.taxes } };
    default:
      return base;
  }
}

/** A guard kept in storage (amounts as strings). */
export type GuardSaved = Omit<TradeGuard, "ref"> & { refIn?: string; refOut?: string };

export const saveGuard = (g: TradeGuard | undefined): GuardSaved | undefined =>
  g ? { ...(({ ref: _r, ...rest }) => rest)(g), ...(g.ref ? { refIn: g.ref.in.toString(), refOut: g.ref.out.toString() } : {}) } : undefined;

export function loadGuard(g: GuardSaved | undefined): TradeGuard | undefined {
  if (!g) return undefined;
  const { refIn, refOut, ...rest } = g;
  return { ...rest, ...(refIn && refOut ? { ref: { in: BigInt(refIn), out: BigInt(refOut) } } : {}) };
}

/** A percentage for people: one decimal under 10, whole numbers above. */
export const pctText = (x: number) => (Math.abs(x) < 10 ? `${(Math.round(x * 10) / 10).toLocaleString("en-US")}%` : `${Math.round(x)}%`);

const verb = (side: "buy" | "sell") => (side === "buy" ? "Buy" : "Sell");

export type CheckSay = {
  /** "warn": a note; "ask": a yes before the trade; "stop": the trade can't be made */
  tone: "warn" | "ask" | "stop";
  text: string;
  /** the question on the button (ask only) */
  ask?: string;
};

/** What a review says about a quote's check, given what the settings allow (null: nothing to say). */
export function checkSay(c: TradeCheck | null | undefined, o: { symbol: string; side: "buy" | "sell"; unlocked: boolean }): CheckSay | null {
  if (!c) return null;
  const n = needs(c, { unlocked: o.unlocked });
  const p = pctText(c.movePct);
  const anyway = `${verb(o.side)} anyway?`;
  if (n === "block") {
    if (c.why === "step" && c.step?.label === "a smaller route" && c.stepDownPct != null) {
      return { tone: "stop", text: `The best route for this trade doesn't fit in one transaction, and the one that does gives ${pctText(c.stepDownPct)} less. Try a smaller amount.` };
    }
    if (c.why === "step" && c.step) {
      return { tone: "stop", text: `This route trades through ${c.step.label} at ${pctText(c.step.pct)} worse than that market's price, so VisionSwap won't make it. Try again in a minute, or with a smaller amount.` };
    }
    if (c.unlockable) {
      return {
        tone: "stop",
        text: `This trade would move the price by ${p}, more than the ${IMPACT_BLOCK_PCT}% VisionSwap allows. Try a smaller amount, or turn on "Allow trades that move the price more than ${IMPACT_BLOCK_PCT}%" in the trade settings.`,
      };
    }
    return { tone: "stop", text: `This route gives about ${p} less than the market price for ${o.symbol}, so VisionSwap won't make it. Try again in a minute, or with a smaller amount.` };
  }
  if (n === "noprice") {
    const text = c.marketPct == null ? `VisionSwap can't find a market price for ${o.symbol} right now to check this trade against.` : "VisionSwap can't check every step of this route against its market right now.";
    return { tone: "ask", text, ask: `${text} ${anyway}` };
  }
  if (n === "confirm") {
    const text = c.why === "market" ? `You'd get about ${p} less than the market price for ${o.symbol}.` : `This trade would move the price by ${p}.`;
    // a sale this far under the market price asks rather than being refused (see judge): the price may just have fallen
    if (o.side === "sell" && c.why === "market" && c.movePct > MARKET_BLOCK_PCT) {
      const why = `${text} If its price just fell, the market price VisionSwap reads may not have caught up yet.`;
      return { tone: "ask", text: why, ask: `${why} ${anyway}` };
    }
    return { tone: "ask", text: `${text} A smaller amount usually gets a better price.`, ask: `${text} ${anyway}` };
  }
  if (c.level === "warn") {
    const text = c.why === "market" ? `You'd get about ${p} less than the market price for ${o.symbol}.` : `This trade moves the price by ${p}.`;
    return { tone: "warn", text: `${text} Consider a smaller amount.` };
  }
  return null;
}

/** What the person agreed to by trading on a review (a yes to its question, or no question at all). */
export function approvalOf(c: TradeCheck | null | undefined, o: { said: boolean; unlocked: boolean }): Approval {
  if (!c) return { unlocked: o.unlocked };
  return {
    unlocked: o.unlocked,
    ...(o.said ? { okLoss: c.movePct } : {}),
    ...(o.said && (c.marketPct == null || c.stepUnchecked) ? { okNoPrice: true } : {}),
  };
}

/** The token costs built into a route, in words (null: none worth saying). */
export function costSay(c: TradeCheck | null | undefined, name: (mint: string) => string): { warn: boolean; text: string } | null {
  if (!c) return null;
  const taxed = Object.entries(c.taxes).filter(([, bps]) => bps > 0);
  const parts: string[] = [];
  if (taxed.length) {
    const who = taxed.map(([m, bps]) => `${name(m)} ${pctText(bps / 100)}`).join(", ");
    parts.push(
      taxed.length === 1 && c.costPct <= (taxed[0][1] / 100) * 1.01
        ? `${name(taxed[0][0])} charges a ${pctText(taxed[0][1] / 100)} tax on every transfer. It's taken by the token itself, and the amounts above already allow for it.`
        : `Transfer taxes built into this route (${who}) take about ${pctText(c.costPct)} of it, and about ${pctText(c.roundTripPct)} to buy and later sell back the same way. They're taken by the tokens themselves, and the amounts above already allow for them.`,
    );
  }
  if (c.curve) parts.push(`It's still on its launch curve (${c.curve.label}), priced in ${name(c.curve.pair)}, so every trade also buys or sells ${name(c.curve.pair)}.`);
  for (const [m, s] of Object.entries(c.taxSoon ?? {})) {
    parts.push(`${name(m)}'s transfer tax is set to change to ${pctText(s.bps / 100)} in about ${s.epochs * 2} days.`);
  }
  return parts.length ? { warn: c.costPct > COST_WARN_PCT, text: parts.join(" ") } : null;
}

/** Plain warnings before a batch into a thin, new or fast-moving token (none: it looks ordinary). */
export function batchWarnings(p: {
  symbol: string;
  liquidity?: number | null;
  created?: number | null;
  change1h?: number | null;
  inUsd?: number | null;
  curvePair?: string | null;
  now?: number;
}): string[] {
  const out: string[] = [];
  const liq = p.liquidity ?? null;
  const share = liq && p.inUsd ? (p.inUsd / liq) * 100 : null;
  const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;
  if (liq != null && liq > 0 && (liq < 50_000 || (share != null && share > 5))) {
    out.push(
      share != null && share > 5
        ? `This batch is about ${pctText(share)} of ${p.symbol}'s liquidity (${usd(liq)}), so it moves the price a lot: later wallets pay more.`
        : `${p.symbol} has only about ${usd(liq)} of liquidity, so a batch can move its price a lot: later wallets pay more.`,
    );
  }
  const now = p.now ?? Date.now();
  if (p.created != null && now - p.created < 24 * 3600_000) out.push(`${p.symbol} is less than a day old: new tokens' prices can swing hard while a batch runs.`);
  if (p.change1h != null && Math.abs(p.change1h) >= 20) out.push(`${p.symbol}'s price moved ${pctText(Math.abs(p.change1h))} in the last hour.`);
  if (p.curvePair) out.push(`${p.symbol} is still on its launch curve, priced in ${p.curvePair}: each wallet's trade also trades ${p.curvePair}.`);
  return out;
}

/** The batch price guard's setting as offered: "5%" (the default named). */
export const driftLabel = (bps: number) => `${bps / 100}%${bps === DRIFT_DEFAULT_BPS ? " (default)" : ""}`;

/** What "Continue" says on a batch that stopped to ask. */
export const continueLabel = (h: Hold | null | undefined) =>
  !h
    ? "Continue"
    : h.why === "drift"
      ? "Continue at the new price"
      : h.why === "market"
        ? "Continue anyway"
        : h.why === "noprice"
          ? "Continue this one"
          : h.why === "tax"
            ? "Continue with the new tax"
            : "Check again";

/** Why a turn's price stopped a batch, in words (only a worse price stops one: see driftStop). */
export function driftText(p: { side: "buy" | "sell"; pct: number; symbol: string; wallet: string }): string {
  const x = pctText(p.pct);
  if (p.side === "buy") return `The price has moved ${x} since you approved this batch: ${p.wallet} would get ${x} less ${p.symbol} for its SOL. Nothing was spent.`;
  return `The price has moved ${x} since you approved this batch: ${p.wallet} would get ${x} less SOL for its ${p.symbol}. Nothing was sold.`;
}
