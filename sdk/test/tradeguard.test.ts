import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessRoute,
  clampDrift,
  connectors,
  costOf,
  curveOf,
  driftPct,
  driftStop,
  feeInForce,
  judge,
  keepAfter,
  lastRate,
  marketLoss,
  needs,
  stepDownLoss,
  stepOff,
  taxRises,
  transfersOf,
  turnFloor,
  viaOf,
  worse,
  DRIFT_DEFAULT_BPS,
  DRIFT_MAX_BPS,
  type RouteStep,
  type TradeCheck,
} from "../src/tradeguard.ts";

const SOL = "So11111111111111111111111111111111111111112";
const MASK = "Base1111111111111111111111111111111111111111";
const LAUNCH = "Launch11111111111111111111111111111111111111";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ─── a two-step route: a launch token priced in a taxed token ───

/** Both tokens charge a 3% transfer tax (Token-2022, transferFeeConfig 300 bps). */
const TAXES = { [MASK]: 300, [LAUNCH]: 300 };
/** The market for SOL -> MASK: 0.43108 lamports per MASK unit. */
const MASK_MARKET = 1 / 0.431080588781782;
/** The launch curve's price: 1755.8 LAUNCH per MASK. */
const CURVE_PER_MASK = 1755.8;
const SOL_USD = 100;
const USD = { [SOL]: SOL_USD, [MASK]: SOL_USD * 0.431080588781782e-3, [LAUNCH]: (SOL_USD * 0.431080588781782e-3) / CURVE_PER_MASK };
const DEC = { [SOL]: 9, [MASK]: 6, [LAUNCH]: 6 };

/** A buy whose first step paid well over its own market: 1 SOL in, the MASK that step gave, the LAUNCH that arrived (raw units). */
const BAD = { sol: 1_000_000_000n, mask: 1_809_000_000n, launch: 2_870_000_000_000n };
const badSteps: RouteStep[] = [
  { label: "Manifest", inputMint: SOL, outputMint: MASK, inAmount: String(BAD.sol), outAmount: String(BAD.mask) },
  { label: "Raydium Launchlab", inputMint: MASK, outputMint: LAUNCH, inAmount: String(BAD.mask), outAmount: String(BAD.launch) },
];
const badCheck = () =>
  assessRoute({
    side: "buy",
    inputMint: SOL,
    outputMint: LAUNCH,
    inAmount: BAD.sol,
    outAmount: BAD.launch,
    impactPct: 1,
    steps: badSteps,
    decimals: DEC,
    usd: USD,
    taxes: TAXES,
    stepMarkets: { 0: MASK_MARKET },
  });

test("a route whose connecting step is far off its market is refused, and can't be unlocked", () => {
  const c = badCheck();
  assert.equal(c.level, "block");
  assert.equal(c.unlockable, false);
  assert.equal(c.why, "step");
  assert.ok(c.step && c.step.pct > 18 && c.step.pct < 20, `step ${c.step?.pct}`);
  assert.equal(c.step?.label, "Manifest");
  assert.ok(c.marketPct! > 20 && c.marketPct! < 26, `market ${c.marketPct}`);
  // without the step's own market, the value check alone still refuses it
  const v = assessRoute({ side: "buy", inputMint: SOL, outputMint: LAUNCH, inAmount: BAD.sol, outAmount: BAD.launch, impactPct: 1, steps: badSteps, decimals: DEC, usd: USD, taxes: TAXES, stepMarkets: {} });
  assert.equal(v.level, "block");
  assert.equal(v.why, "market");
  assert.equal(v.unlockable, false);
});

test("the same route at its fair price passes (only the token's own costs remain)", () => {
  // 1 SOL at the market price buys 2,319.75 MASK; the curve gives 1,755.8 LAUNCH each; 3% tax on each of the three moves
  const mask = BigInt(Math.floor(1e9 * MASK_MARKET));
  const launch = BigInt(Math.floor(Number(mask) * CURVE_PER_MASK * 0.97 ** 3));
  const c = assessRoute({
    side: "buy",
    inputMint: SOL,
    outputMint: LAUNCH,
    inAmount: 1_000_000_000n,
    outAmount: launch,
    impactPct: 3.5,
    steps: [
      { label: "Meteora DLMM", inputMint: SOL, outputMint: MASK, inAmount: "1000000000", outAmount: String(mask) },
      { label: "Raydium Launchlab", inputMint: MASK, outputMint: LAUNCH, inAmount: String(mask), outAmount: String(launch) },
    ],
    decimals: DEC,
    usd: USD,
    taxes: TAXES,
    stepMarkets: { 0: MASK_MARKET * 1.001 },
  });
  assert.equal(c.level, "ok");
  assert.ok(Math.abs(c.marketPct!) < 0.5, `market ${c.marketPct}`);
  // the built-in cost: three taxed moves one way (MASK in and out, LAUNCH out), and there and back
  assert.ok(Math.abs(c.costPct - 8.73) < 0.01, `cost ${c.costPct}`);
  assert.ok(Math.abs(c.roundTripPct - 16.7) < 0.05, `round trip ${c.roundTripPct}`);
  assert.deepEqual(c.curve, { label: "Raydium Launchlab", pair: MASK });
  assert.deepEqual(c.taxes, TAXES);
});

test("54 against 64 accounts at the same moment: the smaller route is refused", () => {
  // two quotes for the same 1 SOL buy at the same moment, the second one limited to fewer accounts
  const pct = stepDownLoss(4_108_345_220_565n, 3_482_391_142_391n);
  assert.ok(pct > 15 && pct < 15.5, `${pct}`);
  const c = assessRoute({ side: "buy", inputMint: SOL, outputMint: LAUNCH, inAmount: 1_000_000_000n, outAmount: 3_482_391_142_391n, impactPct: 19.5, steps: [], decimals: DEC, usd: USD, taxes: TAXES, stepDownPct: pct });
  assert.equal(c.level, "block");
  assert.equal(c.why, "step");
  // the same quotes for an ordinary token differ by under 0.01%
  assert.ok(stepDownLoss(3_406_150_000_000n, 3_406_020_000_000n) < 0.01);
});

// ─── the arithmetic ───

test("taxes: the trade's own tokens move once, tokens in between twice; SOL is never taxed", () => {
  const steps: RouteStep[] = [
    { label: "a", inputMint: SOL, outputMint: MASK, inAmount: "1", outAmount: "1" },
    { label: "b", inputMint: MASK, outputMint: LAUNCH, inAmount: "1", outAmount: "1" },
  ];
  const t = transfersOf(steps, SOL, LAUNCH);
  assert.deepEqual([...t.entries()].sort(), [
    [LAUNCH, 1],
    [MASK, 2],
  ].sort());
  assert.equal(keepAfter(TAXES, t), 0.97 ** 3);
  assert.equal(keepAfter({}, t), 1);
  const { costPct, roundTripPct } = costOf(0.9);
  assert.ok(Math.abs(costPct - 10) < 1e-9 && Math.abs(roundTripPct - 19) < 1e-9);
});

test("value lost against the market: prices and decimals, taxes and the fee allowed for; no price, no figure", () => {
  const base = { inAmount: 1_000_000_000n, inDecimals: 9, inUsd: 100, outAmount: 95_000_000n, outDecimals: 6, outUsd: 1, keep: 1 };
  assert.ok(Math.abs(marketLoss(base)! - 5) < 1e-9);
  assert.ok(Math.abs(marketLoss({ ...base, keep: 0.95 })!) < 1e-9, "a 5% tax explains it all");
  assert.ok(Math.abs(marketLoss({ ...base, outAmount: 100_000_000n, feeBps: 100 })! + 1.0101) < 1e-3, "better than market after the fee");
  assert.equal(marketLoss({ ...base, outUsd: null }), null);
  assert.equal(marketLoss({ ...base, inUsd: 0 }), null);
});

test("a step against its own market, its two tokens' taxes allowed for", () => {
  const s: RouteStep = { label: "x", inputMint: SOL, outputMint: MASK, inAmount: "1000", outAmount: "900" };
  assert.ok(Math.abs(stepOff(s, 1, {})! - 10) < 1e-9);
  assert.ok(Math.abs(stepOff(s, 1, { [MASK]: 300 })! - 7) < 1e-9);
  assert.ok(stepOff(s, 0.8, {})! < 0, "better than the market");
  assert.equal(stepOff(s, 0, {}), null);
});

test("connecting steps are the ones that don't trade the person's own token", () => {
  const buy: RouteStep[] = [
    { label: "a", inputMint: SOL, outputMint: USDC, inAmount: "1", outAmount: "1" },
    { label: "b", inputMint: USDC, outputMint: MASK, inAmount: "1", outAmount: "1" },
    { label: "c", inputMint: MASK, outputMint: LAUNCH, inAmount: "1", outAmount: "1" },
  ];
  assert.deepEqual(
    connectors(buy, "buy", LAUNCH).map((s) => s.label),
    ["a", "b"],
  );
  const sell: RouteStep[] = [
    { label: "c", inputMint: LAUNCH, outputMint: MASK, inAmount: "1", outAmount: "1" },
    { label: "d", inputMint: MASK, outputMint: SOL, inAmount: "1", outAmount: "1" },
  ];
  assert.deepEqual(
    connectors(sell, "sell", LAUNCH).map((s) => s.label),
    ["d"],
  );
  // a direct route has none
  assert.deepEqual(connectors([{ label: "e", inputMint: SOL, outputMint: BONK, inAmount: "1", outAmount: "1" }], "buy", BONK), []);
});

test("a launch curve priced in another token is named; one priced in SOL, or an ordinary pool, isn't", () => {
  assert.deepEqual(curveOf(badSteps, LAUNCH), { label: "Raydium Launchlab", pair: MASK });
  assert.equal(curveOf([{ label: "Pump.fun", inputMint: SOL, outputMint: BONK, inAmount: "1", outAmount: "1" }], BONK), undefined);
  assert.equal(curveOf([{ label: "Raydium CP", inputMint: MASK, outputMint: LAUNCH, inAmount: "1", outAmount: "1" }], LAUNCH), undefined);
  assert.deepEqual(curveOf([{ label: "Meteora DBC", inputMint: LAUNCH, outputMint: USDC, inAmount: "1", outAmount: "1" }], LAUNCH), { label: "Meteora DBC", pair: USDC });
});

// ─── the verdict ───

test("levels: under 2.5% fine, then a warning, a yes above 5%, refused above 15%", () => {
  assert.equal(judge({ impactPct: 0.1, marketPct: 0.4 }).level, "ok");
  assert.equal(judge({ impactPct: 0.1, marketPct: 2.5 }).level, "ok");
  assert.equal(judge({ impactPct: 0.1, marketPct: 2.6 }).level, "warn");
  assert.equal(judge({ impactPct: 4.9, marketPct: 1 }).level, "warn");
  assert.equal(judge({ impactPct: 0.1, marketPct: 5.1 }).level, "confirm");
  assert.equal(judge({ impactPct: 5.1, marketPct: 5.1 }).why, "impact");
  assert.equal(judge({ impactPct: 1, marketPct: 9 }).why, "market");
  assert.equal(judge({ impactPct: 14.9, marketPct: 14.9 }).level, "confirm");
  // over 15% and explained by the trade's own impact: refused, but the settings can turn it into a question
  const big = judge({ impactPct: 20, marketPct: 22 });
  assert.deepEqual([big.level, big.why, big.unlockable], ["block", "impact", true]);
  // over 15% that the impact doesn't explain: an off-market route, never unlocked
  const off = judge({ impactPct: 2, marketPct: 16 });
  assert.deepEqual([off.level, off.why, off.unlockable], ["block", "market", false]);
  // the impact alone, with no market price to compare
  assert.deepEqual([judge({ impactPct: 16, marketPct: null }).level, judge({ impactPct: 16, marketPct: null }).unlockable], ["block", true]);
});

test("a sale far under the market price asks instead of being refused; a buy is refused; an off-market step refuses both", () => {
  // the price book can trail a fast drop: a refusal there could leave someone unable to sell a falling token
  const sale = judge({ impactPct: 2, marketPct: 40, side: "sell" });
  assert.deepEqual([sale.level, sale.why, sale.unlockable], ["confirm", "market", false]);
  assert.equal(sale.movePct, 40);
  assert.equal(needs(check({ ...sale, marketPct: 40 }), {}), "confirm");
  assert.equal(needs(check({ ...sale, marketPct: 40 }), { okLoss: 40 }), null, "a yes covers it");
  const buy = judge({ impactPct: 2, marketPct: 40, side: "buy" });
  assert.deepEqual([buy.level, buy.why], ["block", "market"]);
  assert.equal(judge({ impactPct: 2, marketPct: 40 }).level, "block", "no side: as a buy");
  assert.equal(judge({ impactPct: 0, marketPct: 1, stepPct: 30, side: "sell" }).level, "block");
  // a sale whose own size explains it stays a refusal the settings can turn into a question
  const big = judge({ impactPct: 30, marketPct: 31, side: "sell" });
  assert.deepEqual([big.level, big.why, big.unlockable], ["block", "impact", true]);
  // the replayed sales at their own prices (about 1.5% under the DLMM market): fine
  const sell1 = assessRoute({
    side: "sell",
    inputMint: LAUNCH,
    outputMint: SOL,
    inAmount: 215_857_056_747n,
    outAmount: 48_407_447n,
    impactPct: 1,
    steps: [
      { label: "Raydium Launchlab", inputMint: LAUNCH, outputMint: MASK, inAmount: "215857056747", outAmount: "118046799" },
      { label: "Manifest", inputMint: MASK, outputMint: SOL, inAmount: "118046799", outAmount: "48407447" },
    ],
    decimals: DEC,
    usd: { ...USD, [MASK]: SOL_USD * 0.41689349699012124e-3 },
    taxes: TAXES,
    stepMarkets: { 1: 0.41689349699012124 * 0.97 },
  });
  assert.notEqual(sell1.level, "block");
  assert.notEqual(sell1.level, "confirm");
});

test("price impact: a measured one is taken as it is; Jupiter's 100% (it couldn't tell) is no figure at all", () => {
  const base = { side: "buy" as const, inputMint: SOL, outputMint: LAUNCH, inAmount: 1_000_000_000n, outAmount: 4_000_000_000_000n, steps: [], decimals: DEC, taxes: TAXES };
  // Jupiter's own figure has the token's own tax taken off (and still carries MASK's, which is why the server measures it)
  assert.ok(Math.abs(assessRoute({ ...base, impactPct: 6.8, usd: USD }).impactPct - 3.8) < 1e-9);
  assert.equal(assessRoute({ ...base, impactPct: 0.1, impactNet: true, usd: USD }).impactPct, 0.1);
  // a brand-new token Jupiter has no price for: its "100%" is unknown, so it asks for want of a market price (never "would move the price by 100%")
  const fresh = assessRoute({ ...base, impactPct: 100, usd: {} });
  assert.equal(fresh.impactPct, 0);
  assert.equal(fresh.impactUnknown, true);
  // a taxed route nothing could measure: no figure either, and the value against the market decides
  const taxed = assessRoute({ ...base, impactPct: 9.05, impactUnknown: true, usd: USD });
  assert.deepEqual([taxed.impactPct, taxed.impactUnknown], [0, true]);
  assert.deepEqual([fresh.level, fresh.why], ["confirm", "noprice"]);
  // measured, a real 100% stays one
  assert.equal(assessRoute({ ...base, impactPct: 100, impactNet: true, usd: {} }).level, "block");
});

test("a connecting step more than 5% off its market is refused whatever the rest says", () => {
  assert.equal(judge({ impactPct: 0, marketPct: 0, stepPct: 5 }).level, "ok");
  const s = judge({ impactPct: 0, marketPct: 0, stepPct: 5.1 });
  assert.deepEqual([s.level, s.why, s.unlockable], ["block", "step", false]);
});

test("no market price, or a step whose market couldn't be read: a yes, never a quiet go", () => {
  assert.deepEqual([judge({ impactPct: 0.2, marketPct: null }).level, judge({ impactPct: 0.2, marketPct: null }).why], ["confirm", "noprice"]);
  assert.equal(judge({ impactPct: 0.2, marketPct: 0.1, stepUnchecked: true }).why, "noprice");
});

const check = (over: Partial<TradeCheck>): TradeCheck => ({
  level: "ok",
  why: "ok",
  movePct: 0,
  impactPct: 0,
  marketPct: 0,
  step: null,
  unlockable: false,
  taxes: {},
  costPct: 0,
  roundTripPct: 0,
  ...over,
});

test("what a check needs from the person: a block stays blocked unless unlockable and unlocked", () => {
  assert.equal(needs(check({ movePct: 4, level: "warn" })), null);
  assert.equal(needs(check({ movePct: 7, level: "confirm" })), "confirm");
  assert.equal(needs(check({ movePct: 7, level: "confirm" }), { okLoss: 7 }), null);
  assert.equal(needs(check({ movePct: 7.9, level: "confirm" }), { okLoss: 7 }), null, "a tick within one point is covered");
  assert.equal(needs(check({ movePct: 8.2, level: "confirm" }), { okLoss: 7 }), "confirm");
  assert.equal(needs(check({ movePct: 5.5, level: "confirm" }), { okLoss: null }), "confirm", "crossing 5% needs a yes");
  assert.equal(needs(check({ movePct: 20, level: "block", unlockable: false }), { okLoss: 50, unlocked: true }), "block");
  assert.equal(needs(check({ movePct: 20, level: "block", unlockable: true }), { okLoss: 50 }), "block", "not unlocked");
  assert.equal(needs(check({ movePct: 20, level: "block", unlockable: true }), { unlocked: true }), "confirm");
  assert.equal(needs(check({ movePct: 20, level: "block", unlockable: true }), { unlocked: true, okLoss: 20 }), null);
  assert.equal(needs(check({ movePct: 1, level: "confirm", why: "noprice", marketPct: null })), "noprice");
  assert.equal(needs(check({ movePct: 1, level: "confirm", why: "noprice", marketPct: null }), { okNoPrice: true }), null);
});

test("the server's check and the app's own: the worse of the two, figure by figure", () => {
  const a = check({ level: "warn", movePct: 3, marketPct: 3, taxes: { [MASK]: 300 } });
  const b = check({ level: "block", why: "market", movePct: 30, marketPct: 30, taxes: { [MASK]: 500, [LAUNCH]: 300 } });
  const w = worse(a, b);
  assert.equal(w.level, "block");
  assert.equal(w.movePct, 30);
  assert.deepEqual(w.taxes, { [MASK]: 500, [LAUNCH]: 300 });
  assert.equal(worse(a, null), a);
  assert.equal(worse(a, check({ marketPct: null })).marketPct, 3);
});

test("a transfer tax that went up since the quote is found; one that didn't, or went down, isn't", () => {
  assert.deepEqual(taxRises({ [MASK]: 300 }, { [MASK]: 500 }), [[MASK, 300, 500]]);
  assert.deepEqual(taxRises({ [MASK]: 300 }, { [MASK]: 300 }), []);
  assert.deepEqual(taxRises({ [MASK]: 300 }, { [MASK]: 100 }), []);
  // the trade's own token had no tax when approved and has one now
  assert.deepEqual(taxRises({}, { [LAUNCH]: 200 }, [LAUNCH]), [[LAUNCH, 0, 200]]);
  assert.deepEqual(taxRises({}, {}, [LAUNCH]), []);
  // a token no longer in the route says nothing
  assert.deepEqual(taxRises({ [MASK]: 300 }, {}), []);
});

test("the tokens in between, and the app's own look at a transaction (no steps) taxes them the same", () => {
  assert.deepEqual(viaOf(badSteps, SOL, LAUNCH), [MASK]);
  assert.deepEqual(viaOf([{ label: "x", inputMint: SOL, outputMint: BONK, inAmount: "1", outAmount: "1" }], SOL, BONK), []);
  const withSteps = badCheck();
  const fromTx = assessRoute({ side: "buy", inputMint: SOL, outputMint: LAUNCH, inAmount: BAD.sol, outAmount: BAD.launch, impactPct: 1, steps: [], via: withSteps.via, decimals: DEC, usd: USD, taxes: TAXES });
  assert.deepEqual(withSteps.via, [MASK]);
  assert.equal(fromTx.costPct, withSteps.costPct);
  assert.equal(fromTx.marketPct, withSteps.marketPct);
  // without the steps nothing can say a step is off; the value check still refuses it
  assert.equal(fromTx.step, null);
  assert.equal(fromTx.level, "block");
});

test("the transfer fee in force follows the epoch; a scheduled change is named with how far away it is", () => {
  const r = { older: { epoch: 800, bps: 300 }, newer: { epoch: 905, bps: 1000 } };
  assert.deepEqual(feeInForce(r, 900), { bps: 300, soon: { bps: 1000, epochs: 5 } });
  assert.deepEqual(feeInForce(r, 905), { bps: 1000 });
  assert.deepEqual(feeInForce({}, 1), { bps: 0 });
  assert.deepEqual(feeInForce({ older: { epoch: 1, bps: 300 }, newer: { epoch: 1, bps: 300 } }, 2), { bps: 300 });
});

// ─── a batch, wallet by wallet ───

test("the last wallet's price: the whole batch's quote less the quote without its part", () => {
  const total = { in: 3_000_000_000n, out: 2_700n };
  const without = { in: 2_000_000_000n, out: 1_900n };
  assert.deepEqual(lastRate(total, without), { in: 1_000_000_000n, out: 800n });
  assert.deepEqual(lastRate(total, null), total);
  // nonsense (the smaller quote gave more): the average
  assert.deepEqual(lastRate(total, { in: 2_000_000_000n, out: 2_800n }), total);
});

test("drift: only a worse price stops a turn, a buy's or a sale's", () => {
  const ref = { in: 1_000n, out: 1_000n };
  assert.ok(Math.abs(driftPct(ref, { in: 1_000n, out: 940n }) - 6) < 1e-9);
  assert.ok(Math.abs(driftPct(ref, { in: 1_000n, out: 1_060n }) + 6) < 1e-9);
  assert.equal(driftStop("buy", ref, { in: 1_000n, out: 951n }, 500), null);
  assert.deepEqual(driftStop("buy", ref, { in: 1_000n, out: 940n }, 500)?.dir, "worse");
  assert.equal(driftStop("buy", ref, { in: 1_000n, out: 1_200n }, 500), null, "a cheaper buy goes on");
  assert.deepEqual(driftStop("sell", ref, { in: 1_000n, out: 800n }, 500)?.dir, "worse");
  // the approved price is the last wallet's (the worst): a sale batch's first wallets get more than it by the
  // batch's own spread (2.5% for five 1M LAUNCH sales, read-only quotes), and that must not stop it
  assert.equal(driftStop("sell", ref, { in: 1_000n, out: 1_200n }, 200), null, "a better sale goes on");
  assert.equal(driftStop("sell", ref, { in: 1_000n, out: 1_040n }, 500), null);
  // a different size compares per unit
  assert.equal(driftStop("buy", ref, { in: 2_000n, out: 1_950n }, 500), null);
});

test("the drift limit stays between 1% and 15%; a turn's floor is its amount at the approved price less the limit", () => {
  assert.equal(clampDrift(undefined), DRIFT_DEFAULT_BPS);
  assert.equal(clampDrift(99_999), DRIFT_MAX_BPS);
  assert.equal(clampDrift(0), 100);
  assert.equal(turnFloor(2_000n, { in: 1_000n, out: 5_000n }, 500), 9_500n);
  assert.equal(turnFloor(2_000n, { in: 1_000n, out: 5_000n }, 99_999), 8_500n, "never wider than 15%");
  assert.equal(turnFloor(2_000n, { in: 0n, out: 5_000n }, 500), 0n);
});
