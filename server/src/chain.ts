import { Connection, type Commitment } from "@solana/web3.js";
import { Pool, fetchConfig, type PoolConfig } from "@visionswap/sdk";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { shared } from "./flight.ts";

let lastFallbackLog = 0;

/**
 * Every server call tries the configured RPC first and moves on to the
 * fallback when it is rate-limited, out of credits, refusing the key or down.
 * Keeps settling deposits and relaying payments alive if the paid RPC has a
 * bad day; the request body is plain JSON, so it can be sent twice.
 */
export function rpcFetchWithFallback(primary: string, fallback?: string) {
  const urls = [primary, fallback ?? ""].filter((u, i, a) => u && a.indexOf(u) === i);
  return async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    let last: Response | null = null;
    let limited: Response | null = null;
    let lastErr: unknown = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        const r = await fetch(urls[i], { ...init, signal: AbortSignal.timeout(30_000) });
        if (r.status === 429 || r.status === 401 || r.status === 403 || r.status >= 500) {
          last = r;
          if (r.status === 429) limited ??= r;
          if (i === 0 && urls.length > 1 && Date.now() - lastFallbackLog > 60_000) {
            lastFallbackLog = Date.now();
            log(`rpc: main RPC answered ${r.status}; using the fallback for now`);
          }
          continue;
        }
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    // "too many requests" anywhere means "wait and ask again", which the RPC client does by itself
    if (limited) return limited;
    if (last) return last;
    throw lastErr instanceof Error ? lastErr : new Error("RPC unreachable");
  };
}

export const conn = new Connection(config.rpcUrl, {
  commitment: "confirmed" as Commitment,
  disableRetryOnRateLimit: false,
  fetch: rpcFetchWithFallback(config.rpcUrl, config.rpcFallbackUrl),
});
export const pool = new Pool(config.programId);

let cfgCache: { at: number; cfg: PoolConfig } | null = null;
const readCfg = shared(async () => {
  const cfg = await fetchConfig(conn, pool);
  cfgCache = { at: Date.now(), cfg };
  return cfg;
});

/** On-chain pool config, cached for 15 s (one read at a time). Throws if the pool is not initialized. */
export async function poolConfig(fresh = false): Promise<PoolConfig> {
  if (!fresh && cfgCache && Date.now() - cfgCache.at < 15_000) return cfgCache.cfg;
  return readCfg();
}

const rentCache = new Map<number, bigint>();
export async function rent(bytes: number): Promise<bigint> {
  const hit = rentCache.get(bytes);
  if (hit !== undefined) return hit;
  const v = BigInt(await conn.getMinimumBalanceForRentExemption(bytes));
  rentCache.set(bytes, v);
  return v;
}

/** Polls signature status instead of using websockets (works behind any proxy). */
export async function confirm(signature: string, timeoutMs = 60_000): Promise<"confirmed" | "failed" | "timeout"> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // one bad poll is not an answer: the transaction may already be on its way
    const st = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: false }).catch(() => null))?.value[0];
    if (st?.err) return "failed";
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return "confirmed";
    await new Promise((r) => setTimeout(r, 700));
  }
  return "timeout";
}

/**
 * Whether a simulation failed because the fee payer can't pay (no SOL for the
 * fee, or for rent it has to put up), rather than because of the deposit or
 * payment itself. Such failures mean "paused until it's topped up".
 */
export function payerUnfunded(err: unknown, logs: string[] | null = null): boolean {
  const s = typeof err === "string" ? err : JSON.stringify(err ?? "");
  if (/InsufficientFundsForFee|AccountNotFound/.test(s)) return true;
  if (/InsufficientFundsForRent/.test(s) && /"account_index":0\b/.test(s)) return true;
  // the system program refusing to move the payer's lamports (rent for an account it creates)
  return /"InstructionError":\[\d+,\{"Custom":1\}\]/.test(s) && (logs ?? []).some((l) => /insufficient lamports/i.test(l));
}
