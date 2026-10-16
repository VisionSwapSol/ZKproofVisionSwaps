import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { concat } from "./field.ts";

/**
 * Small sealed boxes for records the server publishes to everyone but only their owner may read
 * (VS-40's status board, VS-57's delivery records). Built from SHA-256 alone, so the browser, the
 * extension and the server make and open exactly the same bytes:
 *
 *   seal(key, plain) = nonce(16) || plain XOR keystream || tag(16)
 *
 * with an encryption key and a MAC key each derived from `key` by HMAC, the keystream HMAC(encKey,
 * nonce || counter) block by block, and the tag HMAC(macKey, nonce || ciphertext) cut to 16 bytes
 * (encrypt-then-MAC). A fresh random nonce each time means two seals of the same record never look
 * alike, so watching a published list doesn't show when a record changed.
 *
 * sealTo(hop, plain) seals to an ed25519 public key (a one-time sending address): an ephemeral
 * X25519 key agrees a shared secret with the address's key turned into its X25519 form, and HKDF
 * makes the box key from it. Only whoever holds that address's private key can open it.
 */

const te = new TextEncoder();
const NONCE = 16;
const TAG = 16;
const BLOCK = 32;

const u32be = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);

function keysOf(key: Uint8Array) {
  if (key.length !== 32) throw new Error("a seal key is 32 bytes");
  return { enc: hmac(sha256, key, te.encode("vs:seal:enc")), mac: hmac(sha256, key, te.encode("vs:seal:mac")) };
}

function stream(enc: Uint8Array, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let off = 0, i = 0; off < data.length; off += BLOCK, i++) {
    const ks = hmac(sha256, enc, concat(nonce, u32be(i)));
    for (let k = 0; k < BLOCK && off + k < data.length; k++) out[off + k] = data[off + k] ^ ks[k];
  }
  return out;
}

/** Constant-time comparison of two equal-length byte strings. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Seals `plain` under a 32-byte key (`nonce`: 16 bytes, random unless a test passes its own). */
export function seal(key: Uint8Array, plain: Uint8Array, nonce: Uint8Array = randomBytes(NONCE)): Uint8Array {
  if (nonce.length !== NONCE) throw new Error("a seal nonce is 16 bytes");
  const k = keysOf(key);
  const ct = stream(k.enc, nonce, plain);
  const tag = hmac(sha256, k.mac, concat(nonce, ct)).slice(0, TAG);
  return concat(nonce, ct, tag);
}

/** What a box sealed under `key` holds, or null when it wasn't sealed under that key (or was changed). */
export function unseal(key: Uint8Array, box: Uint8Array): Uint8Array | null {
  if (box.length < NONCE + TAG) return null;
  const k = keysOf(key);
  const nonce = box.slice(0, NONCE);
  const ct = box.slice(NONCE, box.length - TAG);
  const tag = box.slice(box.length - TAG);
  if (!same(tag, hmac(sha256, k.mac, concat(nonce, ct)).slice(0, TAG))) return null;
  return stream(k.enc, nonce, ct);
}

function boxKey(shared: Uint8Array, ephPub: Uint8Array, edPub: Uint8Array): Uint8Array {
  if (shared.every((b) => b === 0)) throw new Error("bad key agreement");
  return hkdf(sha256, shared, concat(ephPub, edPub), te.encode("vs:seal-to:v1"), 32);
}

/**
 * Seals `plain` so only the holder of the ed25519 key `edPub` (32 bytes) can open it.
 * `ephSecret` (an X25519 secret) is random unless a test passes its own.
 */
export function sealTo(edPub: Uint8Array, plain: Uint8Array, ephSecret: Uint8Array = x25519.utils.randomSecretKey(), nonce?: Uint8Array): Uint8Array {
  if (edPub.length !== 32) throw new Error("an address is 32 bytes");
  const xPub = ed25519.utils.toMontgomery(edPub);
  const ephPub = x25519.getPublicKey(ephSecret);
  const key = boxKey(x25519.getSharedSecret(ephSecret, xPub), ephPub, edPub);
  return concat(ephPub, seal(key, plain, nonce));
}

/** Opens a box made by sealTo with the address's ed25519 secret seed (its first 32 bytes); null when it isn't for this key. */
export function openSealed(edSeed: Uint8Array, box: Uint8Array): Uint8Array | null {
  if (box.length < 32 + NONCE + TAG) return null;
  try {
    const seed = edSeed.slice(0, 32);
    const edPub = ed25519.getPublicKey(seed);
    const ephPub = box.slice(0, 32);
    const key = boxKey(x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(seed), ephPub), ephPub, edPub);
    return unseal(key, box.slice(32));
  } catch {
    return null;
  }
}

// ─── base64, the same in the browser, the extension and the server ───

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 3) {
    const n = (u[i] << 16) | ((u[i + 1] ?? 0) << 8) | (u[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < u.length ? B64[n & 63] : "=");
  }
  return s;
}

export function fromBase64(s: string): Uint8Array | null {
  if (typeof s !== "string" || s.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
