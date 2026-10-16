/// <reference lib="webworker" />
import "../polyfills";
import { PublicKey } from "@solana/web3.js";
import { MerkleTree, keysFromMaster, unhex, hex, toBE, provingFileProblem, type ProvingFile } from "@visionswap/sdk";
import { proveSpend } from "@visionswap/sdk/prover";

/**
 * The proving files, fetched once each and checked against the hashes pinned in the app (VS-54, see
 * sdk/src/provingfiles.ts) before anything is proved with them: a file that isn't exactly the pinned
 * one is never used. The checked bytes are kept here and handed to the prover as they are.
 */
const pinnedFiles = new Map<string, Promise<Uint8Array>>();
function pinnedFile(kind: ProvingFile, url: string): Promise<Uint8Array> {
  let p = pinnedFiles.get(url);
  if (!p) {
    p = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`The proving files couldn't be loaded (${r.status}). Please try again.`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
      const why = provingFileProblem(kind, digest, bytes.length);
      if (why) throw new Error(`The proving files didn't check out (${why}), so nothing was proved. Refresh the page and try again.`);
      return bytes;
    })();
    pinnedFiles.set(url, p);
    // a failed fetch or check is tried afresh next time
    p.catch(() => pinnedFiles.delete(url));
  }
  return p;
}

/**
 * Keeps the pool's Merkle tree and makes proofs, off the main thread so the
 * page stays smooth while a proof is computed.
 */

let tree = new MerkleTree();

type Msg =
  | { id: number; type: "reset" }
  | { id: number; type: "append"; leaves: string[] }
  /** fetch and check the proving files ahead of the first proof */
  | { id: number; type: "warm"; wasm: string; zkey: string }
  | {
      id: number;
      type: "prove";
      master: string;
      wasm: string;
      zkey: string;
      inputs: { index: number; leaf: string; amount: string; nonce: string; blinding: string; nullifier: string }[];
      outputs: { amount: string; nonce: string }[];
      ext: { recipient: string; relayer: string; withdraw: string; relayerFee: string; maxFeeBps: number };
      /** prove against the root the tree had at this many leaves (a proof held for later: see rootpolicy.ts in the SDK) */
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
    } else if (m.type === "warm") {
      await Promise.all([pinnedFile("wasm", m.wasm), pinnedFile("zkey", m.zkey)]);
      post({ id: m.id, ok: true });
    } else if (m.type === "append") {
      tree.append(m.leaves.map((x) => BigInt(x)));
      post({ id: m.id, ok: true, root: tree.root().toString(), size: tree.size });
    } else if (m.type === "prove") {
      const keys = keysFromMaster(unhex(m.master));
      const sp = await proveSpend({
        keys,
        tree,
        // (the SDK refuses a root older than any of the notes, and never swaps in another root)
        ...(m.size ? { rootSize: m.size } : {}),
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
        // only files that are exactly the pinned ones
        wasm: await pinnedFile("wasm", m.wasm),
        zkey: await pinnedFile("zkey", m.zkey),
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
