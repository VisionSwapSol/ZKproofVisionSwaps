import * as snarkjs from "snarkjs";
import { BASE_FIELD, concat, toBE } from "./field.ts";
import { H1, H2, H3 } from "./poseidon.ts";
import type { Keys } from "./keys.ts";
import { encodeMeta, noteBlinding, randomField, type OwnedNote } from "./notes.ts";
import { MerkleTree, zeros, TREE_DEPTH } from "./tree.ts";
import { extDataHash, publicAmountFor, type ExtData } from "./extdata.ts";

export type Artifact = string | Uint8Array;

export type SpendOutput = { amount: bigint; nonce: Uint8Array };

export type SpendProof = {
  /** 256 bytes: -A || B || C, in the byte order Solana's alt_bn128 syscalls use */
  proof: Uint8Array;
  root: bigint;
  nullifiers: [bigint, bigint];
  commitments: [bigint, bigint];
  ext: ExtData;
  publicSignals: string[];
  /** the proof in snarkjs form, for off-chain verification */
  raw: Groth16Proof;
};

export type Groth16Proof = { pi_a: string[]; pi_b: string[][]; pi_c: string[] };

const art = (a: Artifact) => (typeof a === "string" ? a : { type: "mem", data: a });

function g1(x: string, y: string): Uint8Array {
  return concat(toBE(BigInt(x)), toBE(BigInt(y)));
}

/** snarkjs proof -> 256 bytes with A negated and G2 limbs as (c1, c0). */
export function toSolanaProof(p: Groth16Proof): Uint8Array {
  const ax = BigInt(p.pi_a[0]);
  const ay = BigInt(p.pi_a[1]);
  const negA = concat(toBE(ax), toBE(ay === 0n ? 0n : BASE_FIELD - ay));
  const b = concat(
    toBE(BigInt(p.pi_b[0][1])),
    toBE(BigInt(p.pi_b[0][0])),
    toBE(BigInt(p.pi_b[1][1])),
    toBE(BigInt(p.pi_b[1][0])),
  );
  const c = g1(p.pi_c[0], p.pi_c[1]);
  return concat(negA, b, c);
}

/**
 * Builds and proves a 2-in/2-out spend. Missing inputs are padded with
 * zero-value notes that need no Merkle proof.
 */
export async function proveSpend(args: {
  keys: Keys;
  tree: MerkleTree;
  inputs: OwnedNote[];
  outputs: [SpendOutput, SpendOutput];
  ext: Omit<ExtData, "meta0" | "meta1">;
  wasm: Artifact;
  zkey: Artifact;
}): Promise<SpendProof> {
  const { keys, tree, inputs, outputs } = args;
  if (inputs.length < 1 || inputs.length > 2) throw new Error("need one or two input notes");
  const sumIn = inputs.reduce((s, n) => s + n.amount, 0n);
  const sumOut = outputs[0].amount + outputs[1].amount;
  if (sumIn - args.ext.withdraw !== sumOut) throw new Error("amounts do not balance");
  if (args.ext.relayerFee > args.ext.withdraw) throw new Error("relayer fee exceeds withdraw");

  const ext: ExtData = {
    ...args.ext,
    meta0: encodeMeta(keys, outputs[0].nonce, outputs[0].amount),
    meta1: encodeMeta(keys, outputs[1].nonce, outputs[1].amount),
  };
  const root = tree.root();
  const z = zeros();

  const ins = inputs.map((n) => {
    const { pathElements } = tree.path(n.index);
    if (tree.leaf(n.index) !== n.leaf) throw new Error(`leaf ${n.index} does not match the tree`);
    return {
      amount: n.amount,
      priv: keys.privKey,
      blinding: n.blinding,
      index: BigInt(n.index),
      path: pathElements,
      nullifier: n.nullifier,
    };
  });
  while (ins.length < 2) {
    const priv = randomField();
    const blinding = randomField();
    const leaf = H2(0n, H2(H1(priv), blinding));
    const sig = H3(priv, leaf, 0n);
    ins.push({
      amount: 0n,
      priv,
      blinding,
      index: 0n,
      path: z.slice(0, TREE_DEPTH),
      nullifier: H3(leaf, 0n, sig),
    });
  }

  const outBlind = outputs.map((o) => noteBlinding(keys, o.nonce));
  const commitments = outputs.map((o, i) => H2(o.amount, H2(keys.pubKey, outBlind[i]))) as [bigint, bigint];
  const nullifiers = [ins[0].nullifier, ins[1].nullifier] as [bigint, bigint];
  if (nullifiers[0] === nullifiers[1]) throw new Error("duplicate input note");

  const s = (x: bigint) => x.toString();
  const input = {
    root: s(root),
    publicAmount: s(publicAmountFor(ext.withdraw)),
    extDataHash: s(extDataHash(ext)),
    inputNullifier: nullifiers.map(s),
    outputCommitment: commitments.map(s),
    inAmount: ins.map((i) => s(i.amount)),
    inPrivateKey: ins.map((i) => s(i.priv)),
    inBlinding: ins.map((i) => s(i.blinding)),
    inPathIndex: ins.map((i) => s(i.index)),
    inPathElements: ins.map((i) => i.path.map(s)),
    outAmount: outputs.map((o) => s(o.amount)),
    outPubkey: outputs.map(() => s(keys.pubKey)),
    outBlinding: outBlind.map(s),
  };

  const { proof, publicSignals } = (await snarkjs.groth16.fullProve(input, art(args.wasm), art(args.zkey))) as {
    proof: Groth16Proof;
    publicSignals: string[];
  };
  return { proof: toSolanaProof(proof), root, nullifiers, commitments, ext, publicSignals, raw: proof };
}

/** Check a proof off-chain with the verification key (used by tests and the relayer). */
export async function verifyOffchain(vk: object, publicSignals: string[], proof: Groth16Proof): Promise<boolean> {
  return snarkjs.groth16.verify(vk, publicSignals, proof);
}
