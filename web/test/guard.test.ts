import { test } from "node:test";
import assert from "node:assert/strict";
import { assessRoute, type TradeCheck } from "@visionswap/sdk";
import { acceptHold, approvalOf, batchWarnings, checkSay, continueLabel, costSay, driftText, loadGuard, saveGuard } from "../src/lib/guard.ts";
import { continueHeld, holdBatch, retryFailed, stopRest, turnGuard, type Batch, type BatchItem } from "../src/lib/batch.ts";
import { autoSlippage, isDust } from "../src/lib/trade.ts";

const SOL = "So11111111111111111111111111111111111111112";
const MASK = "Base1111111111111111111111111111111111111111";
const LAUNCH = "Launch11111111111111111111111111111111111111";

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
const o = { symbol: "LAUNCH", side: "buy" as const, unlocked: false };

// ─── what a review says ───

test("review: nothing to say, a note, a question with Go back, or a refusal", () => {
  assert.equal(checkSay(check({}), o), null);
  assert.equal(checkSay(null, o), null);
  const warn = checkSay(check({ level: "warn", why: "market", movePct: 3.2, marketPct: 3.2 }), o)!;
  assert.equal(warn.tone, "warn");
  assert.match(warn.text, /You'd get about 3\.2% less than the market price for LAUNCH/);
  const ask = checkSay(check({ level: "confirm", why: "impact", movePct: 7.4, impactPct: 7.4 }), o)!;
  assert.equal(ask.tone, "ask");
  assert.equal(ask.ask, "This trade would move the price by 7.4%. Buy anyway?");
  const sell = checkSay(check({ level: "confirm", why: "market", movePct: 9, marketPct: 9 }), { ...o, side: "sell" })!;
  assert.equal(sell.ask, "You'd get about 9% less than the market price for LAUNCH. Sell anyway?");
  const none = checkSay(check({ level: "confirm", why: "noprice", movePct: 0.4, marketPct: null }), o)!;
  assert.equal(none.tone, "ask");
  assert.match(none.ask!, /can't find a market price for LAUNCH right now/);
});

test("review: a refusal says why in plain words; the 15% one names the setting that turns it into a question", () => {
  const step = checkSay(check({ level: "block", why: "step", movePct: 94, step: { label: "Manifest", pct: 93.8 } }), o)!;
  assert.equal(step.tone, "stop");
  assert.match(step.text, /trades through Manifest at 94% worse than that market's price, so VisionSwap won't make it/);
  const off = checkSay(check({ level: "block", why: "market", movePct: 23, marketPct: 23 }), o)!;
  assert.match(off.text, /gives about 23% less than the market price for LAUNCH/);
  const big = check({ level: "block", why: "impact", movePct: 19.5, impactPct: 19.5, marketPct: 20, unlockable: true });
  assert.match(checkSay(big, o)!.text, /move the price by 20%, more than the 15% VisionSwap allows.*Allow trades that move the price more than 15%/);
  // unlocked: a question instead
  const asked = checkSay(big, { ...o, unlocked: true })!;
  assert.equal(asked.tone, "ask");
  // an off-market route is never unlocked
  assert.equal(checkSay(check({ level: "block", why: "market", movePct: 23, marketPct: 23 }), { ...o, unlocked: true })!.tone, "stop");
  const small = checkSay(check({ level: "block", why: "step", movePct: 20, step: { label: "a smaller route", pct: 15.2 }, stepDownPct: 15.2 }), o)!;
  assert.match(small.text, /doesn't fit in one transaction, and the one that does gives 15% less/);
});

test("what a yes on the review agrees to: the figure shown, and going without a market price only when that was asked", () => {
  const c = check({ level: "confirm", why: "market", movePct: 8.2, marketPct: 8.2 });
  assert.deepEqual(approvalOf(c, { said: true, unlocked: false }), { unlocked: false, okLoss: 8.2 });
  assert.deepEqual(approvalOf(c, { said: false, unlocked: true }), { unlocked: true });
  assert.deepEqual(approvalOf(check({ marketPct: null, level: "confirm", why: "noprice" }), { said: true, unlocked: false }), { unlocked: false, okLoss: 0, okNoPrice: true });
});

test("built-in costs: one taxed token in plain words; a route of taxed tokens with its round trip and launch curve", () => {
  const name = (m: string) => (m === MASK ? "MASK" : m === LAUNCH ? "LAUNCH" : m);
  const one = costSay(check({ taxes: { [LAUNCH]: 300 }, costPct: 3, roundTripPct: 5.91 }), name)!;
  assert.equal(one.warn, false);
  assert.match(one.text, /^LAUNCH charges a 3% tax on every transfer/);
  const replayRoute = assessRoute({
    side: "buy",
    inputMint: SOL,
    outputMint: LAUNCH,
    inAmount: 1_000_000_000n,
    outAmount: 3_640_000_000_000n,
    impactPct: 4,
    steps: [
      { label: "Meteora DLMM", inputMint: SOL, outputMint: MASK, inAmount: "1000000000", outAmount: "2319750000" },
      { label: "Raydium Launchlab", inputMint: MASK, outputMint: LAUNCH, inAmount: "2319750000", outAmount: "3640000000000" },
    ],
    decimals: { [SOL]: 9, [LAUNCH]: 6, [MASK]: 6 },
    usd: {},
    taxes: { [MASK]: 300, [LAUNCH]: 300 },
    taxSoon: { [MASK]: { bps: 500, epochs: 3 } },
  });
  const all = costSay(replayRoute, name)!;
  assert.equal(all.warn, true, "8.7% is over the 5% that's said plainly");
  assert.match(all.text, /Transfer taxes built into this route \(MASK 3%, LAUNCH 3%\) take about 8\.7% of it, and about 17% to buy and later sell back/);
  assert.match(all.text, /still on its launch curve \(Raydium Launchlab\), priced in MASK, so every trade also buys or sells MASK/);
  assert.match(all.text, /MASK's transfer tax is set to change to 5% in about 6 days/);
  assert.equal(costSay(check({}), name), null);
});

test("before a batch: thin, big against liquidity, new, fast-moving or on a curve are said plainly; an ordinary token says nothing", () => {
  const now = Date.parse("2026-10-16T03:20:00Z");
  // a launch token: $6,000 of liquidity, up 21% in the hour, 14 days old, priced in MASK
  const w = batchWarnings({ symbol: "LAUNCH", liquidity: 6_000, created: Date.parse("2026-10-02T03:20:00Z"), change1h: 21, inUsd: 960, curvePair: "MASK", now });
  assert.equal(w.length, 3);
  assert.match(w[0], /This batch is about 16% of LAUNCH's liquidity \(\$6,000\), so it moves the price a lot: later wallets pay more/);
  assert.match(w[1], /price moved 21% in the last hour/);
  assert.match(w[2], /still on its launch curve, priced in MASK/);
  assert.match(batchWarnings({ symbol: "NEW", liquidity: 30_000, created: now - 3600_000, inUsd: 100, now }).join(" "), /only about \$30,000 of liquidity.*less than a day old/);
  assert.deepEqual(batchWarnings({ symbol: "BONK", liquidity: 40_000_000, created: now - 900 * 86_400_000, change1h: -1.2, inUsd: 500, now }), []);
  assert.deepEqual(batchWarnings({ symbol: "X" }), [], "nothing known, nothing said");
});

// ─── what a batch keeps of the approved price ───

const SOLL = 1_000_000_000n;
const batch = (items: Partial<BatchItem>[], extra: Partial<Batch> = {}): Batch => ({
  id: "b1",
  kind: "buyFrom",
  pacing: "spaced",
  nextAt: 0,
  paused: false,
  created: 0,
  symbol: "LAUNCH",
  mint: LAUNCH,
  items: items.map((x, i) => ({ index: i, amount: String(SOLL), status: "waiting" as const, ...x })),
  ...extra,
});

test("continue after each kind of stop takes on exactly what was asked; a refusal takes on nothing", () => {
  const b = batch([{}, {}], { okLoss: 6, taxes: { [MASK]: 300 } });
  const market = continueHeld(holdBatch(b, 1, { why: "market", text: "x", loss: 9.5 }), 1);
  assert.equal(market.okLoss, 9.5);
  const noprice = continueHeld(holdBatch(b, 1, { why: "noprice", text: "x" }), 1);
  assert.equal(noprice.okNoPriceAt, 1);
  assert.equal(turnGuard(noprice, 1).okNoPrice, true);
  assert.equal(turnGuard(noprice, 0).okNoPrice, false, "for that one wallet only");
  const tax = continueHeld(holdBatch(b, 1, { why: "tax", text: "x", taxes: { [MASK]: 500 } }), 1);
  assert.deepEqual(tax.taxes, { [MASK]: 500 });
  const block = continueHeld(holdBatch(b, 1, { why: "block", text: "x" }), 1);
  assert.equal(block.okLoss, 6);
  assert.equal(continueLabel({ why: "block", text: "x" }), "Check again");
  // a funded new wallet that stopped to ask finishes there next time
  assert.equal(holdBatch(b, 0, { why: "drift", text: "x" }, true).items[0].finish, true);
});

test("try those again keeps the approved price (only a stop's one-off yes goes); stop the rest clears the stop", () => {
  const b = batch([{ status: "failed", error: "busy" }], { refIn: "1", refOut: "2", okNoPriceAt: 0, hold: { why: "noprice", text: "x", k: 0 } });
  const r = retryFailed(b, 9);
  assert.equal(r.refIn, "1");
  assert.equal(r.refOut, "2");
  assert.equal(r.okNoPriceAt, undefined);
  assert.equal(r.hold, undefined);
  assert.equal(stopRest(batch([{}], { hold: { why: "drift", text: "x" }, paused: true })).hold, undefined);
});

test("a guard keeps in storage and comes back the same; a yes to a stop is added to it", () => {
  const g = { ref: { in: 5n, out: 7n }, driftBps: 1000, okLoss: 6, taxes: { [MASK]: 300 }, unlocked: true };
  const saved = JSON.parse(JSON.stringify(saveGuard(g)));
  assert.deepEqual(loadGuard(saved), g);
  assert.equal(saveGuard(undefined), undefined);
  assert.deepEqual(acceptHold(g, { why: "drift", text: "x", nowIn: "10", nowOut: "11" }).ref, { in: 10n, out: 11n });
  assert.equal(acceptHold(g, { why: "market", text: "x", loss: 9 }).okLoss, 9);
  assert.equal(acceptHold(undefined, { why: "noprice", text: "x" }).okNoPrice, true);
});

test("a sale's batch that got a worse price says so; a sale far under the market price asks, saying the price may just have fallen", () => {
  assert.match(driftText({ side: "sell", pct: 7, symbol: "BONK", wallet: "Vision wallet #2" }), /7% less SOL for its BONK. Nothing was sold/);
  const sale = checkSay(check({ level: "confirm", why: "market", movePct: 40, marketPct: 40 }), { ...o, side: "sell" })!;
  assert.equal(sale.tone, "ask");
  assert.equal(
    sale.ask,
    "You'd get about 40% less than the market price for LAUNCH. If its price just fell, the market price VisionSwap reads may not have caught up yet. Sell anyway?",
  );
  // within 15% it reads as before
  assert.match(checkSay(check({ level: "confirm", why: "market", movePct: 9, marketPct: 9 }), { ...o, side: "sell" })!.text, /A smaller amount usually gets a better price/);
});

// ─── price room and leftovers ───

test("Auto price room follows liquidity only: a transfer tax is already in the quote, so it adds nothing", () => {
  // LAUNCH: $5,984 of liquidity and a 3% tax got 13% before; now its tier's 10%
  assert.equal(autoSlippage({ liquidity: 5_984 }), 1000);
  assert.equal(autoSlippage({ liquidity: 100_000 }), 600);
  assert.equal(autoSlippage({ liquidity: 1_000_000 }), 300);
  assert.equal(autoSlippage({ liquidity: 50_000_000 }), 100);
  assert.equal(autoSlippage(null), 500);
});

test("a leftover sliver is at most a millionth of a token, and never one of a token with few decimals", () => {
  // wallet #4's 1 unit of MASK (6 decimals)
  assert.equal(isDust(1n, 6), true);
  assert.equal(isDust(2n, 6), false);
  assert.equal(isDust(1_000n, 9), true);
  assert.equal(isDust(1_001n, 9), false);
  assert.equal(isDust(1n, 5), false);
  assert.equal(isDust(1n, 0), false);
  assert.equal(isDust(0n, 9), false);
});
