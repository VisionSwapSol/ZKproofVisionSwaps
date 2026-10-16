/**
 * The price checks every buy and sale passes before anything is signed, shared by the server (which
 * runs them on every quote and build) and the app (which runs them again on the transaction it is
 * about to sign). Pure arithmetic: no network, so the tests pin every threshold down.
 *
 * What they guard against: a quote that fills exactly as quoted but far from the market, for example a
 * route whose first step buys the token a launch is priced in (MASK) on a thin order book at many
 * times its market price. Every quote is compared with the market and with the price the person
 * approved, so such a route is never signed:
 *
 *   - value lost against the market price, after the token taxes the route is known to carry
 *   - each connecting step (SOL -> the token a launch is priced in, and back) against that pair's
 *     own market, so an off-market venue in the middle of a route is caught even when the token
 *     itself looks fine
 *   - the trade's own price impact
 *   - in a batch, each wallet's price against the price that was approved
 *
 * Thresholds:
 *   value lost: under 2.5% normal, 2.5-5% a warning, 5-15% an explicit yes, over 15% blocked
 *   (a sale over 15% asks instead: see judge);
 *   one connecting step more than 5% off its market: blocked; no market price: a yes, and never
 *   automatic inside a batch; price impact: a yes above 5%, blocked above 15% unless unlocked;
 *   a batch's price may drift 5% by default (15% at most) before it pauses and asks.
 * A connecting step at 1.28x its market is already blocked (sdk/test/tradeguard.test.ts replays such a route).
 */

// ─── thresholds ───

/** Value lost against the market price (after known taxes) above which the review warns. */
export const MARKET_WARN_PCT = 2.5;
/** ... above which the person has to say yes to this trade. */
export const MARKET_CONFIRM_PCT = 5;
/** ... above which the trade is refused. */
export const MARKET_BLOCK_PCT = 15;
/**
 * A connecting step (into or out of a token the person didn't ask for) more than this off that
 * pair's own market is refused: deep pairs like SOL/MASK should never be traded far from their
 * market, and when they are, the route found a thin venue.
 */
export const STEP_BLOCK_PCT = 5;
/**
 * Jupiter's priceImpactPct is exactly 1 (100%) when it can't work the impact out, as for a token it
 * has no price for yet (read-only mainnet quotes, 16 Oct 2026: brand-new tokens with no price showed
 * 100% at 0.001 SOL and at 0.05 SOL, with the same rate both times). That says "unknown", not "a 100% move".
 */
export const IMPACT_UNKNOWN_PCT = 99.99;
/** The trade's own price impact above which the person has to say yes. */
export const IMPACT_CONFIRM_PCT = 5;
/** ... above which it is refused, unless "Allow trades that move the price more than 15%" is on. */
export const IMPACT_BLOCK_PCT = 15;
/**
 * A route squeezed into fewer accounts (to fit one transaction) more than this worse than the full
 * 64-account route is refused (research: "refuse or ask if the smaller route is more than 1-2%
 * worse"; same-moment quotes of 16 tokens differed by at most 0.7% between 54 and 64 accounts).
 */
export const STEP_DOWN_MAX_PCT = 2;
/** How far a batch's price may move from the approved price before it pauses (default, bps). */
export const DRIFT_DEFAULT_BPS = 500;
/** The widest that may be set (bps). */
export const DRIFT_MAX_BPS = 1500;
/** The narrowest that may be set (bps): less would stop on ordinary noise. */
export const DRIFT_MIN_BPS = 100;
/** The choices offered in the trade settings. */
export const DRIFT_CHOICES = [200, 500, 1000, 1500] as const;
/** Built-in token costs (transfer taxes) one way above which the review says so plainly. */
export const COST_WARN_PCT = 5;
/** A loss the person accepted also covers a later look at the same trade up to this many points more (prices tick). */
export const ACCEPT_SLACK_PCT = 1;

// ─── shapes ───

export type Level = "ok" | "warn" | "confirm" | "block";
export type Why = "ok" | "impact" | "market" | "step" | "noprice";

/** One step of a route, as Jupiter's routePlan states it (raw amounts). */
export type RouteStep = { label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string };

export type TradeCheck = {
  level: Level;
  why: Why;
  /** the figure to show: the larger of the price impact and the value lost against the market (pct) */
  movePct: number;
  /** the trade's own price impact, its transfer tax left out (pct) */
  impactPct: number;
  /** no price impact could be worked out (Jupiter's figure was taxes or its "100%", and nothing measured it): impactPct is 0 and says nothing */
  impactUnknown?: boolean;
  /** value lost against the market price after known taxes (pct; below 0 is better than market); null: no market price */
  marketPct: number | null;
  /** the connecting step furthest from its own market (pct off, after its taxes) */
  step: { label: string; pct: number } | null;
  /** a connecting step whose market couldn't be read */
  stepUnchecked?: boolean;
  /** a block the person can turn into a question in the settings: only one explained by the trade's own price impact */
  unlockable: boolean;
  /** transfer taxes in force now, bps by mint, for the route's tokens that charge one */
  taxes: Record<string, number>;
  /** a tax change already scheduled on-chain: its new bps and how many epochs away */
  taxSoon?: Record<string, { bps: number; epochs: number }>;
  /** what the route's transfer taxes take, one way (pct), and buying then selling back the same way */
  costPct: number;
  roundTripPct: number;
  /** the token is still on a launch curve priced in `pair` (not SOL), so every trade goes through `pair` too */
  curve?: { label: string; pair: string };
  /** the trade's input in US dollars, when known */
  inUsd?: number | null;
  /** the route was squeezed into fewer accounts than the best route: how much worse (pct) */
  stepDownPct?: number;
  /** the tokens the route trades through in between (their taxes count twice) */
  via?: string[];
};

// ─── arithmetic ───

const WSOL = "So11111111111111111111111111111111111111112";

/** A raw amount as a number of whole tokens (precise enough for prices: ratios, not balances). */
export const whole = (raw: bigint | string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

/** out per in, as a number (0 when there is no input). */
export const rateOf = (inAmount: bigint | string, outAmount: bigint | string) => {
  const i = Number(BigInt(inAmount));
  return i > 0 ? Number(BigInt(outAmount)) / i : 0;
};

/**
 * How many times each token moves in a route (each move pays its transfer tax once): the trade's
 * own two tokens once, every token in between twice (into the wallet's temporary account, and out).
 */
export function transfersOf(steps: RouteStep[], inputMint: string, outputMint: string): Map<string, number> {
  const n = new Map<string, number>();
  const bump = (m: string, k: number) => n.set(m, Math.max(n.get(m) ?? 0, k));
  bump(inputMint, 1);
  bump(outputMint, 1);
  for (const s of steps) for (const m of [s.inputMint, s.outputMint]) if (m !== inputMint && m !== outputMint) bump(m, 2);
  n.delete(WSOL);
  return n;
}

/** The tokens a route trades through in between, in order of first use. */
export function viaOf(steps: RouteStep[], inputMint: string, outputMint: string): string[] {
  const out: string[] = [];
  for (const s of steps) for (const m of [s.inputMint, s.outputMint]) if (m && m !== inputMint && m !== outputMint && !out.includes(m)) out.push(m);
  return out;
}

/** What known transfer taxes leave of a trade's value: each taxed move keeps (1 - bps). */
export function keepAfter(taxes: Record<string, number>, transfers: Map<string, number>): number {
  let keep = 1;
  for (const [m, k] of transfers) keep *= (1 - Math.max(0, Math.min(10_000, taxes[m] ?? 0)) / 10_000) ** k;
  return keep;
}

/** The share (pct) of the trade the taxes take, one way and there and back. */
export const costOf = (keep: number) => ({ costPct: (1 - keep) * 100, roundTripPct: (1 - keep * keep) * 100 });

/**
 * Value lost against the market price (pct): 1 - (what arrives) / (what went in, less the known
 * taxes and fee), both in US dollars. Null without both prices.
 */
export function marketLoss(p: {
  inAmount: bigint | string;
  inDecimals: number;
  inUsd: number | null | undefined;
  outAmount: bigint | string;
  outDecimals: number;
  outUsd: number | null | undefined;
  keep: number;
  feeBps?: number;
}): number | null {
  if (!p.inUsd || !p.outUsd || !(p.inUsd > 0) || !(p.outUsd > 0)) return null;
  const sent = whole(p.inAmount, p.inDecimals) * p.inUsd * p.keep * (1 - (p.feeBps ?? 0) / 10_000);
  if (!(sent > 0)) return null;
  const got = whole(p.outAmount, p.outDecimals) * p.outUsd;
  return (1 - got / sent) * 100;
}

/**
 * How far a step's price is from that pair's market (pct; above 0 is worse), less the taxes the
 * step's two tokens may charge on it (Jupiter states a step's amounts before or after them, so
 * they are allowed for either way). `market` is out per in for the same pair, from a small trade.
 */
export function stepOff(step: RouteStep, market: number, taxes: Record<string, number>): number | null {
  if (!(market > 0)) return null;
  const rate = rateOf(step.inAmount, step.outAmount);
  if (!(rate > 0)) return null;
  const allow = ((taxes[step.inputMint] ?? 0) + (taxes[step.outputMint] ?? 0)) / 100;
  return (1 - rate / market) * 100 - allow;
}

/**
 * The connecting steps of a route: those that don't trade the person's own token (for a buy of X,
 * every step whose output isn't X; for a sale of X, every step whose input isn't X).
 */
export function connectors(steps: RouteStep[], side: "buy" | "sell", token: string): RouteStep[] {
  return steps.filter((s) => (side === "buy" ? s.outputMint !== token : s.inputMint !== token));
}

/** Launch curves (the token hasn't moved to an ordinary pool yet), by Jupiter's venue labels. */
const CURVE = /launch ?lab|^pump\.?fun$|bonding|\bdbc\b|moonshot|moonit|boop|heaven/i;

/** The launch curve the token trades on in this route, and the token that curve is priced in (when it isn't SOL). */
export function curveOf(steps: RouteStep[], token: string): { label: string; pair: string } | undefined {
  for (const s of steps) {
    if (!CURVE.test(s.label)) continue;
    const pair = s.inputMint === token ? s.outputMint : s.outputMint === token ? s.inputMint : null;
    if (pair && pair !== WSOL) return { label: s.label, pair };
  }
  return undefined;
}

/** How much worse (pct) a route squeezed into fewer accounts is than the best one. */
export const stepDownLoss = (bestOut: bigint, out: bigint) => (bestOut > 0n ? Number(((bestOut - out) * 1_000_000n) / bestOut) / 10_000 : 0);

// ─── the verdict ───

/**
 * One trade's level from its figures. Refused outright: a connecting step more than 5% off its
 * market, or a buy losing more than 15% that its own impact doesn't explain by more than 5 points.
 * Refused unless unlocked: over 15% that the impact explains. A yes: over 5%, or no market price
 * (or a step whose market couldn't be read). A warning: over 2.5%.
 *
 * A sale is never refused on the market price alone: that price can trail a fast drop by up to a
 * minute (the price book's age), and a thin token's last-swap price can stay off for longer, so a
 * refusal there could leave someone unable to sell a falling token. It asks instead, and its
 * connecting steps, read against live quotes, are still refused when they are off.
 */
export function judge(p: { impactPct: number; marketPct: number | null; stepPct?: number | null; stepUnchecked?: boolean; side?: "buy" | "sell" }): {
  level: Level;
  why: Why;
  movePct: number;
  unlockable: boolean;
} {
  const impact = Math.max(0, p.impactPct || 0);
  const market = p.marketPct;
  const movePct = Math.max(impact, market ?? 0);
  if (p.stepPct != null && p.stepPct > STEP_BLOCK_PCT) return { level: "block", why: "step", movePct: Math.max(movePct, p.stepPct), unlockable: false };
  const unexplained = market != null ? market - impact : 0;
  if (movePct > Math.min(MARKET_BLOCK_PCT, IMPACT_BLOCK_PCT)) {
    if (unexplained > MARKET_CONFIRM_PCT) return p.side === "sell" ? { level: "confirm", why: "market", movePct, unlockable: false } : { level: "block", why: "market", movePct, unlockable: false };
    return { level: "block", why: "impact", movePct, unlockable: true };
  }
  if (market == null || p.stepUnchecked) return { level: "confirm", why: "noprice", movePct, unlockable: false };
  if (movePct > MARKET_CONFIRM_PCT || impact > IMPACT_CONFIRM_PCT) return { level: "confirm", why: unexplained > 0 && market >= impact ? "market" : "impact", movePct, unlockable: false };
  if (movePct > MARKET_WARN_PCT) return { level: "warn", why: market >= impact ? "market" : "impact", movePct, unlockable: false };
  return { level: "ok", why: "ok", movePct, unlockable: false };
}

/** What the person has agreed to for a trade (or a batch): nothing beyond the warning level unless they said yes. */
export type Approval = {
  /** the largest move (pct) they said yes to; anything up to MARKET_CONFIRM_PCT needs no yes */
  okLoss?: number | null;
  /** they said yes to trading without a market price to compare */
  okNoPrice?: boolean;
  /** "Allow trades that move the price more than 15%" is on */
  unlocked?: boolean;
};

/**
 * Whether a check is covered by what the person agreed to: null when it is, otherwise what it
 * needs ("block": never allowed; "confirm": a yes to this figure; "noprice": a yes without a market price).
 */
export function needs(c: Pick<TradeCheck, "level" | "why" | "movePct" | "unlockable" | "marketPct" | "stepUnchecked">, a: Approval = {}): "block" | "confirm" | "noprice" | null {
  if (c.level === "block" && !(c.unlockable && a.unlocked)) return "block";
  if ((c.marketPct == null || c.stepUnchecked) && !a.okNoPrice) return "noprice";
  const ok = Math.max(MARKET_CONFIRM_PCT, a.okLoss ?? 0) + (a.okLoss != null ? ACCEPT_SLACK_PCT : 0);
  if (c.movePct > ok) return "confirm";
  return null;
}

/** The worse of two checks of the same trade (the server's and the app's own), figure by figure. */
export function worse(a: TradeCheck, b: TradeCheck | null | undefined): TradeCheck {
  if (!b) return a;
  const rank: Record<Level, number> = { ok: 0, warn: 1, confirm: 2, block: 3 };
  const top = rank[b.level] > rank[a.level] ? b : a;
  const marketPct = a.marketPct == null ? b.marketPct : b.marketPct == null ? a.marketPct : Math.max(a.marketPct, b.marketPct);
  const step = !a.step ? b.step : !b.step ? a.step : a.step.pct >= b.step.pct ? a.step : b.step;
  const taxes = { ...a.taxes };
  for (const [m, bps] of Object.entries(b.taxes)) taxes[m] = Math.max(taxes[m] ?? 0, bps);
  return {
    ...top,
    movePct: Math.max(a.movePct, b.movePct),
    impactPct: Math.max(a.impactPct, b.impactPct),
    marketPct,
    step,
    stepUnchecked: !!(a.stepUnchecked || b.stepUnchecked),
    unlockable: rank[a.level] === rank[b.level] ? a.unlockable && b.unlockable : top.unlockable,
    taxes,
    costPct: Math.max(a.costPct, b.costPct),
    roundTripPct: Math.max(a.roundTripPct, b.roundTripPct),
  };
}

/**
 * Everything about one route, from its amounts and the market figures read for it: the verdict,
 * the taxes it carries and what they cost, and whether it trades through a launch curve.
 */
export function assessRoute(p: {
  side: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  inAmount: bigint | string;
  outAmount: bigint | string;
  /** Jupiter's priceImpactPct, as a percentage (or, with impactNet, the impact measured without taxes) */
  impactPct: number;
  /**
   * impactPct was measured (this route against a small quote of the same pair) or already worked
   * out by such a check, so no tax is in it. Jupiter's own figure counts transfer taxes as impact,
   * the tokens in between too, and not consistently: 6.8% for a 0.001 SOL buy of a launch token whose
   * rate matched a 0.01 SOL one (read-only quotes), so subtracting the token's own tax
   * still left a 3.8% "impact" that was only MASK's tax.
   */
  impactNet?: boolean;
  /** Jupiter's figure is known to be no good here (a taxed route nothing could measure): no impact figure at all */
  impactUnknown?: boolean;
  steps: RouteStep[];
  /** decimals by mint (at least the trade's two tokens) */
  decimals: Record<string, number>;
  /** US dollars per whole token, by mint (null or missing: no price) */
  usd: Record<string, number | null | undefined>;
  /** transfer taxes in force, bps by mint */
  taxes: Record<string, number>;
  /** each connecting step's market (out per in, raw units), by step index; missing: couldn't be read */
  stepMarkets?: Record<number, number | null>;
  /** VisionSwap's own fee on a sale (bps), allowed for like a tax */
  feeBps?: number;
  taxSoon?: TradeCheck["taxSoon"];
  stepDownPct?: number;
  /** the tokens in between, when the steps themselves aren't at hand (the app's own look at a transaction) */
  via?: string[];
}): TradeCheck {
  const token = p.side === "buy" ? p.outputMint : p.inputMint;
  const via = p.steps.length ? viaOf(p.steps, p.inputMint, p.outputMint) : (p.via ?? []);
  const hops: RouteStep[] = [p.inputMint, ...via, p.outputMint].slice(1).map((m, i, a) => ({ label: "", inputMint: i ? a[i - 1] : p.inputMint, outputMint: m, inAmount: "0", outAmount: "0" }));
  const keep = keepAfter(p.taxes, transfersOf(hops, p.inputMint, p.outputMint));
  const tokenTax = p.taxes[token] ?? 0;
  // Jupiter's impact counts the token's own tax as impact; it is shown apart (the existing review did the same).
  // A measured one has none in it; Jupiter's "100%" means it couldn't tell, so it says nothing (the market figure decides)
  const raw = p.impactPct || 0;
  const impactUnknown = !p.impactNet && (!!p.impactUnknown || raw >= IMPACT_UNKNOWN_PCT);
  const impactPct = impactUnknown ? 0 : p.impactNet ? Math.max(0, raw) : Math.max(0, raw - tokenTax / 100);
  const inDec = p.decimals[p.inputMint];
  const outDec = p.decimals[p.outputMint];
  const marketPct =
    inDec == null || outDec == null
      ? null
      : marketLoss({ inAmount: p.inAmount, inDecimals: inDec, inUsd: p.usd[p.inputMint], outAmount: p.outAmount, outDecimals: outDec, outUsd: p.usd[p.outputMint], keep, feeBps: p.feeBps });
  let step: TradeCheck["step"] = null;
  let stepUnchecked = false;
  const conn = new Set(connectors(p.steps, p.side, token));
  p.steps.forEach((s, i) => {
    if (!conn.has(s)) return;
    const m = p.stepMarkets?.[i];
    const off = m != null ? stepOff(s, m, p.taxes) : null;
    if (off == null) stepUnchecked = true;
    else if (!step || off > step.pct) step = { label: s.label, pct: off };
  });
  // a squeezed route is judged as a connecting step against the best route
  let stepPct: number | null = (step as TradeCheck["step"])?.pct ?? null;
  if (p.stepDownPct != null && p.stepDownPct > STEP_DOWN_MAX_PCT) {
    stepPct = Math.max(stepPct ?? 0, STEP_BLOCK_PCT + p.stepDownPct);
    step = { label: "a smaller route", pct: p.stepDownPct };
  }
  const v = judge({ impactPct, marketPct, stepPct, stepUnchecked, side: p.side });
  const inUsd = inDec != null && p.usd[p.inputMint] ? whole(p.inAmount, inDec) * p.usd[p.inputMint]! : null;
  const taxes: Record<string, number> = {};
  for (const [m, bps] of Object.entries(p.taxes)) if (bps > 0) taxes[m] = bps;
  return {
    ...v,
    impactPct,
    ...(impactUnknown ? { impactUnknown } : {}),
    marketPct,
    step,
    ...(stepUnchecked ? { stepUnchecked } : {}),
    taxes,
    ...(p.taxSoon && Object.keys(p.taxSoon).length ? { taxSoon: p.taxSoon } : {}),
    ...costOf(keep),
    ...(curveOf(p.steps, token) ? { curve: curveOf(p.steps, token) } : {}),
    inUsd,
    ...(p.stepDownPct != null ? { stepDownPct: p.stepDownPct } : {}),
    ...(via.length ? { via } : {}),
  };
}

/** A Token-2022 transfer fee rule: the bps that apply from `epoch` on. */
export type FeeRule = { epoch: number; bps: number };

/**
 * The transfer fee in force at `epoch`, from a mint's two rules (the newer applies from its epoch;
 * the token program only lets a new one start two epochs after it is set), and a different one
 * already scheduled.
 */
export function feeInForce(r: { older?: FeeRule; newer?: FeeRule }, epoch: number): { bps: number; soon?: { bps: number; epochs: number } } {
  if (!r.newer && !r.older) return { bps: 0 };
  const now = r.newer && epoch >= r.newer.epoch ? r.newer : (r.older ?? r.newer)!;
  return r.newer && epoch < r.newer.epoch && r.newer.bps !== now.bps ? { bps: now.bps, soon: { bps: r.newer.bps, epochs: r.newer.epoch - epoch } } : { bps: now.bps };
}

/**
 * Taxes that went up since the ones approved: mint -> [was, now]. `watch` are the trade's own
 * tokens, which count as untaxed when the approval named no tax for them (a tax switched on since).
 */
export function taxRises(approved: Record<string, number> | undefined, now: Record<string, number> | undefined, watch: string[] = []): [string, number, number][] {
  if (!now) return [];
  const out: [string, number, number][] = [];
  for (const m of new Set([...Object.keys(approved ?? {}), ...watch])) {
    const was = approved?.[m] ?? 0;
    const is = now[m] ?? (watch.includes(m) ? 0 : null);
    if (is != null && is > was) out.push([m, was, is]);
  }
  return out;
}

// ─── a batch's price, wallet by wallet ───

/** A price: `out` of the output for `in` of the input (raw units). */
export type Rate = { in: bigint; out: bigint };

/**
 * The price the last wallet of a batch gets: what the whole batch's quote gives, less what it gives
 * without that wallet's part, for that part. Later wallets pay more as the batch moves the price,
 * so this, not the average, is what every wallet's turn is held to. Falls back to the average.
 */
export function lastRate(total: Rate, without: Rate | null): Rate {
  if (!without) return total;
  const r = { in: total.in - without.in, out: total.out - without.out };
  return r.in > 0n && r.out > 0n ? r : total;
}

/** How much worse (pct) `now` is than `ref`: above 0, fewer out per in. */
export function driftPct(ref: Rate, now: Rate): number {
  if (ref.in <= 0n || ref.out <= 0n || now.in <= 0n) return 0;
  const a = ref.out * now.in;
  return Number(((a - now.out * ref.in) * 1_000_000n) / a) / 10_000;
}

/** The drift limit kept in range (bps). */
export const clampDrift = (bps: number | null | undefined) =>
  Math.max(DRIFT_MIN_BPS, Math.min(DRIFT_MAX_BPS, Math.round(Number.isFinite(bps as number) ? (bps as number) : DRIFT_DEFAULT_BPS)));

/**
 * Whether a turn's price stops the batch: a buy or a sale whose price got worse than the approved
 * one by more than the limit. Null: it goes on. A better price never stops it: the approved price is
 * the last wallet's (the worst, after the batch's own earlier trades), so a sale batch's first
 * wallets always get more than it, by the batch's own spread, and stopping on that would only say,
 * untruly, that the market moved up. `side` is kept for the callers.
 */
export function driftStop(_side: "buy" | "sell", ref: Rate, now: Rate, limitBps: number): { pct: number; dir: "worse" } | null {
  const d = driftPct(ref, now);
  const lim = clampDrift(limitBps) / 100;
  return d > lim ? { pct: d, dir: "worse" } : null;
}

/** The least one turn may get on-chain: its amount at the approved price, less the drift limit. */
export function turnFloor(amount: bigint, ref: Rate, limitBps: number): bigint {
  if (ref.in <= 0n) return 0n;
  return (amount * ref.out * BigInt(10_000 - clampDrift(limitBps))) / (ref.in * 10_000n);
}
