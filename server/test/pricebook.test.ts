import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { Pricebook, type PriceEntry } from "../src/pricebook.ts";

const mint = () => Keypair.generate().publicKey.toBase58();
const opts = { maxAgeMs: 60_000, lane: "background" as const, maxWaitMs: 1_000 };

test("prices: cached when fresh, 50 per call, a failed call leaves only its own mints out", async () => {
  let t = 1_700_000_000_000;
  const calls: string[][] = [];
  const dead = new Set<string>();
  const book = new Pricebook(
    async (ids) => {
      calls.push(ids);
      if (ids.some((m) => dead.has(m))) throw new Error("busy");
      return Object.fromEntries(ids.map((m, i) => [m, i === 0 ? null : { usdPrice: 2, blockId: 7 }]));
    },
    { now: () => t, timers: false },
  );
  const mints = Array.from({ length: 120 }, mint);
  dead.add(mints[60]); // the second call fails
  const got = await book.prices([...mints, "not-a-mint"], opts);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.length <= 50));
  assert.equal(got[mints[0]], null, "no price from Jupiter: null");
  assert.deepEqual(got[mints[1]], { usd: 2, at: t, blockId: 7 });
  assert.ok(!(mints[60] in got), "couldn't fetch: left out");
  assert.ok(!("not-a-mint" in got), "never sent to Jupiter");
  assert.equal(Object.keys(got).length, 70);
  t += 30_000;
  dead.clear();
  await book.prices(mints.slice(0, 50), opts);
  assert.equal(calls.length, 3, "fresh enough: no call");
  await book.prices(mints.slice(0, 50), { ...opts, maxAgeMs: 10_000 });
  assert.equal(calls.length, 4, "too old for this caller: fetched again");
  assert.equal(book.getPrice(mints[1])?.at, t);
});

test("the same mint asked for twice at once is fetched once", async () => {
  let release!: () => void;
  const gateP = new Promise<void>((r) => (release = r));
  let n = 0;
  const book = new Pricebook(async (ids) => {
    n++;
    await gateP;
    return Object.fromEntries(ids.map((m) => [m, { usdPrice: 1 }]));
  });
  const m = mint();
  const a = book.prices([m], opts);
  const b = book.prices([m], opts);
  release();
  const [x, y] = await Promise.all([a, b]);
  assert.equal(n, 1);
  assert.equal(x[m]?.usd, 1);
  assert.equal(y[m]?.usd, 1);
});

test("watched mints are polled together on the keeper lane, and subscribers hear about it", async () => {
  let t = 1_700_000_000_000;
  const calls: { ids: string[]; lane: string }[] = [];
  const book = new Pricebook(
    async (ids, o) => {
      calls.push({ ids, lane: o.lane });
      return Object.fromEntries(ids.map((m) => [m, { usdPrice: 3 }]));
    },
    { now: () => t, timers: false },
  );
  const heard: [string, PriceEntry | null][] = [];
  book.onUpdate((m, e) => heard.push([m, e]));
  const [a, b, c] = [mint(), mint(), mint()];
  book.setWatch(a, 5_000);
  book.setWatch(b, 60_000);
  book.setWatch(c, 60_000);
  await book.poll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].lane, "keeper");
  assert.equal(calls[0].ids.length, 3, "one call for all of them");
  assert.equal(heard.length, 3);
  await book.poll();
  assert.equal(calls.length, 1, "nothing due yet");
  t += 6_000;
  await book.poll();
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls[1].ids), new Set([a, b, c]), "the due mint brings the next-due ones along");
  assert.equal(book.stats().watched, 3);
  book.clearWatch(a);
  assert.equal(book.stats().watched, 2);
});

test("memory stays bounded, and watched prices are kept", async () => {
  const book = new Pricebook(async (ids) => Object.fromEntries(ids.map((m) => [m, { usdPrice: 1 }])), { maxEntries: 3, timers: false });
  const w = mint();
  book.setWatch(w, 60_000);
  await book.prices([w], opts);
  for (let i = 0; i < 10; i++) await book.prices([mint()], opts);
  assert.equal(book.stats().cached, 3);
  assert.ok(book.getPrice(w));
});

test("the keeper doesn't ride on a visitor's less patient fetch, and retries what a joined call missed", async () => {
  const calls: string[] = [];
  let failBackground = true;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const book = new Pricebook(
    async (ids, o) => {
      calls.push(o.lane);
      if (o.lane === "background") {
        await held;
        if (failBackground) throw new Error("busy");
      }
      return Object.fromEntries(ids.map((m) => [m, { usdPrice: 5 }]));
    },
    { timers: false },
  );
  const m = mint();
  const visitor = book.prices([m], opts);
  const keeper = await book.prices([m], { maxAgeMs: 5_000, lane: "keeper", maxWaitMs: 9_000 });
  assert.deepEqual(calls, ["background", "keeper"], "fetched on its own lane");
  assert.equal(keeper[m]?.usd, 5);
  release();
  await visitor;
  // a visitor joining a keeper fetch that fails asks again on its own lane
  failBackground = false;
  const n = mint();
  let fail = true;
  const book2 = new Pricebook(
    async (ids, o) => {
      calls.push("2:" + o.lane);
      if (fail) {
        fail = false;
        throw new Error("busy");
      }
      return Object.fromEntries(ids.map((x) => [x, { usdPrice: 7 }]));
    },
    { timers: false },
  );
  const k2 = book2.prices([n], { maxAgeMs: 5_000, lane: "keeper", maxWaitMs: 9_000 });
  const v2 = await book2.prices([n], opts);
  await k2;
  assert.equal(v2[n]?.usd, 7);
  assert.deepEqual(calls.slice(2), ["2:keeper", "2:background"]);
});

test("a visitor joining a slow keeper fetch waits only as long as their own patience", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  let calls = 0;
  const book = new Pricebook(
    async (ids, o) => {
      calls++;
      if (o.lane === "keeper") await slow;
      return Object.fromEntries(ids.map((m) => [m, { usdPrice: 3 }]));
    },
    { timers: false },
  );
  const m = mint();
  book.setWatch(m, 60_000);
  const poll = book.poll();
  const t0 = Date.now();
  const got = await book.prices([m], { ...opts, maxWaitMs: 150 });
  assert.ok(Date.now() - t0 < 1_000, "not held for the keeper's whole wait");
  assert.ok(!(m in got), "not fetched in time: left out");
  assert.equal(calls, 1, "the keeper's fetch isn't replaced by a less important one");
  release();
  await poll;
  assert.equal(book.getPrice(m)?.usd, 3);
});

test("the poll log stays small even when nobody asks for stats", async () => {
  let t = 1_700_000_000_000;
  const book = new Pricebook(async () => Promise.reject(new Error("busy")), { now: () => t, timers: false });
  book.setWatch(mint(), 1_000);
  for (let i = 0; i < 2_000; i++) {
    t += 500;
    await book.poll();
  }
  assert.ok((book as unknown as { polls: number[] }).polls.length <= 121);
});
