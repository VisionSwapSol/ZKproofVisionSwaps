import { test } from "node:test";
import assert from "node:assert/strict";
import { JupiterLimiter, type Lane } from "../src/jupiter.ts";

const clock = () => {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const headers = (h: Record<string, string>) => ({ get: (k: string) => h[k] ?? null });

/** Starts a turn and records when it is granted (or refused). */
function track(l: JupiterLimiter, order: string[], lane: Lane, o: { maxWaitMs: number; ip?: string; retry?: boolean }, name: string = lane) {
  const p = l.turn(lane, o).then(
    () => void order.push(name),
    () => void order.push(`${name}:busy`),
  );
  return p;
}

const settle = () => new Promise((r) => setImmediate(r));

test("a lane under its share goes ahead of a lane over it, and spare room is lent", async () => {
  const c = clock();
  // 10/min -> 9 usable, at most 2 per 10 seconds
  const l = new JupiterLimiter({ rpm: 10, rpmMax: 10, now: c.now, timers: false });
  const order: string[] = [];
  // exec spends its share (40% of 9 = 3.6)
  for (let i = 0; i < 2; i++) await track(l, order, "exec", { maxWaitMs: 60_000 }, "e" + i);
  c.advance(10_001);
  for (let i = 2; i < 4; i++) await track(l, order, "exec", { maxWaitMs: 60_000 }, "e" + i);
  assert.deepEqual(order, ["e0", "e1", "e2", "e3"]);
  // the burst window is full now: queue one of each
  const waits = [
    track(l, order, "background", { maxWaitMs: 60_000 }),
    track(l, order, "exec", { maxWaitMs: 60_000 }),
    track(l, order, "keeper", { maxWaitMs: 60_000 }),
    track(l, order, "interactive", { maxWaitMs: 60_000, ip: "a" }),
  ];
  await settle();
  assert.equal(order.length, 4, "nothing goes while the window is full");
  c.advance(10_001);
  l.pump();
  await settle();
  // exec is over its share: interactive and keeper (under theirs) go first
  assert.deepEqual(order.slice(4), ["interactive", "keeper"]);
  c.advance(10_001);
  l.pump();
  await settle();
  // background (5% of 9 rounds to under one call) is under its share once, then exec borrows
  assert.deepEqual(order.slice(6), ["background", "exec"]);
  await Promise.all(waits);
});

test("one visitor can't fill the queue, and calls that can't make their deadline are refused", async () => {
  const c = clock();
  const l = new JupiterLimiter({ rpm: 10, rpmMax: 10, now: c.now, timers: false });
  const order: string[] = [];
  await track(l, order, "exec", { maxWaitMs: 1 }, "x1");
  await track(l, order, "exec", { maxWaitMs: 1 }, "x2");
  const a = [1, 2, 3].map((i) => track(l, order, "interactive", { maxWaitMs: 20_000, ip: "same" }, "a" + i));
  await settle();
  assert.ok(order.includes("a3:busy"), "a third waiting call from one visitor is refused at once");
  // the server's own calls have no per-visitor cap
  const k = track(l, order, "keeper", { maxWaitMs: 1_000 }, "k");
  c.advance(1_500);
  l.pump();
  await settle();
  assert.ok(order.includes("k:busy"), "past its deadline a waiting call gives up");
  c.advance(10_000);
  l.pump();
  await Promise.all([...a, k]);
  assert.ok(order.includes("a1") && order.includes("a2"));
  assert.equal(l.stats().lanes.interactive.queued, 0);
});

test("learns a bigger plan from Jupiter's headers, and backs off after a 429", () => {
  const c = clock();
  const l = new JupiterLimiter({ rpm: 60, rpmMax: 600, now: c.now, timers: false });
  const resetIn10 = String(Math.floor((c.now() + 10_000) / 1000));
  // one call in a 10-second window with 99 left: a 100 per 10 s (600/min) plan
  l.observe(headers({ "x-ratelimit-current": "1", "x-ratelimit-remaining": "99", "x-ratelimit-reset": resetIn10 }), 200);
  assert.equal(l.capacity(), 600);
  l.observe(headers({ "x-ratelimit-current": "100", "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn10 }), 429);
  const s = l.stats();
  assert.ok(s.pausedForMs > 0 && s.pausedForMs <= 10_000);
  assert.equal(s.rateLimited5m, 1);
  assert.ok(l.capacity() < 600, "slows down for a while after a 429");
  c.advance(16 * 60_000);
  assert.equal(l.capacity(), 60, "learned and penalty both expire");
});

test("never more than the usable rate in any minute", async () => {
  const c = clock();
  const l = new JupiterLimiter({ rpm: 30, rpmMax: 30, now: c.now, timers: false });
  const granted: number[] = [];
  const all: Promise<void>[] = [];
  for (let i = 0; i < 80; i++) all.push(l.turn("exec", { maxWaitMs: 1e9 }).then(() => void granted.push(c.now())));
  await settle();
  for (let t = 0; t < 400; t++) {
    c.advance(1_000);
    l.pump();
    await settle();
  }
  await Promise.all(all);
  for (const t0 of granted) assert.ok(granted.filter((t) => t >= t0 && t < t0 + 60_000).length <= 27);
});

test("the keeper is let in while swap builds are queued past their share: it goes next", async () => {
  const c = clock();
  // 60/min -> 54 usable, 9 per 10 seconds; exec's share is 21.6
  const l = new JupiterLimiter({ rpm: 60, rpmMax: 60, now: c.now, timers: false });
  const order: string[] = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 9; i++) await track(l, order, "exec", { maxWaitMs: 1 }, "e");
    c.advance(10_001);
  }
  c.advance(-7_001); // the next free turn is 7 s away
  const builds = Array.from({ length: 10 }, (_, i) => track(l, order, "exec", { maxWaitMs: 1e9 }, "b" + i));
  const k = track(l, order, "keeper", { maxWaitMs: 9_000 }, "k");
  await settle();
  assert.ok(!order.includes("k:busy"), "admitted: exec is over its share, so its queue isn't ahead");
  c.advance(7_001);
  l.pump();
  await settle();
  assert.equal(order[27], "k", "served before the waiting builds");
  // a lane over its share still waits behind a long higher-priority queue
  const bg = await l.turn("background", { maxWaitMs: 1_000 }).then(
    () => "ok",
    () => "busy",
  );
  assert.equal(bg, "busy");
  c.advance(120_000);
  l.pump();
  await Promise.all([...builds, k]);
});

test("a visitor's own cap applies only when others are waiting, and says when to come back", async () => {
  const c = clock();
  const l = new JupiterLimiter({ rpm: 60, rpmMax: 60, now: c.now, timers: false });
  assert.equal(l.perIpMax(), 8);
  // a quiet site: nine quick calls from one visitor all go
  for (let i = 0; i < 9; i++) await l.turn("interactive", { maxWaitMs: 5_000, ip: "a" });
  // the 10-second window is full and someone else is waiting now
  const b = l.turn("interactive", { maxWaitMs: 60_000, ip: "b" });
  c.advance(30_000);
  const err = await l.turn("interactive", { maxWaitMs: 20_000, ip: "a" }).then(
    () => null,
    (e: Error & { status?: number; retryAfter?: number }) => e,
  );
  assert.ok(err && err.status === 429 && /quickly/.test(err.message));
  assert.equal(err.retryAfter, 30, "when the visitor's oldest call leaves the minute");
  l.pump();
  await b;
});

test("in exec the keeper's trades go before visitors' builds, and one visitor can't queue many", async () => {
  const c = clock();
  // 10/min -> 9 usable, 2 per 10 seconds
  const l = new JupiterLimiter({ rpm: 10, rpmMax: 10, now: c.now, timers: false });
  const order: string[] = [];
  await track(l, order, "exec", { maxWaitMs: 1 }, "x1");
  await track(l, order, "exec", { maxWaitMs: 1 }, "x2");
  // the burst window is full: a visitor queues builds, then a keeper trade arrives
  const v = [1, 2, 3].map((i) => track(l, order, "exec", { maxWaitMs: 120_000, ip: "v" }, "v" + i));
  const w = track(l, order, "exec", { maxWaitMs: 120_000, ip: "w" }, "w1");
  await settle();
  assert.ok(order.includes("v3:busy"), "a third waiting build from one visitor is refused");
  const k = track(l, order, "exec", { maxWaitMs: 15_000 }, "k");
  await settle();
  assert.ok(!order.includes("k:busy"), "the keeper's wait only counts keeper trades ahead of it");
  c.advance(10_001);
  l.pump();
  await settle();
  assert.deepEqual(order.slice(3, 5), ["k", "v1"], "the keeper's trade first, then the builds in order");
  c.advance(60_000);
  l.pump();
  await Promise.all([...v, w, k]);
});

test("a visitor's waiting price refreshes and quotes don't stop their own swap build", async () => {
  const c = clock();
  const l = new JupiterLimiter({ rpm: 10, rpmMax: 10, now: c.now, timers: false });
  const order: string[] = [];
  await track(l, order, "exec", { maxWaitMs: 1 }, "x1");
  await track(l, order, "exec", { maxWaitMs: 1 }, "x2");
  // the burst window is full: one tab has a price refresh and a quote waiting
  const b = track(l, order, "background", { maxWaitMs: 120_000, ip: "v" }, "b");
  const q = track(l, order, "interactive", { maxWaitMs: 120_000, ip: "v" }, "q");
  const s = track(l, order, "exec", { maxWaitMs: 120_000, ip: "v" }, "s");
  await settle();
  assert.ok(!order.includes("s:busy"), "the build waits its turn instead of being refused");
  for (let i = 0; i < 6; i++) {
    c.advance(10_001);
    l.pump();
  }
  await Promise.all([b, q, s]);
  assert.ok(order.includes("s"));
});

test("a burst of 429s from one full window cuts the allowance once, and it comes back a step at a time", () => {
  const c = clock();
  const l = new JupiterLimiter({ rpm: 60, rpmMax: 600, now: c.now, timers: false });
  for (let i = 0; i < 5; i++) l.observe(headers({}), 429);
  assert.equal(l.capacity(), 42, "one cut (to 70%), not five");
  c.advance(11_000);
  l.observe(headers({}), 429);
  assert.equal(l.capacity(), 29, "a later window's 429 cuts again");
  for (let i = 0; i < 10; i++) {
    c.advance(11_000);
    l.observe(headers({}), 429);
  }
  assert.equal(l.capacity(), 15, "never below a quarter of the plan");
  c.advance(60_000);
  assert.equal(l.capacity(), 21, "a tenth of the plan back each minute");
  c.advance(6 * 60_000);
  assert.equal(l.capacity(), 57);
  c.advance(60_000);
  assert.equal(l.capacity(), 60, "and then all of it");
  assert.equal(l.baseCapacity(), 60);
  assert.equal(l.stats().rateLimited5m, 0, "old 429s leave the count without anyone asking for stats");
});

test("a visitor's retry keeps its place as a visitor's call: the keeper still goes first, and only the visitor's own caps let it through", async () => {
  const c = clock();
  const l = new JupiterLimiter({ rpm: 10, rpmMax: 10, now: c.now, timers: false });
  const order: string[] = [];
  // the window is full
  for (let i = 0; i < 2; i++) await track(l, order, "exec", { maxWaitMs: 1 }, "e" + i);
  const waiting = [
    track(l, order, "exec", { maxWaitMs: 1e9, ip: "v" }, "v1"),
    track(l, order, "exec", { maxWaitMs: 1e9, ip: "w" }, "w1"),
    track(l, order, "exec", { maxWaitMs: 1e9, ip: "z" }, "z1"),
    track(l, order, "exec", { maxWaitMs: 1e9, ip: "z" }, "z2"),
    // z already has two waiting: a new call of theirs is refused, a retry of one they had a turn for isn't
    track(l, order, "exec", { maxWaitMs: 1e9, ip: "z" }, "z3"),
    track(l, order, "exec", { maxWaitMs: 1e9, ip: "z", retry: true }, "zr"),
    track(l, order, "exec", { maxWaitMs: 1e9 }, "keeper"),
  ];
  await settle();
  assert.deepEqual(order.slice(2), ["z3:busy"]);
  for (let i = 0; i < 40 && order.length < 9; i++) {
    c.advance(10_001);
    l.pump();
    await settle();
  }
  await Promise.all(waiting);
  assert.equal(order[3], "keeper", "the server's own trade goes ahead of every visitor's call, retries included");
  assert.ok(order.indexOf("zr") > order.indexOf("v1"), "a retry waits behind the visitors queued before it");
});
