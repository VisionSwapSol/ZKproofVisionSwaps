import { test } from "node:test";
import assert from "node:assert/strict";
import { predictCredit, DELIVERY_FEE } from "@visionswap/sdk";
import { payQuote } from "../src/lib/hops.ts";
import { prepPlan } from "../src/lib/jobs.ts";
import { nextStep, payoutFor, payOpen, walletDeposit, PAY_LATE_MS, type PayView, type WalletPay } from "../src/lib/walletpay.ts";

const FEE = 2_048_120n;
const BPS = 80;
const W = (a: bigint) => payQuote(a, FEE, BPS).withdraw;
const MIN = 10_000_000n;

test("the deposit is exactly what the payment spends: the recipient gets the amount to the lamport", () => {
  for (const a of [10_000_000n, 500_000_000n, 1_234_567_891n, 25_000_000_000n]) {
    const r = walletDeposit(a, { withdrawOf: W, min: MIN, max: 30_000_000_000n });
    assert.ok("deposit" in r);
    assert.equal(r.deposit, W(a));
    assert.equal(predictCredit(r.deposit, FEE, BPS), a + DELIVERY_FEE);
  }
});

test("a note of exactly the payment needs no cut or join, now or later", () => {
  const d = W(500_000_000n);
  assert.deepEqual(prepPlan([d], [d], FEE, true), { steps: 0, ok: true });
  assert.deepEqual(prepPlan([d], [d], FEE, false), { steps: 0, ok: true });
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

test("bounds: the smallest deposit, and the most one deposit can be", () => {
  const small = walletDeposit(1_000_000n, { withdrawOf: W, min: 1_000_000_000n, max: 30_000_000_000n });
  assert.ok("problem" in small && small.problem === "small");
  if (small.problem !== "small") return;
  assert.ok(W(small.least) >= 1_000_000_000n);
  assert.ok(W(small.least - 1n) < 1_000_000_000n);
  const big = walletDeposit(26_000_000_000n, { withdrawOf: W, min: MIN, max: 25_000_000_000n });
  assert.ok("problem" in big && big.problem === "big");
  if (big.problem !== "big") return;
  assert.ok(W(big.most) <= 25_000_000_000n && W(big.most + 1n) > 25_000_000_000n);
  // right at the edges is fine
  const edge = payoutFor(25_000_000_000n, W);
  assert.ok("deposit" in walletDeposit(edge, { withdrawOf: W, min: MIN, max: 25_000_000_000n }));
});

const D = W(500_000_000n);
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
