import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { rootAge, pickRuns, cancel, statuses, schedule, startScheduler, stopScheduler, testHooks, jobStatusRoutes } from "../src/schedule.ts";
import { claimNotes, releaseNotes, notesInFlight, cleanRequest, ringReader, sendBudget, type Ring } from "../src/relayer.ts";
import { PoolStore } from "../src/store.ts";
import { hops } from "../src/hops.ts";
import { MerkleTree, type PoolEvent } from "@visionswap/sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// these tests call the scheduler directly, without starting it: count it as loaded even when .env names a relayer
testHooks.loaded(true);

const hex = (n: bigint) => n.toString(16).padStart(64, "0");
/** A ring whose newest root is `newest` and holds roots 1..newest, the way the program fills it. */
function ring(newest: number) {
  const roots = new Array<bigint>(256).fill(0n);
  for (let r = Math.max(1, newest - 255); r <= newest; r++) roots[r % 256] = BigInt(r);
  return { roots, rootIndex: newest % 256, nextIndex: newest };
}

test("a root's age counts the roots added since, across the ring's wrap", () => {
  const r = ring(300);
  assert.equal(rootAge(r, hex(300n)), 0);
  assert.equal(rootAge(r, hex(299n)), 1);
  assert.equal(rootAge(r, hex(256n)), 44);
  assert.equal(rootAge(r, hex(45n)), 255);
  assert.equal(rootAge(r, hex(44n)), null, "pushed out of the ring");
  assert.equal(rootAge(r, hex(9999n)), null);
});

test("only due jobs go while their roots are young", () => {
  const now = 1_000_000;
  const p = pickRuns(
    [
      { id: "a", due: now - 1, age: 10 },
      { id: "b", due: now + 60_000, age: 10 },
      { id: "c", due: now - 5, age: 20 },
    ],
    now,
    0,
    3,
  );
  assert.deepEqual(p.send, ["c", "a"], "due ones, oldest root first");
  assert.deepEqual(p.early, []);
  assert.deepEqual(p.stale, []);
});

test("a job near the end of the ring goes early, inside its window", () => {
  const now = 1_000_000;
  const p = pickRuns([{ id: "x", due: now + 3_600_000, age: 256 - 48 }], now, 0, 3);
  assert.deepEqual(p.send, ["x"]);
  assert.deepEqual(p.early, ["x"]);
  const young = pickRuns([{ id: "x", due: now + 3_600_000, age: 256 - 49 }], now, 0, 3);
  assert.deepEqual(young.send, []);
});

test("the margin grows with the sends queued ahead, since each adds two roots", () => {
  const now = 1_000_000;
  // 200 roots old: safe alone, at risk behind 4 sends (200 + 8 >= 208)
  const alone = pickRuns([{ id: "late", due: now + 1e6, age: 200 }], now, 0, 10);
  assert.deepEqual(alone.send, []);
  const queued = pickRuns(
    [
      { id: "d1", due: now - 1, age: 230 },
      { id: "d2", due: now - 1, age: 220 },
      { id: "d3", due: now - 1, age: 210 },
      { id: "d4", due: now - 1, age: 205 },
      { id: "late", due: now + 1e6, age: 200 },
    ],
    now,
    0,
    10,
  );
  assert.ok(queued.send.includes("late"));
  assert.deepEqual(queued.early, ["late"]);
  // jobs already being sent count as ahead too
  assert.deepEqual(pickRuns([{ id: "late", due: now + 1e6, age: 200 }], now, 4, 10).send, ["late"]);
});

test("jobs whose root is gone are stale, and the free slots cap what starts", () => {
  const now = 1_000_000;
  const p = pickRuns(
    [
      { id: "gone", due: now - 1, age: null },
      { id: "a", due: now - 1, age: 240 },
      { id: "b", due: now - 1, age: 100 },
      { id: "c", due: now - 1, age: 50 },
    ],
    now,
    1,
    2,
  );
  assert.deepEqual(p.stale, ["gone"]);
  assert.deepEqual(p.send, ["a", "b"], "oldest roots first, two slots");
});

test("a job backing off after a failed try waits out its hold, even with its root getting old", () => {
  const now = 1_000_000;
  const held = pickRuns([{ id: "x", due: now + 120_000, age: 210, hold: now + 10_000 }], now, 0, 3);
  assert.deepEqual(held.send, [], "not every tick while the relayer is topped up");
  const after = pickRuns([{ id: "x", due: now + 120_000, age: 210, hold: now }], now, 0, 3);
  assert.deepEqual(after.send, ["x"]);
  assert.deepEqual(after.early, ["x"]);
  // a held job still counts as ahead of the others, so their margin stays safe
  const behind = pickRuns(
    [
      { id: "h", due: now - 1, age: 230, hold: now + 10_000 },
      { id: "y", due: now + 1e6, age: 206 },
    ],
    now,
    0,
    3,
  );
  assert.deepEqual(behind.send, ["y"]);
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("while saved payments are still loading, one not back yet is never reported cancelled or gone", () => {
  const token = "ab".repeat(16);
  const id = "0a".repeat(12);
  const job = { id, tokenHash: sha(token), status: "scheduled", nullifiers: ["a1".repeat(32), "a2".repeat(32)], window: "1h", due: Date.now() + 3_600_000, latest: Date.now() + 3_600_000, tries: 0 };
  testHooks.restoring(() => true);
  try {
    const loading = (e: unknown) => (e as { status?: number; retryAfter?: number }).status === 503 && (e as { retryAfter?: number }).retryAfter === 15;
    assert.throws(() => cancel(id, token), loading);
    assert.throws(() => statuses([id]), loading);
    assert.deepEqual(statuses([]), []);
    // storage answers: the job is back, and can be cancelled
    testHooks.restore(JSON.stringify([job]));
    assert.equal(statuses([id])[0].status, "scheduled");
    assert.deepEqual(cancel(id, token), { status: "cancelled" });
    testHooks.restoring(() => false);
    assert.deepEqual(cancel("0b".repeat(12), token), { status: "unknown" }, "once everything is back, unknown means unknown");
  } finally {
    testHooks.restoring(() => false);
  }
});

test("a cancel that comes while a new payment is still being checked stops it for good, so 'unknown' means it never arrived", () => {
  const token = "ef".repeat(16);
  const id = "0f".repeat(12);
  const done = testHooks.checking(id, token);
  assert.deepEqual(cancel(id, "00".repeat(16)), { status: "unknown" }, "only the holder of its token can");
  assert.deepEqual(cancel(id, token), { status: "cancelled" });
  assert.equal(done(), true, "the check that ends after it refuses the payment");
});

test("the app asks after its payments by POST, ids out of the URL; both looks answer in the {error} shape while loading", async () => {
  const app = Fastify();
  jobStatusRoutes(app, (reply, e) => {
    const err = e as Error & { status?: number; retryAfter?: number };
    if (err.retryAfter) reply.header("Retry-After", String(err.retryAfter));
    reply.code(err.status ?? 500).send({ error: err.message });
  });
  const id = "0e".repeat(12);
  const post = (ids: unknown) => app.inject({ method: "POST", url: "/api/relay/jobs/status", payload: { ids } });
  const get = () => app.inject({ method: "GET", url: `/api/relay/jobs?ids=${id},nope` });
  const unknown = [{ id, status: "unknown", signature: null, error: null }];
  assert.deepEqual((await post([id, "nope", 7])).json(), unknown, "malformed ids are left out");
  assert.deepEqual((await get()).json(), unknown, "the older GET answers the same");
  assert.equal((await post(Array(201).fill(id))).statusCode, 400, "at most 200 at a time");
  assert.equal((await post("0e")).statusCode, 400);
  testHooks.restoring(() => true);
  try {
    for (const r of [await post([id]), await get()]) {
      assert.equal(r.statusCode, 503);
      assert.equal(r.headers["retry-after"], "15");
      assert.match((r.json() as { error: string }).error, /still loading/);
    }
  } finally {
    testHooks.restoring(() => false);
  }
  await app.close();
});

test("a saved copy caught mid-send is followed when the same job came back meanwhile", () => {
  const token = "cd".repeat(16);
  const id = "0c".repeat(12);
  const base = { id, tokenHash: sha(token), nullifiers: ["b1".repeat(32), "b2".repeat(32)], window: "1h", due: Date.now() + 3_600_000, latest: Date.now() + 3_600_000, tries: 0 };
  // handed back while storage was slow: this server holds it as waiting
  testHooks.restore(JSON.stringify([{ ...base, status: "scheduled" }]));
  // then storage answers with the copy that was being sent
  testHooks.restore(JSON.stringify([{ ...base, status: "sending", sigs: ["sigA"], lastValid: 500 }]));
  const [s] = statuses([id]);
  assert.equal(s.status, "sending", "its send may still land: settled from the chain before it goes again");
  assert.equal(s.signature, "sigA");
});

test("the root list is read again, fresh, for a root newer than the one kept", async () => {
  let reads = 0;
  const gate: (() => void)[] = [];
  const ringOf = (n: number): Ring => ({ roots: [BigInt(n)], rootIndex: 0, nextIndex: n });
  const r = ringReader(() => {
    const n = ++reads;
    return new Promise<Ring>((ok) => gate.push(() => ok(ringOf(n))));
  });
  const tick = () => new Promise((ok) => setTimeout(ok, 5));
  const first = r.read();
  gate.shift()!();
  assert.equal((await first).nextIndex, 1);
  assert.equal((await r.read()).nextIndex, 1, "kept for a while");
  assert.equal(reads, 1);
  // a read already under way, begun before the caller's request: waited out, then a new one
  const slow = r.read(0);
  await tick();
  const asked = Date.now();
  const fresh = r.read(0, asked);
  const joined = r.read(0);
  await tick();
  assert.equal(reads, 2, "only one read at a time");
  gate.shift()!();
  assert.equal((await slow).nextIndex, 2);
  assert.equal((await joined).nextIndex, 2, "a caller with no cutoff joins the read under way");
  await tick();
  assert.equal(reads, 3);
  gate.shift()!();
  assert.equal((await fresh).nextIndex, 3);
  assert.equal(r.last()?.nextIndex, 3);
  // the kept list now dates from after `asked`, so it serves that cutoff without another read
  assert.equal((await r.read(10_000, asked)).nextIndex, 3);
  // however old, a list read after the cutoff serves it (a second look on a miss costs nothing more)
  assert.equal((await r.read(Infinity, asked)).nextIndex, 3);
  assert.equal(reads, 3);
});

test("sends checked together each hold their share of the relayer's balance", async () => {
  const cost = 100n;
  const floor = 1000n;
  let reads = 0;
  // room for two sends, with every balance read slow enough that all three are checked together
  const b = sendBudget(async (fresh) => {
    if (fresh) reads++;
    await new Promise((ok) => setTimeout(ok, 5));
    return floor + 2n * cost + 50n;
  }, floor, 50);
  const all = await Promise.allSettled([1, 2, 3].map(() => b.take(cost)));
  assert.equal(all.filter((r) => r.status === "fulfilled").length, 2, "only the ones that fit");
  const no = all.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(no.reason.code, "relayer_unfunded");
  assert.ok(reads >= 1, "close to the line, the balance is read fresh");
  const [give1, give2] = all.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<(sent: boolean) => void>).value);
  // one refused before it went out: its share is free at once (and giving twice changes nothing)
  give1(false);
  give1(true);
  const give3 = await b.take(cost);
  // one that went out still counts until the balance has caught up with it
  give2(true);
  await assert.rejects(b.take(cost), (e: { code?: string }) => e.code === "relayer_unfunded");
  await new Promise((ok) => setTimeout(ok, 60));
  give3(false);
  await b.take(cost);
  // a balance nobody could read lets the send go (the chain itself still decides)
  await sendBudget(async () => null, floor).take(cost);
});

test("the same notes can't be relayed twice at once", () => {
  const a = ["aa".repeat(32), "bb".repeat(32)];
  const b = ["bb".repeat(32), "cc".repeat(32)];
  assert.equal(claimNotes(a, 60_000), true);
  assert.equal(notesInFlight(a), true);
  assert.equal(claimNotes(b, 60_000), false, "shares a note with a payment being sent");
  assert.equal(notesInFlight(["cc".repeat(32)]), false, "a refused claim takes nothing");
  releaseNotes(a);
  assert.equal(claimNotes(b, 60_000), true);
  releaseNotes(b);
  // a claim runs out by itself
  const t = Date.now();
  assert.equal(claimNotes(a, 1000, t), true);
  assert.equal(notesInFlight(a, t + 2000), false);
  assert.equal(claimNotes(a, 1000, t + 2000), true);
  releaseNotes(a);
});

const good = {
  proof: Buffer.alloc(256, 1).toString("base64"),
  root: "AB".repeat(32),
  nullifiers: ["Cd".repeat(32), "ef".repeat(32)],
  commitments: ["01".repeat(32), "02".repeat(32)],
  recipient: "11111111111111111111111111111112",
  withdraw: "5000000",
  relayerFee: "2000000",
  maxFeeBps: 80,
  meta0: Buffer.alloc(28, 2).toString("base64"),
  meta1: Buffer.alloc(28, 3).toString("base64"),
  extra: "x".repeat(10_000),
};

test("a relay request is rebuilt from its own fields only, hex in lower case", () => {
  const r = cleanRequest(good);
  assert.equal(r.root, "ab".repeat(32));
  assert.deepEqual(r.nullifiers, ["cd".repeat(32), "ef".repeat(32)]);
  assert.equal("extra" in r, false);
  assert.deepEqual(Object.keys(r).sort(), ["commitments", "maxFeeBps", "meta0", "meta1", "nullifiers", "proof", "recipient", "relayerFee", "root", "withdraw"]);
  // the same notes in another letter case are the same notes
  assert.deepEqual(cleanRequest({ ...good, nullifiers: ["CD".repeat(32), "EF".repeat(32)] }).nullifiers, r.nullifiers);
});

test("a malformed relay request is refused", () => {
  const bad: Record<string, unknown>[] = [
    { withdraw: " 5000000" },
    { withdraw: "1e9" },
    { withdraw: "99999999999999999999" },
    { relayerFee: 2000000 },
    { proof: Buffer.alloc(255).toString("base64") },
    { meta0: Buffer.alloc(29).toString("base64") },
    { root: "zz".repeat(32) },
    { nullifiers: ["ef".repeat(32), "EF".repeat(32)] },
    { nullifiers: ["ef".repeat(32)] },
    { recipient: "not an address" },
    { maxFeeBps: 10_001 },
    { maxFeeBps: "80" },
  ];
  for (const patch of bad) assert.throws(() => cleanRequest({ ...good, ...patch }), /Malformed/, JSON.stringify(patch));
});

test("the pool index can tell whether a payment's new notes arrived", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-store-"));
  try {
    const s = new PoolStore(dir, "Prog111");
    const tree = new MerkleTree();
    for (let k = 0; k < 3; k++) {
      const c: [bigint, bigint] = [BigInt(100 + 2 * k), BigInt(101 + 2 * k)];
      tree.append(c);
      const ev: PoolEvent = { kind: "spent", index: 2 * k, commitments: c, metas: [new Uint8Array(28), new Uint8Array(28)], nullifiers: [BigInt(900 + 2 * k), BigInt(901 + 2 * k)], withdraw: 0n, root: tree.root() };
      s.apply([ev], 1, `sig${k}`, k + 1);
    }
    assert.equal(s.hasLeaves([102n, 103n]), true);
    assert.equal(s.hasLeaves([100n, 105n]), true, "anywhere in the pool");
    assert.equal(s.hasLeaves([102n, 999n]), false, "both must be there");
    assert.equal(s.hasLeaves([100n, 101n], 2), false, "only the newest leaves were looked through");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a payment cancelled while it was being checked stays refused when the app sends it again after a lost answer", async () => {
  const token = "fa".repeat(16);
  const id = "1f".repeat(12);
  const done = testHooks.checking(id, token);
  assert.deepEqual(cancel(id, token), { status: "cancelled" });
  assert.equal(done(), true, "the check that ends after it refuses the payment");
  // the same hand-over again (same id and token): refused before anything is checked or reserved
  await assert.rejects(
    schedule({ request: good, window: "1h", id, token }),
    (e: Error & { status?: number }) => e.status === 409 && /already ended/.test(e.message),
  );
  assert.deepEqual(cancel(id, token), { status: "cancelled" }, "asking again gets the same answer");
  assert.deepEqual(cancel(id, "00".repeat(16)), { status: "unknown" }, "only for the holder of its token");
});

test("the start's grace for payments still loading counts from when the scheduler starts, however late that is", async () => {
  let now = Date.now() + 60 * 60_000;
  testHooks.clock(() => now);
  testHooks.restoring(() => true);
  try {
    // this copy waited an hour for the one before it, then starts
    await startScheduler();
    const unknown = "2e".repeat(12);
    assert.throws(() => statuses([unknown]), (e: { status?: number }) => e.status === 503, "still loading: never 'unknown'");
    now += 11 * 60_000;
    assert.equal(statuses([unknown])[0].status, "unknown", "past the grace, unknown means unknown");
    // stopped (another copy took over) and started again: the grace starts over
    await stopScheduler();
    await startScheduler();
    assert.throws(() => statuses([unknown]), (e: { status?: number }) => e.status === 503);
  } finally {
    await stopScheduler();
    testHooks.restoring(() => false);
    testHooks.clock(() => Date.now());
  }
});

test("delivering jobs the ledger let go of are looked at a few per tick, each in turn, and a hop still waiting isn't read again every tick", async () => {
  const ids = Array.from({ length: 7 }, (_, k) => `f${k}`.repeat(12));
  const hopOf = (id: string) => `Hop${id}`;
  testHooks.restore(JSON.stringify(ids.map((id) => ({ id, tokenHash: sha(id), status: "delivering", hop: hopOf(id), tx1: `tx1${id}`, to: "Recipient" }))));
  const looks = new Map<string, number>();
  const get = hops.get;
  const settleMissing = hops.settleMissing;
  // the ledger holds none of them; the last one was delivered, the others' hops still hold their SOL
  hops.get = () => undefined;
  hops.settleMissing = async (hop: string) => {
    looks.set(hop, (looks.get(hop) ?? 0) + 1);
    return hop === hopOf(ids[6]) ? { delivered: true as const, signature: "tx2" } : { delivered: false as const };
  };
  try {
    const t0 = Date.now();
    await testHooks.followDeliveries(t0);
    assert.equal([...looks.values()].reduce((a, b) => a + b, 0), 5, "five looks a tick");
    // the next tick: the ones not looked at yet get their turn (a throttled one doesn't use up a look)
    await testHooks.followDeliveries(t0 + 2_000);
    assert.equal(looks.get(hopOf(ids[5])), 1);
    assert.equal(looks.get(hopOf(ids[6])), 1);
    assert.equal(statuses([ids[6]])[0].status, "sent");
    assert.equal(statuses([ids[6]])[0].signature, "tx2");
    const waiting = statuses([ids[0]])[0];
    assert.equal(waiting.status, "delivering");
    assert.match(String(waiting.note), /Ready to finish/);
    // a hop still waiting isn't read again every tick, nor every minute
    for (const dt of [4_000, 6_000, 61_000, 5 * 60_000]) await testHooks.followDeliveries(t0 + dt);
    assert.deepEqual(
      ids.map((id) => looks.get(hopOf(id))),
      [1, 1, 1, 1, 1, 1, 1],
    );
    // ... but now and then, still five a tick, the longest-waiting first
    await testHooks.followDeliveries(t0 + 10 * 60_000 + 1_000);
    assert.deepEqual(
      ids.map((id) => looks.get(hopOf(id))),
      [2, 2, 2, 2, 2, 1, 1],
    );
    await testHooks.followDeliveries(t0 + 10 * 60_000 + 3_000);
    assert.deepEqual(
      ids.map((id) => looks.get(hopOf(id))),
      [2, 2, 2, 2, 2, 2, 1],
      "the sent one is never looked at again",
    );
  } finally {
    hops.get = get;
    hops.settleMissing = settleMissing;
  }
});
