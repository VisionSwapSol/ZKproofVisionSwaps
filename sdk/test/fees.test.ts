import { test } from "node:test";
import assert from "node:assert/strict";
import { depositParts, depositFee, maxDepositFor } from "../src/index.ts";

const SOL = 1_000_000_000n;
const base = { rentPending: 1_705_200n, txFee: 10_000n, feeBps: 80, min: SOL / 100n };

function check(balance: bigint, max: bigint) {
  const o = { ...base, max };
  const parts = depositParts(balance, o);
  const per = o.rentPending + o.txFee;
  const smallest = o.min + depositFee(o.min, o.feeBps) + per;
  if (balance < smallest) {
    assert.deepEqual(parts, [], `balance ${balance} is below the smallest deposit`);
    return;
  }
  assert.ok(parts.length > 0, `balance ${balance} fits at least one deposit`);
  let cost = 0n;
  for (const a of parts) {
    assert.ok(a >= o.min && a <= o.max, `part ${a} within [min, max]`);
    cost += a + depositFee(a, o.feeBps) + per;
  }
  const dust = balance - cost;
  assert.ok(dust >= 0n, `never spends more than the balance (dust ${dust})`);
  assert.ok(dust <= 3n, `leaves at most a few lamports of rounding (dust ${dust}), which ride along so the address ends at zero`);
  if (parts.length > 1) assert.ok(maxDepositFor(balance - per, o.feeBps) > o.max, "splits only when one deposit would be too big");
}

test("one address moves into the pool in the fewest deposits, ending at zero", () => {
  let seed = 7n;
  const rnd = (n: bigint) => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return seed % n;
  };
  for (let i = 0; i < 4000; i++) {
    const balance = rnd(300n * SOL) + 1n;
    check(balance, 25n * SOL);
    check(balance, (1n << 64n) - 1n);
    check(balance, SOL / 50n + rnd(3n * SOL));
  }
  // the exact edges
  const smallest = base.min + depositFee(base.min, base.feeBps) + base.rentPending + base.txFee;
  for (const d of [-2n, -1n, 0n, 1n, 2n, 1000n]) check(smallest + d, 25n * SOL);
  for (const b of [25n * SOL, 25n * SOL + 3n * SOL, 50n * SOL + 2n * 1_715_200n, 51n * SOL, 1000n * SOL]) check(b, 25n * SOL);
});
