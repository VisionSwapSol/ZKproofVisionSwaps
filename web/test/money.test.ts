import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtUsd, maskText, MASK, solStr } from "../src/lib/money.ts";

// the engine's own fmt (engine.ts can't be loaded here: it needs a browser), written out the same way
const fmt = (l: bigint, digits = 4) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: digits });

test("dollars as a wallet shows them", () => {
  assert.equal(fmtUsd(0), "$0.00");
  assert.equal(fmtUsd(0.004), "<$0.01");
  assert.equal(fmtUsd(0.005), "$0.01");
  assert.equal(fmtUsd(148.144), "$148.14");
  assert.equal(fmtUsd(1234.5), "$1,234.50");
  assert.equal(fmtUsd(12345.6), "$12,346");
});

test("SOL in the same words as the engine", () => {
  for (const l of [0n, 1n, 123_456_789n, 10n ** 12n, 408_100_000n]) assert.equal(solStr(l), fmt(l));
  assert.equal(solStr(123_456_789n, 6), fmt(123_456_789n, 6));
  // a plain number is SOL, not lamports
  assert.equal(solStr(1.43689), "1.4369");
});

test("hiding amounts: every amount goes, wallet numbers, times and durations stay", () => {
  assert.equal(MASK, "••••");
  assert.equal(maskText("Moved 0.0393 SOL from Vision wallet #3 into the pool"), "Moved •••• SOL from Vision wallet #3 into the pool");
  assert.equal(maskText("Bought 980,000 BONK"), "Bought •••• BONK");
  assert.equal(maskText("$27.62"), "••••");
  assert.equal(maskText("≈ $4.25"), "••••");
  assert.equal(maskText("Got 1.2 mSOL"), "Got •••• mSOL");
  assert.equal(maskText("Got 300 jitoSOL"), "Got •••• jitoSOL");
  assert.equal(maskText("0.035 SOL by 1:47 PM"), "•••• SOL by 1:47 PM");
  assert.equal(maskText("Funded 10 new Vision wallets (2 minutes, one by one)"), "Funded •••• new Vision wallets (2 minutes, one by one)");
  assert.equal(maskText("Vision wallets #13–#22"), "Vision wallets #13–#22");
  assert.equal(maskText("Vision wallets #1, #3–#5 and #8"), "Vision wallets #1, #3–#5 and #8");
  assert.equal(maskText("0.2839 SOL joining your private balance · about 8 min"), "•••• SOL joining your private balance · about 8 min");
  assert.equal(maskText("Moved 2:14 PM"), "Moved 2:14 PM");
  assert.equal(maskText("Shielded 0.5 SOL 24 h ago"), "Shielded •••• SOL 24 h ago");
  assert.equal(maskText("No numbers here"), "No numbers here");
});
