import { test } from "node:test";
import assert from "node:assert/strict";
import {
  afterFailure,
  allOfIt,
  batchCounts,
  batchFinished,
  batchSummary,
  batchTitle,
  busyError,
  gapMs,
  itemName,
  liftTo,
  nextWaiting,
  plainReason,
  onLoad,
  partMin,
  resolveRunning,
  resumeLine,
  retryFailed,
  scaleMinOut,
  setItem,
  shareOf,
  splitAmounts,
  stopRest,
  FAST_GAP,
  PART_MIN,
  type Batch,
  type BatchItem,
  type Facts,
} from "../src/lib/batch.ts";

const seq = (xs: number[]) => {
  let i = 0;
  return () => xs[i++ % xs.length];
};
const SOL = 1_000_000_000n;

const batch = (kind: Batch["kind"], items: Partial<BatchItem>[], extra: Partial<Batch> = {}): Batch => ({
  id: "b1",
  kind,
  pacing: "spaced",
  nextAt: 0,
  paused: false,
  created: 0,
  symbol: "BONK",
  mint: "Mint111",
  items: items.map((x) => ({ amount: "100000000", status: "waiting", ...x })),
  ...extra,
});

test("split: the parts add up to the total exactly", () => {
  for (const n of [2, 3, 5, 7, 10]) {
    for (const vary of [false, true]) {
      const total = 7_123_456_789n;
      const parts = splitAmounts(total, n, vary, seq([0.01, 0.99, 0.5, 0.2, 0.83, 0.37]));
      assert.equal(parts.length, n);
      assert.equal(
        parts.reduce((s, x) => s + x, 0n),
        total,
      );
    }
  }
  assert.deepEqual(splitAmounts(10n, 3, false), [3n, 3n, 4n]);
  assert.deepEqual(splitAmounts(5n, 0, true), []);
});

test("split with variation: every part within 3% of an even share, and not all alike", () => {
  const total = 5n * SOL;
  let gridded = 0;
  for (let r = 0; r < 50; r++) {
    const parts = splitAmounts(total, 5, true);
    const even = Number(total) / 5;
    for (const p of parts) assert.ok(Math.abs(Number(p) - even) / even <= 0.0301, `${p} vs ${even}`);
    // to the lamport: no shared grid (0.0001 SOL, or even 1,000 lamports) that would mark the parts as one batch
    gridded += parts.filter((p) => p % 1_000n === 0n).length;
  }
  assert.ok(gridded < 5, `${gridded} of 250 parts on a 1,000-lamport grid`);
  const parts = splitAmounts(total, 4, true, seq([0, 1, 0.25, 0.75]));
  assert.ok(new Set(parts.map(String)).size > 1);
});

test("split rounding goes to parts picked at random, not always the last", () => {
  // even weights (0.5 moves nothing), then the one lamport of rounding goes where the next draw says
  assert.deepEqual(splitAmounts(10n, 3, true, seq([0.5, 0.5, 0.5, 0])), [4n, 3n, 3n]);
  assert.deepEqual(splitAmounts(10n, 3, true, seq([0.5, 0.5, 0.5, 0.4])), [3n, 4n, 3n]);
  assert.deepEqual(splitAmounts(11n, 3, true, seq([0.5, 0.5, 0.5, 0.9, 0.1])), [4n, 3n, 4n]);
});

test("batch randomness comes from the secure source by default", () => {
  // Math.random is never called for amounts or gaps
  const real = Math.random;
  Math.random = () => {
    throw new Error("Math.random used");
  };
  try {
    splitAmounts(5n * SOL, 4, true);
    gapMs("spaced");
  } finally {
    Math.random = real;
  }
});

test("all of it keeps each wallet's reserve, in whole thousands of lamports", () => {
  assert.deepEqual(allOfIt([1_000_000_000n, 5_000_000n, 1_006_123_456n], 6_000_000n), [994_000_000n, 0n, 1_000_123_000n]);
});

test("minimums, shares, scaled minimums and gaps", () => {
  assert.equal(partMin(null, 6_000_000n), PART_MIN);
  assert.equal(partMin(17_500_000n, 6_000_000n), PART_MIN);
  assert.equal(partMin(40_000_000n, 6_000_000n), 34_000_000n);
  assert.equal(shareOf(1001n, 50), 500n);
  assert.equal(shareOf(1001n, 100), 1001n);
  assert.equal(shareOf(1000n, 25), 250n);
  assert.equal(scaleMinOut(1_000_000n, 1n * SOL, 3n * SOL), 333_333n);
  assert.equal(scaleMinOut(1_000_000n, 1n, 0n), 0n);
  assert.equal(gapMs("fast"), FAST_GAP);
  assert.equal(gapMs("spaced", () => 0), 10_000);
  assert.equal(gapMs("spaced", () => 0.999999), 60_000);
  for (let i = 0; i < 100; i++) {
    const g = gapMs("spaced");
    assert.ok(g >= 10_000 && g <= 60_000);
  }
});

test("a batch runs its wallets in order, and stopping leaves the rest untouched", () => {
  let b = batch("move", [{ index: 0 }, { index: 1 }, { index: 2 }]);
  assert.equal(nextWaiting(b), 0);
  b = setItem(b, 0, { status: "running" });
  assert.equal(nextWaiting(b), 1);
  assert.equal(batchFinished(b), false);
  b = setItem(b, 0, { status: "done", sig: "s1" });
  b = stopRest(b);
  assert.deepEqual(
    b.items.map((x) => x.status),
    ["done", "skipped", "skipped"],
  );
  assert.equal(batchFinished(b), true);
  assert.equal(b.stopped, true);
  assert.equal(batchSummary(b), "1 of 3 moved back. 2 were stopped before their turn.");
});

test("stopping keeps a running wallet running (it finishes)", () => {
  const b = stopRest(setItem(batch("send", [{ index: 0 }, { index: 1 }]), 0, { status: "running" }));
  assert.deepEqual(
    b.items.map((x) => x.status),
    ["running", "skipped"],
  );
  assert.equal(batchFinished(b), false);
});

test("try those again: failed and stopped wallets get another turn at today's price", () => {
  let b = batch("buyFrom", [
    { index: 0, status: "done" },
    { index: 1, status: "failed", error: "no route", minOut: "5", tries: 2 },
    { index: 2, status: "skipped" },
  ]);
  b = { ...b, stopped: true };
  const r = retryFailed(b, 1234);
  assert.equal(r.nextAt, 1234);
  assert.equal(r.stopped, false);
  assert.deepEqual(
    r.items.map((x) => x.status),
    ["done", "waiting", "waiting"],
  );
  assert.equal(r.items[1].error, undefined);
  assert.equal(r.items[1].minOut, undefined);
  assert.equal(r.items[1].tries, undefined);
});

test("a spaced-out wallet that made its joins at a turn of their own: a try again spaces its joins out again", () => {
  const b = batch("buyNew", [
    { status: "done", joined: true },
    { status: "failed", error: "no route", joined: true },
  ]);
  const r = retryFailed(b, 1);
  assert.equal(r.items[0].joined, true, "a finished wallet is left as it is");
  assert.equal(r.items[1].status, "waiting");
  assert.equal(r.items[1].joined, undefined);
  // a busy server's second try is the same payment turn: its joins are already made
  const again = afterFailure(b, { amount: "1", status: "running", joined: true }, "Too many requests", false);
  assert.equal(again.again, true);
  assert.equal(again.item.joined, true);
});

test("a reloaded batch waits for Continue; a finished one doesn't", () => {
  assert.equal(onLoad(batch("move", [{ index: 0 }])).paused, true);
  assert.equal(onLoad(batch("move", [{ index: 0, status: "done" }], { paused: true })).paused, false);
});

const facts = (f: Partial<Facts>): Facts => ({ intent: false, held: 0n, lamports: 0n, sweepMin: 15_000_000n, waiting: false, ...f });

test("reload: a buy into a new wallet is never paid twice", () => {
  const b = batch("buyNew", []);
  const run = (x: Partial<BatchItem>) => ({ amount: "1", status: "running" as const, ...x });
  // no wallet taken yet: nothing was paid
  assert.equal(resolveRunning(b, run({}), null).status, "waiting");
  // its SOL arrived and a buy waits there: it finishes there, no second pool fee
  const fin = resolveRunning(b, run({ index: 4 }), facts({ intent: true, lamports: 50_000_000n }));
  assert.equal(fin.status, "waiting");
  assert.equal(fin.finish, true);
  // the tokens arrived: done
  const got = resolveRunning(b, run({ index: 4 }), facts({ held: 777n }));
  assert.equal(got.status, "done");
  assert.equal(got.got, "777");
  // no buy waiting and nothing there: the payment never went out, so it simply runs again
  assert.equal(resolveRunning(b, run({ index: 4 }), facts({})).status, "waiting");
  // SOL there but no buy waiting: never paid again, said instead
  const odd = resolveRunning(b, run({ index: 4 }), facts({ lamports: 9n }));
  assert.equal(odd.status, "failed");
  assert.match(odd.error!, /Vision wallet #5/);
  // the chain couldn't be read: left as it is, looked at again
  assert.equal(resolveRunning(b, run({ index: 4 }), null).status, "running");
  // after "Stop the rest", an unstarted one is stopped, not run
  assert.equal(resolveRunning({ ...b, stopped: true }, run({ index: 4 }), facts({})).status, "skipped");
});

test("reload: buys from wallets, sales, moves and sends", () => {
  const run = (x: Partial<BatchItem>): BatchItem => ({ amount: "1", status: "running", index: 2, ...x });
  const bf = batch("buyFrom", []);
  assert.equal(resolveRunning(bf, run({}), facts({ held: 5n })).status, "done");
  assert.equal(resolveRunning(bf, run({}), facts({ intent: true, lamports: SOL })).finish, true);
  assert.equal(resolveRunning(bf, run({}), facts({ lamports: SOL })).status, "waiting");
  const s = batch("sell", []);
  assert.equal(resolveRunning(s, run({ before: "100" }), facts({ held: 40n })).status, "done");
  assert.equal(resolveRunning(s, run({ before: "100" }), facts({ held: 100n })).status, "waiting");
  const m = batch("move", []);
  assert.equal(resolveRunning(m, run({}), facts({ waiting: true, lamports: SOL })).status, "done");
  assert.equal(resolveRunning(m, run({}), facts({ lamports: 1_000n })).status, "done");
  assert.equal(resolveRunning(m, run({}), facts({ lamports: SOL })).status, "waiting");
  const sd = batch("send", []);
  assert.equal(resolveRunning(sd, run({}), facts({ lamports: 0n })).status, "done");
  assert.equal(resolveRunning(sd, run({}), facts({ lamports: SOL })).status, "waiting");
  // not running: unchanged
  const done: BatchItem = { amount: "1", status: "done" };
  assert.equal(resolveRunning(m, done, facts({})), done);
});

test("after a failure: a busy server gets another turn, a funded buy is marked to finish", () => {
  const b = batch("buyNew", []);
  const x: BatchItem = { amount: "1", status: "running", index: 3 };
  const busy = afterFailure(b, x, "Too many requests. Try again in a moment.", false);
  assert.equal(busy.again, true);
  assert.equal(busy.item.status, "waiting");
  assert.equal(busy.item.tries, 1);
  // twice at most
  assert.equal(afterFailure(b, { ...x, tries: 2 }, "Too many requests.", false).item.status, "failed");
  // a funded buy is never retried by itself
  const fin = afterFailure(b, x, "Jupiter is busy", true);
  assert.equal(fin.again, false);
  assert.equal(fin.item.status, "failed");
  assert.equal(fin.item.finish, true);
  const plain = afterFailure(b, x, "No route for this token.", false);
  assert.equal(plain.item.status, "failed");
  assert.equal(plain.item.error, "No route for this token.");
  assert.equal(plain.item.finish, false);
  assert.equal(busyError("No route found"), false);
  assert.equal(busyError("Request failed (429)"), true);
  assert.equal(busyError("Jupiter is busy right now. Try again in a few seconds."), true);
  // an ordinary refusal that happens to say "try again" is not a busy server (a re-run could spend again)
  assert.equal(busyError("Vision wallet #2 still lacks about 0.002 SOL for this route's fees. Try again in a moment, or with a smaller amount."), false);
  assert.equal(busyError("The pool can't be reached right now. Try again in a moment."), false);
});

test("in words", () => {
  const b = batch("buyNew", [{ status: "done", index: 4 }, { status: "running" }, { status: "waiting" }]);
  assert.equal(batchTitle(b), "Buying BONK · 1 of 3 done");
  assert.equal(resumeLine(b), "Buying BONK in 3 wallets · 1 done");
  assert.equal(itemName(b.items[0]), "Vision wallet #5");
  assert.equal(itemName(b.items[2]), "New wallet");
  assert.deepEqual(batchCounts(b), { done: 1, failed: 0, skipped: 0, waiting: 1, running: 1, total: 3 });
  assert.equal(batchTitle(batch("move", [{}])), "Moving back to your private balance · 0 of 1 done");
});

test("the summary at the end", () => {
  const f = (kind: Batch["kind"], st: Partial<BatchItem>[]) => batchSummary(batch(kind, st));
  const d = { status: "done" as const };
  const x = { status: "failed" as const, error: "no route" };
  assert.equal(f("buyFrom", [d, d, d, d, d, x, x]), "5 of 7 bought. 2 didn't go through; their SOL is safe in their wallets.");
  assert.equal(f("buyFrom", [d, x]), "1 of 2 bought. 1 didn't go through; its SOL is safe in its wallet.");
  assert.equal(f("buyNew", [d, x, x]), "1 of 3 bought. 2 didn't go through; nothing was spent for them.");
  assert.equal(f("buyNew", [d, { ...x, finish: true }, x]), "1 of 3 bought. 2 didn't go through; nothing was spent for 1, and 1 keeps its SOL in its new wallet.");
  assert.equal(f("buyNew", [{ ...x, finish: true }, { ...x, finish: true }]), "0 of 2 bought. 2 didn't go through; their SOL is safe in their new wallets.");
  assert.equal(f("sell", [d, d, d]), "All 3 sold.");
  assert.equal(f("send", [d, d]), "Both sent.");
  assert.equal(f("sell", [d, x]), "1 of 2 sold. 1 didn't go through; its tokens are still in its wallet.");
  assert.equal(f("move", [x, x, { status: "skipped" }]), "0 of 3 moved back. 2 didn't go through; what didn't move is still in their wallets. 1 was stopped before its turn.");
  assert.equal(f("send", [d, x]), "1 of 2 sent. 1 didn't go through; nothing was sent from it.");
});

test("vary never takes a part below the least, and the total stays the same", () => {
  const least = 20_000_000n;
  for (const r of [0, 0.01, 0.5, 0.99]) {
    const parts = splitAmounts(200_000_000n, 10, true, seq([r, 1 - r, 0.3, 0.7]), least);
    assert.equal(
      parts.reduce((s, x) => s + x, 0n),
      200_000_000n,
    );
    assert.ok(parts.every((x) => x >= least));
  }
  // a total too small for n parts is left as it is (the form says so)
  assert.deepEqual(liftTo([10n, 5n], 8n), [10n, 5n]);
  assert.deepEqual(liftTo([12n, 5n, 13n], 8n), [12n, 8n, 10n]);
  assert.deepEqual(liftTo([9n, 9n], 8n), [9n, 9n]);
});

test("a failed wallet's reason, in plain words", () => {
  assert.equal(
    plainReason("The swap didn't go through: failed to get token accounts owned by account CYwD…: Invalid param: could not find mint Your 0.2994 SOL is safe in Vision wallet #1: use \"Finish the buy\" there."),
    "no market for this token right now",
  );
  assert.equal(plainReason("Didn't go through: There's nothing to send from this Vision wallet."), "there's nothing to send from this Vision wallet");
  assert.equal(plainReason("Vision wallet #3 can spend at most 0.1 SOL: it keeps 0.006 SOL for its fees."), "Vision wallet #3 can spend at most 0.1 SOL: it keeps 0.006 SOL for its fees");
  assert.equal(plainReason("Too many requests from your network. Try again in 1 minute."), "the service was busy just then");
  assert.equal(plainReason("The price has moved past your price tolerance since the quote. Nothing was spent."), "the price moved past your price tolerance");
  assert.equal(plainReason(""), "no reason given");
});
