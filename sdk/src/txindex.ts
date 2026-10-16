import bs58 from "bs58";

/**
 * The pool's transaction index (GET /api/pool/txs): for every leaf, the transaction that created it
 * (and, for a deposit's leaf, the transaction that queued the deposit), and for every nullifier, the
 * transaction that spent it. Public chain facts only, in the same order as /api/pool/leaves and
 * /api/pool/nullifiers.
 *
 * Served only in whole, aligned chunks of TX_CHUNK records, and a client that needs any of it downloads
 * every chunk: asking for just the chunk that holds one's own note would tell the server roughly when
 * that note was made (P1-1). Never add a per-note or per-deposit lookup.
 *
 * Records (little-endian slot; all-zero signature = not known, for leaves indexed before this existed):
 *   leaf:      tx signature (64) | slot (u64) | deposit's queue tx signature (64, zero for a spend's leaf)
 *   nullifier: tx signature (64) | slot (u64)
 */
export const TX_CHUNK = 4096;
export const LEAF_TX_REC = 64 + 8 + 64;
export const NF_TX_REC = 64 + 8;

export type LeafTx = { tx: string; slot: number; depositTx: string | null };
export type NfTx = { tx: string; slot: number };

const zero = (b: Uint8Array) => b.every((x) => x === 0);

function sigBytes(sig: string | null | undefined): Uint8Array {
  if (!sig) return new Uint8Array(64);
  const b = bs58.decode(sig);
  if (b.length !== 64) throw new Error("not a transaction signature");
  return b;
}

function slotBytes(slot: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(slot))), true);
  return b;
}

export function encodeLeafTx(r: LeafTx | null): Uint8Array {
  const out = new Uint8Array(LEAF_TX_REC);
  if (!r) return out;
  out.set(sigBytes(r.tx), 0);
  out.set(slotBytes(r.slot), 64);
  out.set(sigBytes(r.depositTx), 72);
  return out;
}

export function encodeNfTx(r: NfTx | null): Uint8Array {
  const out = new Uint8Array(NF_TX_REC);
  if (!r) return out;
  out.set(sigBytes(r.tx), 0);
  out.set(slotBytes(r.slot), 64);
  return out;
}

/** The leaf records in `data` (null where not known). */
export function decodeLeafTxs(data: Uint8Array): (LeafTx | null)[] {
  if (data.length % LEAF_TX_REC) throw new Error("malformed transaction index");
  const out: (LeafTx | null)[] = [];
  for (let o = 0; o < data.length; o += LEAF_TX_REC) {
    const sig = data.subarray(o, o + 64);
    if (zero(sig)) {
      out.push(null);
      continue;
    }
    const dep = data.subarray(o + 72, o + 136);
    const slot = Number(new DataView(data.buffer, data.byteOffset + o + 64, 8).getBigUint64(0, true));
    out.push({ tx: bs58.encode(sig), slot, depositTx: zero(dep) ? null : bs58.encode(dep) });
  }
  return out;
}

/** The nullifier records in `data` (null where not known). */
export function decodeNfTxs(data: Uint8Array): (NfTx | null)[] {
  if (data.length % NF_TX_REC) throw new Error("malformed transaction index");
  const out: (NfTx | null)[] = [];
  for (let o = 0; o < data.length; o += NF_TX_REC) {
    const sig = data.subarray(o, o + 64);
    if (zero(sig)) {
      out.push(null);
      continue;
    }
    const slot = Number(new DataView(data.buffer, data.byteOffset + o + 64, 8).getBigUint64(0, true));
    out.push({ tx: bs58.encode(sig), slot });
  }
  return out;
}

/** Whether a requested range is one whole, aligned chunk (the only kind the server answers). */
export function alignedChunk(from: number, limit: number): boolean {
  return Number.isInteger(from) && from >= 0 && from % TX_CHUNK === 0 && limit === TX_CHUNK;
}

/** The start of every chunk for `total` records: 0, TX_CHUNK, 2·TX_CHUNK, …. */
export function chunkStarts(total: number): number[] {
  const out: number[] = [];
  for (let from = 0; from < total; from += TX_CHUNK) out.push(from);
  return out;
}
