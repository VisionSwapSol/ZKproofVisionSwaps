import { PublicKey } from "@solana/web3.js";
import { Pool } from "./program.ts";

/**
 * What the app knows for itself, instead of taking the server's word for it. A server that names
 * another program (a typo, or an attacker who controls it) could otherwise have deposits fund a
 * copy of the pool; a raised relayer fee would be sealed into every proof.
 */

/** The pool program on mainnet. */
export const MAINNET_PROGRAM_ID = "VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6";

/** The most any proof this app makes may pay its relayer, in lamports (today's fee is about a third of it). */
export const MAX_RELAYER_FEE = 5_000_000n;

/** The program's own ceiling on the pool fee, in basis points (MAX_FEE_BPS in the program). */
export const MAX_POOL_FEE_BPS = 100;

/** The most a swap's platform fee may be, in basis points. */
export const MAX_SWAP_FEE_BPS = 100;

export type PoolFacts = {
  network: string;
  programId: string;
  feeBps: number;
  relayerFee: string;
  selfRelayCost?: string;
  sellFeeBps?: number;
  accounts?: { config: string; vault: string; tree: string };
};

/**
 * What doesn't check out in the server's description of the pool. "refuse": the page must not use
 * this pool at all (another program on mainnet, or accounts that aren't the program's own). "fees":
 * a relayer, own-payer or pool fee above its ceiling: nothing is proved with them. "swap": a swap
 * fee above its ceiling, which only swaps refuse (a pool payment never pays it).
 *
 * `official`: the app was built for (or is served from) VisionSwap's own site, which only ever runs
 * the mainnet pool. Then the pool must be the mainnet program whatever network the server names: a
 * server that says "devnet" can't name another program that way. Without it (a local or test
 * build), another network may run its own copy.
 */
export function poolProblems(info: PoolFacts, opts: { official?: boolean } = {}): { refuse: string[]; fees: string[]; swap: string[] } {
  const refuse: string[] = [];
  const fees: string[] = [];
  const swap: string[] = [];
  let program: PublicKey | null = null;
  try {
    program = new PublicKey(info.programId);
  } catch {
    refuse.push("program id is not an address");
  }
  if ((opts.official || info.network === "mainnet") && info.programId !== MAINNET_PROGRAM_ID) refuse.push("program id is not VisionSwap's");
  if (opts.official && info.network !== "mainnet") refuse.push("network is not mainnet");
  if (program && info.accounts) {
    const pool = new Pool(program);
    if (info.accounts.config !== pool.config.toBase58() || info.accounts.vault !== pool.vault.toBase58() || info.accounts.tree !== pool.tree.toBase58()) {
      refuse.push("pool accounts are not the program's own");
    }
  }
  const big = (s: string | undefined) => {
    try {
      return s == null ? null : BigInt(s);
    } catch {
      return -1n;
    }
  };
  const fee = big(info.relayerFee);
  if (fee == null || fee < 0n || fee > MAX_RELAYER_FEE) fees.push("relayer fee is above the ceiling");
  const self = big(info.selfRelayCost);
  if (self != null && (self < 0n || self > MAX_RELAYER_FEE)) fees.push("own-payer cost is above the ceiling");
  if (!Number.isInteger(info.feeBps) || info.feeBps < 0 || info.feeBps > MAX_POOL_FEE_BPS) fees.push("pool fee is above the ceiling");
  if (info.sellFeeBps != null && (!Number.isInteger(info.sellFeeBps) || info.sellFeeBps < 0 || info.sellFeeBps > MAX_SWAP_FEE_BPS)) swap.push("swap fee is above the ceiling");
  return { refuse, fees, swap };
}
