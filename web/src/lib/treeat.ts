import { H2, zeros, type MerkleTree } from "@visionswap/sdk";

/**
 * The pool's tree as it stood when it held only its first `size` leaves: its root, and the
 * Merkle paths to that root. A proof against such an older root (one the program still accepts)
 * doesn't show the exact moment it was made. Only the nodes on the edge of the older tree are
 * worked out again; every other node is the same as today's.
 */
export function treeAt(tree: MerkleTree, size: number): MerkleTree {
  if (size < 1 || size > tree.size) throw new Error("no such tree size");
  // MerkleTree keeps every level of the tree; this reads them rather than rebuilding them
  const layers = (tree as unknown as { layers: bigint[][] }).layers;
  const z = zeros();
  const node = (lvl: number, i: number): bigint => {
    const lo = i * 2 ** lvl;
    if (lo >= size) return z[lvl];
    if (lo + 2 ** lvl <= size) return layers[lvl][i];
    return H2(node(lvl - 1, 2 * i), node(lvl - 1, 2 * i + 1));
  };
  const view = {
    depth: tree.depth,
    size,
    leaf: (i: number) => (i < size ? tree.leaf(i) : 0n),
    root: () => node(tree.depth, 0),
    path: (index: number) => {
      if (index < 0 || index >= size) throw new Error("index out of range");
      const pathElements: bigint[] = [];
      for (let lvl = 0; lvl < tree.depth; lvl++) pathElements.push(node(lvl, (index >> lvl) ^ 1));
      return { pathElements, pathIndex: index };
    },
  };
  return view as unknown as MerkleTree;
}
