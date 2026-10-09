import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { concat, equalBytes, fromLE, toLE, wideToField, FIELD } from "./field.ts";
import { H2, H3 } from "./poseidon.ts";
import type { Keys } from "./keys.ts";

/**
 * Note layout on-chain: a 32-byte leaf plus 28 bytes of metadata
 *
 *   meta = nonce(12) || tag(8) || amount XOR mask (8, little-endian)
 *
 * tag and mask come from the view key and the random nonce, so only the owner
 * can recognise a note or read its amount; to everyone else they are noise.
 */
export const META_LEN = 28;
const te = new TextEncoder();
const utf8 = (s: string) => te.encode(s);

export type OwnedNote = {
  index: number;
  leaf: bigint;
  amount: bigint;
  nonce: Uint8Array;
  blinding: bigint;
  nullifier: bigint;
};

export function randomNonce(): Uint8Array {
  const n = new Uint8Array(12);
  crypto.getRandomValues(n);
  return n;
}

export function noteBlinding(k: Keys, nonce: Uint8Array): bigint {
  return wideToField(sha512(concat(utf8("vs:blind"), k.viewKey, nonce)));
}

function tagOf(k: Keys, nonce: Uint8Array): Uint8Array {
  return sha256(concat(utf8("vs:tag"), k.viewKey, nonce)).slice(0, 8);
}

function maskOf(k: Keys, nonce: Uint8Array): Uint8Array {
  return sha256(concat(utf8("vs:amt"), k.viewKey, nonce)).slice(0, 8);
}

/** inner = Poseidon(pubKey, blinding); what a depositor hands the program. */
export function noteInner(k: Keys, nonce: Uint8Array): bigint {
  return H2(k.pubKey, noteBlinding(k, nonce));
}

export function noteLeaf(amount: bigint, inner: bigint): bigint {
  if (amount < 0n || amount >= 1n << 64n) throw new Error("amount out of range");
  return H2(amount, inner);
}

export function encodeMeta(k: Keys, nonce: Uint8Array, amount: bigint): Uint8Array {
  if (nonce.length !== 12) throw new Error("nonce must be 12 bytes");
  const enc = toLE(amount, 8);
  const mask = maskOf(k, nonce);
  for (let i = 0; i < 8; i++) enc[i] ^= mask[i];
  return concat(nonce, tagOf(k, nonce), enc);
}

export function nullifierOf(k: Keys, leaf: bigint, index: number): bigint {
  const idx = BigInt(index);
  return H3(leaf, idx, H3(k.privKey, leaf, idx));
}

/** Returns the note if `meta` was written for these keys and matches `leaf`. */
export function tryOpen(k: Keys, index: number, leaf: bigint, meta: Uint8Array): OwnedNote | null {
  if (meta.length !== META_LEN) return null;
  const nonce = meta.slice(0, 12);
  if (!equalBytes(meta.slice(12, 20), tagOf(k, nonce))) return null;
  const enc = meta.slice(20, 28);
  const mask = maskOf(k, nonce);
  const plain = new Uint8Array(8);
  for (let i = 0; i < 8; i++) plain[i] = enc[i] ^ mask[i];
  const amount = fromLE(plain);
  const blinding = noteBlinding(k, nonce);
  if (H2(amount, H2(k.pubKey, blinding)) !== leaf) return null;
  return { index, leaf, amount, nonce, blinding, nullifier: nullifierOf(k, leaf, index) };
}

/** A throwaway field element for padding inputs. */
export function randomField(): bigint {
  const b = new Uint8Array(64);
  crypto.getRandomValues(b);
  return wideToField(b) % FIELD;
}
