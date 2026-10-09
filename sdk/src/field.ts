/** BN254 scalar field helpers. Everything on-chain is 32-byte big-endian. */

export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** Base field of BN254 (curve coordinates). */
export const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

export function mod(a: bigint, m: bigint = FIELD): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

export function toBE(n: bigint, len = 32): Uint8Array {
  if (n < 0n) throw new Error("negative");
  const out = new Uint8Array(len);
  let x = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("value does not fit");
  return out;
}

export function fromBE(b: Uint8Array): bigint {
  let n = 0n;
  for (const v of b) n = (n << 8n) | BigInt(v);
  return n;
}

export function toLE(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = n;
  for (let i = 0; i < len; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("value does not fit");
  return out;
}

export function fromLE(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function unhex(s: string): Uint8Array {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  if (h.length % 2) throw new Error("odd hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Uniform field element from 64 random-looking bytes (bias < 2^-250). */
export function wideToField(b64: Uint8Array): bigint {
  if (b64.length !== 64) throw new Error("need 64 bytes");
  return mod(fromBE(b64));
}
