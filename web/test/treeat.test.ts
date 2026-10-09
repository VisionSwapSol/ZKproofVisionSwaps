import { test } from "node:test";
import assert from "node:assert/strict";
import { MerkleTree } from "@visionswap/sdk";
import { treeAt } from "../src/lib/treeat.ts";

test("an older tree gives the same root and paths as one built from only its leaves", () => {
  const leaves = Array.from({ length: 37 }, (_, i) => BigInt(1000 + i * 7));
  const now = new MerkleTree(leaves);
  for (const size of [1, 2, 3, 8, 16, 17, 31, 36, 37]) {
    const old = new MerkleTree(leaves.slice(0, size));
    const view = treeAt(now, size);
    assert.equal(view.root(), old.root(), `root at ${size}`);
    for (const i of [0, size - 1, Math.floor(size / 2)]) {
      assert.deepEqual(view.path(i).pathElements, old.path(i).pathElements, `path ${i} at ${size}`);
      assert.equal(view.leaf(i), old.leaf(i));
    }
    assert.throws(() => view.path(size));
  }
  assert.throws(() => treeAt(now, 38));
});
