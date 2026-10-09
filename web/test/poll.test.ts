import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, gapScan, paced, syncDelay, Rotation, planMoves, afterMove, dueMove, shuffle, randInt, range, leavesHold } from "../src/lib/poll.ts";

test("chunk keeps every key and never exceeds the size", () => {
  const keys = range(250);
  const parts = chunk(keys, 100);
  assert.deepEqual(
    parts.map((p) => p.length),
    [100, 100, 50],
  );
  assert.deepEqual(parts.flat(), keys);
  assert.deepEqual(chunk([], 100), []);
});

test("randInt stays in range and shuffle keeps the items", () => {
  for (let i = 0; i < 500; i++) {
    const x = randInt(3, 7);
    assert.ok(x >= 3 && x <= 7);
  }
  assert.equal(randInt(5, 5), 5);
  const s = shuffle(range(50));
  assert.deepEqual([...s].sort((a, b) => a - b), range(50));
});

test("paced runs everything, no more than the limit at once, in order of results", async () => {
  let live = 0;
  let peak = 0;
  const out = await paced(range(12), 3, async (i) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 2));
    live--;
    return i * 2;
  });
  assert.deepEqual(out, range(12).map((i) => i * 2));
  assert.ok(peak <= 3);
});

test("gapScan finds used addresses past gaps shorter than the limit", async () => {
  const used = new Set([0, 1, 2, 5, 9, 17]);
  const asked: number[] = [];
  const r = await gapScan(0, async (i) => (asked.push(i), used.has(i)), 10, 3);
  assert.deepEqual(r.found, [0, 1, 2, 5, 9, 17]);
  assert.equal(r.next, 18);
  // it stops after ten unused in a row past the last one
  assert.equal(Math.max(...asked), 27);
});

test("gapScan stops at a gap as long as the limit, and starts from the hint", async () => {
  const used = new Set([3, 4, 20]);
  const r = await gapScan(3, async (i) => used.has(i), 10, 4);
  assert.deepEqual(r.found, [3, 4]);
  assert.equal(r.next, 5);
  const none = await gapScan(7, async () => false, 5, 3);
  assert.deepEqual(none, { next: 7, found: [] });
});

test("gapScan passes errors on (the scan is retried later, never half-trusted)", async () => {
  await assert.rejects(gapScan(0, async (i) => {
    if (i === 4) throw new Error("rpc down");
    return true;
  }));
});

test("syncDelay backs off when idle and stays quick while lively", () => {
  for (let k = 0; k < 50; k++) {
    const quick = syncDelay(0, false);
    assert.ok(quick >= 7650 && quick <= 10_350);
    const idle = syncDelay(20, false);
    assert.ok(idle >= 51_000 && idle <= 69_000);
    const lively = syncDelay(20, true);
    assert.ok(lively <= 10_350);
  }
  assert.ok(syncDelay(3, false) > 20_000);
});

test("Rotation hands out one item per turn, every item once per pass, and waits between turns", () => {
  const rot = new Rotation([1000, 2000]);
  const all = range(4);
  const seen: number[] = [];
  let now = 0;
  for (let turn = 0; turn < 4; turn++) {
    const i = rot.take(now, all);
    assert.ok(i != null);
    seen.push(i);
    assert.equal(rot.take(now + 500, all), null); // not yet
    now += 2001;
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), all);
  rot.soon();
  assert.ok(rot.take(now, all) != null);
  assert.equal(rot.take(now + 99_999, []), null);
  rot.clear();
  assert.ok(rot.take(now, all) != null);
});

test("planMoves spaces several payments apart and moves a lone one at once", () => {
  const gap: [number, number] = [20_000, 150_000];
  const now = 1_000_000;
  const lone = planMoves(now, [4], {}, 0, gap);
  assert.deepEqual(lone, { 4: now });

  const many = planMoves(now, [1, 2, 3, 4], {}, 0, gap);
  const times = Object.values(many).sort((a, b) => a - b);
  assert.equal(times.length, 4);
  assert.equal(times[0], now);
  for (let k = 1; k < times.length; k++) {
    assert.ok(times[k] - times[k - 1] >= gap[0] && times[k] - times[k - 1] <= gap[1]);
  }
  // only one is due now
  assert.equal(Object.values(many).filter((t) => t <= now).length, 1);

  // a payment arriving soon after a move waits its turn
  const later = planMoves(now, [7], {}, now - 5_000, gap);
  assert.ok(later[7] >= now - 5_000 + gap[0]);

  // addresses no longer ready drop off the plan; planned times are kept
  const kept = planMoves(now + 1, [2, 3], many, 0, gap);
  assert.deepEqual(kept, { 2: many[2], 3: many[3] });

  // the one being watched goes now
  const watched = planMoves(now, [8, 9], {}, now - 1000, gap, 9);
  assert.equal(watched[9], now);
});

test("afterMove and dueMove never let two moves go back to back", () => {
  const gap: [number, number] = [20_000, 150_000];
  const now = 5_000_000;
  const plan = { 1: now - 10, 2: now - 5, 3: now + 1_000 };
  const first = dueMove(now, plan, 0, gap[0]);
  assert.equal(first, 1);
  const rest = afterMove(now, plan, 1, gap);
  assert.equal(rest[1], undefined);
  const times = Object.values(rest).sort((a, b) => a - b);
  assert.ok(times[0] >= now + gap[0]);
  assert.ok(times[1] - times[0] >= gap[0]);
  assert.equal(dueMove(now, rest, now, gap[0]), null);
  assert.equal(dueMove(now + 1000, { 5: now }, now, gap[0]), null); // too soon after the last move
  assert.equal(dueMove(now + gap[0], { 5: now }, now, gap[0]), 5);
});

test("a spend's own new notes are looked for, not just any new leaves", () => {
  const REC = 60;
  const leaf = (n: number) => n.toString(16).padStart(64, "0");
  const pool = (ns: number[]) => {
    const b = new Uint8Array(ns.length * REC);
    ns.forEach((n, i) => b.set(Buffer.from(leaf(n), "hex"), i * REC));
    return b;
  };
  // someone else's payment added two leaves first: ours (7 and 8) aren't there yet
  const before = pool([1, 2, 3, 4, 5]);
  assert.equal(leavesHold(before, 5, REC, [leaf(7), leaf(8)], 2), false);
  const after = pool([1, 2, 3, 4, 5, 7, 8]);
  assert.equal(leavesHold(after, 7, REC, [leaf(7), leaf(8)], 2), true);
  assert.equal(leavesHold(after, 7, REC, [leaf(7).toUpperCase(), leaf(8)], 2), true, "hex in either case");
  assert.equal(leavesHold(after, 6, REC, [leaf(7), leaf(8)], 2), false, "both notes, not one");
  assert.equal(leavesHold(after, 7, REC, [leaf(2)], 3), false, "only leaves from `from` on are read");
  assert.equal(leavesHold(after, 7, REC, [], 0), true);
});
