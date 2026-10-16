import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePrivateKey, encodePrivateKey, randomMaster } from "../../sdk/src/keys.ts";
import { DEV_ORIGINS, LINK_TTL_MS, SITE_ORIGIN, freshPending, isAccountKey, linkKey } from "../src/link.ts";

const key = () => encodePrivateKey(randomMaster());
const SITE = [SITE_ORIGIN];

test("isAccountKey agrees with the sdk's decodePrivateKey on real keys and on every one-character typo", () => {
  for (let n = 0; n < 40; n++) {
    const k = key();
    assert.equal(isAccountKey(k), true);
    assert.ok(!("problem" in decodePrivateKey(k)));
    // change one character of the base58 part: both refuse it (or, if it still decodes, both agree)
    const i = 4 + (n % (k.length - 4));
    const c = k[i] === "2" ? "3" : "2";
    const typo = k.slice(0, i) + c + k.slice(i + 1);
    assert.equal(isAccountKey(typo), !("problem" in decodePrivateKey(typo)), typo);
  }
});

test("isAccountKey refuses anything that isn't a key", () => {
  const k = key();
  for (const bad of [undefined, null, 42, {}, [], "", "vsk1", k.slice(0, -1), k + "1", ` ${k}`, `${k} `, k.replace("vsk1", "vsk2"), "x".repeat(500), "vsk1" + "1".repeat(200)])
    assert.equal(isAccountKey(bad), false, String(bad));
  // a wallet's secret key (64 bytes of base58) is not an account key
  assert.equal(isAccountKey("4".repeat(88)), false);
});

test("linkKey takes exactly { type: 'vs-link', key } from the website, and nothing else", () => {
  const k = key();
  assert.equal(linkKey({ type: "vs-link", key: k }, SITE_ORIGIN, SITE), k);
  // sender
  assert.equal(linkKey({ type: "vs-link", key: k }, undefined, SITE), null);
  assert.equal(linkKey({ type: "vs-link", key: k }, "https://visionswap.net.evil.com", SITE), null);
  assert.equal(linkKey({ type: "vs-link", key: k }, "https://www.visionswap.net", SITE), null);
  assert.equal(linkKey({ type: "vs-link", key: k }, "http://visionswap.net", SITE), null);
  assert.equal(linkKey({ type: "vs-link", key: k }, "chrome-extension://abcdefghijklmnopabcdefghijklmnop", SITE), null);
  assert.equal(linkKey({ type: "vs-link", key: k }, "http://localhost:5196", SITE), null, "the published build ignores the local site");
  assert.equal(linkKey({ type: "vs-link", key: k }, "http://localhost:5196", [SITE_ORIGIN, ...DEV_ORIGINS]), k, "the development build takes it");
  // shape
  assert.equal(linkKey({ type: "vs-link", key: k, extra: 1 }, SITE_ORIGIN, SITE), null);
  assert.equal(linkKey({ type: "vs-link" }, SITE_ORIGIN, SITE), null);
  assert.equal(linkKey({ type: "link", key: k }, SITE_ORIGIN, SITE), null);
  assert.equal(linkKey({ type: "vs-link", key: k.slice(0, -2) }, SITE_ORIGIN, SITE), null);
  assert.equal(linkKey([k], SITE_ORIGIN, SITE), null);
  assert.equal(linkKey(k, SITE_ORIGIN, SITE), null);
  assert.equal(linkKey(null, SITE_ORIGIN, SITE), null);
});

test("a pending link is good for two minutes, and only with a real key", () => {
  const k = key();
  const now = 1_800_000_000_000;
  assert.equal(freshPending({ key: k, at: now }, now), true);
  assert.equal(freshPending({ key: k, at: now - LINK_TTL_MS + 1 }, now), true);
  assert.equal(freshPending({ key: k, at: now - LINK_TTL_MS }, now), false, "expired at two minutes");
  assert.equal(freshPending({ key: k, at: now + 60_000 }, now), false, "a time in the future isn't trusted");
  assert.equal(freshPending({ key: k, at: "now" }, now), false);
  assert.equal(freshPending({ key: k, at: Number.NaN }, now), false);
  assert.equal(freshPending({ key: "vsk1nope", at: now }, now), false);
  assert.equal(freshPending(undefined, now), false);
  assert.equal(freshPending(null, now), false);
});
