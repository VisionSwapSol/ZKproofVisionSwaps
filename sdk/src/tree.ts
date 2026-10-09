import { H2 } from "./poseidon.ts";

export const TREE_DEPTH = 26;

let ZEROS: bigint[] | null = null;
/** zeros[i] = root of an empty subtree of height i (zeros[0] = 0, the empty leaf). */
export function zeros(): bigint[] {
  if (ZEROS) return ZEROS;
  const z = [0n];
  for (let i = 0; i < TREE_DEPTH; i++) z.push(H2(z[i], z[i]));
  ZEROS = z;
  return z;
}

/**
 * Append-only Poseidon Merkle tree that mirrors the on-chain one. Built from
 * every leaf in the pool, so no server ever learns which leaf is yours.
 */
export class MerkleTree {
  readonly depth: number;
  private layers: bigint[][];

  constructor(leaves: bigint[] = [], depth = TREE_DEPTH) {
    this.depth = depth;
    this.layers = Array.from({ length: depth + 1 }, () => []);
    if (leaves.length) this.append(leaves);
  }

  get size(): number {
    return this.layers[0].length;
  }

  leaf(i: number): bigint {
    return this.layers[0][i];
  }

  append(leaves: bigint[]) {
    if (!leaves.length) return;
    const z = zeros();
    let start = this.layers[0].length;
    if (start + leaves.length > 2 ** this.depth) throw new Error("tree full");
    this.layers[0].push(...leaves);
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const cur = this.layers[lvl];
      const up = this.layers[lvl + 1];
      const from = start >> 1;
      const to = (cur.length - 1) >> 1;
      for (let i = from; i <= to; i++) {
        const l = cur[2 * i];
        const r = 2 * i + 1 < cur.length ? cur[2 * i + 1] : z[lvl];
        up[i] = H2(l, r);
      }
      start = from;
    }
  }

  root(): bigint {
    const z = zeros();
    return this.layers[this.depth][0] ?? z[this.depth];
  }

  path(index: number): { pathElements: bigint[]; pathIndex: number } {
    if (index < 0 || index >= this.size) throw new Error("index out of range");
    const z = zeros();
    const pathElements: bigint[] = [];
    let i = index;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const sib = i ^ 1;
      const layer = this.layers[lvl];
      pathElements.push(sib < layer.length ? layer[sib] : z[lvl]);
      i >>= 1;
    }
    return { pathElements, pathIndex: index };
  }
}

/**
 * Constant-memory version of the on-chain insert: keeps only the filled
 * subtrees, so a server can follow the root of a huge tree cheaply.
 */
export class Frontier {
  filled: bigint[];
  nextIndex = 0;
  root: bigint;

  constructor(state?: { filled: string[]; nextIndex: number; root: string }) {
    const z = zeros();
    if (state) {
      this.filled = state.filled.map((x) => BigInt(x));
      this.nextIndex = state.nextIndex;
      this.root = BigInt(state.root);
    } else {
      this.filled = z.slice(0, TREE_DEPTH);
      this.root = z[TREE_DEPTH];
    }
  }

  insert(leaf: bigint): number {
    const z = zeros();
    const index = this.nextIndex;
    let cur = leaf;
    let idx = index;
    for (let i = 0; i < TREE_DEPTH; i++) {
      if ((idx & 1) === 0) {
        this.filled[i] = cur;
        cur = H2(cur, z[i]);
      } else {
        cur = H2(this.filled[i], cur);
      }
      idx >>= 1;
    }
    this.root = cur;
    this.nextIndex = index + 1;
    return index;
  }

  toJSON() {
    return { filled: this.filled.map((x) => x.toString()), nextIndex: this.nextIndex, root: this.root.toString() };
  }
}
