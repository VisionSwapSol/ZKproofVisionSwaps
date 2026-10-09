import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import * as snarkjs from "snarkjs";
import { keysFromSignature, visionWallet, hopWallet } from "../src/keys.ts";
import { encodeMeta, noteInner, noteLeaf, randomNonce, tryOpen, nullifierOf } from "../src/notes.ts";
import { MerkleTree, zeros } from "../src/tree.ts";
import { proveSpend } from "../src/prover.ts";
import { extDataHash, publicAmountFor, splitWithdraw, grossUp } from "../src/extdata.ts";
import { H2 } from "../src/poseidon.ts";
import { FIELD } from "../src/field.ts";

const here = dirname(fileURLToPath(import.meta.url));
const art = join(here, "..", "..", "circuits", "artifacts");
const wasm = join(art, "transaction.wasm");
const zkey = join(art, "transaction.zkey");
const vk = JSON.parse(readFileSync(join(art, "verification_key.json"), "utf8"));

const sig = new Uint8Array(64).map((_, i) => (i * 37 + 11) & 0xff);
const keys = keysFromSignature(sig);

test("keys are deterministic and vision wallets differ", () => {
  const again = keysFromSignature(sig);
  assert.equal(again.privKey, keys.privKey);
  assert.equal(again.pubKey, keys.pubKey);
  assert.notEqual(visionWallet(keys, 0).publicKey.toBase58(), visionWallet(keys, 1).publicKey.toBase58());
  assert.equal(visionWallet(keys, 3).publicKey.toBase58(), visionWallet(again, 3).publicKey.toBase58());
});

test("notes open only for their owner", () => {
  const nonce = randomNonce();
  const amount = 1_234_567_890n;
  const leaf = noteLeaf(amount, noteInner(keys, nonce));
  const meta = encodeMeta(keys, nonce, amount);
  const mine = tryOpen(keys, 7, leaf, meta);
  assert.ok(mine);
  assert.equal(mine!.amount, amount);
  const other = keysFromSignature(new Uint8Array(64).fill(9));
  assert.equal(tryOpen(other, 7, leaf, meta), null);
  // a wrong leaf for the same meta is rejected
  assert.equal(tryOpen(keys, 7, leaf + 1n, meta), null);
});

test("empty tree root matches the zero ladder", () => {
  const t = new MerkleTree();
  assert.equal(t.root(), zeros()[26]);
  const t2 = new MerkleTree([5n]);
  let h = 5n;
  for (let i = 0; i < 26; i++) h = H2(h, zeros()[i]);
  assert.equal(t2.root(), h);
});

test("fee split and gross-up agree", () => {
  for (const want of [1n, 9_999n, 10_000_000n, 123_456_789n, 50_000_000_000n]) {
    const w = grossUp(want, 1_500_000n, 80);
    const s = splitWithdraw(w, 1_500_000n, 80);
    assert.ok(s.toRecipient >= want);
    const s1 = splitWithdraw(w - 1n, 1_500_000n, 80);
    assert.ok(s1.toRecipient < want, `gross-up not minimal for ${want}`);
  }
});

test("a withdrawal proof verifies, and tampering breaks it", { timeout: 180_000 }, async () => {
  // three deposits from other people, then ours, then two more
  const tree = new MerkleTree();
  const filler = () => H2(BigInt(Math.floor(Math.random() * 1e9)), H2(11n, 22n));
  tree.append([filler(), filler(), filler()]);
  const nonce = randomNonce();
  const amount = 2_000_000_000n; // 2 SOL
  const leaf = noteLeaf(amount, noteInner(keys, nonce));
  tree.append([leaf, filler(), filler()]);
  const note = tryOpen(keys, 3, leaf, encodeMeta(keys, nonce, amount))!;
  assert.equal(note.nullifier, nullifierOf(keys, leaf, 3));

  const recipient = Keypair.generate().publicKey;
  const relayer = Keypair.generate().publicKey;
  const withdraw = 750_000_000n;
  const t0 = Date.now();
  const sp = await proveSpend({
    keys,
    tree,
    inputs: [note],
    outputs: [
      { amount: amount - withdraw, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient, relayer, withdraw, relayerFee: 1_500_000n, maxFeeBps: 80 },
    wasm,
    zkey,
  });
  const ms = Date.now() - t0;
  console.log(`  proof generated in ${ms} ms`);
  assert.equal(sp.proof.length, 256);
  assert.equal(sp.publicSignals[0], tree.root().toString());
  assert.equal(sp.publicSignals[1], publicAmountFor(withdraw).toString());
  assert.equal(sp.publicSignals[2], extDataHash(sp.ext).toString());

  const { raw: proof, publicSignals } = sp;
  assert.equal(await snarkjs.groth16.verify(vk, publicSignals, proof), true);
  const bad = [...publicSignals];
  bad[2] = ((BigInt(bad[2]) + 1n) % FIELD).toString();
  assert.equal(await snarkjs.groth16.verify(vk, bad, proof), false, "changed extDataHash must fail");
  const bad2 = [...publicSignals];
  bad2[1] = publicAmountFor(withdraw + 1n).toString();
  assert.equal(await snarkjs.groth16.verify(vk, bad2, proof), false, "changed amount must fail");
});

test("the circuit refuses to create value", { timeout: 120_000 }, async () => {
  const tree = new MerkleTree();
  const nonce = randomNonce();
  const leaf = noteLeaf(1_000_000_000n, noteInner(keys, nonce));
  tree.append([leaf]);
  const note = tryOpen(keys, 0, leaf, encodeMeta(keys, nonce, 1_000_000_000n))!;
  // claim the note is worth more than it is
  const forged = { ...note, amount: 5_000_000_000n };
  await assert.rejects(
    proveSpend({
      keys,
      tree,
      inputs: [forged],
      outputs: [
        { amount: 1_000_000_000n, nonce: randomNonce() },
        { amount: 0n, nonce: randomNonce() },
      ],
      ext: {
        recipient: Keypair.generate().publicKey,
        relayer: Keypair.generate().publicKey,
        withdraw: 4_000_000_000n,
        relayerFee: 0n,
        maxFeeBps: 80,
      },
      wasm,
      zkey,
    }),
  );
});

test("a payment's sending address is known before its proof, and found again from its change note", { timeout: 180_000 }, async () => {
  // as the app does it: the change note's nonce is picked first, so its leaf (and the hop it names) is known before proving
  for (const change of [1_000_000_000n, 0n]) {
    const tree = new MerkleTree();
    const nonce = randomNonce();
    const amount = 1_000_000_000n + change;
    const leaf = noteLeaf(amount, noteInner(keys, nonce));
    tree.append([leaf]);
    const note = tryOpen(keys, 0, leaf, encodeMeta(keys, nonce, amount))!;
    const nonce0 = randomNonce();
    const out0 = noteLeaf(change, noteInner(keys, nonce0));
    const hop = hopWallet(keys, out0);
    const sp = await proveSpend({
      keys,
      tree,
      inputs: [note],
      outputs: [
        { amount: change, nonce: nonce0 },
        { amount: 0n, nonce: randomNonce() },
      ],
      ext: { recipient: hop.publicKey, relayer: Keypair.generate().publicKey, withdraw: 1_000_000_000n, relayerFee: 1_500_000n, maxFeeBps: 80 },
      wasm,
      zkey,
    });
    assert.equal(sp.commitments[0], out0, "the proof's change note is the one the hop was made from");
    // the owner's app, scanning its notes (any amount, zero included), makes the same hop again
    const found = tryOpen(keys, 1, sp.commitments[0], sp.ext.meta0);
    assert.ok(found, "the change note is the owner's");
    assert.equal(found!.amount, change);
    assert.ok(hopWallet(keys, found!.leaf).publicKey.equals(hop.publicKey));
  }
});

// snarkjs keeps a worker pool alive; release it so the test process can exit
after(async () => {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  await g.curve_bn128?.terminate();
});
