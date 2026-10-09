import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { config, lamportsSetting } from "../src/config.ts";
import { heldBack, settleOne } from "../src/crank.ts";
import { screenedSinceStart } from "../src/guard.ts";
import { store } from "../src/indexer.ts";

test("low-balance settings take lamports or SOL, and a typo keeps the default", () => {
  assert.equal(lamportsSetting("50000000", 1n), 50_000_000n);
  assert.equal(lamportsSetting(" 0.05 ", 1n), 50_000_000n);
  assert.equal(lamportsSetting(".5", 1n), 500_000_000n);
  assert.equal(lamportsSetting("5e7", 7n), 7n);
  assert.equal(lamportsSetting("0.05 SOL", 7n), 7n);
  assert.equal(lamportsSetting(undefined, 7n), 7n);
});

test("our relayer leaves flagged and not-yet-rescreened deposits alone", () => {
  const g = (flagged: boolean, screened: boolean) => ({ isFlagged: () => flagged, screenedSinceStart: () => screened });
  assert.equal(heldBack("a", g(true, true)), "flagged");
  assert.equal(heldBack("a", g(false, false)), "unscreened");
  assert.equal(heldBack("a", g(false, true)), null);
});

test("'add it now' refuses a deposit the guard hasn't cleared since the server started", async () => {
  const saved = { relayer: config.relayer, guard: config.guard };
  const inner = "ab".repeat(32);
  try {
    config.relayer = Keypair.generate();
    config.guard = Keypair.generate();
    store.pending.set(inner, { inner, depositor: Keypair.generate().publicKey.toBase58(), amount: "1000000000", slot: "1", leaf: "00" });
    await assert.rejects(settleOne(inner), (e: Error & { status?: number }) => e.status === 503 && /paused/.test(e.message));
  } finally {
    store.pending.delete(inner);
    Object.assign(config, saved);
  }
});

test("only a deposit that was already waiting when the server started needs a re-screen first", () => {
  const saved = config.guard;
  const old = "cd".repeat(32);
  const late = "ce".repeat(32);
  try {
    config.guard = Keypair.generate();
    const rec = (inner: string, slot: string) => ({ inner, depositor: Keypair.generate().publicKey.toBase58(), amount: "1000000000", slot, leaf: "00" });
    store.pending.set(old, rec(old, "900"));
    store.pending.set(late, rec(late, "1001"));
    assert.equal(screenedSinceStart(old, 1000n), false, "queued before the start: its flag may have been lost");
    assert.equal(screenedSinceStart(late, 1000n), true, "queued after the start: screened for its deposit moments before");
    assert.equal(screenedSinceStart(late, null), false, "the start isn't known yet: every deposit waits for a look");
    assert.equal(screenedSinceStart("cf".repeat(32), 0n), false, "a deposit the index doesn't hold");
    store.pending.set(late, rec(late, "-1"));
    assert.equal(screenedSinceStart(late, 0n), false, "a slot that isn't a number counts as old");
  } finally {
    store.pending.delete(old);
    store.pending.delete(late);
    config.guard = saved;
  }
});
