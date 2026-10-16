import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { fromBase64, openSealed, seal, sealTo, toBase64, unseal } from "../src/seal.ts";

const te = new TextEncoder();
const td = new TextDecoder();
const key = (b: number) => new Uint8Array(32).fill(b);

test("a sealed box opens with its key and only with it", () => {
  const plain = te.encode("a status the owner reads, longer than one 32-byte block of keystream");
  const box = seal(key(7), plain);
  assert.equal(box.length, 16 + plain.length + 16);
  assert.equal(td.decode(unseal(key(7), box)!), td.decode(plain));
  assert.equal(unseal(key(8), box), null);
});

test("a changed byte anywhere stops the box from opening", () => {
  const box = seal(key(1), te.encode("hello"));
  for (let i = 0; i < box.length; i++) {
    const bad = box.slice();
    bad[i] ^= 1;
    assert.equal(unseal(key(1), bad), null, `byte ${i}`);
  }
  assert.equal(unseal(key(1), box.slice(0, 20)), null);
});

test("sealing the same record twice gives different bytes (a fresh nonce), and a fixed nonce is deterministic", () => {
  const p = te.encode("same");
  assert.notDeepEqual(seal(key(2), p), seal(key(2), p));
  const n = new Uint8Array(16).fill(9);
  assert.deepEqual(seal(key(2), p, n), seal(key(2), p, n));
});

test("a box sealed to an address opens with that address's key only", () => {
  const hop = Keypair.generate();
  const other = Keypair.generate();
  const box = sealTo(hop.publicKey.toBytes(), te.encode('{"to":"x"}'));
  assert.equal(td.decode(openSealed(hop.secretKey, box)!), '{"to":"x"}');
  assert.equal(openSealed(other.secretKey, box), null);
  // only the seed matters (a 64-byte secret key and its first 32 bytes are the same key)
  assert.equal(td.decode(openSealed(hop.secretKey.slice(0, 32), box)!), '{"to":"x"}');
  const bad = box.slice();
  bad[40] ^= 1;
  assert.equal(openSealed(hop.secretKey, bad), null);
  assert.equal(openSealed(hop.secretKey, box.slice(0, 40)), null);
});

test("base64 round-trips every length", () => {
  for (let n = 0; n < 70; n++) {
    const u = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    const s = toBase64(u);
    assert.equal(s, Buffer.from(u).toString("base64"));
    assert.deepEqual(fromBase64(s), u);
  }
  assert.equal(fromBase64("abc"), null);
  assert.equal(fromBase64("ab!d"), null);
});
