import { test } from "node:test";
import assert from "node:assert/strict";
import { drawRootLag, heldRootSize, isMature, matureNotes, secureInt, ROOT_LAG_MAX, ROOT_HISTORY } from "../src/rootpolicy.ts";

/** A deterministic stand-in for the secure source (xorshift32), so a test can replay draws exactly. */
function seeded(seed: number) {
  let x = seed >>> 0 || 1;
  return (buf: Uint32Array) => {
    for (let i = 0; i < buf.length; i++) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      buf[i] = x;
    }
    return buf;
  };
}

/** Pearson's chi-square of `counts` against a uniform spread. */
function chiSquare(counts: number[]): number {
  const n = counts.reduce((s, c) => s + c, 0);
  const e = n / counts.length;
  return counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
}

test("secureInt covers 0..max, both ends included, and throws away the draws that would bias it", () => {
  for (const max of [0, 1, 2, 5, 32, 255]) {
    const seen = new Set<number>();
    for (let i = 0; i < 4000; i++) {
      const v = secureInt(max);
      assert.ok(Number.isInteger(v) && v >= 0 && v <= max, `${v} in 0..${max}`);
      seen.add(v);
    }
    if (max <= 32) assert.equal(seen.size, max + 1, `every value of 0..${max} shows up`);
  }
  // a draw in the biased tail (at or above the largest multiple of the span) is never used: the next one is
  const span = 3;
  const limit = Math.floor(0x1_0000_0000 / span) * span;
  const draws = [0xffff_ffff, limit, 7];
  let k = 0;
  assert.equal(
    secureInt(span - 1, (b) => {
      b[0] = draws[k++];
      return b;
    }),
    7 % span,
  );
  assert.equal(k, 3);
  assert.throws(() => secureInt(-1));
  assert.throws(() => secureInt(1.5));
});

test("lags are spread evenly over 0..ROOT_LAG_MAX (chi-square, secure source)", () => {
  const counts = new Array(ROOT_LAG_MAX + 1).fill(0);
  const n = (ROOT_LAG_MAX + 1) * 1000;
  for (let i = 0; i < n; i++) counts[drawRootLag()]++;
  // 32 degrees of freedom: 80 is far past the 1-in-100,000 point, so this never fails by chance in practice
  assert.ok(chiSquare(counts) < 80, `chi-square ${chiSquare(counts).toFixed(1)}`);
  // the root it names is always one the program still holds, with room to spare for a scheduled wait
  assert.ok(ROOT_LAG_MAX < ROOT_HISTORY / 4);
});

test("a held proof's root doesn't depend on which mature notes it spends", () => {
  const size = 5000;
  const rand = seeded(42);
  for (let t = 0; t < 2000; t++) {
    const lag = drawRootLag(rand);
    // any two sets of notes that are mature name exactly the same root for the same draw
    const a = [{ index: 0 }];
    const b = [{ index: size - 1 - ROOT_LAG_MAX }];
    const c = [{ index: 17 }, { index: size - 1 - ROOT_LAG_MAX - (t % 50) }];
    const ra = heldRootSize(size, a, lag);
    assert.deepEqual(heldRootSize(size, b, lag), ra);
    assert.deepEqual(heldRootSize(size, c, lag), ra);
    assert.deepEqual(ra, { size: size - lag });
  }
});

test("notes that aren't mature wait for the pool to move on; it never falls back to the newest root", () => {
  // the newest leaf is index 999 in a tree of 1000: it needs ROOT_LAG_MAX more leaves, whatever the lag
  for (let lag = 0; lag <= ROOT_LAG_MAX; lag++) {
    assert.deepEqual(heldRootSize(1000, [{ index: 999 }], lag), { wait: ROOT_LAG_MAX });
    assert.deepEqual(heldRootSize(1000, [{ index: 10 }, { index: 990 }], lag), { wait: ROOT_LAG_MAX - 9 });
  }
  // once mature, every lag covers the notes: the root never comes before the newest note
  for (let lag = 0; lag <= ROOT_LAG_MAX; lag++) {
    const r = heldRootSize(1000 + ROOT_LAG_MAX, [{ index: 999 }], lag);
    assert.ok("size" in r && r.size >= 1000, `lag ${lag}`);
  }
  assert.throws(() => heldRootSize(1000, [], 0));
  assert.throws(() => heldRootSize(1000, [{ index: 1 }], ROOT_LAG_MAX + 1));
  assert.throws(() => heldRootSize(1000, [{ index: 1 }], -1));
});

test("statistically, the named root tells nothing about where the newest note sits", () => {
  // proofs made the moment their notes turn mature (the most telling case): the gap between the
  // root and the newest note is the lag's complement, so it is uniform too, and the same for notes
  // that arrived early or late in the tree
  const rand = seeded(7);
  const gaps: Record<string, number[]> = { early: new Array(ROOT_LAG_MAX + 1).fill(0), late: new Array(ROOT_LAG_MAX + 1).fill(0) };
  const n = (ROOT_LAG_MAX + 1) * 600;
  for (let i = 0; i < n; i++) {
    const which = i % 2 ? "early" : "late";
    const newest = which === "early" ? 100 + (i % 7) : 90_000 + (i % 13);
    const size = newest + 1 + ROOT_LAG_MAX;
    const r = heldRootSize(size, [{ index: newest }], drawRootLag(rand));
    assert.ok("size" in r);
    gaps[which][r.size - (newest + 1)]++;
  }
  for (const k of ["early", "late"]) assert.ok(chiSquare(gaps[k]) < 80, `${k}: chi-square ${chiSquare(gaps[k]).toFixed(1)}`);
  // and over notes of every age, the lag (tip minus root) is uncorrelated with the newest note's age
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const size = 50_000;
    const age = ROOT_LAG_MAX + (i % 400);
    const r = heldRootSize(size, [{ index: size - 1 - age }], drawRootLag(rand));
    assert.ok("size" in r);
    xs.push(age);
    ys.push(size - r.size);
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const corr = sxy / Math.sqrt(sxx * syy);
  assert.ok(Math.abs(corr) < 0.03, `correlation ${corr.toFixed(4)}`);
});

test("matureNotes keeps only notes every lag covers", () => {
  const notes = [{ index: 0 }, { index: 60 }, { index: 67 }, { index: 68 }, { index: 99 }];
  assert.deepEqual(
    matureNotes(notes, 100).map((n) => n.index),
    [0, 60, 67],
  );
  assert.equal(isMature(67, 100), true);
  assert.equal(isMature(68, 100), false);
});
