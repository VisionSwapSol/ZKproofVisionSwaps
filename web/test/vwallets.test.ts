import { test } from "node:test";
import assert from "node:assert/strict";
import { walletName, walletNumbers, walletsName, ownPaidText, walletStatus, fundAmounts, FUND_MIN, VARY_BPS } from "../src/lib/vwallets.ts";

test("wallet names and numbers", () => {
  assert.equal(walletName(3), "Vision wallet #4");
  assert.equal(walletNumbers([0]), "#1");
  assert.equal(walletNumbers([6, 0, 1, 2, 3, 4, 5]), "#1–#7");
  assert.equal(walletNumbers([0, 1]), "#1 and #2");
  assert.equal(walletNumbers([4, 1]), "#2 and #5");
  assert.equal(walletNumbers([0, 2, 3]), "#1, #3 and #4");
  assert.equal(walletNumbers([2, 2, 3, 4]), "#3–#5");
  assert.equal(walletsName([3]), "Vision wallet #4");
  assert.equal(walletsName([3, 3]), "Vision wallet #4");
  assert.equal(walletsName([0, 1, 2]), "Vision wallets #1–#3");
});

test("the message after paying the person's own wallets", () => {
  assert.equal(ownPaidText([3], true), "Your SOL is in Vision wallet #4. Use it, move it back, or export its key in the Wallets tab.");
  assert.equal(
    ownPaidText([0, 1, 2, 3, 4, 5, 6], false),
    "Your SOL is going to Vision wallets #1–#7. Find them in the Wallets tab: buy with them, move the SOL back, or export their keys.",
  );
  assert.match(ownPaidText([3], false), /^Your SOL is going to Vision wallet #4\. Find it in the Wallets tab/);
  assert.match(ownPaidText([0, 1], true), /^Your SOL is in Vision wallets #1 and #2\./);
});

test("a wallet row's status", () => {
  const base = { lamports: 0n, tokens: 0, finishable: false, arriving: false, sweepMin: 12_000_000n };
  assert.equal(walletStatus(base), "empty");
  assert.equal(walletStatus({ ...base, arriving: true }), "arriving");
  assert.equal(walletStatus({ ...base, lamports: 1_000_000_000n }), "ready");
  // SOL already there and more on its way: usable now
  assert.equal(walletStatus({ ...base, lamports: 1_000_000_000n, arriving: true }), "ready");
  assert.equal(walletStatus({ ...base, lamports: 5_000_000n }), "small");
  assert.equal(walletStatus({ ...base, lamports: 5_000_000n, sweepMin: null }), "ready");
  assert.equal(walletStatus({ ...base, lamports: 6_000_000n, tokens: 1 }), "tokens");
  assert.equal(walletStatus({ ...base, lamports: 0n, tokens: 1 }), "tokens");
  assert.equal(walletStatus({ ...base, lamports: 900_000_000n, finishable: true }), "finish");
});

test("fund amounts: exact, or varied by at most 3% and rounded, never below the floor", () => {
  assert.deepEqual(fundAmounts(500_000_000n, 3, false), [500_000_000n, 500_000_000n, 500_000_000n]);
  let k = 0;
  const seq = [0, 0.999999, 0.5, 0.25, 0.75];
  const rnd = () => seq[k++ % seq.length];
  const a = fundAmounts(1_000_000_000n, 5, true, rnd);
  assert.equal(a.length, 5);
  for (const x of a) {
    assert.ok(x >= 1_000_000_000n - (1_000_000_000n * BigInt(VARY_BPS)) / 10_000n - 100_000n, `${x} too low`);
    assert.ok(x <= 1_000_000_000n + (1_000_000_000n * BigInt(VARY_BPS)) / 10_000n, `${x} too high`);
    assert.equal(x % 100_000n, 0n, "rounded to 0.0001 SOL");
  }
  assert.equal(a[0], 970_000_000n);
  assert.equal(a[2], 1_000_000_000n);
  // with real randomness, the amounts differ
  const r = fundAmounts(1_000_000_000n, 10, true);
  assert.ok(new Set(r.map(String)).size > 1);
  // a floor holds
  assert.ok(fundAmounts(FUND_MIN, 20, true, Math.random, FUND_MIN).every((x) => x >= FUND_MIN));
});
