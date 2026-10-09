import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { H2, MerkleTree, type PoolEvent } from "@visionswap/sdk";
import { PoolStore } from "../src/store.ts";

const meta = (n: number) => new Uint8Array(28).fill(n);

test("the store follows the tree, survives a restart, and tracks the waiting room", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-store-"));
  try {
    const s = new PoolStore(dir, "Prog111");
    const inner = 777n;
    const amount = 2_000_000_000n;
    const leaf = H2(amount, inner);
    const tree = new MerkleTree();

    s.apply([{ kind: "queued", depositor: "Dep1", amount, inner, slot: 10n }], 1, "sig1", 10);
    assert.equal(s.pending.size, 1);

    tree.append([leaf]);
    s.apply([{ kind: "settled", index: 0, leaf, amount, meta: meta(1), root: tree.root() }], 2, "sig2", 12);
    assert.equal(s.pending.size, 0, "settling empties the waiting room");
    assert.equal(s.count, 1);

    const c0 = 11n;
    const c1 = 12n;
    tree.append([c0, c1]);
    const spent: PoolEvent = {
      kind: "spent",
      index: 1,
      commitments: [c0, c1],
      metas: [meta(2), meta(3)],
      nullifiers: [101n, 102n],
      withdraw: 500_000_000n,
      root: tree.root(),
    };
    s.apply([spent], 3, "sig3", 20);
    s.save();
    assert.equal(s.count, 3);
    assert.ok(s.isSpent(101n) && s.isSpent(102n) && !s.isSpent(103n));
    assert.equal(s.leafRange(1, 10).length, 2 * 60);

    // a gap is refused
    assert.throws(() => s.apply([{ kind: "settled", index: 9, leaf: 5n, amount: 1n, meta: meta(0), root: 0n }], 4, "sig4", 21));

    // reload from disk
    const again = new PoolStore(dir, "Prog111");
    assert.equal(again.count, 3);
    assert.equal(again.frontier.root, tree.root());
    assert.equal(again.lastSig, "sig3");
    assert.ok(again.isSpent(102n));
    assert.deepEqual(again.leafRange(0, 3), s.leafRange(0, 3));

    // a different deployment starts clean
    const other = new PoolStore(dir, "OtherProg");
    assert.equal(other.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refund removes the deposit from the waiting room", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-store-"));
  try {
    const s = new PoolStore(dir, "Prog222");
    s.apply([{ kind: "queued", depositor: "Dep2", amount: 5n, inner: 42n, slot: 1n }], 1, "a", 1);
    s.apply([{ kind: "refunded", depositor: "Dep2", amount: 5n, inner: 42n, byGuard: true }], 2, "b", 2);
    assert.equal(s.pending.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
