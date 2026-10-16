/**
 * "Prove I control this address" (P1-2): an exchange gives its customer a challenge text, and the
 * customer signs it with the address the exchange asks about (a Vision wallet, a deposit address or
 * the connected wallet). Under the EU's transfer rules, exchanges assess whether a customer owns or
 * controls a self-hosted address, and a signed message is one of the ways they accept.
 *
 * What is signed is always "VisionSwap ownership proof:\n" followed by the exchange's text, as UTF-8,
 * with the address's ed25519 key: the same thing any wallet's "sign message" signs, so anyone can
 * check it with the address alone (the /verify page does it in the browser). The prefix means the
 * signature can never be taken for a transaction, an off-chain message or one of VisionSwap's own
 * messages; a text that would read as one is refused anyway.
 *
 * Nothing about a proof goes to VisionSwap: it is made and checked on the device.
 *
 * Plain functions only (no React, no build-time settings), so the node tests can run them.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey, VersionedMessage } from "@solana/web3.js";
import bs58 from "bs58";

export const OWNERSHIP_PREFIX = "VisionSwap ownership proof:\n";
/** The longest challenge text taken (exchanges use a line or two). */
export const OWNERSHIP_MAX = 1000;

const te = new TextEncoder();

/** Whether `bytes` read as a Solana transaction message (legacy or versioned). */
export function looksLikeTransaction(bytes: Uint8Array): boolean {
  try {
    const again = VersionedMessage.deserialize(bytes).serialize();
    return again.length === bytes.length && again.every((b, i) => b === bytes[i]);
  } catch {
    return false;
  }
}

/** Why a challenge text can't be signed, or null when it can. */
export function ownershipTextProblem(text: string): string | null {
  const t = text.trim();
  if (!t) return "Paste the message the exchange gave you first.";
  if (t.length > OWNERSHIP_MAX) return `That message is longer than ${OWNERSHIP_MAX} characters. Ask the exchange for its short challenge text.`;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) return "That message has hidden control characters, so it isn't signed.";
  if (/^vs:/i.test(t)) return "That text looks like one of VisionSwap's own messages, so it isn't signed.";
  if (t.startsWith("ÿsolana offchain")) return "That text is a Solana off-chain message, which this page doesn't sign.";
  if (looksLikeTransaction(te.encode(t))) return "That text reads as a Solana transaction, so it isn't signed.";
  return null;
}

/** The exact bytes signed for a challenge: the prefix, then the text (trimmed). Throws when the text can't be signed. */
export function ownershipMessage(text: string): Uint8Array {
  const why = ownershipTextProblem(text);
  if (why) throw new Error(why);
  const bytes = te.encode(OWNERSHIP_PREFIX + text.trim());
  // (the prefix already rules this out; checked again so no path ever signs a transaction)
  if (looksLikeTransaction(bytes)) throw new Error("That text reads as a Solana transaction, so it isn't signed.");
  return bytes;
}

/** What the person hands the exchange. */
export type OwnershipProof = {
  /** the address that signed */
  address: string;
  /** the exact text signed, prefix included */
  message: string;
  /** the ed25519 signature, base58 */
  signature: string;
};

/** Signs a challenge with an address's own key (its 32-byte ed25519 seed, or a 64-byte Solana secret key). */
export function signOwnership(secretKey: Uint8Array, text: string): OwnershipProof {
  const seed = secretKey.length === 64 ? secretKey.slice(0, 32) : secretKey;
  if (seed.length !== 32) throw new Error("This key can't sign.");
  const msg = ownershipMessage(text);
  const sig = ed25519.sign(msg, seed);
  const address = new PublicKey(ed25519.getPublicKey(seed)).toBase58();
  return { address, message: new TextDecoder().decode(msg), signature: bs58.encode(sig) };
}

/** A proof from a signature some wallet made over ownershipMessage(text) (a connected wallet's signMessage). */
export function proofFrom(address: string, text: string, signature: Uint8Array): OwnershipProof {
  const msg = ownershipMessage(text);
  const proof = { address, message: new TextDecoder().decode(msg), signature: bs58.encode(signature) };
  if (!verifyOwnership(proof).ok) throw new Error("The wallet's signature doesn't check out for this address. Nothing was shared.");
  return proof;
}

/** A signature as typed or pasted: base58, hex or base64; null when it is none of them or not 64 bytes. */
export function readSignature(s: string): Uint8Array | null {
  const t = s.trim();
  const tries: (() => Uint8Array)[] = [
    () => (/^[0-9a-f]{128}$/i.test(t) ? Uint8Array.from(t.match(/../g)!.map((h) => parseInt(h, 16))) : new Uint8Array()),
    () => bs58.decode(t),
    () => (/^[A-Za-z0-9+/]{86}={0,2}$/.test(t) ? Uint8Array.from(atob(t), (c) => c.charCodeAt(0)) : new Uint8Array()),
  ];
  for (const f of tries) {
    try {
      const b = f();
      if (b.length === 64) return b;
    } catch {
      /* not this encoding */
    }
  }
  return null;
}

export type OwnershipCheck = { ok: true; address: string; text: string } | { ok: false; why: string };

/**
 * Checks a proof: that `signature` is the ed25519 signature of `message` by `address`. `message` may be
 * given with or without the prefix (an exchange checking its own challenge text pastes just that); what
 * is checked is always the prefixed text.
 */
export function verifyOwnership(p: { address: string; message: string; signature: string }): OwnershipCheck {
  let key: PublicKey;
  try {
    key = new PublicKey(p.address.trim());
  } catch {
    return { ok: false, why: "That isn't a Solana address." };
  }
  const sig = readSignature(p.signature);
  if (!sig) return { ok: false, why: "That isn't a signature: expected 64 bytes, in base58, hex or base64." };
  const raw = p.message.replace(/\r\n/g, "\n");
  const text = raw.startsWith(OWNERSHIP_PREFIX) ? raw.slice(OWNERSHIP_PREFIX.length) : raw;
  if (!text.trim()) return { ok: false, why: "Paste the message that was signed." };
  const msg = te.encode(OWNERSHIP_PREFIX + text.trim());
  let good = false;
  try {
    good = ed25519.verify(sig, msg, key.toBytes());
  } catch {
    good = false;
  }
  return good
    ? { ok: true, address: key.toBase58(), text: text.trim() }
    : { ok: false, why: "The signature doesn't match this address and message. Check that all three were copied in full." };
}
