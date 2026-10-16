/**
 * The app's side of payment receipts (P1-1, behind RECEIPTS_ENABLED in lib/features.ts).
 *
 * To say which transactions made a payment's notes, the app downloads the pool's whole transaction
 * index (/api/pool/txs), every chunk, the same bytes anyone gets: fetching only the chunk that holds
 * its own note would tell the server roughly when that note was made, next to the payment being
 * proven. Nothing per note or per deposit is ever asked for, and the deposit's waiting-room account is
 * never looked up through the chain gateway.
 *
 * Plain functions only (no React, no build-time settings), so the node tests can run them.
 */
import { TX_CHUNK, chunkStarts, decodeLeafTxs, decodeNfTxs, type LeafTx, type NfTx, type ReceiptHistory } from "@visionswap/sdk";

/** Reads one binary range: its bytes, and the total the server reports (X-Total). */
export type FetchBinary = (path: string) => Promise<{ data: Uint8Array; total: number }>;

export type TxIndex = { leaves: (LeafTx | null)[]; nullifiers: (NfTx | null)[] };

/** Downloads every chunk of one kind ("leaves" or "nullifiers"), in order, whatever the caller is looking for. */
async function every(fetchBin: FetchBinary, kind: "leaves" | "nullifiers"): Promise<Uint8Array[]> {
  const first = await fetchBin(`/api/pool/txs?kind=${kind}&from=0&limit=${TX_CHUNK}`);
  const parts = [first.data];
  for (const from of chunkStarts(first.total).slice(1)) parts.push((await fetchBin(`/api/pool/txs?kind=${kind}&from=${from}&limit=${TX_CHUNK}`)).data);
  return parts;
}

/** The pool's whole transaction index. */
export async function downloadTxIndex(fetchBin: FetchBinary): Promise<TxIndex> {
  const [l, n] = [await every(fetchBin, "leaves"), await every(fetchBin, "nullifiers")];
  return { leaves: l.flatMap((d) => decodeLeafTxs(d)), nullifiers: n.flatMap((d) => decodeNfTxs(d)) };
}

/**
 * The history a receipt is built from: which transaction made each leaf, and each spend's nullifiers
 * (from the app's own copy of the pool's nullifiers, in the same order as the index) and outputs.
 */
export function historyFrom(index: TxIndex, nullifierAt: (i: number) => bigint | null): ReceiptHistory {
  const spends = new Map<string, { nullifiers: bigint[]; outputs: number[] }>();
  const of = (tx: string) => {
    let s = spends.get(tx);
    if (!s) spends.set(tx, (s = { nullifiers: [], outputs: [] }));
    return s;
  };
  index.nullifiers.forEach((r, i) => {
    const n = r ? nullifierAt(i) : null;
    if (r && n != null) of(r.tx).nullifiers.push(n);
  });
  index.leaves.forEach((r, i) => {
    if (r && !r.depositTx && spends.has(r.tx)) of(r.tx).outputs.push(i);
  });
  return {
    leafTx: (i) => {
      const r = index.leaves[i];
      return r ? { tx: r.tx, depositTx: r.depositTx } : null;
    },
    spend: (tx) => spends.get(tx) ?? null,
  };
}
