import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, priorityPrice, speedOf, SPEEDS } from "../src/priority.ts";

test("unknown speeds are Normal", () => {
  assert.equal(speedOf("fast"), "fast");
  assert.equal(speedOf("turbo"), "turbo");
  assert.equal(speedOf("ludicrous"), "normal");
  assert.equal(speedOf(undefined), "normal");
});

test("percentiles ignore blocks where nothing was paid", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([0, 0, 0], 90), 0);
  assert.equal(percentile([0, 10, 20, 30, 40], 50), 30);
  assert.equal(percentile([5, 1, 3], 90), 5);
});

test("a quiet network pays the speed's floor", () => {
  const n = priorityPrice({ speed: "normal", attempt: 0, recent: [], units: 300_000, base: 20_000, jitter: 0 });
  assert.deepEqual(n, { microLamports: 20_000, lamports: 6_000 });
  const f = priorityPrice({ speed: "fast", attempt: 0, recent: [0, 0], units: 300_000, jitter: 0 });
  assert.equal(f.microLamports, SPEEDS.fast.floor);
});

test("a busy route pays what its accounts paid lately, and each retry doubles it", () => {
  const recent = [100_000, 200_000, 300_000, 400_000];
  const a0 = priorityPrice({ speed: "fast", attempt: 0, recent, units: 200_000, jitter: 0 });
  const a1 = priorityPrice({ speed: "fast", attempt: 1, recent, units: 200_000, jitter: 0 });
  assert.equal(a0.microLamports, 400_000);
  assert.equal(a1.microLamports, 800_000);
});

test("the whole fee never goes over the speed's cap, however busy or however many retries", () => {
  for (const speed of ["normal", "fast", "turbo"] as const) {
    for (const attempt of [0, 1, 2, 3, 9]) {
      for (const units of [50_000, 300_000, 1_400_000]) {
        const p = priorityPrice({ speed, attempt, recent: [50_000_000], units });
        assert.ok(p.lamports <= SPEEDS[speed].capLamports, `${speed} ${attempt} ${units}: ${p.lamports}`);
        assert.ok(p.microLamports >= 1);
      }
    }
  }
});

test("odd attempt numbers can't break the price", () => {
  const p = priorityPrice({ speed: "normal", attempt: Number.NaN, recent: [], units: 100_000, base: 20_000, jitter: 0 });
  assert.equal(p.microLamports, 20_000);
  const q = priorityPrice({ speed: "normal", attempt: -4, recent: [], units: 100_000, base: 20_000, jitter: 0 });
  assert.equal(q.microLamports, 20_000);
});

test("the site's own Normal floor stays between Normal's and Fast's, so the speeds keep their order", () => {
  const at = (base: number) => priorityPrice({ speed: "normal", attempt: 0, recent: [], units: 300_000, base, jitter: 0 }).microLamports;
  assert.equal(at(1), SPEEDS.normal.floor);
  assert.equal(at(50_000), 50_000);
  assert.equal(at(900_000), 111_111);
  assert.ok(at(900_000) <= priorityPrice({ speed: "fast", attempt: 0, recent: [], units: 300_000, jitter: 0 }).microLamports);
});

test("a raised Normal floor, at its highest price and on any retry, stays under Fast's lowest", () => {
  for (const base of [140_000, 150_000, 900_000]) {
    for (const attempt of [0, 1, 2, 3]) {
      const top = priorityPrice({ speed: "normal", attempt, recent: [], units: 100_000, base, jitter: 1 }).microLamports;
      const low = priorityPrice({ speed: "fast", attempt, recent: [], units: 100_000, jitter: 0 }).microLamports;
      assert.ok(top < low, `base ${base}, attempt ${attempt}: ${top} vs ${low}`);
    }
  }
});

test("prices at one speed are spread out, never below the floor, and the speeds' ranges stay apart", () => {
  const seen = new Set<number>();
  for (const speed of ["normal", "fast", "turbo"] as const) {
    let top = 0;
    for (let i = 0; i < 200; i++) {
      const p = priorityPrice({ speed, attempt: 0, recent: [], units: 300_000, base: 20_000 });
      assert.ok(p.microLamports >= SPEEDS[speed].floor && p.microLamports < SPEEDS[speed].floor * 1.35 + 1);
      assert.ok(p.lamports <= SPEEDS[speed].capLamports);
      top = Math.max(top, p.microLamports);
      seen.add(p.microLamports);
    }
    if (speed !== "turbo") assert.ok(top < SPEEDS[speed === "normal" ? "fast" : "turbo"].floor);
  }
  assert.ok(seen.size > 300, "not one fixed price per speed");
  assert.equal(priorityPrice({ speed: "normal", attempt: 0, recent: [], units: 300_000, jitter: 1 }).microLamports, 27_000);
});
