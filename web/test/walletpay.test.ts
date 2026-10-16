import { test } from "node:test";
import assert from "node:assert/strict";
import { predictCredit, DELIVERY_FEE } from "@visionswap/sdk";
import { payQuote } from "../src/lib/hops.ts";
import {
  depositSizes,
  leastChange,
  maxChange,
  nextStep,
  payoutFor,
  payOpen,
  sizeAtLeast,
  walletDeposit,
  walletMost,
  CHANGE_MAX_BPS,
  CHANGE_MIN_BPS,
  PAY_LATE_MS,
  type PayView,
  type WalletPay,
} from "../src/lib/walletpay.ts";

const FEE = 2_048_120n;
const BPS = 80;
const W = (a: bigint) => payQuote(a, FEE, BPS).withdraw;
const MIN = 10_000_000n;
const SOL = 1_000_000_000n;
const MAX = 300n * SOL;
const LIMITS = { withdrawOf: W, min: MIN, max: MAX };
const sol = (x: number) => BigInt(Math.round(x * 1e9));

test("standard sizes: 1, 2, 3 and 5 times each power of ten", () => {
  const sizes = depositSizes(MAX).filter((s) => s >= MIN);
  assert.deepEqual(
    sizes.map((s) => Number(s) / 1e9),
    [0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 3, 5, 10, 20, 30, 50, 100, 200, 300],
  );
  assert.equal(sizeAtLeast(sol(0.7)), SOL);
  assert.equal(sizeAtLeast(SOL), SOL);
  assert.equal(sizeAtLeast(SOL + 1n), 2n * SOL);
  assert.equal(sizeAtLeast(sol(2.5)), 3n * SOL);
  assert.equal(sizeAtLeast(sol(4)), 5n * SOL);
});

test("the deposit is the smallest standard size that covers the payment with change: the recipient still gets the amount to the lamport", () => {
  const sizes = depositSizes(MAX);
  for (const a of [10_000_000n, 123_456_789n, 500_000_000n, 1_234_567_891n, 25_000_000_000n, sol(250)]) {
    const r = walletDeposit(a, LIMITS);
    assert.ok("deposit" in r, `${a}`);
    assert.ok(sizes.includes(r.deposit), `${a}: ${r.deposit} is a standard size`);
    // never the payment's own amount: some of the note always comes back as change
    assert.equal(r.change, r.deposit - W(a));
    assert.ok(r.change >= leastChange(r.deposit), `${a}: change ${r.change}`);
    // the smallest that does: the size below it doesn't cover the payment with its least change
    const below = sizes.filter((s) => s < r.deposit && s >= MIN).pop();
    if (below != null) assert.ok(below - W(a) < leastChange(below), `${a}: ${below} would do`);
    // the payment spends W(a) of the note, so its delivery is exact as before
    assert.equal(predictCredit(W(a), FEE, BPS), a + DELIVERY_FEE);
  }
});

test("many payment amounts share one deposit size, so the deposit doesn't give the amount away", () => {
  for (const a of [sol(0.6), sol(0.75), sol(0.9), sol(0.97)]) {
    const r = walletDeposit(a, LIMITS);
    assert.ok("deposit" in r);
    assert.equal(r.deposit, SOL, `${a}`);
  }
  for (const a of [sol(1.2), sol(1.6), sol(1.95)]) {
    const r = walletDeposit(a, LIMITS);
    assert.ok("deposit" in r);
    assert.equal(r.deposit, 2n * SOL, `${a}`);
  }
});

test("a deposit is never spent whole: a payment that would use (nearly) all of a size takes the next one", () => {
  const whole = payoutFor(SOL, W);
  for (const a of [whole, whole - 1_000n, payoutFor(SOL - leastChange(SOL) + 1n, W)]) {
    const r = walletDeposit(a, LIMITS);
    assert.ok("deposit" in r);
    assert.equal(r.deposit, 2n * SOL, `${a}`);
  }
  // just enough change stays on the size
  const fits = payoutFor(SOL - leastChange(SOL), W);
  const r = walletDeposit(fits, LIMITS);
  assert.ok("deposit" in r && r.deposit === SOL && r.change >= leastChange(SOL));
});

test("the pool's smallest deposit still holds: a small payment deposits at least it", () => {
  const r = walletDeposit(2_000_000n, LIMITS);
  assert.ok("deposit" in r);
  assert.equal(r.deposit, MIN);
  assert.equal(r.change, MIN - W(2_000_000n));
  // a smallest deposit between two sizes: the next size up
  const odd = walletDeposit(2_000_000n, { ...LIMITS, min: 15_000_000n });
  assert.ok("deposit" in odd && odd.deposit === 20_000_000n);
});

test("the most one deposit can be: the largest standard size within the limit, less fees and change", () => {
  const max = 25n * SOL;
  const big = walletDeposit(sol(21), { ...LIMITS, max });
  assert.ok("problem" in big);
  assert.equal(big.most, payoutFor(20n * SOL - leastChange(20n * SOL), W));
  // the most it names fits, on that size
  const r = walletDeposit(big.most, { ...LIMITS, max });
  assert.ok("deposit" in r && r.deposit === 20n * SOL);
  // the pool's 300 SOL largest deposit is a size of its own
  const top = walletDeposit(sol(290), LIMITS);
  assert.ok("deposit" in top && top.deposit === MAX);
  // no size fits the limits at all
  assert.equal(walletMost({ ...LIMITS, min: 40_000_000n, max: 45_000_000n }), null);
  const none = walletDeposit(2_000_000n, { ...LIMITS, min: 40_000_000n, max: 45_000_000n });
  assert.ok("problem" in none && none.most === 0n);
});

test("Max leaves a small random change, and the amount it gives pays from that same size", () => {
  const size = 5n * SOL;
  let last = -1n;
  for (const u of [0, 0.25, 0.5, 0.75, 0.999]) {
    const c = maxChange(size, u);
    assert.ok(c >= (size * CHANGE_MIN_BPS) / 10_000n && c <= (size * CHANGE_MAX_BPS) / 10_000n, `${u}: ${c}`);
    assert.ok(c > last, "grows with the draw");
    last = c;
    const m = walletMost({ ...LIMITS, max: sol(7.3), spare: (s) => maxChange(s, u) });
    assert.ok(m && m.size === size);
    assert.equal(m!.most, payoutFor(size - c, W));
    const r = walletDeposit(m!.most, LIMITS);
    assert.ok("deposit" in r && r.deposit === size && r.change >= c);
  }
  assert.equal(maxChange(size, 0), leastChange(size));
  // a spare below the least change never spends more of the note than the least change allows
  const m = walletMost({ ...LIMITS, max: size, spare: () => 0n });
  assert.equal(m!.most, payoutFor(size - leastChange(size), W));
});

test("payoutFor is the inverse: the largest payment a note covers", () => {
  for (const n of [MIN, 12_345_678n, 500_000_000n, 1_000_000_007n, 25_000_000_000n]) {
    const p = payoutFor(n, W);
    assert.ok(W(p) <= n, `${n}: W(p) fits`);
    assert.ok(W(p + 1n) > n, `${n}: one lamport more doesn't`);
  }
  // a note of exactly a payment's withdrawal pays that payment
  assert.equal(payoutFor(W(500_000_000n), W), 500_000_000n);
  // too small for any payment
  assert.equal(payoutFor(FEE, W), 0n);
});

// a payment of 0.5 SOL from a standard 1 SOL deposit: its note covers it with change
const D = SOL;
const pay = (extra: Partial<WalletPay> = {}): WalletPay => ({
  id: "a",
  created: 1_000,
  to: "x",
  amount: "500000000",
  when: "15m",
  depositor: "w",
  inner: "00",
  D: D.toString(),
  status: "waiting",
  sig: "s",
  ...extra,
});
const view = (extra: Partial<PayView> = {}): PayView => ({ now: 2_000, settled: false, unspent: false, waiting: false, need: D, recorded: null, ...extra });

test("paying: nothing signed is dropped; a landed deposit waits; one that never landed is dropped", () => {
  assert.deepEqual(nextStep(pay({ status: "paying", sig: undefined }), view()), { do: "drop" });
  assert.deepEqual(nextStep(pay({ status: "paying" }), view({ waiting: true })), { do: "set", status: "waiting" });
  assert.deepEqual(nextStep(pay({ status: "paying" }), view({ settled: true })), { do: "set", status: "waiting" });
  assert.deepEqual(nextStep(pay({ status: "paying" }), view()), { do: "look" });
  assert.deepEqual(nextStep(pay({ status: "paying" }), view({ sig: "landed" })), { do: "set", status: "waiting" });
  assert.deepEqual(nextStep(pay({ status: "paying" }), view({ sig: "dropped" })), { do: "drop" });
  assert.deepEqual(nextStep(pay({ status: "paying" }), view({ sig: "failed" })), { do: "drop" });
  assert.deepEqual(nextStep(pay({ status: "paying" }), view({ sig: "unknown" })), { do: "wait" });
});

test("waiting: goes once its note is in, and asks the chain when it vanished without one", () => {
  assert.deepEqual(nextStep(pay(), view({ waiting: true })), { do: "wait" });
  assert.deepEqual(nextStep(pay(), view({ settled: true, unspent: true })), { do: "fire" });
  assert.deepEqual(nextStep(pay(), view({ settled: true })), { do: "set", status: "cancelled", why: "spent" });
  assert.deepEqual(nextStep(pay(), view()), { do: "look" });
  assert.deepEqual(nextStep(pay(), view({ fate: "refunded" })), { do: "set", status: "cancelled", why: "refunded" });
  assert.deepEqual(nextStep(pay(), view({ fate: "returned" })), { do: "set", status: "returned", why: "returned" });
  assert.deepEqual(nextStep(pay(), view({ fate: "unknown" })), { do: "wait" });
});

test("over a day old, or fees above what the note covers: the owner decides", () => {
  assert.deepEqual(nextStep(pay(), view({ settled: true, unspent: true, now: 1_000 + PAY_LATE_MS + 1 })), { do: "set", status: "needs-you", ask: "late" });
  assert.deepEqual(nextStep(pay(), view({ settled: true, unspent: true, need: D + 1n })), { do: "set", status: "needs-you", ask: "fees" });
  // lower fees are fine: the note covers it
  assert.deepEqual(nextStep(pay(), view({ settled: true, unspent: true, need: D - 5_000n })), { do: "fire" });
  // both: the fee choice, so "Send it now" never spends more than its own note
  assert.deepEqual(nextStep(pay(), view({ settled: true, unspent: true, need: D + 1n, now: 1_000 + PAY_LATE_MS + 1 })), { do: "set", status: "needs-you", ask: "fees" });
});

test("sending is never sent twice: a started payment ends it, unspent goes again, spent with no record asks", () => {
  const s = pay({ status: "sending", sendingAt: 1_500 });
  assert.deepEqual(nextStep(s, view({ settled: true, recorded: "sent" })), { do: "set", status: "sent" });
  assert.deepEqual(nextStep(s, view({ settled: true, unspent: true, recorded: "scheduled" })), { do: "set", status: "scheduled" });
  assert.deepEqual(nextStep(s, view({ settled: true, unspent: true })), { do: "fire" });
  assert.deepEqual(nextStep(s, view({ settled: true })), { do: "set", status: "needs-you", ask: "unsure" });
  assert.deepEqual(nextStep(s, view({ settled: true, unspent: true, now: 1_000 + PAY_LATE_MS + 1 })), { do: "set", status: "needs-you", ask: "late" });
});

test("ended and asking payments are left alone", () => {
  for (const status of ["sent", "scheduled", "returned", "cancelled", "needs-you"] as const) {
    assert.deepEqual(nextStep(pay({ status }), view({ settled: true, unspent: true })), { do: "wait" });
  }
  assert.equal(payOpen("needs-you"), true);
  assert.equal(payOpen("sent"), false);
});
