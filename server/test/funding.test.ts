import { test } from "node:test";
import assert from "node:assert/strict";
import { fundingSince, fundingWalk, type FundingTx } from "../src/funding.ts";

const tx = (t: Partial<FundingTx> & Pick<FundingTx, "gain" | "post">): FundingTx => ({ payers: [], refunded: [], queued: [], ...t });
const pay = (from: string, gain: number, post: number) => tx({ gain, post, payers: [from] });
/** a deposit into the waiting room (`post` 0 when it empties the address) */
const move = (inner: string, post = 0) => tx({ gain: -1_000_000, post, queued: [inner] });
const handBack = (inner: string, post: number) => tx({ gain: 300_000_000, post, payers: ["Guard", "PendingPda"], refunded: [inner] });

test("only payers since the address was last empty are screened", () => {
  // newest first: a clean payment after the address was cleared; the flagged one came before
  const r = fundingSince([pay("Clean", 500_000_000, 500_000_000), move("a"), pay("Flagged", 200_000_000, 200_000_000)], false);
  assert.deepEqual(r.payers, ["Clean"]);
  assert.equal(r.complete, true);
  assert.equal(r.received, 500_000_000);
});

test("dust doesn't count as funding, but still counts as received", () => {
  const r = fundingSince([pay("Dust", 50_000, 550_000), pay("Payer", 500_000, 500_000)], true);
  assert.deepEqual(r.payers, ["Payer"]);
  assert.equal(r.received, 550_000);
  assert.equal(r.complete, true);
});

test("a deposit handed back by the pool is traced to the payers it first came from", () => {
  const r = fundingSince([handBack("a", 300_000_000), move("a"), pay("Original", 300_000_000, 300_000_000), move("b"), pay("Older", 1_000_000_000, 1_000_000_000)], false);
  assert.deepEqual(r.payers.sort(), ["Guard", "Original", "PendingPda"]);
  assert.equal(r.complete, true);
});

test("a multi-part move handed back part by part skips only its own empty point", () => {
  const r = fundingSince(
    [
      handBack("p3", 900_000_000), handBack("p2", 600_000_000), handBack("p1", 300_000_000),
      move("p3"), move("p2", 300_000_000), move("p1", 600_000_000),
      pay("Original", 900_000_000, 900_000_000),
      move("old"), pay("LongGone", 1_000_000_000, 1_000_000_000),
    ],
    false,
  );
  assert.deepEqual(r.payers.sort(), ["Guard", "Original", "PendingPda"]);
  assert.equal(r.complete, true);
});

test("a handed-back move that left change behind doesn't reach past the next empty point", () => {
  // the move left 0.01 SOL, so it has no empty point of its own
  const r = fundingSince([handBack("a", 310_000_000), move("a", 10_000_000), pay("Original", 310_000_000, 310_000_000), move("old"), pay("LongGone", 1_000_000_000, 1_000_000_000)], false);
  assert.deepEqual(r.payers.sort(), ["Guard", "Original", "PendingPda"]);
});

test("without an empty point the walk is complete only when the history ended", () => {
  const txs = [pay("A", 1_000_000, 2_000_000), pay("B", 1_000_000, 1_000_000)];
  assert.equal(fundingSince(txs, false).complete, false);
  assert.equal(fundingSince(txs, true).complete, true);
});

test("the walk pages back to the last empty point", async () => {
  const pages = [[pay("A", 1_000_000, 2_000_000)], [pay("B", 1_000_000, 1_000_000), move("x")]];
  const r = await fundingWalk(async (before) => ({ txs: pages[Number(before ?? 0)], next: String(Number(before ?? 0) + 1), ended: false }), 5);
  assert.deepEqual(r.payers, ["A", "B"]);
});

test("a busy wallet's long history screens the payers of its recent pages instead of refusing", async () => {
  let reads = 0;
  const busy = async () => {
    reads++;
    return { txs: [pay(`P${reads}`, 500_000, 9_000_000_000), ...Array.from({ length: 19 }, () => pay("Tiny", 1, 9_000_000_000))], next: `s${reads}`, ended: false };
  };
  const r = await fundingWalk(busy, 3);
  assert.equal(reads, 3);
  assert.equal(r.complete, false);
  assert.deepEqual(r.payers.sort(), ["P1", "P2", "P3"]);
});

test("pages of failed transactions still count toward the cap", async () => {
  let reads = 0;
  const r = await fundingWalk(async () => ({ txs: [], next: `s${++reads}`, ended: false }), 4);
  assert.equal(reads, 4);
  assert.equal(r.complete, false);
  assert.deepEqual(r.payers, []);
});

test("an older page that can't be read leaves the recent payers to be screened; the first page can't be skipped", async () => {
  const r = await fundingWalk(async (before) => {
    if (before) throw new Error("429 Too Many Requests");
    return { txs: [pay("Recent", 500_000, 9_000_000_000)], next: "s1", ended: false };
  }, 3);
  assert.deepEqual(r.payers, ["Recent"]);
  assert.equal(r.complete, false);
  await assert.rejects(fundingWalk(async () => { throw new Error("429 Too Many Requests"); }, 3), /429/);
});
