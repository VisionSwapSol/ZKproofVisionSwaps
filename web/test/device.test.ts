import { test } from "node:test";
import assert from "node:assert/strict";
import { accountTag, deviceKey, historyKeys, holdsFunds, isSealed, sealWith, unsealWith } from "../src/lib/device.ts";
import { backedUp, passkeyLabel, sameBytes } from "../src/lib/passkey.ts";

const aes = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

test("a sealed key opens only with the key that sealed it", async () => {
  const k = await aes();
  const s = await sealWith(k, "vsk1secret");
  assert.ok(isSealed(s));
  assert.ok(!JSON.stringify(s).includes("vsk1secret"));
  assert.equal(await unsealWith(k, s), "vsk1secret");
  await assert.rejects(unsealWith(await aes(), s));
  const ct = Uint8Array.from(atob(s.ct), (c) => c.charCodeAt(0));
  ct[0] ^= 1;
  await assert.rejects(unsealWith(k, { ...s, ct: btoa(String.fromCharCode(...ct)) }));
});

test("only sealed objects count as sealed (older versions saved plain text)", () => {
  assert.equal(isSealed("vsk1abc"), false);
  assert.equal(isSealed(null), false);
  assert.equal(isSealed({ v: 2, iv: "", ct: "" }), false);
});

test("history keys of one account, and nothing else", () => {
  const fp = "7f3a00112233aabb";
  const all = [
    `vs:act:${fp}`,
    `vs:req:${fp}`,
    `vs:jobs:${fp}`,
    `vs:orders:${fp}`,
    `vs:intent:${fp}:0`,
    `vs:intent:${fp}:12`,
    `vs:aside:${fp}`,
    `vs:walletpay:${fp}`,
    `vs:vst:${fp}`,
    `vs:vname:${fp}`,
    `vs:batch:${fp}`,
    // kept on purpose: counters, funded-address indexes, the move plan, used fee wallets, choices waiting for the owner, the backup flag
    `vs:df:${fp}`,
    `vs:dmove:${fp}`,
    `vs:found:${fp}`,
    `vs:dw:${fp}`,
    `vs:dq:${fp}`,
    `vs:vw:${fp}`,
    `vs:gas:${fp}`,
    `vs:dh:${fp}:3`,
    `vs:bk:${fp}`,
    "vs:act:other0000000000",
    `vs:act:${fp}x`,
    "vs:key",
    "vs:wallet",
  ];
  assert.deepEqual(historyKeys(fp, all), all.slice(0, 11));
});

test("account tags and passkey names", () => {
  assert.equal(accountTag("7f3a00112233aabb"), "7F3A");
  assert.equal(passkeyLabel("7F3A"), "VisionSwap private account 7F3A");
});

test("a passkey counts as synced only when the backed-up flag is set", () => {
  const ad = (flags: number) => {
    const a = new Uint8Array(37);
    a[32] = flags;
    return a;
  };
  assert.equal(backedUp(ad(0x45)), false); // UP, UV, AT: device-bound
  assert.equal(backedUp(ad(0x5d)), true); // BE + BS
  assert.equal(backedUp(ad(0x4d)), false); // eligible but not backed up yet
  assert.equal(backedUp(new Uint8Array(10)), false);
  assert.equal(backedUp(null), false);
});

test("byte comparison", () => {
  assert.ok(sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
  assert.ok(!sameBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])));
  assert.ok(!sameBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])));
});

test("storage that can't be read is an error, never \"no saved sign-in\"", async () => {
  // no IndexedDB here at all, like a storage hiccup in the browser: the caller must keep the saved sign-in
  await assert.rejects(deviceKey(false));
});

test("an account counts as holding something as soon as anything arrives", () => {
  const empty = { notes: [], waiting: [], deposits: [{ lamports: 0n, tokens: [] }], vision: [{ lamports: 0n, tokens: [] }] };
  assert.equal(holdsFunds(empty), false);
  assert.equal(holdsFunds({ ...empty, deposits: [{ lamports: 300_000_000n, tokens: [] }] }), true, "SOL at a deposit address");
  assert.equal(holdsFunds({ ...empty, deposits: [{ lamports: 0n, tokens: [{}] }] }), true, "tokens sent there");
  assert.equal(holdsFunds({ ...empty, waiting: [{}] }), true, "a deposit in the waiting room");
  assert.equal(holdsFunds({ ...empty, notes: [{}] }), true, "a private balance");
  assert.equal(holdsFunds({ ...empty, vision: [{ lamports: 5n, tokens: [] }] }), true, "a Vision wallet holding SOL");
});
