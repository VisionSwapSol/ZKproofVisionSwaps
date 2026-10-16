import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVING_FILES, VERIFICATION_KEY_SHA256, provingFileName, provingFileProblem, sha256Hex } from "../src/provingfiles.ts";

const art = (name: string) => fileURLToPath(new URL(`../../circuits/artifacts/${name}`, import.meta.url));

test("the pins are the files the trusted setup's record names", { skip: !existsSync(art("TRANSCRIPT.json")) && "no circuit artifacts here" }, () => {
  const t = JSON.parse(readFileSync(art("TRANSCRIPT.json"), "utf8")) as { wasmSha256: string; finalZkeySha256: string; verificationKeySha256: string };
  assert.equal(PROVING_FILES.wasm.sha256, t.wasmSha256);
  assert.equal(PROVING_FILES.zkey.sha256, t.finalZkeySha256);
  assert.equal(VERIFICATION_KEY_SHA256, t.verificationKeySha256);
});

test("the artifacts on disk are exactly the pinned files", { skip: !existsSync(art("transaction.zkey")) && "no circuit artifacts here" }, () => {
  for (const kind of ["wasm", "zkey"] as const) {
    const bytes = readFileSync(art(PROVING_FILES[kind].name));
    const digest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(provingFileProblem(kind, digest, bytes.length), null);
  }
  const vk = readFileSync(art("verification_key.json"));
  assert.equal(createHash("sha256").update(vk).digest("hex"), VERIFICATION_KEY_SHA256);
  // the server's own copy of the verification key is the same file
  const server = fileURLToPath(new URL("../../server/zk/verification_key.json", import.meta.url));
  if (existsSync(server)) assert.equal(createHash("sha256").update(readFileSync(server)).digest("hex"), VERIFICATION_KEY_SHA256);
});

test("anything else is refused, by size or by hash", () => {
  const p = PROVING_FILES.wasm;
  assert.match(provingFileProblem("wasm", p.sha256, p.size - 1)!, /bytes/);
  assert.match(provingFileProblem("wasm", "00".repeat(32), p.size)!, /SHA-256/);
  assert.equal(provingFileProblem("wasm", p.sha256.toUpperCase(), p.size), null);
  // the hash helper agrees with node's
  const b = new TextEncoder().encode("abc");
  assert.equal(sha256Hex(b), createHash("sha256").update(b).digest("hex"));
});

test("build file names carry the first 12 characters of the pinned hash", () => {
  assert.equal(provingFileName("wasm"), `transaction-${PROVING_FILES.wasm.sha256.slice(0, 12)}.wasm`);
  assert.equal(provingFileName("zkey"), `transaction-${PROVING_FILES.zkey.sha256.slice(0, 12)}.zkey`);
});

test("a proof is made from the checked bytes themselves, as the app's proof worker hands them over", { timeout: 180_000, skip: !existsSync(art("transaction.zkey")) && "no circuit artifacts here" }, async () => {
  const { Keypair } = await import("@solana/web3.js");
  const snarkjs = await import("snarkjs");
  const { keysFromSignature } = await import("../src/keys.ts");
  const { encodeMeta, noteInner, noteLeaf, randomNonce, tryOpen } = await import("../src/notes.ts");
  const { MerkleTree } = await import("../src/tree.ts");
  const { proveSpend } = await import("../src/prover.ts");
  const bytes = {
    wasm: new Uint8Array(readFileSync(art("transaction.wasm"))),
    zkey: new Uint8Array(readFileSync(art("transaction.zkey"))),
  };
  for (const kind of ["wasm", "zkey"] as const) assert.equal(provingFileProblem(kind, sha256Hex(bytes[kind]), bytes[kind].length), null);
  const keys = keysFromSignature(new Uint8Array(64).map((_, i) => (i * 13 + 5) & 0xff));
  const tree = new MerkleTree();
  const nonce = randomNonce();
  const leaf = noteLeaf(1_000_000_000n, noteInner(keys, nonce));
  tree.append([leaf]);
  const note = tryOpen(keys, 0, leaf, encodeMeta(keys, nonce, 1_000_000_000n))!;
  const sp = await proveSpend({
    keys,
    tree,
    inputs: [note],
    outputs: [
      { amount: 600_000_000n, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient: Keypair.generate().publicKey, relayer: Keypair.generate().publicKey, withdraw: 400_000_000n, relayerFee: 1_500_000n, maxFeeBps: 80 },
    wasm: bytes.wasm,
    zkey: bytes.zkey,
  });
  const vk = JSON.parse(readFileSync(art("verification_key.json"), "utf8"));
  assert.equal(await snarkjs.groth16.verify(vk, sp.publicSignals, sp.raw), true);
});

after(async () => {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  await g.curve_bn128?.terminate();
});
