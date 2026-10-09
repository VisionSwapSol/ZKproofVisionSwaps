/// <reference lib="webworker" />
import "../polyfills";
import { PublicKey } from "@solana/web3.js";
import { MerkleTree, keysFromMaster, unhex, hex, toBE } from "@visionswap/sdk";
import { proveSpend } from "@visionswap/sdk/prover";
import { treeAt } from "../lib/treeat";

/**
 * Keeps the pool's Merkle tree and makes proofs, off the main thread so the
 * page stays smooth while a proof is computed.
 */

let tree = new MerkleTree();

type Msg =
  | { id: number; type: "reset" }
  | { id: number; type: "append"; leaves: string[] }
  | {
      id: number;
      type: "prove";
      master: string;
      wasm: string;
      zkey: string;
      inputs: { index: number; leaf: string; amount: string; nonce: string; blinding: string; nullifier: string }[];
      outputs: { amount: string; nonce: string }[];
      ext: { recipient: string; relayer: string; withdraw: string; relayerFee: string; maxFeeBps: number };
      /** prove against the root the tree had at this many leaves (an older one the pool still accepts) */
      size?: number;
    };

const post = (m: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const b64 = (u: Uint8Array) => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const m = ev.data;
  try {
    if (m.type === "reset") {
      tree = new MerkleTree();
      post({ id: m.id, ok: true, root: tree.root().toString(), size: 0 });
    } else if (m.type === "append") {
      tree.append(m.leaves.map((x) => BigInt(x)));
      post({ id: m.id, ok: true, root: tree.root().toString(), size: tree.size });
    } else if (m.type === "prove") {
      const keys = keysFromMaster(unhex(m.master));
      const sp = await proveSpend({
        keys,
        tree: m.size && m.size < tree.size ? treeAt(tree, m.size) : tree,
        inputs: m.inputs.map((n) => ({
          index: n.index,
          leaf: BigInt(n.leaf),
          amount: BigInt(n.amount),
          nonce: unhex(n.nonce),
          blinding: BigInt(n.blinding),
          nullifier: BigInt(n.nullifier),
        })),
        outputs: m.outputs.map((o) => ({ amount: BigInt(o.amount), nonce: unhex(o.nonce) })) as [
          { amount: bigint; nonce: Uint8Array },
          { amount: bigint; nonce: Uint8Array },
        ],
        ext: {
          recipient: new PublicKey(m.ext.recipient),
          relayer: new PublicKey(m.ext.relayer),
          withdraw: BigInt(m.ext.withdraw),
          relayerFee: BigInt(m.ext.relayerFee),
          maxFeeBps: m.ext.maxFeeBps,
        },
        wasm: m.wasm,
        zkey: m.zkey,
      });
      post({
        id: m.id,
        ok: true,
        proof: b64(sp.proof),
        root: hex(toBE(sp.root)),
        nullifiers: sp.nullifiers.map((x) => hex(toBE(x))),
        commitments: sp.commitments.map((x) => hex(toBE(x))),
        meta0: b64(sp.ext.meta0),
        meta1: b64(sp.ext.meta1),
      });
    }
  } catch (e) {
    post({ id: m.id, ok: false, error: (e as Error).message });
  }
};
