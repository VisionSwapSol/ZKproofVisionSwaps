/**
 * Payment receipts (P1-1): a receipt built from an account's notes verifies against the chain, and any
 * change to it, or a transaction that doesn't match, is refused. The chain here is a fixture: real
 * Poseidon leaves and nullifiers, the program's real event and instruction encodings, real ed25519
 * screening passes, served by a fake `fetchTx`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, Ed25519Program } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { keysFromSignature } from "../src/keys.ts";
import { noteBlinding, randomNonce, randomField, META_LEN } from "../src/notes.ts";
import { H2, H3 } from "../src/poseidon.ts";
import { concat, toBE, toLE } from "../src/field.ts";
import { EVENT_DISC, Pool, attestationMessage } from "../src/program.ts";
import {
  buildReceipt,
  verifyReceipt,
  OWNERSHIP_PROOF_PREFIX,
  type OwnNote,
  type Receipt,
  type ReceiptHistory,
  type ReceiptTx,
} from "../src/receipt.ts";
import { TX_CHUNK, alignedChunk, chunkStarts, decodeLeafTxs, decodeNfTxs, encodeLeafTx, encodeNfTx } from "../src/txindex.ts";

const keys = keysFromSignature(new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff));
const other = keysFromSignature(new Uint8Array(64).map((_, i) => (i * 13 + 5) & 0xff));
const programKp = Keypair.generate();
const PROGRAM = programKp.publicKey.toBase58();
const pool = new Pool(programKp.publicKey);
const guard = Keypair.generate();
const relayer = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;
const te = new TextEncoder();
const disc = (name: string) => sha256(te.encode(`global:${name}`)).slice(0, 8);
const u64 = (n: bigint | number) => toLE(BigInt(n), 8);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const sigOf = (seed: number) => bs58.encode(new Uint8Array(64).map((_, i) => (i * 7 + seed * 31 + 1) & 0xff));

/** A note of `k`'s, with its leaf at `index`. */
function note(k: typeof keys, index: number, amount: bigint): OwnNote & { inner: bigint } {
  const blinding = noteBlinding(k, randomNonce());
  const inner = H2(k.pubKey, blinding);
  return { index, leaf: H2(amount, inner), amount, blinding, inner };
}
const nullifier = (k: typeof keys, n: OwnNote) => H3(n.leaf, BigInt(n.index), H3(k.privKey, n.leaf, BigInt(n.index)));

/** The fixture chain: transactions by signature. */
const chain = new Map<string, ReceiptTx>();
const logsOf = (...events: Uint8Array[]) => [`Program ${PROGRAM} invoke [1]`, ...events.map((e) => `Program data: ${b64(e)}`), `Program ${PROGRAM} success`];
const ixOf = (i: { programId: PublicKey; keys: { pubkey: PublicKey }[]; data: Buffer | Uint8Array }) => ({
  programId: i.programId.toBase58(),
  accounts: i.keys.map((k) => k.pubkey.toBase58()),
  data: new Uint8Array(i.data),
});

let slot = 1000;
/** Puts a deposit by `depositor` and its settle on the chain; returns their signatures. */
function deposit(n: OwnNote & { inner: bigint }, depositor: Keypair, seed: number, opts: { pass?: boolean } = {}) {
  const depositTx = sigOf(seed);
  const settleTx = sigOf(seed + 1);
  const expiry = 99_999n;
  const msg = attestationMessage(depositor.publicKey, expiry);
  const pass = Ed25519Program.createInstructionWithPublicKey({ publicKey: guard.publicKey.toBytes(), message: msg, signature: ed25519.sign(msg, guard.secretKey.slice(0, 32)) });
  const dep = pool.deposit({ depositor: depositor.publicKey, amount: n.amount, inner: n.inner, meta: new Uint8Array(META_LEN), attestationExpiry: expiry, maxFeeBps: 80 });
  const queued = concat(EVENT_DISC.DepositQueued, depositor.publicKey.toBytes(), u64(n.amount), toBE(n.inner), u64(slot));
  chain.set(depositTx, { err: null, slot: slot++, logs: logsOf(queued), instructions: [...(opts.pass === false ? [] : [ixOf(pass)]), ixOf(dep)], inner: [] });
  const settle = pool.settle(pool.pending(n.inner), depositor.publicKey, treasury);
  const settled = concat(EVENT_DISC.DepositSettled, u64(n.index), toBE(n.leaf), u64(n.amount), new Uint8Array(META_LEN), toBE(randomField()));
  chain.set(settleTx, { err: null, slot: slot++, logs: logsOf(settled), instructions: [ixOf(settle)], inner: [] });
  return { depositTx, settleTx };
}

/** Puts a spend on the chain: its two input nullifiers, two output notes (at `outIndex`, +1) and the withdraw to `recipient`. */
function spend(seed: number, nullifiers: [bigint, bigint], outs: [OwnNote, OwnNote], withdraw: bigint, recipient: PublicKey, opts: { forgedBy?: string } = {}) {
  const tx = sigOf(seed);
  const data = concat(
    disc("transact"),
    new Uint8Array(256).fill(7),
    toBE(randomField()),
    toBE(nullifiers[0]),
    toBE(nullifiers[1]),
    toBE(outs[0].leaf),
    toBE(outs[1].leaf),
    u64(withdraw),
    u64(2_000_000n),
    toLE(80n, 2),
    new Uint8Array(META_LEN),
    new Uint8Array(META_LEN),
  );
  const ev = concat(
    EVENT_DISC.Spent,
    u64(outs[0].index),
    toBE(outs[0].leaf),
    toBE(outs[1].leaf),
    new Uint8Array(META_LEN),
    new Uint8Array(META_LEN),
    toBE(nullifiers[0]),
    toBE(nullifiers[1]),
    u64(withdraw),
    toBE(randomField()),
  );
  const logs = opts.forgedBy
    ? // the event logged while another program is the one running: it must not count
      [`Program ${PROGRAM} invoke [1]`, `Program ${opts.forgedBy} invoke [2]`, `Program data: ${b64(ev)}`, `Program ${opts.forgedBy} success`, `Program ${PROGRAM} success`]
    : logsOf(ev);
  chain.set(tx, {
    err: null,
    slot: slot++,
    logs,
    instructions: [{ programId: PROGRAM, accounts: [relayer.toBase58(), recipient.toBase58(), "x", "x", "x", "x", "x", "x", "x"], data }],
    inner: [],
  });
  return tx;
}

const fetchTx = async (sig: string) => chain.get(sig) ?? null;

/** The history the app would get from the full transaction-index download. */
function historyOf(leaves: Map<number, { tx: string; depositTx: string | null }>, spends: Map<string, { nullifiers: bigint[]; outputs: number[] }>): ReceiptHistory {
  return { leafTx: (i) => leaves.get(i) ?? null, spend: (tx) => spends.get(tx) ?? null };
}

// ─── one deposit, one payment out of the pool to an outside address, delivered from a one-time address ───
const depositor = Keypair.generate();
const d1 = note(keys, 5, 1_000_000_000n);
const dep1 = deposit(d1, depositor, 10);
const hop = Keypair.generate().publicKey;
const final = Keypair.generate().publicKey;
const change = note(keys, 20, 300_000_000n);
const zero = note(keys, 21, 0n);
const pad = randomField();
const W = spend(30, [nullifier(keys, d1), pad], [change, zero], 700_000_000n, hop);
const tx2 = sigOf(40);
chain.set(tx2, { err: null, slot: slot++, logs: [], instructions: [ixOf(SystemProgram.transfer({ fromPubkey: hop, toPubkey: final, lamports: 687_000_000 }))], inner: [] });

const leaves = new Map<number, { tx: string; depositTx: string | null }>([
  [5, { tx: dep1.settleTx, depositTx: dep1.depositTx }],
  [20, { tx: W, depositTx: null }],
  [21, { tx: W, depositTx: null }],
]);
const spends = new Map<string, { nullifiers: bigint[]; outputs: number[] }>([[W, { nullifiers: [nullifier(keys, d1), pad], outputs: [20, 21] }]]);
const mine = [d1, change, zero];
const base = { network: "localnet", programId: PROGRAM, paymentTx: W, delivery: { tx: tx2, hop: hop.toBase58(), to: final.toBase58() } };

const clone = (r: Receipt): Receipt => JSON.parse(JSON.stringify(r));

test("a direct deposit -> payment receipt verifies: the depositing wallet, its screening pass, the payout and its delivery", async () => {
  const r = buildReceipt(keys, mine, historyOf(leaves, spends), base);
  assert.equal(r.payment.inputs.length, 1, "only this account's note is opened; the padding input isn't");
  assert.ok(!("viewKey" in JSON.parse(JSON.stringify(r))), "no viewing key in a receipt");
  const c = await verifyReceipt(r, fetchTx, { programId: PROGRAM, guard: guard.publicKey.toBase58() });
  assert.deepEqual(c.problems, []);
  assert.equal(c.ok, true);
  assert.equal(c.payment?.recipient, hop.toBase58());
  assert.equal(c.payment?.withdraw, 700_000_000n);
  assert.equal(c.payment?.delivery?.to, final.toBase58());
  assert.equal(c.payment?.delivery?.lamports, 687_000_000n);
  assert.equal(c.payment?.complete, false, "without its outputs opened it doesn't claim to be the whole source");
  assert.equal(c.sources.length, 1);
  const s = c.sources[0];
  assert.equal(s.kind, "deposit");
  if (s.kind === "deposit") {
    assert.equal(s.depositor, depositor.publicKey.toBase58());
    assert.equal(s.amount, 1_000_000_000n);
    assert.deepEqual(s.pass, { guard: guard.publicKey.toBase58(), current: true });
  }
});

test("opening both outputs proves conservation: the opened input pays for everything, so the other input is zero-value padding", async () => {
  const r = buildReceipt(keys, mine, historyOf(leaves, spends), { ...base, openOutputs: true });
  assert.ok(r.payment.outputs);
  const c = await verifyReceipt(r, fetchTx, { programId: PROGRAM });
  assert.equal(c.ok, true, c.problems.join("; "));
  assert.equal(c.payment?.complete, true);
  // an output opened with another amount doesn't match the pool's event
  const bad = clone(r);
  bad.payment.outputs![0].amount = "1";
  const c2 = await verifyReceipt(bad, fetchTx, { programId: PROGRAM });
  assert.equal(c2.ok, false);
  assert.match(c2.problems.join(" "), /output doesn't match/);
});

test("a tampered sig, a wrong index, a swapped transaction or another program are all refused", async () => {
  const r = buildReceipt(keys, mine, historyOf(leaves, spends), base);
  const tampered = clone(r);
  tampered.payment.inputs[0].sig = tampered.payment.inputs[0].sig.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  assert.equal((await verifyReceipt(tampered, fetchTx, { programId: PROGRAM })).ok, false, "tampered sig");
  const index = clone(r);
  index.payment.inputs[0].index = 6;
  assert.equal((await verifyReceipt(index, fetchTx, { programId: PROGRAM })).ok, false, "wrong index");
  const amount = clone(r);
  amount.payment.inputs[0].amount = "999999999";
  assert.equal((await verifyReceipt(amount, fetchTx, { programId: PROGRAM })).ok, false, "wrong amount");
  // another deposit's transactions in place of this note's own
  const d2 = note(keys, 6, 2_000_000_000n);
  const dep2 = deposit(d2, Keypair.generate(), 50);
  const swapped = clone(r);
  (swapped.payment.inputs[0].origin as { settleTx: string }).settleTx = dep2.settleTx;
  assert.equal((await verifyReceipt(swapped, fetchTx, { programId: PROGRAM })).ok, false, "swapped settle");
  const swapped2 = clone(r);
  (swapped2.payment.inputs[0].origin as { depositTx: string }).depositTx = dep2.depositTx;
  assert.equal((await verifyReceipt(swapped2, fetchTx, { programId: PROGRAM })).ok, false, "swapped deposit");
  // a payment that isn't this one
  const swappedW = clone(r);
  swappedW.payment.tx = dep1.settleTx;
  assert.equal((await verifyReceipt(swappedW, fetchTx, { programId: PROGRAM })).ok, false, "swapped payment");
  // the receipt is for another program
  assert.equal((await verifyReceipt(r, fetchTx, { programId: Keypair.generate().publicKey.toBase58() })).ok, false, "another program");
  // a delivery from somewhere else
  const elsewhere = clone(r);
  elsewhere.payment.delivery!.hop = Keypair.generate().publicKey.toBase58();
  assert.equal((await verifyReceipt(elsewhere, fetchTx, { programId: PROGRAM })).ok, false, "delivery not from the payout address");
  // a transaction that failed on-chain proves nothing
  const failedW = spend(60, [nullifier(keys, d1), pad], [change, zero], 700_000_000n, hop);
  chain.get(failedW)!.err = { InstructionError: [0, { Custom: 1 }] };
  const failed = clone(r);
  failed.payment.tx = failedW;
  delete failed.payment.delivery;
  const cf = await verifyReceipt(failed, fetchTx, { programId: PROGRAM });
  assert.equal(cf.ok, false);
  assert.match(cf.problems.join(" "), /failed on-chain/);
});

test("a pool event logged by another program in the same transaction doesn't count", async () => {
  const forger = Keypair.generate().publicKey.toBase58();
  const forged = spend(70, [nullifier(keys, d1), pad], [change, zero], 700_000_000n, hop, { forgedBy: forger });
  const r = buildReceipt(keys, mine, historyOf(leaves, new Map([[forged, { nullifiers: [nullifier(keys, d1), pad], outputs: [20, 21] }]])), { ...base, paymentTx: forged, delivery: undefined });
  const c = await verifyReceipt(r, fetchTx, { programId: PROGRAM });
  assert.equal(c.ok, false);
  assert.match(c.problems.join(" "), /aren't in that transaction's pool event/);
});

test("an ancestry of two spends verifies back to the deposit, and the owner can stop a level early", async () => {
  // W1 pays out part of d3 and keeps change c1; W2 spends c1
  const d3 = note(keys, 100, 2_000_000_000n);
  const dep3 = deposit(d3, depositor, 80);
  const c1 = note(keys, 110, 1_200_000_000n);
  const z1 = note(keys, 111, 0n);
  const p1 = randomField();
  const W1 = spend(90, [nullifier(keys, d3), p1], [c1, z1], 800_000_000n, Keypair.generate().publicKey);
  const c2 = note(keys, 120, 200_000_000n);
  const z2 = note(keys, 121, 0n);
  const p2 = randomField();
  const W2 = spend(95, [nullifier(keys, c1), p2], [c2, z2], 1_000_000_000n, hop);
  const lv = new Map(leaves);
  lv.set(100, { tx: dep3.settleTx, depositTx: dep3.depositTx });
  lv.set(110, { tx: W1, depositTx: null });
  lv.set(111, { tx: W1, depositTx: null });
  lv.set(120, { tx: W2, depositTx: null });
  lv.set(121, { tx: W2, depositTx: null });
  const sp = new Map(spends);
  sp.set(W1, { nullifiers: [nullifier(keys, d3), p1], outputs: [110, 111] });
  sp.set(W2, { nullifiers: [nullifier(keys, c1), p2], outputs: [120, 121] });
  const notes = [d3, c1, z1, c2, z2];
  const r = buildReceipt(keys, notes, historyOf(lv, sp), { network: "localnet", programId: PROGRAM, paymentTx: W2, openOutputs: true });
  assert.equal(r.payment.inputs[0].origin.kind, "change");
  const c = await verifyReceipt(r, fetchTx, { programId: PROGRAM, guard: guard.publicKey.toBase58() });
  assert.equal(c.ok, true, c.problems.join("; "));
  assert.equal(c.links, 1);
  assert.equal(c.payment?.complete, true);
  assert.deepEqual(
    c.sources.map((s) => s.kind),
    ["deposit"],
  );
  // stopping at the payment itself: the change note's earlier spend is named, not opened
  const short = buildReceipt(keys, notes, historyOf(lv, sp), { network: "localnet", programId: PROGRAM, paymentTx: W2, depth: 0 });
  const cs = await verifyReceipt(short, fetchTx, { programId: PROGRAM });
  assert.equal(cs.ok, true, cs.problems.join("; "));
  assert.deepEqual(
    cs.sources.map((s) => s.kind),
    ["unopened"],
  );
});

test("a note received privately from someone else ends the trail there, labelled as such", async () => {
  // someone else's spend made a note for this account
  const theirs = note(other, 200, 500_000_000n);
  const gift = note(keys, 210, 400_000_000n);
  const z = note(other, 211, 0n);
  const G = spend(110, [nullifier(other, theirs), randomField()], [gift, z], 100_000_000n, Keypair.generate().publicKey);
  const out1 = note(keys, 220, 0n);
  const out2 = note(keys, 221, 0n);
  const p = randomField();
  const P = spend(115, [nullifier(keys, gift), p], [out1, out2], 400_000_000n, hop);
  const lv = new Map<number, { tx: string; depositTx: string | null }>([
    [210, { tx: G, depositTx: null }],
    [220, { tx: P, depositTx: null }],
    [221, { tx: P, depositTx: null }],
  ]);
  const sp = new Map<string, { nullifiers: bigint[]; outputs: number[] }>([
    [G, { nullifiers: [nullifier(other, theirs), randomField()], outputs: [210, 211] }],
    [P, { nullifiers: [nullifier(keys, gift), p], outputs: [220, 221] }],
  ]);
  const r = buildReceipt(keys, [gift, out1, out2], historyOf(lv, sp), { network: "localnet", programId: PROGRAM, paymentTx: P, openOutputs: true });
  assert.equal(r.payment.inputs[0].origin.kind, "received");
  const c = await verifyReceipt(r, fetchTx, { programId: PROGRAM });
  assert.equal(c.ok, true, c.problems.join("; "));
  assert.deepEqual(
    c.sources.map((s) => s.kind),
    ["received"],
  );
  assert.equal(c.payment?.complete, true);
});

test("the screening pass is read from the instruction right before the deposit, and a deposit without one says so", async () => {
  const d4 = note(keys, 300, 1_000_000_000n);
  const dep4 = deposit(d4, depositor, 130, { pass: false });
  const o4 = note(keys, 310, 0n);
  const o5 = note(keys, 311, 0n);
  const p = randomField();
  const P = spend(140, [nullifier(keys, d4), p], [o4, o5], 1_000_000_000n, hop);
  const lv = new Map<number, { tx: string; depositTx: string | null }>([[300, { tx: dep4.settleTx, depositTx: dep4.depositTx }]]);
  const sp = new Map<string, { nullifiers: bigint[]; outputs: number[] }>([[P, { nullifiers: [nullifier(keys, d4), p], outputs: [310, 311] }]]);
  const r = buildReceipt(keys, [d4, o4, o5], historyOf(lv, sp), { network: "localnet", programId: PROGRAM, paymentTx: P });
  const c = await verifyReceipt(r, fetchTx, { programId: PROGRAM, guard: guard.publicKey.toBase58() });
  assert.equal(c.ok, true, c.problems.join("; "));
  const s = c.sources[0];
  assert.ok(s.kind === "deposit" && s.pass === null);
});

test("an ownership proof binds the receipt to an address it names, and only to one it names", async () => {
  const challenge = "exchange-challenge 4821";
  const message = OWNERSHIP_PROOF_PREFIX + challenge;
  const good = { address: depositor.publicKey.toBase58(), message, signature: bs58.encode(ed25519.sign(te.encode(message), depositor.secretKey.slice(0, 32))) };
  const r = buildReceipt(keys, mine, historyOf(leaves, spends), { ...base, binding: [good] });
  const c = await verifyReceipt(r, fetchTx, { programId: PROGRAM });
  assert.equal(c.ok, true, c.problems.join("; "));
  assert.deepEqual(c.bound, [depositor.publicKey.toBase58()]);
  const stranger = Keypair.generate();
  const bad = { address: stranger.publicKey.toBase58(), message, signature: bs58.encode(ed25519.sign(te.encode(message), stranger.secretKey.slice(0, 32))) };
  const c2 = await verifyReceipt(buildReceipt(keys, mine, historyOf(leaves, spends), { ...base, binding: [bad] }), fetchTx, { programId: PROGRAM });
  assert.equal(c2.ok, false);
  assert.match(c2.problems.join(" "), /doesn't name/);
  const forged = { ...good, message: OWNERSHIP_PROOF_PREFIX + "another text" };
  assert.equal((await verifyReceipt(buildReceipt(keys, mine, historyOf(leaves, spends), { ...base, binding: [forged] }), fetchTx, { programId: PROGRAM })).ok, false);
});

test("a payment that didn't spend this account's notes can't get a receipt", () => {
  assert.throws(() => buildReceipt(other, [], historyOf(leaves, spends), base), /didn't spend notes of this account/);
  assert.throws(() => buildReceipt(keys, mine, historyOf(leaves, spends), { ...base, paymentTx: sigOf(999) }), /isn't a payment from the pool/);
});

test("the transaction index: records round-trip, and only whole aligned chunks are served", () => {
  const rec = { tx: sigOf(1), slot: 123456789, depositTx: sigOf(2) };
  const [back] = decodeLeafTxs(encodeLeafTx(rec));
  assert.deepEqual(back, rec);
  assert.deepEqual(decodeLeafTxs(encodeLeafTx({ tx: sigOf(3), slot: 5, depositTx: null })), [{ tx: sigOf(3), slot: 5, depositTx: null }]);
  assert.deepEqual(decodeLeafTxs(encodeLeafTx(null)), [null], "an unknown leaf reads as unknown");
  assert.deepEqual(decodeNfTxs(encodeNfTx({ tx: sigOf(4), slot: 9 })), [{ tx: sigOf(4), slot: 9 }]);
  assert.equal(alignedChunk(0, TX_CHUNK), true);
  assert.equal(alignedChunk(TX_CHUNK * 3, TX_CHUNK), true);
  assert.equal(alignedChunk(5, TX_CHUNK), false, "a range starting at one note's index is refused");
  assert.equal(alignedChunk(0, 10), false);
  assert.deepEqual(chunkStarts(0), []);
  assert.deepEqual(chunkStarts(TX_CHUNK + 1), [0, TX_CHUNK]);
});
