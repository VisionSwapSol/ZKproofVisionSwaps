import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import * as snarkjs from "snarkjs";
import { keysFromSignature } from "../src/keys.ts";
import { encodeMeta, noteInner, noteLeaf, randomNonce, tryOpen } from "../src/notes.ts";
import { MerkleTree, treeAt } from "../src/tree.ts";
import { expectedPublicSignals, proveSpend } from "../src/prover.ts";
import { heldRootSize, ROOT_LAG_MAX } from "../src/rootpolicy.ts";
import { H2 } from "../src/poseidon.ts";

const here = dirname(fileURLToPath(import.meta.url));
const art = join(here, "..", "..", "circuits", "artifacts");
const wasm = join(art, "transaction.wasm");
const zkey = join(art, "transaction.zkey");
const vk = JSON.parse(readFileSync(join(art, "verification_key.json"), "utf8"));
const keys = keysFromSignature(new Uint8Array(64).map((_, i) => (i * 13 + 5) & 0xff));
let filled = 0;
const filler = () => H2(BigInt(++filled), H2(31n, 47n));

test("a held proof names the older root its lag picks, and verifies", { timeout: 180_000 }, async () => {
  const tree = new MerkleTree([filler(), filler()]);
  const nonce = randomNonce();
  const amount = 900_000_000n;
  const leaf = noteLeaf(amount, noteInner(keys, nonce));
  tree.append([leaf]);
  const note = tryOpen(keys, 2, leaf, encodeMeta(keys, nonce, amount))!;
  // not mature yet: it would have to wait
  assert.ok("wait" in heldRootSize(tree.size, [note], 5));
  tree.append(Array.from({ length: ROOT_LAG_MAX + 4 }, filler));
  const at = heldRootSize(tree.size, [note], 5);
  assert.ok("size" in at && at.size === tree.size - 5);
  const sp = await proveSpend({
    keys,
    tree,
    inputs: [note],
    outputs: [
      { amount: amount - 100_000_000n, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient: Keypair.generate().publicKey, relayer: Keypair.generate().publicKey, withdraw: 100_000_000n, relayerFee: 1_500_000n, maxFeeBps: 80 },
    wasm,
    zkey,
    rootSize: at.size,
  });
  assert.equal(sp.root, treeAt(tree, at.size).root());
  assert.notEqual(sp.root, tree.root());
  assert.deepEqual(sp.publicSignals, expectedPublicSignals(sp));
  assert.equal(await snarkjs.groth16.verify(vk, sp.publicSignals, sp.raw), true);
});

test("a proof never names a root older than one of its notes", async () => {
  const tree = new MerkleTree([filler(), filler(), filler()]);
  const nonce = randomNonce();
  const leaf = noteLeaf(5n, noteInner(keys, nonce));
  tree.append([leaf, filler()]);
  const note = tryOpen(keys, 3, leaf, encodeMeta(keys, nonce, 5n))!;
  const args = {
    keys,
    tree,
    inputs: [note],
    outputs: [
      { amount: 5n, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ] as [{ amount: bigint; nonce: Uint8Array }, { amount: bigint; nonce: Uint8Array }],
    ext: { recipient: Keypair.generate().publicKey, relayer: Keypair.generate().publicKey, withdraw: 0n, relayerFee: 0n, maxFeeBps: 80 },
    wasm,
    zkey,
  };
  await assert.rejects(proveSpend({ ...args, rootSize: 3 }), /newer than the root/);
  await assert.rejects(proveSpend({ ...args, rootSize: 0 }), /no such tree size/);
  await assert.rejects(proveSpend({ ...args, rootSize: tree.size + 1 }), /no such tree size/);
});

after(async () => {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  await g.curve_bn128?.terminate();
});
