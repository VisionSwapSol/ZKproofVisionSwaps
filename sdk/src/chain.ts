import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import bs58 from "bs58";
import { eventsFromLogs, type PoolEvent } from "./events.ts";
import { ACCOUNT_DISC, Pool, type PendingDeposit, type PoolConfig, type TreeState } from "./program.ts";

export type TxEvents = { signature: string; slot: number; blockTime: number | null; events: PoolEvent[] };

/**
 * Reads pool history straight from an RPC node, oldest first. This is the
 * no-server path: anyone can rebuild the whole pool from the chain alone.
 * `after` resumes from a known signature (exclusive).
 */
export async function scanPoolHistory(
  conn: Connection,
  pool: Pool,
  opts: { after?: string; pageLimit?: number; concurrency?: number } = {},
): Promise<TxEvents[]> {
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(pool.programId, {
      before,
      until: opts.after,
      limit: opts.pageLimit ?? 1000,
    });
    sigs.push(...page);
    if (page.length < (opts.pageLimit ?? 1000)) break;
    before = page[page.length - 1].signature;
  }
  const ok = sigs.filter((s) => !s.err).reverse();
  const out: TxEvents[] = [];
  const conc = opts.concurrency ?? 4;
  for (let i = 0; i < ok.length; i += conc) {
    const chunk = ok.slice(i, i + conc);
    const txs = await Promise.all(
      chunk.map((s) => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" })),
    );
    txs.forEach((tx, k) => {
      if (!tx || tx.meta?.err) return;
      const events = eventsFromLogs(tx.meta?.logMessages ?? [], pool.programId.toBase58());
      if (events.length) out.push({ signature: chunk[k].signature, slot: tx.slot, blockTime: tx.blockTime ?? null, events });
    });
  }
  return out;
}

export async function fetchConfig(conn: Connection, pool: Pool): Promise<PoolConfig> {
  const a = await conn.getAccountInfo(pool.config, "confirmed");
  if (!a) throw new Error("pool is not initialized");
  return pool.decodeConfig(a.data);
}

export async function fetchTree(conn: Connection, pool: Pool): Promise<TreeState> {
  const a = await conn.getAccountInfo(pool.tree, "confirmed");
  if (!a) throw new Error("pool is not initialized");
  return pool.decodeTree(a.data);
}

/** Waiting-room deposits, optionally only those from one wallet. */
export async function fetchPending(conn: Connection, pool: Pool, depositor?: PublicKey): Promise<PendingDeposit[]> {
  const filters: { memcmp: { offset: number; bytes: string } }[] = [
    { memcmp: { offset: 0, bytes: bs58.encode(ACCOUNT_DISC.Pending) } },
  ];
  if (depositor) filters.push({ memcmp: { offset: 8, bytes: depositor.toBase58() } });
  const accts = await conn.getProgramAccounts(pool.programId, { commitment: "confirmed", filters });
  return accts.map((a) => pool.decodePending(a.pubkey, a.account.data));
}

export async function isSpent(conn: Connection, pool: Pool, nullifier: bigint): Promise<boolean> {
  return !!(await conn.getAccountInfo(pool.nullifier(nullifier), "confirmed"));
}
