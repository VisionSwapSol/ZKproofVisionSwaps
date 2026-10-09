import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifySpendProof, checkSpendProof, looksValid, strikeKey } from "../src/zkverify.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/spend-proof.json", import.meta.url), "utf8")) as { proof: string; inputs: string[] };
const proof = new Uint8Array(Buffer.from(fx.proof, "base64"));
const inputs = fx.inputs.map((x) => BigInt(x));

test("the bundled verifying key is the one the program was built from", () => {
  const vk = readFileSync(new URL("../zk/verification_key.json", import.meta.url));
  const rs = readFileSync(new URL("../../program/programs/vision_pool/src/constants.rs", import.meta.url), "utf8");
  const want = /verification_key\.json sha256: ([0-9a-f]{64})/.exec(rs)?.[1];
  assert.equal(createHash("sha256").update(vk).digest("hex"), want);
});

test("a real proof checks out locally", () => {
  assert.equal(verifySpendProof(proof, inputs), true);
});

test("a proof with any public input changed is refused", () => {
  for (let i = 0; i < inputs.length; i++) {
    const bad = [...inputs];
    bad[i] = bad[i] + 1n;
    assert.equal(verifySpendProof(proof, bad), false, `input ${i}`);
  }
  const flipped = proof.slice();
  flipped[200] ^= 1;
  assert.equal(verifySpendProof(flipped, inputs), false);
  assert.equal(verifySpendProof(proof.slice(0, 255), inputs), false);
});

test("the same check runs off the main thread, and too many at once are turned away as busy", async () => {
  assert.equal(await checkSpendProof(proof, inputs), true);
  const bad = [...inputs];
  bad[0] = bad[0] + 1n;
  assert.equal(await checkSpendProof(proof, bad), false);
  const all = await Promise.allSettled(Array.from({ length: 12 }, () => checkSpendProof(proof, inputs)));
  const busy = all.filter((r) => r.status === "rejected");
  assert.ok(busy.length > 0 && busy.length <= 4, `busy: ${busy.length}`);
  for (const r of busy) assert.equal((r as PromiseRejectedResult).reason.code, "busy");
  assert.ok(all.every((r) => r.status === "rejected" || r.value === true));
});

test("random bytes fail the quick check; a real proof passes it", () => {
  assert.equal(looksValid(proof, inputs), true);
  assert.equal(looksValid(new Uint8Array(256).fill(7), inputs), false);
  const big = [...inputs];
  big[0] = 2n ** 254n;
  assert.equal(looksValid(proof, big), false, "an input outside the field");
});

test("strikes count against the wider network", () => {
  assert.equal(strikeKey("1.2.3.4"), "1.2.3.0/24");
  assert.equal(strikeKey("2001:db8:aa:1::/64"), "2001:db8:aa::/48");
  assert.equal(strikeKey("something else"), "something else");
});

const status = (e: unknown) => (e as { status?: number }).status;

test("a network sending proofs that fail is paused for a while; others carry on", async () => {
  const junk = new Uint8Array(256).fill(7);
  for (const ip of ["9.8.7.1", "9.8.7.2", "9.8.7.3"]) assert.equal(await checkSpendProof(junk, inputs, ip), false);
  // the same /24 from a new address: paused, with a hint of how long
  await assert.rejects(checkSpendProof(proof, inputs, "9.8.7.4"), (e: unknown) => status(e) === 429 && (e as { retryAfter: number }).retryAfter > 500);
  assert.equal(await checkSpendProof(proof, inputs, "9.8.8.1"), true, "a neighbouring network is unaffected");
});

test("one address sending proofs that fail pauses only itself, not its neighbours", async () => {
  const junk = new Uint8Array(256).fill(7);
  for (let i = 0; i < 3; i++) assert.equal(await checkSpendProof(junk, inputs, "7.7.7.1"), false);
  await assert.rejects(checkSpendProof(proof, inputs, "7.7.7.1"), (e: unknown) => status(e) === 429);
  assert.equal(await checkSpendProof(proof, inputs, "7.7.7.2"), true, "others on the same shared network carry on");
  // its strikes were spent on its own pause: one more from a neighbour doesn't pause the network
  assert.equal(await checkSpendProof(junk, inputs, "7.7.7.3"), false);
  assert.equal(await checkSpendProof(proof, inputs, "7.7.7.4"), true);
});

test("a check turned away as busy doesn't use up the caller's own share", async () => {
  const fill = ["4.1.0.1", "4.2.0.1", "4.3.0.1", "4.4.0.1"].flatMap((ip) => [1, 2].map(() => checkSpendProof(proof, inputs, ip)));
  await assert.rejects(checkSpendProof(proof, inputs, "4.9.0.1"), (e: { code?: string }) => e.code === "busy");
  await Promise.all(fill);
  for (let i = 0; i < 20; i++) assert.equal(await checkSpendProof(proof, inputs, "4.9.0.1"), true, `check ${i + 1}`);
  await assert.rejects(checkSpendProof(proof, inputs, "4.9.0.1"), (e: unknown) => status(e) === 429);
});

test("each network has its own share of checks, a minute and at once", async () => {
  const ip = "5.5.5.5";
  const two = await Promise.allSettled([1, 2, 3].map(() => checkSpendProof(proof, inputs, ip)));
  assert.equal(two.filter((r) => r.status === "rejected" && status(r.reason) === 429).length, 1, "two at a time");
  for (let i = 0; i < 18; i++) assert.equal(await checkSpendProof(proof, inputs, ip), true);
  await assert.rejects(checkSpendProof(proof, inputs, ip), (e: unknown) => status(e) === 429 && (e as { retryAfter: number }).retryAfter <= 60);
  assert.equal(await checkSpendProof(proof, inputs, "6.6.6.6"), true, "everyone else still gets theirs");
});
