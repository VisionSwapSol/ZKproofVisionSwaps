import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, MessageV0, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  DELIVERY_FEE,
  SHAPE_BAND,
  answerBoard,
  boardEpoch,
  l1Message,
  n2Message,
  noteLeaf,
  predictCredit,
  readShape,
  selectInputs,
  shapeJson,
  shapeOk,
  tokenHash,
  verifyDelivery,
  type OwnedNote,
} from "@visionswap/sdk";
import {
  LARGE_SHARE_BPS,
  NEAR_BPS,
  NEAR_WINDOW_MS,
  SWEPT_WINDOW_MS,
  avoidLoneSwept,
  drawExtraReserve,
  largeShareText,
  mergeOwnDeposits,
  nearAmount,
  nearDeposit,
  poolShareBps,
  shieldedValue,
  sweptLeaves,
  withDecoys,
  type OwnDeposit,
} from "../src/lib/privacy.ts";
import { DUST_FOLD_MAX, OWN_BAND, drawDeliveryShape, drawOwnShape, foldDust, jitterComputeLimit, ownPriorityMax, priceForPriority, priorityOf } from "../src/lib/txshape.ts";
import { DROPPED_KEEP_MS, droppedFor, noteDropped, pruneDropped, type DroppedProof } from "../src/lib/dropped.ts";
import { askBoard } from "../src/lib/statusboard.ts";
import { ROOT_MOVED_NOTE, rootGone } from "../src/lib/jobs.ts";
import { autoFinishable, feeOfShape, finishAmount, finishTransaction, l1Sig, n2Sig, payQuote, shapeOf, trustedRecipient } from "../src/lib/hops.ts";

/** A seeded generator (mulberry32): the same draws every run, so the distributions are checked deterministically. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const inner = (i: number) => i.toString(16).padStart(64, "0");

// ─── VS-04: a payment close in size to one of this account's own recent deposits ───

test("near amount: within 3% either way, never for nothing", () => {
  assert.equal(NEAR_BPS, 300);
  assert.ok(nearAmount(1_000_000_000n, 1_000_000_000n));
  assert.ok(nearAmount(1_030_000_000n, 1_000_000_000n));
  assert.ok(nearAmount(970_000_000n, 1_000_000_000n));
  assert.ok(!nearAmount(1_030_000_001n, 1_000_000_000n));
  assert.ok(!nearAmount(969_999_999n, 1_000_000_000n));
  assert.ok(!nearAmount(0n, 1n));
  assert.ok(!nearAmount(1n, 0n));
});

test("this account's deposits are remembered from the waiting room, first sighting kept, old ones dropped", () => {
  const now = 10 * DAY;
  let list = mergeOwnDeposits([], [{ inner: inner(1), amount: 2_000_000_000n, src: "wallet" }], now);
  assert.deepEqual(list, [{ inner: inner(1), amount: "2000000000", t: now, src: "wallet" }]);
  // seen again later: its first sighting stays (the age counts from when it was made)
  list = mergeOwnDeposits(list, [{ inner: inner(1), amount: 2_000_000_000n, src: "wallet" }, { inner: inner(2), amount: 5n, src: "vision" }], now + 1000);
  assert.equal(list.find((d) => d.inner === inner(1))!.t, now);
  assert.equal(list.length, 2);
  // a little over a week later both are gone
  assert.equal(mergeOwnDeposits(list, [], now + 9 * DAY).length, 0);
  // at most 200 are kept, newest first
  const many = mergeOwnDeposits(
    [],
    Array.from({ length: 250 }, (_, i) => ({ inner: inner(i), amount: 1n, src: "deposit" as const })),
    now,
  );
  assert.equal(many.length, 200);
});

test("a payment is matched to the closest recent deposit, within its window", () => {
  const now = 100 * DAY;
  const deps: OwnDeposit[] = [
    { inner: inner(1), amount: "1000000000", t: now - 3_600_000, src: "wallet" },
    { inner: inner(2), amount: "1010000000", t: now - 3_600_000, src: "deposit" },
    { inner: inner(3), amount: "5000000000", t: now - 3 * DAY, src: "vision" },
    { inner: inner(4), amount: "9000000000", t: now - 3 * DAY, src: "wallet" },
  ];
  assert.equal(nearDeposit(1_009_000_000n, deps, now)?.inner, inner(2), "the closest of two");
  assert.equal(nearDeposit(2_000_000_000n, deps, now), null);
  // a Vision wallet's move back is remembered for a week: its whole trail is public
  assert.equal(nearDeposit(5_100_000_000n, deps, now)?.src, "vision");
  // a plain deposit only for two days
  assert.equal(nearDeposit(9_000_000_000n, deps, now), null);
  assert.equal(nearDeposit(9_000_000_000n, deps, now - 3 * DAY + NEAR_WINDOW_MS - 1)?.inner, inner(4));
  assert.ok(SWEPT_WINDOW_MS > NEAR_WINDOW_MS);
});

// ─── VS-12: the Vision wallet reserve, and notes swept back from Vision wallets ───

test("the extra reserve is drawn below half the reserve, to the lamport, and varies", () => {
  const base = 6_000_000n;
  const rnd = seeded(12);
  const draws = Array.from({ length: 2000 }, () => drawExtraReserve(base, rnd));
  assert.ok(draws.every((x) => x >= 0n && x < base / 2n));
  // no grid: nearly every draw is its own figure, and few are round
  assert.ok(new Set(draws).size > 1990);
  assert.ok(draws.filter((x) => x % 100_000n === 0n).length < 10);
  // spread over the whole range: each quarter of it gets a fair share
  for (let q = 0n; q < 4n; q++) {
    const n = draws.filter((x) => x >= (q * base) / 8n && x < ((q + 1n) * base) / 8n).length;
    assert.ok(n > 400 && n < 600, `quarter ${q}: ${n}`);
  }
  assert.equal(drawExtraReserve(0n, rnd), 0n);
});

const note = (index: number, amount: bigint, innerN: number): OwnedNote => ({
  index,
  leaf: noteLeaf(amount, BigInt("0x" + inner(innerN))),
  amount,
  nonce: new Uint8Array(12),
  blinding: 0n,
  nullifier: BigInt(index + 1),
});

test("a note a Vision wallet swept back isn't spent alone for an amount close to its own while another note can do", () => {
  const now = 50 * DAY;
  const deps: OwnDeposit[] = [{ inner: inner(7), amount: "1000000000", t: now - DAY, src: "vision" }];
  const swept = sweptLeaves(deps, now);
  const s = note(0, 1_000_000_000n, 7);
  assert.ok(swept.has(s.leaf));
  const other = note(1, 3_000_000_000n, 8);
  const free = [s, other];
  const w = 990_000_000n;
  // selectInputs picks the closest note on its own: the swept one
  assert.deepEqual(selectInputs(free, w), [s]);
  assert.deepEqual(avoidLoneSwept(selectInputs(free, w), free, swept, w, selectInputs), [other]);
  // an amount far from it: the usual pick stays
  assert.deepEqual(avoidLoneSwept(selectInputs(free, 500_000_000n), free, swept, 500_000_000n, selectInputs), [s]);
  // nothing else covers it: the usual pick stays (the form already says so)
  assert.deepEqual(avoidLoneSwept([s], [s], swept, w, selectInputs), [s]);
  // a move back older than a week no longer counts
  assert.equal(sweptLeaves(deps, now + 7 * DAY).size, 0);
});

// ─── VS-15: what the pool holds, and a payment's share of it ───

test("the pool's value and a payment's share of it", () => {
  assert.equal(shieldedValue(10_000_000_000n, 946_560n, 2_000_000_000n), 7_999_053_440n);
  assert.equal(shieldedValue(1n, 946_560n, 0n), 0n);
  assert.equal(poolShareBps(5_000_000_000n, 10_000_000_000n), 5000);
  assert.equal(poolShareBps(20_000_000_000n, 10_000_000_000n), 10_000, "never above the whole");
  assert.equal(poolShareBps(1n, null), null);
  assert.equal(poolShareBps(1n, 0n), null);
  assert.equal(LARGE_SHARE_BPS, 5000);
  assert.match(largeShareText(62), /about 62% of what the pool holds/);
  assert.match(largeShareText(100), /nearly everything the pool holds/);
  // calm and true: no alarm words
  assert.doesNotMatch(largeShareText(80), /danger|warning|unsafe|exposed|traced/i);
});

// ─── VS-57 / VS-21: one's own addresses read among others ───

test("own addresses are read mixed with decoys from a public list, in random order", () => {
  const own = ["a", "b"];
  const pool = Array.from({ length: 30 }, (_, i) => `p${i}`);
  const rnd = seeded(5);
  const asked = withDecoys(own, [...pool, "a"], 4, rnd);
  assert.equal(asked.length, 2 + 8);
  assert.ok(own.every((a) => asked.includes(a)));
  assert.equal(new Set(asked).size, asked.length, "each once");
  // the own ones aren't always first: over many draws they land anywhere
  const firsts = new Set(Array.from({ length: 200 }, () => withDecoys(own, pool, 4, rnd)[0]));
  assert.ok(firsts.size > 8);
  // too few others: all of them
  assert.equal(withDecoys(own, ["x"], 4, rnd).length, 3);
});

// ─── VS-34: transaction shapes ───

const SHAPES = { feeMin: SHAPE_BAND.feeMin.toString(), feeMax: SHAPE_BAND.feeMax.toString(), cuMin: SHAPE_BAND.cuMin, cuMax: SHAPE_BAND.cuMax, v0: true };

test("delivery shapes are drawn within the band the relayer takes, and vary", () => {
  const rnd = seeded(34);
  const draws = Array.from({ length: 1000 }, () => drawDeliveryShape({ shapes: SHAPES }, rnd)!);
  assert.ok(draws.every((s) => s && shapeOk(s)));
  const fees = new Set(draws.map((s) => s.fee));
  const cus = new Set(draws.map((s) => s.cuL1));
  assert.ok(fees.size > 50, "many fees");
  assert.ok(cus.size > 50, "many compute limits");
  // the fixed shape's own figures are no longer what every delivery carries
  assert.ok(draws.filter((s) => s.fee === DELIVERY_FEE && s.cuL1 === 2_500).length < 50);
  const v0 = draws.filter((s) => s.v0).length;
  assert.ok(v0 > 400 && v0 < 600, `v0 in about half: ${v0}`);
  // a server that takes legacy messages only, or a narrower band, is kept to
  assert.ok(Array.from({ length: 200 }, () => drawDeliveryShape({ shapes: { ...SHAPES, v0: false } }, rnd)!).every((s) => !s.v0));
  const narrow = { ...SHAPES, feeMin: "15000", feeMax: "16000", cuMin: 2_000, cuMax: 3_000 };
  assert.ok(Array.from({ length: 200 }, () => drawDeliveryShape({ shapes: narrow }, rnd)!).every((s) => s.fee >= 15_000n && s.fee <= 16_000n && s.cuL1 >= 2_000 && s.cuL1 <= 3_000));
  // a server can't widen the SDK's own band
  const wide = { ...SHAPES, feeMin: "1", feeMax: "999999999", cuMin: 1, cuMax: 1_400_000 };
  assert.ok(Array.from({ length: 200 }, () => drawDeliveryShape({ shapes: wide }, rnd)!).every((s) => shapeOk(s)));
  // a server without shapes: none (the fixed one)
  assert.equal(drawDeliveryShape({}, rnd), undefined);
  assert.equal(drawDeliveryShape(null, rnd), undefined);
});

test("a delivery in a drawn shape pays the recipient exactly the amount, and its signature covers the shape", () => {
  const rnd = seeded(7);
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const blockhash = bs58.encode(new Uint8Array(32).fill(3));
  for (let i = 0; i < 20; i++) {
    const shape = drawDeliveryShape({ shapes: SHAPES }, rnd)!;
    const amount = 250_000_000n + BigInt(i);
    const q = payQuote(amount, 1_545_760n, 80, undefined, shape.fee);
    assert.equal(q.deliveryFee, shape.fee);
    assert.equal(q.toRecipient, amount);
    assert.equal(predictCredit(q.withdraw, q.relayerFee, 80), amount + shape.fee, "the hop gets the amount and its own fee");
    const sig = bs58.decode(l1Sig(hop, to, amount, blockhash, shape));
    assert.ok(verifyDelivery(l1Message({ hop: hop.publicKey, to, lamports: amount, blockhash, shape }), sig, hop.publicKey));
    assert.ok(!verifyDelivery(l1Message({ hop: hop.publicKey, to, lamports: amount, blockhash }), sig, hop.publicKey), "never valid in another shape");
    // finished from the device in the same shape: everything less its fee
    const f = finishAmount(amount + shape.fee, 890_880n, shape.fee);
    assert.deepEqual(f, { lamports: amount });
    assert.ok(autoFinishable(amount + shape.fee, amount, shape.fee));
    const raw = finishTransaction(hop, to, amount, blockhash, shape);
    const tx = VersionedTransaction.deserialize(raw);
    assert.equal(tx.version === 0, shape.v0);
  }
  const n = { account: Keypair.generate().publicKey.toBase58(), authority: Keypair.generate().publicKey.toBase58(), value: blockhash };
  const shape = drawDeliveryShape({ shapes: SHAPES }, rnd)!;
  const sig = bs58.decode(n2Sig(hop, to, 5_000_000n, n, shape));
  assert.ok(verifyDelivery(n2Message({ hop: hop.publicKey, to, lamports: 5_000_000n, nonceAccount: new PublicKey(n.account), authority: new PublicKey(n.authority), nonce: n.value, shape }), sig, hop.publicKey));
});

test("a leg's or a job's shape reads back; anything unreadable is the fixed one", () => {
  const shape = drawDeliveryShape({ shapes: SHAPES }, seeded(1))!;
  assert.deepEqual(shapeOf(shapeJson(shape)), shape);
  assert.equal(feeOfShape(shapeJson(shape)), shape.fee);
  assert.equal(shapeOf(undefined), undefined);
  assert.equal(feeOfShape(undefined), DELIVERY_FEE);
  assert.equal(feeOfShape({ fee: "1", cuL1: 1, cuN2: 1, v0: false }), DELIVERY_FEE, "outside the band: the fixed one");
  assert.deepEqual(readShape(shapeJson(shape)), shape);
});

test("a delivery record trusted only under the hop's own signature, in the shape it names", () => {
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const blockhash = bs58.encode(new Uint8Array(32).fill(9));
  const shape = drawDeliveryShape({ shapes: SHAPES }, seeded(2))!;
  const l1 = { blockhash, sig: l1Sig(hop, to, 7_000_000n, blockhash, shape) };
  assert.equal(trustedRecipient(hop.publicKey, { status: "funded", to: to.toBase58(), amount: "7000000", l1, shape: shapeJson(shape) }), to.toBase58());
  // the same signature named without its shape (or with another) doesn't check out
  assert.equal(trustedRecipient(hop.publicKey, { status: "funded", to: to.toBase58(), amount: "7000000", l1 }), null);
  assert.equal(trustedRecipient(hop.publicKey, { status: "funded", to: to.toBase58(), amount: "7000000", l1, shape: { ...shapeJson(shape), fee: "11000" } }), null);
});

test("the app's own transactions draw their limit and price within their band", () => {
  const rnd = seeded(99);
  for (const kind of ["deposit", "sweep", "cleanup"] as const) {
    const b = OWN_BAND[kind];
    const draws = Array.from({ length: 1000 }, () => drawOwnShape(kind, rnd));
    assert.ok(draws.every((s) => s.cu >= b.cu[0] && s.cu <= b.cu[1] && s.price >= b.price[0] && s.price <= b.price[1]));
    assert.ok(new Set(draws.map((s) => `${s.cu}/${s.price}`)).size > 300, `${kind}: many shapes`);
    // about half the limits are round figures, as wallets set them
    const round = draws.filter((s) => s.cu % 10_000 === 0).length;
    assert.ok(round > 400 && round < 650, `${kind}: ${round} round`);
    // the fee shown before a transaction is built is never below what it then pays
    assert.ok(draws.every((s) => priorityOf(s) <= ownPriorityMax(kind)));
  }
  // never below what these transactions always asked for
  assert.equal(OWN_BAND.deposit.cu[0], 120_000);
  assert.equal(OWN_BAND.sweep.cu[0], 200_000);
});

test("a rounding sliver is paid as exactly that much more priority (VS-13)", () => {
  const rnd = seeded(13);
  for (let i = 0; i < 500; i++) {
    const s = drawOwnShape("deposit", rnd);
    const dust = BigInt(Math.floor(rnd() * Number(DUST_FOLD_MAX + 1n)));
    const f = foldDust(s, dust)!;
    assert.equal(f.cu, s.cu);
    assert.equal(priorityOf(f), priorityOf(s) + dust, `cu ${s.cu}, price ${s.price}, dust ${dust}`);
  }
  assert.equal(foldDust({ cu: 120_000, price: 10_000 }, 0n)!.price, 10_000);
  assert.equal(foldDust({ cu: 120_000, price: 10_000 }, DUST_FOLD_MAX + 1n), null);
  assert.equal(foldDust({ cu: 120_000, price: 10_000 }, -1n), null);
  for (const cu of [1, 7, 120_000, 260_000, 1_000_000]) for (const p of [0n, 1n, 999n, 123_456n]) assert.equal(priorityOf({ cu, price: priceForPriority(cu, p) }), p);
});

function swapTx(units: number, price: bigint, v0 = true): VersionedTransaction {
  const payer = Keypair.generate().publicKey;
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })];
  const msg = MessageV0.compile({ payerKey: payer, instructions: ixs, recentBlockhash: bs58.encode(new Uint8Array(32).fill(1)) });
  const tx = new VersionedTransaction(msg);
  if (!v0) Object.defineProperty(tx, "version", { value: "legacy" });
  return tx;
}
const unitsOf = (tx: VersionedTransaction) => {
  const back = VersionedTransaction.deserialize(tx.serialize());
  const ix = back.message.compiledInstructions.find((x) => x.data[0] === 2)!;
  return new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getUint32(1, true);
};

test("a swap's compute limit is raised by a random 2% to 20%, only while the fee check passes", () => {
  const rnd = seeded(77);
  const seen = new Set<number>();
  for (let i = 0; i < 300; i++) {
    const tx = swapTx(180_000, 100_000n);
    assert.ok(jitterComputeLimit(tx, () => true, rnd));
    const u = unitsOf(tx);
    assert.ok(u > 180_000 && u <= Math.ceil(180_000 * 1.2) + 5_000, String(u));
    seen.add(u);
  }
  assert.ok(seen.size > 30, "it varies");
  // the server's formula (1.25 × simulation + 5,000) no longer reads back from most of them
  const tx = swapTx(180_000, 100_000n);
  assert.equal(jitterComputeLimit(tx, () => false, rnd), false, "a fee check that fails changes nothing");
  assert.equal(unitsOf(tx), 180_000);
  const legacy = swapTx(180_000, 100_000n, false);
  assert.equal(jitterComputeLimit(legacy, () => true, rnd), false, "only v0 messages are changed");
  // the check sees the old and new limits and the price
  let saw: bigint[] = [];
  jitterComputeLimit(swapTx(100_000, 5n), (u, p, before) => ((saw = [u, p, before]), true), rnd);
  assert.equal(saw[1], 5n);
  assert.equal(saw[2], 100_000n);
  assert.ok(saw[0] > 100_000n);
});

// ─── VS-31: a payment made again after its proof didn't go ───

test("a payment made again after a dropped proof reuses its notes while that proof can still land", () => {
  const now = 1_000_000;
  const d: DroppedProof = { to: "dest", amount: "5000", nfs: ["aa", "bb"], root: "r1", at: now };
  let list = noteDropped([], d, now);
  const live = new Set(["aa", "bb", "cc"]);
  assert.equal(droppedFor(list, "dest", 5000n, live, now + 1000), d);
  assert.equal(droppedFor(list, "dest", 5001n, live, now), null, "another amount is another payment");
  assert.equal(droppedFor(list, "other", 5000n, live, now), null);
  // once one of its notes is spent the old proof can never land
  assert.equal(droppedFor(list, "dest", 5000n, new Set(["aa"]), now), null);
  // the same notes again replace the record; old ones are dropped
  list = noteDropped(list, { ...d, at: now + 5 }, now + 5);
  assert.equal(list.length, 1);
  assert.equal(droppedFor(list, "dest", 5000n, live, now + 5 + DROPPED_KEEP_MS), null);
  // pruned once its root leaves the pool's list (an unknown answer keeps it)
  assert.equal(pruneDropped(list, live, () => null, now).length, 1);
  assert.equal(pruneDropped(list, live, () => false, now).length, 0);
  assert.equal(pruneDropped(list, new Set(["aa"]), () => true, now).length, 0);
});

// ─── VS-16: a held proof whose root the pool moved past ───

test("a held proof whose root a newer read of the pool's roots doesn't hold can never land", () => {
  const root = "ab".repeat(32);
  const ring = new Set([root, "cd".repeat(32)]);
  const j = { request: { root }, created: 1_000, refreshed: 50_000 };
  assert.equal(rootGone(j, ring, 60_000), false);
  assert.equal(rootGone(j, new Set(["cd".repeat(32)]), 60_000), true);
  // a read older than the proof can't know its root
  assert.equal(rootGone(j, new Set(["cd".repeat(32)]), 52_000), false);
  assert.equal(rootGone({ created: 1, request: {} }, ring, 1e9), false);
  assert.equal(rootGone(j, null, 1e9), false);
  assert.match(ROOT_MOVED_NOTE, /fresh one/);
});

// ─── VS-40: the status board, as the app reads it ───

const boardRand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const boardSecret = new Uint8Array(32).fill(4);

/** A server's board for these token hashes, as the server answers it (see sdk/src/board.ts). */
function fakeBoard(listed: { th: string; status: unknown }[], serverEpoch: number) {
  const sent: { buckets: string[]; epoch: number }[] = [];
  const post = async (buckets: string[], epoch: number) => {
    sent.push({ buckets, epoch });
    const e = Math.abs(epoch - serverEpoch) <= 1 ? epoch : serverEpoch;
    return answerBoard(listed, buckets, e, boardSecret, boardRand);
  };
  return { sent, post };
}

test("the app reads its own entries from the status board, and unknown for one it doesn't list", async () => {
  const items = [
    { id: "a1".repeat(12), token: "t-mine-1" },
    { id: "b2".repeat(12), token: "t-mine-2" },
  ];
  const now = 1_700_000_000_000;
  const listed = [items[0].token, ...Array.from({ length: 30 }, (_, i) => `someone-${i}`)].map((t) => ({ th: tokenHash(t), status: { status: "scheduled", signature: null, error: null } }));
  const { sent, post } = fakeBoard(listed, boardEpoch(now));
  const memo = { chars: 0 };
  const got = await askBoard(items, memo, post, (id) => ({ id, status: "unknown" }), now);
  assert.deepEqual(got, [
    { id: items[0].id, status: "scheduled", signature: null, error: null },
    { id: items[1].id, status: "unknown" },
  ]);
  // the request named no id and no token: the whole board, while it is small
  assert.deepEqual(sent, [{ buckets: [""], epoch: boardEpoch(now) }]);
  assert.equal(JSON.stringify(sent).includes("t-mine"), false);
});

test("an answer the app can't read is never taken as \"not listed\" (that would hand a payment back)", async () => {
  const items = [{ id: "e5".repeat(12), token: "t-mine" }];
  const now = 1_700_000_000_000;
  const listed = [{ th: tokenHash("t-mine"), status: { status: "scheduled", signature: null, error: null } }];
  const good = await fakeBoard(listed, boardEpoch(now)).post([""], boardEpoch(now));
  for (const bad of [{ ...good, nonce: undefined }, { ...good, nonce: "xyz" }, { ...good, entries: null }, { ...good, finer: true }]) {
    await assert.rejects(askBoard(items, { chars: 0 }, async () => bad as never, (id) => ({ id, status: "unknown" }), now));
  }
  // the same board answered twice: different tags, the same status read
  const memo = { chars: 0 };
  const { post } = fakeBoard(listed, boardEpoch(now));
  const a = await askBoard(items, memo, post, (id) => ({ id, status: "unknown" }), now);
  const b = await askBoard(items, memo, post, (id) => ({ id, status: "unknown" }), now);
  assert.deepEqual(a, b);
  assert.equal(a[0].status, "scheduled");
});

test("a clock an hour off, with the whole board answered, needs no second look", async () => {
  const items = [{ id: "f6".repeat(12), token: "mine" }];
  const now = 1_700_000_000_000;
  const listed = ["mine", ...Array.from({ length: 30 }, (_, i) => `x${i}`)].map((t) => ({ th: tokenHash(t), status: { status: "scheduled", signature: null, error: null } }));
  const { sent, post } = fakeBoard(listed, boardEpoch(now) + 3);
  const got = await askBoard(items, { chars: 0 }, post, (id) => ({ id, status: "unknown" }), now);
  assert.equal(got[0].status, "scheduled");
  assert.equal(sent.length, 1);
});

test("a big board is asked again at the server's granularity, and the app follows it", async () => {
  const items = [{ id: "c3".repeat(12), token: "mine" }];
  const now = 1_700_000_000_000;
  const listed = ["mine", ...Array.from({ length: 3500 }, (_, i) => `x${i}`)].map((t) => ({ th: tokenHash(t), status: { status: "sent", signature: "s", error: null } }));
  const { sent, post } = fakeBoard(listed, boardEpoch(now));
  const memo = { chars: 0 };
  const got = await askBoard(items, memo, post, (id) => ({ id, status: "unknown" }), now);
  assert.equal(got[0].status, "sent");
  assert.equal(sent.length, 2);
  // 3,501 entries fill a board of 4,096: buckets of two hex characters, 16 entries each
  assert.equal(memo.chars, 2);
  assert.equal(sent[1].buckets[0].length, 2);
  await askBoard(items, memo, post, (id) => ({ id, status: "unknown" }), now);
  assert.equal(sent.length, 3, "next time straight at that granularity");
});

test("a clock hours off still reads the board: the app asks again for the server's hour", async () => {
  const items = [{ id: "d4".repeat(12), token: "mine" }];
  const now = 1_700_000_000_000;
  const listed = ["mine", ...Array.from({ length: 3500 }, (_, i) => `x${i}`)].map((t) => ({ th: tokenHash(t), status: { status: "scheduled", signature: null, error: null } }));
  // the server's clock is three hours ahead of this device's
  const { sent, post } = fakeBoard(listed, boardEpoch(now) + 3);
  const memo = { chars: 1 };
  const got = await askBoard(items, memo, post, (id) => ({ id, status: "unknown" }), now);
  assert.equal(got[0].status, "scheduled");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].epoch, boardEpoch(now) + 3);
});
