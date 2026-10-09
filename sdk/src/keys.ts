import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { concat, wideToField, hex, toBE } from "./field.ts";
import { H1 } from "./poseidon.ts";

/**
 * The one message a wallet signs to open a VisionSwap account. Ed25519
 * signatures are deterministic, so signing it again on any device gives the
 * same keys. NEVER change this text: every key and note depends on it.
 */
export const SIGN_MESSAGE =
  "VisionSwap private account\n\n" +
  "Signing this creates the keys to your private balance.\n" +
  "It does not move funds or cost anything.\n\n" +
  "Only sign it inside the VisionSwap app. Anyone who has this signature can spend your private balance.\n\n" +
  "v1";

const te = new TextEncoder();
const utf8 = (s: string) => te.encode(s);

export type Keys = {
  /** 32-byte root secret; never leaves the browser */
  master: Uint8Array;
  /** spending key, a BN254 field element */
  privKey: bigint;
  /** Poseidon(privKey): the owner field inside every note */
  pubKey: bigint;
  /** 32 bytes; finds notes and reads amounts, cannot spend */
  viewKey: Uint8Array;
};

export function keysFromSignature(signature: Uint8Array): Keys {
  if (signature.length !== 64) throw new Error("expected a 64-byte ed25519 signature");
  const master = sha256(concat(utf8("visionswap:v1:master"), signature));
  return keysFromMaster(master);
}

export function keysFromMaster(master: Uint8Array): Keys {
  if (master.length !== 32) throw new Error("master must be 32 bytes");
  let privKey = wideToField(sha512(concat(utf8("vs:spend"), master)));
  if (privKey === 0n) privKey = 1n; // unreachable in practice
  const pubKey = H1(privKey);
  const viewKey = sha256(concat(utf8("vs:view"), master));
  return { master, privKey, pubKey, viewKey };
}

/** Short fingerprint used to confirm a wallet re-derives the same account. */
export function keysFingerprint(k: Keys): string {
  return hex(sha256(concat(utf8("vs:fp"), k.viewKey))).slice(0, 16);
}

function derivedWallet(k: Keys, domain: string, index: number): Keypair {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw new Error("bad index");
  const idx = new Uint8Array(4);
  new DataView(idx.buffer).setUint32(0, index, false);
  return Keypair.fromSeed(sha256(concat(utf8(domain), k.master, idx)));
}

/**
 * The fee wallet for "send it yourself": when the relayer is down, a payment can be submitted
 * by this wallet instead. Funded by its owner with a little SOL, which the payment pays back.
 */
export function gasWallet(k: Keys, index = 0): Keypair {
  return derivedWallet(k, "vs:gas", index);
}

/**
 * The key of order #n: a Vision wallet approves it to trade exactly an order's amount. Derived from
 * the account, so the owner's app can hand it to the order keeper again if the keeper loses it.
 */
export function orderKey(k: Keys, n: number): Keypair {
  return derivedWallet(k, "vs:order", n);
}

/** Vision wallet #i: an ordinary Solana keypair, recoverable from the same signature. */
export function visionWallet(k: Keys, index: number): Keypair {
  return derivedWallet(k, "vs:wallet", index);
}

/**
 * Deposit address #i: where SOL can be sent from any wallet or exchange (by QR
 * code or by copying the address). Only this account holds its key, so only
 * this account can move what arrives, into the pool or back out.
 */
export function depositWallet(k: Keys, index: number): Keypair {
  return derivedWallet(k, "vs:deposit", index);
}

/**
 * The one-time sending address of a private payment to an outside address: the pool pays it, and
 * it passes the SOL on to the recipient in a standard transfer. Named by the spend's change note
 * (`out0`, its first new leaf), so every proof gets its own, and the owner's app finds every one
 * again from its own notes alone: the change note is in the pool exactly when the hop was paid.
 */
export function hopWallet(k: Keys, out0: bigint): Keypair {
  return Keypair.fromSeed(sha256(concat(utf8("vs:hop:v1"), k.master, toBE(out0, 32))));
}

/**
 * Private keys for accounts opened without a wallet. The key IS the 32-byte
 * master secret, written as "vsk1" + base58(master || 4-byte checksum), so a
 * typo or a truncated copy is caught instead of opening an empty account.
 */
export const PRIVATE_KEY_PREFIX = "vsk1";

export function randomMaster(): Uint8Array {
  const m = new Uint8Array(32);
  crypto.getRandomValues(m);
  return m;
}

function keyChecksum(master: Uint8Array): Uint8Array {
  return sha256(concat(utf8("vs:key-check"), master)).slice(0, 4);
}

export function encodePrivateKey(master: Uint8Array): string {
  if (master.length !== 32) throw new Error("master must be 32 bytes");
  return PRIVATE_KEY_PREFIX + bs58.encode(concat(master, keyChecksum(master)));
}

export type KeyProblem = "empty" | "wallet-key" | "not-ours" | "typo";

/** Reads a private key back. Returns the master secret, or why the text isn't one. */
export function decodePrivateKey(text: string): { master: Uint8Array } | { problem: KeyProblem } {
  const t = text.replace(/\s+/g, "");
  if (!t) return { problem: "empty" };
  if (!t.startsWith(PRIVATE_KEY_PREFIX)) {
    // a Solana wallet's secret key is 64 bytes of base58 (87-88 characters) or a JSON byte array
    let bytes = 0;
    try {
      bytes = t.startsWith("[") ? (JSON.parse(t) as unknown[]).length : bs58.decode(t).length;
    } catch {
      /* not base58 either */
    }
    return { problem: bytes === 64 ? "wallet-key" : "not-ours" };
  }
  let raw: Uint8Array;
  try {
    raw = bs58.decode(t.slice(PRIVATE_KEY_PREFIX.length));
  } catch {
    return { problem: "typo" };
  }
  if (raw.length !== 36) return { problem: "typo" };
  const master = raw.slice(0, 32);
  const check = keyChecksum(master);
  for (let i = 0; i < 4; i++) if (raw[32 + i] !== check[i]) return { problem: "typo" };
  return { master };
}
