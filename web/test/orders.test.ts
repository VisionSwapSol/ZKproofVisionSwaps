import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { KEY_SLOTS, keySlots, pickKeyN, tokenDelegate, usd, priceText, parsePrice, metNow, legsFor, scaleLegs, shrinkLegs, stepsKept, sellClash, mergeReply, fillStats, ago, inTime, priceEntry, priceStale, PRICE_FRESH_MS } from "../src/lib/orders.ts";
import type { Order } from "../src/lib/engine.ts";

const order = (extra: Partial<Order> = {}): Order => ({
  id: "a",
  token: "t",
  keyN: 0,
  kind: "sell",
  vision: 2,
  mint: "M",
  symbol: "TKN",
  decimals: 6,
  program: "P",
  amount: "1000000000",
  slUsd: 0.5,
  slippageBps: 1000,
  created: 0,
  expires: 10,
  status: "active",
  fills: [],
  lastPrice: 1,
  ...extra,
});

test("order keys: a few per Vision wallet, never one a known order uses", () => {
  assert.deepEqual(keySlots(3).slice(0, 2), [3 * KEY_SLOTS, 3 * KEY_SLOTS + 1]);
  const taken = keySlots(1).filter((n) => n !== KEY_SLOTS + 7);
  assert.equal(pickKeyN(1, taken), KEY_SLOTS + 7);
  for (let i = 0; i < 50; i++) {
    const n = pickKeyN(4, [4 * KEY_SLOTS]);
    assert.ok(n > 4 * KEY_SLOTS && n < 5 * KEY_SLOTS);
  }
});

test("tokenDelegate reads the approval from raw account data", () => {
  const d = new Uint8Array(165);
  const who = PublicKey.unique();
  d[72] = 1;
  d.set(who.toBytes(), 76);
  d[121] = 0x40;
  d[122] = 0x42;
  d[123] = 0x0f; // 1,000,000
  assert.deepEqual(tokenDelegate(d), { delegate: who.toBase58(), delegated: 1_000_000n });
  assert.deepEqual(tokenDelegate(new Uint8Array(165)), { delegate: null, delegated: 0n });
});

test("tiny prices never come out in exponent form", () => {
  assert.equal(usd(1.05e-7), "$0.0₆105");
  assert.equal(usd(1e-7), "$0.0₆1");
  assert.equal(usd(0.00099999), "$0.001");
  assert.equal(usd(0.0012345), "$0.00123");
  assert.equal(usd(2.5), "$2.5");
  assert.equal(usd(null), "–");
  assert.ok(!/e/i.test(priceText(1.05e-7)));
  assert.equal(parsePrice(priceText(1.05e-7)), 1.05e-7);
  assert.equal(parsePrice("1.05e-7"), null, "exponent text is refused, not misread");
  assert.equal(parsePrice("0,5"), 0.5);
});

test("prices already met are refused with today's price", () => {
  assert.match(metNow("buy", { buyBelow: 1.2 }, 1) ?? "", /at or above today's price \(\$1\)/);
  assert.equal(metNow("buy", { buyBelow: 0.9 }, 1), null);
  assert.match(metNow("sell", { tp: [2, 0.9] }, 1) ?? "", /take-profit/);
  assert.match(metNow("sell", { sl: 1 }, 1) ?? "", /stop-loss/);
  assert.equal(metNow("sell", { tp: [2], sl: 0.5 }, 1), null);
  assert.equal(metNow("sell", { tp: [0.1] }, null), null, "no price: nothing to say yet");
});

test("take-profit steps: shares of the amount, and resized keeping their shares", () => {
  assert.deepEqual(
    legsFor(1000n, [
      { tpUsd: 2, pct: 33 },
      { tpUsd: 3, pct: 33 },
      { tpUsd: 4, pct: 34 },
    ]).map((l) => l.amount),
    ["330", "330", "340"],
  );
  assert.deepEqual(
    legsFor(999n, [
      { tpUsd: 2, pct: 50 },
      { tpUsd: 3, pct: 50 },
    ]).map((l) => l.amount),
    ["499", "500"],
    "steps adding up to 100% leave nothing out",
  );
  assert.deepEqual(
    legsFor(1000n, [{ tpUsd: 2, pct: 40 }]).map((l) => l.amount),
    ["400"],
  );
  const scaled = scaleLegs(
    [
      { tpUsd: 2, amount: "600" },
      { tpUsd: 3, amount: "400" },
    ],
    501n,
  );
  assert.deepEqual(
    scaled.map((l) => l.amount),
    ["300", "201"],
  );
  // one step for half of it stays half of what's left, never stretched over all of it
  assert.deepEqual(
    shrinkLegs([{ tpUsd: 2, amount: "500" }], 1000n, 700n).map((l) => l.amount),
    ["350"],
  );
  assert.deepEqual(
    shrinkLegs(
      [
        { tpUsd: 2, amount: "600" },
        { tpUsd: 3, amount: "400" },
      ],
      1000n,
      501n,
    ).map((l) => l.amount),
    ["300", "201"],
    "steps covering all of it still do",
  );
  assert.equal(stepsKept([{ amount: "1000" }], 1000n), false, "one step for all of it needs no steps sent");
  assert.equal(stepsKept([{ amount: "500" }], 1000n), true);
  assert.equal(stepsKept([{ amount: "500" }, { amount: "500" }], 1000n), true);
});

test("a manual sale lowers a take-profit/stop-loss, or ends it, and always ends a DCA in that wallet", () => {
  const o = order();
  assert.equal(sellClash([o], 2, "M", 2_000_000_000n, 500_000_000n), null, "enough left: nothing changes");
  const lower = sellClash([o], 2, "M", 1_000_000_000n, 300_000_000n);
  assert.equal(lower?.plan, "lower");
  assert.equal(lower?.keep, 700_000_000n);
  assert.equal(sellClash([o], 2, "M", 1_000_000_000n, 1_000_000_000n)?.plan, "cancel", "selling it all ends it");
  assert.equal(sellClash([o], 2, "M", 1_000_000_000n, 999_500_000n)?.plan, "cancel", "too little left to run");
  assert.equal(sellClash([o], 3, "M", 1_000_000_000n, 900_000_000n), null, "another wallet");
  assert.equal(sellClash([{ ...o, status: "cancelled" }], 2, "M", 1_000_000_000n, 900_000_000n), null, "an ended order");
  const dca = order({ id: "d", kind: "dca", mint: "X", amount: "40000000", dca: { count: 4, every: 3600, done: 1, next: 0 } });
  assert.equal(sellClash([dca], 2, "M", 1_000_000_000n, 1n)?.plan, "cancel");
  const steps = order({
    legs: [
      { tpUsd: 2, amount: "500000000" },
      { tpUsd: 3, amount: "500000000" },
    ],
  });
  assert.equal(sellClash([steps], 2, "M", 1_000_000_000n, 998_000_000n)?.plan, "cancel", "steps would each be too small");
  assert.equal(sellClash([steps], 2, "M", 1_000_000_000n, 200_000_000n)?.plan, "lower");
});

test("the keeper's news merges in, counting what traded before a hand-back", () => {
  const o = order({
    kind: "dca",
    amount: "40000000",
    dca: { count: 4, every: 3600, done: 2, next: 0 },
    fills: [{ t: 1, sig: "s1", spent: "10000000", got: "5" }],
    base: { fills: [{ t: 1, sig: "s1", spent: "10000000", got: "5" }], spent: "20000000", buys: 2, legs: [] },
  });
  const m = mergeReply(o, {
    id: "a",
    status: "active",
    stage: "watching",
    fills: [{ t: 2, sig: "s2", spent: "10000000", got: "6" }],
    spent: "10000000",
    amount: "20000000",
    dca: { done: 1, count: 2, next: 99, every: 3600, paused: false },
    expires: 50,
  });
  assert.equal(m.fills.length, 2);
  assert.equal(m.spent, "30000000");
  assert.equal(m.amount, "40000000");
  assert.equal(m.dca?.done, 3);
  assert.equal(m.dca?.count, 4);
  assert.equal(m.expires, 50);
  const s = mergeReply(order(), {
    id: "a",
    status: "active",
    legs: [
      { tpUsd: 2, amount: "500", filled: true },
      { tpUsd: 3, amount: "500", filled: false },
    ],
  });
  assert.equal(s.tpUsd, 3, "the lowest step still open");
});

test("fill stats: totals and the average price", () => {
  const st = fillStats({
    kind: "sell",
    decimals: 6,
    fills: [
      { t: 1, sig: "a", spent: "1000000", got: "10000000", priceUsd: 2 },
      { t: 2, sig: "b", spent: "3000000", got: "40000000", priceUsd: 4 },
      { t: 3, sig: "c", spent: "", got: "" },
    ],
  });
  assert.equal(st.tokens, 4_000_000n);
  assert.equal(st.got, 50_000_000n);
  assert.equal(st.avgUsd, 3.5);
});

test("times in plain words", () => {
  assert.equal(ago(0, 12_000), "12 s ago");
  assert.equal(ago(0, 180_000), "3 min ago");
  assert.equal(inTime(3 * 3_600_000, 0), "in 3 h");
  assert.equal(inTime(12 * 86_400_000, 0), "in 12 days");
});

test("a price carries the time the price service fetched it, and an old one can't judge a trigger", () => {
  assert.deepEqual(priceEntry({ usd: 2, at: 1_000 }, 5_000), { usd: 2, at: 1_000 });
  // a plain number (an older server) counts as fetched now; a time from the future is capped at now
  assert.deepEqual(priceEntry(3, 5_000), { usd: 3, at: 5_000 });
  assert.deepEqual(priceEntry({ usd: 2, at: 9_000 }, 5_000), { usd: 2, at: 5_000 });
  // an age from the server is measured on this device's clock: a clock 10 min ahead still sees a fresh price
  const ahead = 1_000_000 + 600_000;
  const e = priceEntry({ usd: 2, age: 30_000 }, ahead);
  assert.deepEqual(e, { usd: 2, at: ahead - 30_000 });
  assert.equal(priceStale(e!.at, ahead), false);
  assert.equal(priceStale(priceEntry({ usd: 2, age: PRICE_FRESH_MS + 5_000 }, ahead)!.at, ahead), true);
  assert.deepEqual(priceEntry({ usd: 2, age: -50 }, 5_000), { usd: 2, at: 5_000 });
  assert.equal(priceEntry(null), null);
  assert.equal(priceEntry({ usd: null, at: 1 }), null);
  assert.equal(priceEntry({ usd: Number.NaN, at: 1 }), null);
  assert.equal(priceStale(null), false);
  assert.equal(priceStale(0, PRICE_FRESH_MS), false);
  assert.equal(priceStale(0, PRICE_FRESH_MS + 1), true);
});

test("a stop room equal to the price room is kept as 'the same', so it follows a new price room", () => {
  // the keeper reports the room in effect: 1000 with a 1000 price room is no choice of the person's
  const same = mergeReply(order({ slippageBps: 1000 }), { id: "a", status: "active", slippageBps: 1000, slSlippageBps: 1000 });
  assert.equal(same.slSlippageBps, undefined);
  const own = mergeReply(order({ slippageBps: 1000 }), { id: "a", status: "active", slippageBps: 1000, slSlippageBps: 1500 });
  assert.equal(own.slSlippageBps, 1500);
  // a reply without the rooms keeps what the device knew
  const kept = mergeReply(order({ slippageBps: 500, slSlippageBps: 1500 }), { id: "a", status: "active" });
  assert.equal(kept.slSlippageBps, 1500);
  // buys never carry a stop room
  const buy = mergeReply(order({ kind: "buy", slippageBps: 500 }), { id: "a", status: "active", slSlippageBps: null });
  assert.equal(buy.slSlippageBps, undefined);
});
