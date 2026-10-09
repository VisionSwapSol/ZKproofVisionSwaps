import { PublicKey } from "@solana/web3.js";

/**
 * Addresses from visitors. Base58 decoding takes time that grows with the square of the input,
 * so a long string could hold the whole server for seconds: the shape is checked before decoding.
 */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True when `v` has the shape of a Solana address (cheap; it may still not decode). */
export const looksLikeKey = (v: unknown): v is string => typeof v === "string" && ADDRESS.test(v);

/** A visitor's address as a PublicKey. Anything else throws a 400 (the message keeps web3.js's wording). */
export function parseKey(v: unknown): PublicKey {
  if (!looksLikeKey(v)) throw Object.assign(new Error("Invalid public key input"), { status: 400 });
  return new PublicKey(v);
}

/** An order key from a visitor's app: 64 bytes in base58, never more than 88 characters (checked before decoding). */
export const looksLikeSecret = (v: unknown): v is string => typeof v === "string" && /^[1-9A-HJ-NP-Za-km-z]{80,88}$/.test(v);
