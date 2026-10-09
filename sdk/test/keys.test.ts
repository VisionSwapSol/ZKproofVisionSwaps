import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import {
  keysFromMaster,
  keysFingerprint,
  visionWallet,
  depositWallet,
  randomMaster,
  encodePrivateKey,
  decodePrivateKey,
  PRIVATE_KEY_PREFIX,
} from "../src/index.ts";

test("private keys round-trip and open the same account", () => {
  for (let i = 0; i < 200; i++) {
    const m = randomMaster();
    const text = encodePrivateKey(m);
    assert.ok(text.startsWith(PRIVATE_KEY_PREFIX));
    const r = decodePrivateKey(text);
    assert.ok("master" in r);
    assert.deepEqual(r.master, m);
    assert.equal(keysFingerprint(keysFromMaster(r.master)), keysFingerprint(keysFromMaster(m)));
  }
});

test("pasting with spaces or line breaks still works", () => {
  const m = randomMaster();
  const text = encodePrivateKey(m);
  const messy = `  ${text.slice(0, 20)}\n ${text.slice(20, 35)} \t${text.slice(35)}  `;
  const r = decodePrivateKey(messy);
  assert.ok("master" in r);
  assert.deepEqual(r.master, m);
});

test("any single wrong, missing or extra character is caught", () => {
  const text = encodePrivateKey(randomMaster());
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let caught = 0;
  let tried = 0;
  for (let pos = PRIVATE_KEY_PREFIX.length; pos < text.length; pos++) {
    for (const c of ["1", "z", "Q"]) {
      if (text[pos] === c) continue;
      tried++;
      const r = decodePrivateKey(text.slice(0, pos) + c + text.slice(pos + 1));
      if ("problem" in r) caught++;
    }
    tried += 2;
    if ("problem" in decodePrivateKey(text.slice(0, pos) + text.slice(pos + 1))) caught++;
    if ("problem" in decodePrivateKey(text.slice(0, pos) + alphabet[pos % alphabet.length] + text.slice(pos))) caught++;
  }
  assert.equal(caught, tried);
});

test("a wallet's secret key is recognised and refused", () => {
  const kp = Keypair.generate();
  const asB58 = decodePrivateKey(bs58.encode(kp.secretKey));
  assert.deepEqual(asB58, { problem: "wallet-key" });
  const asJson = decodePrivateKey(JSON.stringify(Array.from(kp.secretKey)));
  assert.deepEqual(asJson, { problem: "wallet-key" });
  assert.deepEqual(decodePrivateKey("hello there"), { problem: "not-ours" });
  assert.deepEqual(decodePrivateKey("   "), { problem: "empty" });
});

test("deposit addresses are stable, distinct from Vision wallets and from each other", () => {
  const k = keysFromMaster(randomMaster());
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const d = depositWallet(k, i).publicKey.toBase58();
    const v = visionWallet(k, i).publicKey.toBase58();
    assert.notEqual(d, v);
    assert.equal(depositWallet(k, i).publicKey.toBase58(), d);
    assert.ok(!seen.has(d) && !seen.has(v));
    seen.add(d);
    seen.add(v);
  }
  const other = keysFromMaster(randomMaster());
  assert.notEqual(depositWallet(other, 0).publicKey.toBase58(), depositWallet(k, 0).publicKey.toBase58());
});
