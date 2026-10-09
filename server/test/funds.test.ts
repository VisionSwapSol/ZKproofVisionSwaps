import { test } from "node:test";
import assert from "node:assert/strict";
import { crossing } from "../src/funds.ts";

test("a low balance is reported once when it crosses the line, and once when it recovers", () => {
  const w = { name: "relayer", address: "x", threshold: 50_000_000n, lamports: null, low: false };
  assert.equal(crossing(w, 80_000_000n), null);
  assert.match(crossing(w, 40_000_000n) ?? "", /relayer is low on SOL \(0\.0400 SOL, below 0\.0500\)/);
  assert.equal(w.low, true);
  assert.equal(crossing(w, 30_000_000n), null, "still low: no repeat");
  assert.match(crossing(w, 60_000_000n) ?? "", /topped up/);
  assert.equal(crossing(w, 70_000_000n), null);
});
