import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { conn, pool } from "./chain.ts";
import { PoolStore } from "./store.ts";
import { Follower, viewOf, type Chain, type ChainState, type PendingAcct, type TxView } from "./poolsync.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";

const programId = config.programId.toBase58();
export const store = new PoolStore(config.dataDir, programId);

let lastActivity = 0;

/** Someone is using the app: follow the chain closely for a while, starting now. */
export function noteActivity() {
  const wasIdle = Date.now() - lastActivity >= 120_000;
  lastActivity = Date.now();
  // an idle server waits 30 s between looks; the first visitor shouldn't have to
  if (wasIdle && idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
    setTimeout(() => void loop(), 300).unref();
  }
}
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Rate limits, timeouts and outages: worth waiting out, never a reason to read one at a time. */
const busyError = (e: unknown) => /\b(429|500|502|503|504)\b|too many|timed? ?out|fetch failed|econn|socket|aborted/i.test(String((e as Error)?.message ?? e));

let batchOffUntil = 0;
const pdas = new Map<string, string>();

/**
 * Batches go to the configured RPC only, never the public fallback (which
 * counts a batch as one call per item), and without waiting out rate limits:
 * a refused batch just means reading four at a time for a while.
 */
const batchConn = new Connection(config.rpcUrl, {
  commitment: "confirmed",
  disableRetryOnRateLimit: true,
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30_000) }),
});

const chain: Chain = {
  async signatures(until) {
    const out = [];
    let before: string | undefined;
    for (;;) {
      const page = await conn.getSignaturesForAddress(pool.programId, { before, until: until ?? undefined, limit: 1000 });
      out.push(...page.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err })));
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    return out;
  },

  // one request for the whole chunk where the RPC takes batches, four at a time otherwise
  async transactions(sigs) {
    const opts = { maxSupportedTransactionVersion: 1, commitment: "confirmed" } as const;
    let txs: (VersionedTransactionResponse | null)[] | null = null;
    if (Date.now() > batchOffUntil) {
      try {
        txs = await batchConn.getTransactions(sigs, opts);
      } catch (e) {
        // a busy RPC may take batches again soon; one that refuses them won't
        batchOffUntil = Date.now() + (busyError(e) ? 600_000 : 3600_000);
      }
    }
    if (!txs) {
      txs = [];
      for (let k = 0; k < sigs.length; k += 4) {
        txs.push(...(await Promise.all(sigs.slice(k, k + 4).map((s) => conn.getTransaction(s, opts)))));
      }
    }
    // an RPC may answer a batch in any order: each answer is matched to its own signature
    const bySig = new Map(txs.flatMap((tx) => (tx ? [[tx.transaction.signatures[0], tx] as const] : [])));
    return sigs.map((s): TxView | null => {
      const tx = bySig.get(s);
      return tx?.meta ? viewOf(s, tx) : null;
    });
  },

  async state(accounts) {
    const keys = [pool.tree, ...accounts.map((a) => new PublicKey(a))];
    const pending = new Map<string, PendingAcct | null>();
    let slot = Number.MAX_SAFE_INTEGER;
    let tree: ReturnType<typeof pool.decodeTree> | null = null;
    for (let i = 0; i < keys.length; i += 100) {
      const r = await conn.getMultipleAccountsInfoAndContext(keys.slice(i, i + 100), "confirmed");
      slot = Math.min(slot, r.context.slot);
      r.value.forEach((a, k) => {
        const key = keys[i + k];
        if (i + k === 0) {
          if (!a) throw new Error("pool is not initialized");
          tree = pool.decodeTree(a.data);
          return;
        }
        let acct: PendingAcct | null = null;
        if (a) {
          try {
            const p = pool.decodePending(key, a.data);
            acct = { depositor: p.depositor.toBase58(), amount: p.amount, slot: p.slot, meta: p.meta };
          } catch {
            acct = { depositor: "", amount: -1n, slot: -1n, meta: new Uint8Array(0) }; // there, but not readable as a deposit
          }
        }
        pending.set(key.toBase58(), acct);
      });
    }
    const t = tree as ReturnType<typeof pool.decodeTree> | null;
    if (!t) throw new Error("pool is not initialized");
    return { slot, nextIndex: t.nextIndex, pendingLamports: t.pendingLamports, roots: t.roots, pending } satisfies ChainState;
  },

  pdaOf(inner) {
    let a = pdas.get(inner);
    if (!a) {
      if (pdas.size > 20_000) pdas.clear();
      a = pool.pending(BigInt("0x" + inner)).toBase58();
      pdas.set(inner, a);
    }
    return a;
  },
};

const main = new Follower(store, chain, programId);

/**
 * When the index and the chain disagree in a way waiting won't fix, a fresh
 * copy is built in its own folder and swapped in once it reaches the chain
 * and matches its root. The current copy keeps serving until then.
 */
const rebuildDir = join(config.dataDir, "rebuild");
let rebuild: { follower: Follower; startedAt: number } | null = null;
let lastRebuild = 0;

async function tendRebuild() {
  if (!rebuild) {
    if (!main.needsRebuild() || Date.now() - lastRebuild < 3600_000) return;
    lastRebuild = Date.now();
    mkdirSync(rebuildDir, { recursive: true });
    // an earlier attempt's progress is picked up where it stopped
    rebuild = { follower: new Follower(new PoolStore(rebuildDir, programId), chain, programId, "rebuild"), startedAt: Date.now() };
    log("indexer: rebuilding the pool index in the background; the current copy keeps serving meanwhile");
    return;
  }
  const r = rebuild.follower;
  if (!main.needsRebuild() && main.done()) {
    log("indexer: back in step with the chain; the background rebuild is no longer needed");
    rebuild = null;
    rmSync(rebuildDir, { recursive: true, force: true });
    return;
  }
  await r.syncOnce();
  if (r.done()) {
    store.adopt(r.store);
    main.restart();
    rebuild = null;
    rmSync(rebuildDir, { recursive: true, force: true });
    log("indexer: the rebuilt pool index is now serving");
  } else if (r.stuck && Date.now() - r.stuck.since > 10 * 60_000) {
    log("indexer: the background rebuild stopped at the same kind of problem; trying again later");
    rebuild = null;
  }
}

export async function syncOnce(): Promise<void> {
  await main.syncOnce();
  await tendRebuild().catch((e) => log("indexer: rebuild:", (e as Error).message.slice(0, 160)));
}

/**
 * Polls every 2.5 s while people are using the app or deposits are waiting,
 * and every 30 s otherwise, which keeps an idle server well inside a free
 * RPC plan. After a failed read it waits longer (up to a minute) before the
 * next look, so a rate-limited RPC gets room to recover.
 */
async function loop() {
  await syncOnce();
  const busy = Date.now() - lastActivity < 120_000 || store.pending.size > 0 || main.behind > 0 || !!rebuild;
  if (busy) setTimeout(() => void loop(), 2500).unref();
  else {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void loop();
    }, 30_000);
    idleTimer.unref();
  }
}

export function startIndexer() {
  void loop();
}

export function indexerStatus() {
  const s = main.status();
  return {
    state: main.stuck || s.mismatch || s.stalled ? "stuck" : rebuild ? "rebuilding" : main.lastError ? "retrying" : s.behind ? "catching-up" : "ok",
    leaves: store.count,
    chainLeaves: main.chainCount,
    nullifiers: store.nfCount,
    /** pool transactions still to read (non-zero while catching up after a restart) */
    behind: s.behind,
    waiting: store.pending.size,
    /** since the index last moved on: caught up, or applied something */
    lastSyncAgoMs: Date.now() - main.lastProgress,
    lastError: main.lastError,
    /** the pool transaction the index can't get past, if any; the last good copy keeps serving */
    stuckAt: s.stuckAt,
    stuckForSec: s.stuckForSec,
    /** pool transactions whose cut-short logs were rebuilt from their instructions */
    rebuiltTxs: main.rebuiltTxs,
    /** signatures passed over because they changed nothing in the pool */
    skipped: main.skipped,
    rebuild: rebuild ? { leaves: rebuild.follower.store.count, behind: rebuild.follower.behind } : null,
  };
}
