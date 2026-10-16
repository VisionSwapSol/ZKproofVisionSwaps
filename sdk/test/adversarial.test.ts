// Adversarial tests for the circuit and the Groth16 check (pre-audit VS-33), with the real
// circuit (transaction.wasm), proving key and verification key in circuits/artifacts.
//
// Circuit cases build the circuit's input the way proveSpend does, bend one value, and
// ask the real witness generator, which runs every `===` check of the circuit. Each case
// names the exact line of circuits/src/transaction.circom that must refuse it, so deleting
// or weakening that check makes the case fail. Verifier cases take one honest proof and
// change its public signals or its points, then run snarkjs's verifier with the real key.
//
// Scope: the witness generator also computes signals the circuit assigns without
// constraining (`<--`, inside circomlib's Num2Bits and IsEqual), so those constraints are
// covered by a mutation sweep or a constraint solver rather than here. The on-chain verifier has its own tests in
// program/programs/vision_pool/src/adversarial_tests.rs.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import { bn254 } from "@noble/curves/bn254.js";
import * as snarkjs from "snarkjs";
import { keysFromSignature } from "../src/keys.ts";
import { encodeMeta, noteInner, noteLeaf, randomNonce, tryOpen, nullifierOf, noteBlinding, type OwnedNote } from "../src/notes.ts";
import { MerkleTree, zeros } from "../src/tree.ts";
import { proveSpend, toSolanaProof, type Groth16Proof, type SpendProof } from "../src/prover.ts";
import { extDataHash, publicAmountFor, type ExtData } from "../src/extdata.ts";
import { H1, H2, H3 } from "../src/poseidon.ts";
import { FIELD, BASE_FIELD, fromBE } from "../src/field.ts";

const here = dirname(fileURLToPath(import.meta.url));
const art = join(here, "..", "..", "circuits", "artifacts");
const wasmFile = join(art, "transaction.wasm");
const zkey = join(art, "transaction.zkey");
const vk = JSON.parse(readFileSync(join(art, "verification_key.json"), "utf8"));
const wasm = { type: "mem", data: new Uint8Array(readFileSync(wasmFile)) };

const keys = keysFromSignature(new Uint8Array(64).map((_, i) => (i * 53 + 7) & 0xff));
const s = (x: bigint) => x.toString();
const TWO64 = 1n << 64n;

// ───── one honest spend of two real notes ─────

type In = { amount: bigint; priv: bigint; blinding: bigint; index: bigint; path: bigint[] };
type Out = { amount: bigint; blinding: bigint };

const leafOf = (i: In) => H2(i.amount, H2(H1(i.priv), i.blinding));
const nullifierFor = (i: In) => H3(leafOf(i), i.index, H3(i.priv, leafOf(i), i.index));
const commitmentOf = (o: Out) => H2(o.amount, H2(keys.pubKey, o.blinding));

/** The circuit's input, built exactly as proveSpend builds it, with any value overridable. */
function circuitInput(o: { root: bigint; ins: In[]; outs: Out[]; publicAmount: bigint; extHash: bigint }, override: Record<string, unknown> = {}) {
  return {
    root: s(o.root),
    publicAmount: s(o.publicAmount),
    extDataHash: s(o.extHash),
    inputNullifier: o.ins.map((i) => s(nullifierFor(i))),
    outputCommitment: o.outs.map((x) => s(commitmentOf(x))),
    inAmount: o.ins.map((i) => s(i.amount)),
    inPrivateKey: o.ins.map((i) => s(i.priv)),
    inBlinding: o.ins.map((i) => s(i.blinding)),
    inPathIndex: o.ins.map((i) => s(i.index)),
    inPathElements: o.ins.map((i) => i.path.map(s)),
    outAmount: o.outs.map((x) => s(x.amount)),
    outPubkey: o.outs.map(() => s(keys.pubKey)),
    outBlinding: o.outs.map((x) => s(x.blinding)),
    ...override,
  };
}

/**
 * Runs the real witness generator. Returns the public signals, or, when the circuit refuses
 * the input, the line of circuits/src/transaction.circom whose check failed.
 */
async function run(input: object): Promise<{ signals: bigint[] } | { line: number }> {
  const out = { type: "mem" };
  const quiet = console.error;
  console.error = () => {}; // the generator prints each failed assertion; the test reads it from the error
  try {
    await snarkjs.wtns.calculate(input, wasm, out);
  } catch (e) {
    const m = /Transaction_\d+ line: (\d+)/.exec((e as Error).message);
    if (!m) throw e;
    return { line: Number(m[1]) };
  } finally {
    console.error = quiet;
  }
  const w = (await snarkjs.wtns.exportJson(out)) as bigint[];
  return { signals: w.slice(1, 8).map((x) => BigInt(x)) };
}

async function witness(input: object): Promise<bigint[] | null> {
  const r = await run(input);
  return "signals" in r ? r.signals : null;
}

/** transaction.circom lines of the checks the cases below expect to fail */
const LINE = {
  nullifier: 109, // inNullifier[i].out === inputNullifier[i]
  inIndexRange: 113, // Num2Bits(levels) on inPathIndex
  inAmountRange: 87, // Num2Bits(64) on inAmount
  root: 126, // ForceEqualIfEnabled(root, computed root) when inAmount != 0
  commitment: 143, // outLeaf[i].out === outputCommitment[i]
  outAmountRange: 146, // Num2Bits(64) on outAmount
  sameNullifier: 159, // IsEqual(inputNullifier[i], inputNullifier[j]).out === 0
  conservation: 165, // sumIns + publicAmount === sumOuts
};

/** Asserts the circuit refuses the input at exactly that check. */
async function refused(input: object, line: number, what: string) {
  const r = await run(input);
  assert.ok("line" in r, `${what}: the circuit accepted it`);
  assert.equal((r as { line: number }).line, line, `${what}: refused by another check`);
}

const tree = new MerkleTree();
const filler = (n: number) => H2(BigInt(n), H2(11n, 22n));
let noteA: OwnedNote;
let noteB: OwnedNote;
let base: { root: bigint; ins: In[]; outs: Out[]; publicAmount: bigint; extHash: bigint };
let sp: SpendProof;
const withdraw = 750_000_000n;
const ext = { recipient: Keypair.generate().publicKey, relayer: Keypair.generate().publicKey, withdraw, relayerFee: 1_500_000n, maxFeeBps: 80 };

function inOf(n: OwnedNote): In {
  return { amount: n.amount, priv: keys.privKey, blinding: n.blinding, index: BigInt(n.index), path: tree.path(n.index).pathElements };
}

function note(amount: bigint, index: number): OwnedNote {
  const nonce = randomNonce();
  const leaf = noteLeaf(amount, noteInner(keys, nonce));
  tree.append([leaf]);
  assert.equal(tree.size - 1, index);
  return tryOpen(keys, index, leaf, encodeMeta(keys, nonce, amount))!;
}

before(async () => {
  tree.append([filler(1), filler(2), filler(3)]);
  noteA = note(2_000_000_000n, 3);
  tree.append([filler(4)]);
  noteB = note(500_000_000n, 5);
  tree.append([filler(6)]);
  const outs: Out[] = [
    { amount: 2_500_000_000n - withdraw, blinding: noteBlinding(keys, randomNonce()) },
    { amount: 0n, blinding: noteBlinding(keys, randomNonce()) },
  ];
  base = { root: tree.root(), ins: [inOf(noteA), inOf(noteB)], outs, publicAmount: publicAmountFor(withdraw), extHash: 123n };
  sp = await proveSpend({
    keys,
    tree,
    inputs: [noteA, noteB],
    outputs: [
      { amount: 2_500_000_000n - withdraw, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext,
    wasm: wasmFile,
    zkey,
  });
});

// ───── the circuit ─────

test("circuit: the honest input has a witness, with the public signals in the program's order", async () => {
  const pub = await witness(circuitInput(base));
  assert.ok(pub);
  assert.deepEqual(pub, [
    base.root,
    base.publicAmount,
    base.extHash,
    nullifierFor(base.ins[0]),
    nullifierFor(base.ins[1]),
    commitmentOf(base.outs[0]),
    commitmentOf(base.outs[1]),
  ]);
  assert.equal(nullifierFor(base.ins[0]), noteA.nullifier, "the SDK's nullifier is the circuit's");
});

test("circuit: the same note twice in one spend is refused (and the SDK refuses to try)", async () => {
  const a = inOf(noteA);
  const twice = { ...base, ins: [a, a], outs: [{ ...base.outs[0], amount: 4_000_000_000n - withdraw }, base.outs[1]] };
  await refused(circuitInput(twice), LINE.sameNullifier, "the same note twice");
  await assert.rejects(
    proveSpend({ keys, tree, inputs: [noteA, noteA], outputs: [{ amount: 4_000_000_000n - withdraw, nonce: randomNonce() }, { amount: 0n, nonce: randomNonce() }], ext, wasm: wasmFile, zkey }),
    /duplicate input note/,
  );
});

test("circuit: one leaf at two positions has two different nullifiers", () => {
  assert.notEqual(nullifierOf(keys, noteA.leaf, 3), nullifierOf(keys, noteA.leaf, 4));
});

test("circuit: a real input needs the real root; a zero-value input needs none", async () => {
  await refused(circuitInput({ ...base, root: zeros()[26] }), LINE.root, "empty tree's root");
  await refused(circuitInput({ ...base, root: base.root + 1n }), LINE.root, "root + 1");
  const otherTree = new MerkleTree([leafOf(base.ins[0])]);
  await refused(circuitInput({ ...base, root: otherTree.root() }), LINE.root, "a tree where the note sits elsewhere");

  // padding: a zero-value input with a made-up path still proves, and adds nothing
  const pad: In = { amount: 0n, priv: 5n, blinding: 6n, index: 0n, path: zeros().slice(0, 26) };
  const onlyA = { ...base, ins: [inOf(noteA), pad], outs: [{ ...base.outs[0], amount: 2_000_000_000n - withdraw }, base.outs[1]] };
  assert.ok(await witness(circuitInput(onlyA)));
  const padWithValue = { ...onlyA, ins: [inOf(noteA), { ...pad, amount: 1n }], outs: [{ ...onlyA.outs[0], amount: onlyA.outs[0].amount + 1n }, base.outs[1]] };
  await refused(circuitInput(padWithValue), LINE.root, "an input with value must be in the tree");
});

test("circuit: a leaf index of 2^26 or more is refused", async () => {
  const a = inOf(noteA);
  const far = { ...a, index: a.index + (1n << 26n) };
  await refused(circuitInput({ ...base, ins: [far, base.ins[1]] }), LINE.inIndexRange, "index + 2^26");
});

test("circuit: amounts must fit in 64 bits, so value cannot wrap around the field", async () => {
  // out0 = r - 1 and out1 = (in - withdraw) + 1 sum to (in - withdraw) mod r: conservation holds,
  // and only the 64-bit range check stops the spend from minting r - 1
  const wrap = { ...base, outs: [{ ...base.outs[0], amount: FIELD - 1n }, { ...base.outs[1], amount: 2_500_000_000n - withdraw + 1n }] };
  await refused(circuitInput(wrap), LINE.outAmountRange, "an output of r - 1");

  const big = { ...base, outs: [{ ...base.outs[0], amount: TWO64 }, base.outs[1]], publicAmount: TWO64 - 2_500_000_000n };
  await refused(circuitInput(big), LINE.outAmountRange, "an output of 2^64");

  // the largest note there can be: 2^64 - 1 in, 2^64 - 1 out
  const maxTree = new MerkleTree();
  const maxIn: In = { amount: TWO64 - 1n, priv: keys.privKey, blinding: 77n, index: 0n, path: [] };
  maxTree.append([leafOf(maxIn)]);
  maxIn.path = maxTree.path(0).pathElements;
  const pad: In = { amount: 0n, priv: 5n, blinding: 6n, index: 0n, path: zeros().slice(0, 26) };
  const max = { root: maxTree.root(), ins: [maxIn, pad], outs: [{ amount: TWO64 - 1n, blinding: 8n }, { amount: 0n, blinding: 9n }], publicAmount: 0n, extHash: 1n };
  assert.ok(await witness(circuitInput(max)), "2^64 - 1 is a valid amount");

  const tooBigIn: In = { ...maxIn, amount: TWO64 };
  const t2 = new MerkleTree([leafOf(tooBigIn)]);
  tooBigIn.path = t2.path(0).pathElements;
  const overIn = { ...max, root: t2.root(), ins: [tooBigIn, pad], outs: [{ amount: TWO64 - 1n, blinding: 8n }, { amount: 1n, blinding: 9n }] };
  await refused(circuitInput(overIn), LINE.inAmountRange, "an input of 2^64");
});

test("circuit: value is conserved, and the nullifiers and commitments must be the real ones", async () => {
  const more = { ...base, outs: [{ ...base.outs[0], amount: base.outs[0].amount + 1n }, base.outs[1]] };
  await refused(circuitInput(more), LINE.conservation, "one lamport more out than in");
  await refused(circuitInput(base, { publicAmount: s(publicAmountFor(withdraw - 1n)) }), LINE.conservation, "a smaller withdraw");
  const n = nullifierFor(base.ins[1]);
  await refused(circuitInput(base, { inputNullifier: [s(nullifierFor(base.ins[0]) + 1n), s(n)] }), LINE.nullifier, "a made-up nullifier");
  await refused(circuitInput(base, { inputNullifier: [s(n), s(n)] }), LINE.nullifier, "the second note's nullifier twice");
  const c1 = commitmentOf(base.outs[1]);
  await refused(circuitInput(base, { outputCommitment: [s(commitmentOf(base.outs[0]) + 1n), s(c1)] }), LINE.commitment, "a made-up commitment");
});

test("circuit: it computes modulo r, so x + r is the same input as x (aliases are stopped outside it)", async () => {
  const pub = await witness(circuitInput(base, { root: s(base.root + FIELD) }));
  assert.ok(pub);
  assert.equal(pub![0], base.root, "the witness holds the reduced value");
});

// ───── the verifier, with the real verification key ─────

const verify = (signals: string[], proof: Groth16Proof = sp.raw) => snarkjs.groth16.verify(vk, signals, proof);

test("verifier: the honest proof verifies; any public signal changed does not", { timeout: 120_000 }, async () => {
  assert.equal(await verify(sp.publicSignals), true);
  for (let i = 0; i < 7; i++) {
    const bad = [...sp.publicSignals];
    bad[i] = s((BigInt(bad[i]) + 1n) % FIELD);
    assert.equal(await verify(bad), false, `signal ${i} + 1`);
  }
});

test("verifier: x + r aliases are refused by snarkjs (the program checks the same with in_field)", { timeout: 120_000 }, async () => {
  for (let i = 0; i < 7; i++) {
    const bad = [...sp.publicSignals];
    bad[i] = s(BigInt(bad[i]) + FIELD);
    assert.equal(await verify(bad), false, `signal ${i} + r`);
  }
  for (const x of sp.publicSignals) assert.ok(BigInt(x) < FIELD, "the SDK only makes canonical signals");
});

test("verifier: swapped or duplicate nullifiers, swapped commitments and other roots fail", { timeout: 120_000 }, async () => {
  const p = sp.publicSignals;
  assert.equal(await verify([p[0], p[1], p[2], p[4], p[3], p[5], p[6]]), false, "swapped nullifiers");
  assert.equal(await verify([p[0], p[1], p[2], p[3], p[3], p[5], p[6]]), false, "duplicate nullifier");
  assert.equal(await verify([p[0], p[1], p[2], p[3], p[4], p[6], p[5]]), false, "swapped commitments");
  assert.equal(await verify([s(zeros()[26]), ...p.slice(1)]), false, "empty tree's root");
  const older = new MerkleTree();
  for (let i = 0; i < 5; i++) older.append([tree.leaf(i)]);
  assert.equal(await verify([s(older.root()), ...p.slice(1)]), false, "an older root of the same tree");
});

test("verifier: publicAmount is bound, with its sign", { timeout: 120_000 }, async () => {
  const p = sp.publicSignals;
  assert.equal(p[1], s(publicAmountFor(withdraw)));
  for (const [name, v] of [
    ["withdraw + 1", publicAmountFor(withdraw + 1n)],
    ["+withdraw (would mint)", withdraw],
    ["no withdraw", 0n],
  ] as const) {
    assert.equal(await verify([p[0], s(v), ...p.slice(2)]), false, name);
  }
});

test("verifier: every ext data field is bound through extDataHash", { timeout: 180_000 }, async () => {
  const e = sp.ext;
  assert.equal(sp.publicSignals[2], s(extDataHash(e)));
  const flip = (b: Uint8Array) => {
    const c = b.slice();
    c[c.length - 1] ^= 1;
    return c;
  };
  const changed: [string, ExtData][] = [
    ["recipient", { ...e, recipient: Keypair.generate().publicKey }],
    ["relayer", { ...e, relayer: e.recipient }],
    ["withdraw", { ...e, withdraw: e.withdraw + 1n }],
    ["relayerFee", { ...e, relayerFee: e.relayerFee + 1n }],
    ["maxFeeBps", { ...e, maxFeeBps: e.maxFeeBps + 1 }],
    ["meta0", { ...e, meta0: flip(e.meta0) }],
    ["meta1", { ...e, meta1: flip(e.meta1) }],
  ];
  for (const [name, other] of changed) {
    const h = extDataHash(other);
    assert.notEqual(h, extDataHash(e), name);
    assert.ok(h < 1n << 248n, "the top byte is cleared, so the hash is always below r");
    const bad = [...sp.publicSignals];
    bad[2] = s(h);
    assert.equal(await verify(bad), false, name);
  }
});

test("ext data hash: the SDK and the program hash the same bytes", () => {
  // the same vector as ext_data_hash_matches_the_sdk_and_fits_the_field in the program's tests
  const b = (f: (i: number) => number, n: number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);
  const h = extDataHash({
    recipient: new PublicKey(b((i) => i + 1, 32)),
    relayer: new PublicKey(b((i) => i + 33, 32)),
    withdraw: 1_234_567_890n,
    relayerFee: 1_500_000n,
    maxFeeBps: 80,
    meta0: b((i) => i * 7, 28),
    meta1: b((i) => 255 - i, 28),
  });
  assert.equal(h.toString(16).padStart(64, "0"), "005667903f773df01e5f3614baec793da979ef1d7efe339b688a1ff086aaaa35");
});

// ───── proof points ─────

const { Fr } = bn254.fields;
type G1 = ReturnType<typeof bn254.G1.Point.fromAffine>;
type G2 = ReturnType<typeof bn254.G2.Point.fromAffine>;
const g1 = (p: string[]): G1 => bn254.G1.Point.fromAffine({ x: BigInt(p[0]), y: BigInt(p[1]) });
const g2 = (p: string[][]): G2 =>
  bn254.G2.Point.fromAffine({ x: { c0: BigInt(p[0][0]), c1: BigInt(p[0][1]) }, y: { c0: BigInt(p[1][0]), c1: BigInt(p[1][1]) } });
const g1j = (p: G1) => {
  const a = p.toAffine();
  return [s(a.x), s(a.y), "1"];
};
const g2j = (p: G2) => {
  const a = p.toAffine();
  return [
    [s(a.x.c0), s(a.x.c1)],
    [s(a.y.c0), s(a.y.c1)],
    ["1", "0"],
  ];
};
function randomScalar(): bigint {
  const b = new Uint8Array(64);
  crypto.getRandomValues(b);
  return (fromBE(b) % (Fr.ORDER - 1n)) + 1n;
}

test("proof points: malleated proofs", { timeout: 180_000 }, async () => {
  const p = sp.publicSignals;
  const A = g1(sp.raw.pi_a);
  const B = g2(sp.raw.pi_b);
  const C = g1(sp.raw.pi_c);
  const proof = (a: G1, b: G2, c: G1): Groth16Proof => ({ pi_a: g1j(a), pi_b: g2j(b), pi_c: g1j(c) });

  assert.equal(await verify(p, proof(A, B, C)), true, "the same proof, re-encoded");
  assert.equal(await verify(p, proof(A.negate(), B, C)), false, "-A");
  assert.equal(await verify(p, proof(A, B.negate(), C)), false, "-B");
  assert.equal(await verify(p, proof(A, B, C.negate())), false, "-C");
  assert.equal(await verify(p, proof(C, B, A)), false, "A and C swapped");

  // Groth16 proofs are malleable. (-A, -B, C) is a second valid proof, and anyone can
  // re-randomize a proof with the public delta: A' = A/s, B' = s*B + s*t*delta, C' = C + t*A.
  // So proof bytes are never unique: spends are told apart by their nullifiers.
  assert.equal(await verify(p, proof(A.negate(), B.negate(), C)), true, "(-A, -B, C)");
  const delta = g2(vk.vk_delta_2);
  const t = randomScalar();
  const sc = randomScalar();
  const A2 = A.multiply(Fr.inv(sc));
  const B2 = B.multiply(sc).add(delta.multiply(Fr.mul(sc, t)));
  const C2 = C.add(A.multiply(t));
  const rerandomized = proof(A2, B2, C2);
  assert.notDeepEqual(rerandomized, sp.raw);
  assert.equal(await verify(p, rerandomized), true, "re-randomized");
  // and the re-randomized proof still says nothing else: change a signal and it fails
  assert.equal(await verify([p[0], p[1], p[2], p[4], p[3], p[5], p[6]], rerandomized), false);
});

test("proof points: off the curve or at infinity is refused", { timeout: 120_000 }, async () => {
  const p = sp.publicSignals;
  const r = sp.raw;
  const offA = { ...r, pi_a: [r.pi_a[0], s(BigInt(r.pi_a[1]) + 1n), "1"] };
  assert.equal(await verify(p, offA), false, "A off the curve");
  const offB = { ...r, pi_b: [r.pi_b[0], [s(BigInt(r.pi_b[1][0]) + 1n), r.pi_b[1][1]], ["1", "0"]] };
  assert.equal(await verify(p, offB), false, "B off the curve");
  const infA = { ...r, pi_a: ["0", "1", "0"] };
  assert.equal(await verify(p, infA), false, "A at infinity");
  const infC = { ...r, pi_c: ["0", "1", "0"] };
  assert.equal(await verify(p, infC), false, "C at infinity");
});

test("proof points: the program's 256 bytes are -A, B as (c1, c0) halves, then C", () => {
  const bytes = toSolanaProof(sp.raw);
  const be = (at: number) => fromBE(bytes.subarray(at, at + 32));
  const A = g1(sp.raw.pi_a);
  const negA = bn254.G1.Point.fromAffine({ x: be(0), y: be(32) });
  assert.ok(negA.add(A).equals(bn254.G1.Point.ZERO), "the first point is -A");
  assert.equal(be(64), BigInt(sp.raw.pi_b[0][1]));
  assert.equal(be(96), BigInt(sp.raw.pi_b[0][0]));
  assert.equal(be(128), BigInt(sp.raw.pi_b[1][1]));
  assert.equal(be(160), BigInt(sp.raw.pi_b[1][0]));
  assert.equal(be(192), BigInt(sp.raw.pi_c[0]));
  assert.equal(be(224), BigInt(sp.raw.pi_c[1]));
  for (let at = 0; at < 256; at += 32) assert.ok(be(at) < BASE_FIELD, "every coordinate is canonical (< p)");
});

// snarkjs keeps a worker pool alive; release it so the test process can exit
after(async () => {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  await g.curve_bn128?.terminate();
});
