import { ComputeBudgetProgram, PublicKey, SystemProgram, type AddressLookupTableAccount, type VersionedTransaction } from "@solana/web3.js";
import { depositFee, depositParts, maxDepositFor } from "@visionswap/sdk";

/**
 * The arithmetic and checks behind buying and selling, kept free of the page so it can be tested
 * on its own: how many notes a spend has to join first, the most that can be spent, the priority
 * fee each speed may pay, and what a swap transaction may do with a Vision wallet's funds.
 */

// ─── speed ───

export type Speed = "normal" | "fast" | "turbo";
export const SPEEDS: { v: Speed; label: string }[] = [
  { v: "normal", label: "Normal" },
  { v: "fast", label: "Fast" },
  { v: "turbo", label: "Turbo" },
];
/** The most each speed's priority fee may cost, in lamports. The server keeps to the same caps; the browser refuses anything above. */
export const SPEED_CAP: Record<Speed, bigint> = { normal: 300_000n, fast: 1_500_000n, turbo: 5_000_000n };
export const speedOf = (s: unknown): Speed => (s === "fast" || s === "turbo" ? s : "normal");

/** A typical swap's compute units, for estimating its priority fee before there is a route. */
const TYPICAL_UNITS = 300_000n;
/** Each speed's lowest price per compute unit (micro-lamports), the same floors the server uses. */
const SPEED_FLOOR: Record<Speed, bigint> = { normal: 20_000n, fast: 150_000n, turbo: 1_000_000n };
/** What a speed's priority fee usually comes to on a typical swap (the cap is only the most it may cost). */
export const speedEstimate = (s: Speed): bigint => {
  const est = (SPEED_FLOOR[s] * TYPICAL_UNITS) / 1_000_000n;
  return est < SPEED_CAP[s] ? est : SPEED_CAP[s];
};

// ─── the least a trade gives ───

/**
 * The price room (bps) that keeps a route's on-chain minimum at or above `minOut`, the least the
 * person was shown, for a route promising `outAmount`. Null when that leaves under 0.1% room
 * (the least a swap may have), so the route can't keep that promise.
 */
export function roomFor(outAmount: bigint, minOut: bigint): number | null {
  if (outAmount <= 0n || outAmount < minOut) return null;
  const bps = Number(((outAmount - minOut) * 10_000n) / outAmount);
  return bps >= 10 ? bps : null;
}

// ─── joining notes ───

/** Joining more notes than this for one spend takes too long to be worth it (each join is a proof and a relay). */
export const MAX_MERGES = 16;

export type MergePlan = {
  /** joins needed before the spend fits in one proof (which takes at most two notes) */
  merges: number;
  /** what those joins cost: one relayer fee each */
  cost: bigint;
  /** whether the spend can be made at all, joins included */
  ok: boolean;
  /** how many notes the balance is in */
  pieces: number;
};

const desc = (amounts: bigint[]) => [...amounts].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));

/**
 * How many joins a spend of `withdraw` needs. Each join puts the two largest notes together and
 * costs `fee`, so after k joins the best pair holds the k+2 largest notes, less k fees.
 */
export function mergePlan(amounts: bigint[], fee: bigint, withdraw: bigint, maxMerges = MAX_MERGES): MergePlan {
  const a = desc(amounts);
  let sum = 0n;
  for (let m = 1; m <= a.length; m++) {
    sum += a[m - 1];
    const merges = Math.max(0, m - 2);
    if (merges > maxMerges) break;
    if (sum - BigInt(merges) * fee >= withdraw) return { merges, cost: BigInt(merges) * fee, ok: true, pieces: a.length };
  }
  return { merges: 0, cost: 0n, ok: false, pieces: a.length };
}

/** The largest single spend (before fees) the notes allow, joins included. */
export function maxWithdraw(amounts: bigint[], fee: bigint, maxMerges = MAX_MERGES): bigint {
  const a = desc(amounts);
  let sum = 0n;
  let best = 0n;
  for (let m = 1; m <= a.length && m - 2 <= maxMerges; m++) {
    sum += a[m - 1];
    const w = sum - BigInt(Math.max(0, m - 2)) * fee;
    if (w > best) best = w;
  }
  return best;
}

// ─── moving SOL back into the pool ───

/**
 * What a Vision wallet can put into the pool: everything but the network fee, the waiting-room
 * rent (it comes back later) and, while it still holds tokens, the reserve that pays for selling
 * them. `fit` is the largest deposit whose fee fits in a budget. Zero when that is below the
 * smallest deposit.
 */
export function sweepAmount(p: { lamports: bigint; reclaim: bigint; txFee: bigint; rentPending: bigint; reserve: bigint; minDeposit: bigint; fit: (budget: bigint) => bigint }): {
  budget: bigint;
  amount: bigint;
} {
  const budget = p.lamports + p.reclaim - p.txFee - p.rentPending - p.reserve;
  const amount = budget > 0n ? p.fit(budget) : 0n;
  return { budget, amount: amount >= p.minDeposit ? amount : 0n };
}

/**
 * How a Vision wallet's SOL goes back into the pool: in as few deposits as the pool's per-deposit
 * limit allows, each paying its own fee, waiting-room rent and network fee (`txFee`, the largest
 * any part pays), and keeping the reserve while it still holds tokens. [] when not even the
 * smallest deposit fits.
 */
export function sweepParts(p: { lamports: bigint; reclaim: bigint; txFee: bigint; rentPending: bigint; reserve: bigint; feeBps: number; min: bigint; max: bigint }): bigint[] {
  return depositParts(p.lamports + p.reclaim - p.reserve, { rentPending: p.rentPending, txFee: p.txFee, feeBps: p.feeBps, min: p.min, max: p.max });
}

/**
 * The last deposit of a move, from what the address holds now: the most that fits within the
 * limit, and the rounding dust that rides along so the address ends at exactly zero. No dust while
 * a reserve stays, and never more than a sliver: anything that can keep the address open stays there.
 */
export function lastPart(p: { lamports: bigint; txFee: bigint; rentPending: bigint; reserve: bigint; feeBps: number; max: bigint; rentWallet: bigint }): { amount: bigint; dust: bigint } {
  const budget = p.lamports - p.rentPending - p.txFee - p.reserve;
  let amount = maxDepositFor(budget, p.feeBps);
  if (amount > p.max) amount = p.max;
  let dust = budget - amount - depositFee(amount, p.feeBps);
  if (p.reserve > 0n || dust < 0n || dust >= p.rentWallet) dust = 0n;
  return { amount, dust };
}

/**
 * Whether another deposit's worth is still there after the last part went in (more arrived during
 * the move, beyond what the limit let the last part take): then the move isn't finished.
 */
export function leftOver(p: { lamports: bigint; txFee: bigint; rentPending: bigint; reserve: bigint; feeBps: number; amount: bigint; dust: bigint; nextTxFee: bigint; min: bigint; max: bigint }): boolean {
  const rest = p.lamports - p.txFee - p.rentPending - p.amount - depositFee(p.amount, p.feeBps) - p.dust;
  return sweepParts({ lamports: rest, reclaim: 0n, txFee: p.nextTxFee, rentPending: p.rentPending, reserve: p.reserve, feeBps: p.feeBps, min: p.min, max: p.max }).length > 0;
}

/** What a Vision wallet or deposit address must hold, above what keeps it open, to pay a settle fee itself. */
export const SETTLE_FEE_MIN = 10_000n;

/**
 * Who pays the small fee to add an overdue waiting deposit to the pool. A deposit from a Vision
 * wallet or a deposit address pays from that same address when it can, otherwise the server does:
 * never the connected wallet, which would publicly tie it to that address. The connected wallet
 * pays only for its own deposit.
 */
export function settlePayer(p: { fromAddress: boolean; ownLamports: bigint | null; rentWallet: bigint; depositor: string; wallet: string | null }): "own" | "wallet" | "server" {
  // the network refuses a fee that would leave the address holding less than it needs to stay open
  if (p.fromAddress) return p.ownLamports != null && p.ownLamports >= p.rentWallet + SETTLE_FEE_MIN ? "own" : "server";
  return p.wallet !== null && p.wallet === p.depositor ? "wallet" : "server";
}

// ─── checking a swap before signing it ───

const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** Room for rent a route may wrap on top of the amount (temporary accounts). */
export const WRAP_ALLOWANCE = 3_000_000n;

const ata = (owner: PublicKey, mint: PublicKey, program: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), program.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];

const u32 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at, true);
const u64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);

/**
 * The checks on amounts and destination that sit on top of the SDK's structural check: the
 * priority fee stays within the chosen speed's cap, plain SOL leaving the wallet is no more than
 * the trade's input (plus a little rent), and the route's output lands in the wallet's own token
 * account. `tables` are the transaction's address lookup tables. Throws with a plain reason.
 */
export function checkSwapSpend(
  tx: VersionedTransaction,
  tables: AddressLookupTableAccount[],
  o: { owner: PublicKey; outputMint: string; lamportsIn: bigint; speed: Speed },
): void {
  const msg = tx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
  const budget = ComputeBudgetProgram.programId.toBase58();
  const system = SystemProgram.programId.toBase58();
  let units = 200_000n * BigInt(msg.compiledInstructions.length);
  let price = 0n;
  let sent = 0n;
  const mint = new PublicKey(o.outputMint);
  const mine = new Set([TOKEN_PROGRAM, TOKEN_2022].map((p) => ata(o.owner, mint, p).toBase58()));
  let lands = false;
  for (const ix of msg.compiledInstructions) {
    const prog = keys.get(ix.programIdIndex)?.toBase58();
    const d = ix.data;
    if (prog === budget) {
      // SetComputeUnitLimit (2, u32) and SetComputeUnitPrice (3, u64 micro-lamports)
      if (d[0] === 2 && d.length >= 5) units = BigInt(u32(d, 1));
      if (d[0] === 3 && d.length >= 9) price = u64(d, 1);
    } else if (prog === system && d.length >= 12 && u32(d, 0) === 2) {
      sent += u64(d, 4);
    } else if (prog === JUPITER && ix.accountKeyIndexes.some((k) => msg.isAccountWritable(k) && mine.has(keys.get(k)?.toBase58() ?? ""))) {
      lands = true;
    }
  }
  if ((units * price + 999_999n) / 1_000_000n > SPEED_CAP[o.speed]) throw new Error("The swap's network fee is higher than the speed you chose allows.");
  if (sent > o.lamportsIn + WRAP_ALLOWANCE) throw new Error("The swap would use more SOL than this trade.");
  if (!lands) throw new Error("The swap's tokens would land somewhere other than this Vision wallet.");
}
