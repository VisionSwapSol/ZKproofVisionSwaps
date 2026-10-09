import { PublicKey } from "@solana/web3.js";
import { config } from "./config.ts";
import { conn } from "./chain.ts";
import { log } from "./log.ts";
import { shared } from "./flight.ts";

/**
 * Keeps an eye on the SOL the relayer and the guard hold. The relayer pays
 * for settling deposits, relayed payments and orders; the guard pays for
 * sending flagged or requested deposits back. When either runs low, the log
 * says so once (and once more when it's topped up) and /api/health shows it.
 */

export type Balance = { address: string; lamports: string | null; low: boolean; threshold: string };

type Watch = { name: string; address: string; threshold: bigint; lamports: bigint | null; low: boolean };

/** Updates one balance; returns the line to log when it crosses its threshold, either way. */
export function crossing(w: Watch, lamports: bigint): string | null {
  const low = lamports < w.threshold;
  const was = w.low;
  w.lamports = lamports;
  w.low = low;
  const sol = (v: bigint) => (Number(v) / 1e9).toFixed(4);
  if (low && !was) return `funds: the ${w.name} is low on SOL (${sol(lamports)} SOL, below ${sol(w.threshold)}). Top it up so everything keeps running.`;
  if (!low && was) return `funds: the ${w.name} is topped up again (${sol(lamports)} SOL)`;
  return null;
}

const watches: Watch[] = [];
if (config.relayer) {
  watches.push({ name: "relayer", address: config.relayer.publicKey.toBase58(), threshold: config.relayerLowLamports, lamports: null, low: false });
}
if (config.guard) {
  watches.push({ name: "guard", address: config.guard.publicKey.toBase58(), threshold: config.guardLowLamports, lamports: null, low: false });
}
let checkedAt = 0;

export async function checkFunds() {
  if (!watches.length) return;
  const accts = await conn.getMultipleAccountsInfo(watches.map((w) => new PublicKey(w.address)), "confirmed");
  checkedAt = Date.now();
  watches.forEach((w, i) => {
    const line = crossing(w, BigInt(accts[i]?.lamports ?? 0));
    if (line) log(line);
  });
}

let triedAt = 0;
/** one read at a time, and while the RPC fails, at most one try every few seconds */
const refresh = shared(() =>
  checkFunds()
    .catch(() => {})
    .finally(() => (triedAt = Date.now())),
);

/** Current balances, refreshed when older than 10 s (a failed read keeps the last one). */
export async function fundsStatus(): Promise<{ relayer: Balance | null; guard: Balance | null }> {
  if (Date.now() - checkedAt > 10_000 && Date.now() - triedAt > 3_000) await refresh();
  const view = (name: string): Balance | null => {
    const w = watches.find((x) => x.name === name);
    return w ? { address: w.address, lamports: w.lamports?.toString() ?? null, low: w.low, threshold: w.threshold.toString() } : null;
  };
  return { relayer: view("relayer"), guard: view("guard") };
}

export function startFundsWatch() {
  if (!watches.length) return;
  const tick = () => void checkFunds().catch(() => {});
  tick();
  setInterval(tick, 2 * 60_000).unref();
}
