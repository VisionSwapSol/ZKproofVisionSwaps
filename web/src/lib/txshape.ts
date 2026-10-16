/**
 * The shapes of the transactions the app builds itself (VS-34), kept apart from the engine so the
 * draws can be tested on their own. Every delivery, deposit, move and clean-up used to carry the same
 * compute limit and price, which picked the app's transactions out on the chain. Now:
 *
 *  - a delivery's transfer (the one-time sending address paying the recipient) takes a shape drawn
 *    within the band the relayer takes (see DeliveryShape in the SDK), so it looks like any wallet's;
 *  - a deposit, a Vision wallet's move back, and a clean-up draw their compute limit and price within
 *    a safe band (never below what they were: the limit always covers the work);
 *  - the rounding sliver a deposit address or a Vision wallet can't keep (VS-13) is paid as a little
 *    more priority instead of a separate transfer into the waiting-room account, which marked
 *    automated deposits;
 *  - a swap's compute limit, which the server sets from its simulation by a fixed formula, is raised
 *    by a random amount before the Vision wallet signs it.
 */
import { ComputeBudgetProgram, type VersionedTransaction } from "@solana/web3.js";
import { SHAPE_BAND, randomShape, shapeOk, type DeliveryInfo, type DeliveryShape } from "@visionswap/sdk";
import { secureRandom } from "./poll";

// ─── deliveries ───

/**
 * A delivery shape drawn at random within the band the server takes and the SDK's own (a server
 * can't widen it), or undefined when the server takes only the fixed shape (an older one).
 */
export function drawDeliveryShape(info: Pick<DeliveryInfo, "shapes"> | null | undefined, rnd: () => number = secureRandom): DeliveryShape | undefined {
  const b = info?.shapes;
  if (!b) return undefined;
  let feeMin: bigint;
  let feeMax: bigint;
  try {
    feeMin = BigInt(b.feeMin) > SHAPE_BAND.feeMin ? BigInt(b.feeMin) : SHAPE_BAND.feeMin;
    feeMax = BigInt(b.feeMax) < SHAPE_BAND.feeMax ? BigInt(b.feeMax) : SHAPE_BAND.feeMax;
  } catch {
    return undefined;
  }
  const cuMin = Math.max(SHAPE_BAND.cuMin, Number(b.cuMin) || 0);
  const cuMax = Math.min(SHAPE_BAND.cuMax, Number(b.cuMax) || 0);
  if (feeMin > feeMax || cuMin > cuMax) return undefined;
  const fits = (s: DeliveryShape) => s.fee >= feeMin && s.fee <= feeMax && s.cuL1 >= cuMin && s.cuL1 <= cuMax && s.cuN2 >= cuMin && s.cuN2 <= cuMax;
  for (let i = 0; i < 32; i++) {
    const s = randomShape(rnd);
    const shape = { ...s, v0: b.v0 ? s.v0 : false };
    if (fits(shape) && shapeOk(shape)) return shape;
  }
  // a band too narrow for the usual draws: its middle
  const mid = { fee: (feeMin + feeMax) / 2n, cuL1: Math.round((cuMin + cuMax) / 2), cuN2: Math.round((cuMin + cuMax) / 2), v0: false };
  return shapeOk(mid) ? mid : undefined;
}

// ─── the app's own transactions ───

export type OwnKind = "deposit" | "sweep" | "cleanup";
/** A compute limit and a price (micro-lamports per unit). */
export type OwnShape = { cu: number; price: number };

/**
 * The bands the app draws in. The limits start at what these transactions always asked for (120,000
 * for a deposit, 200,000 for a move that closes accounts and for clean-ups), so the work always fits;
 * the price stays modest, as before (10,000 then).
 */
export const OWN_BAND: Record<OwnKind, { cu: [number, number]; price: [number, number] }> = {
  deposit: { cu: [120_000, 180_000], price: [6_000, 16_000] },
  sweep: { cu: [200_000, 260_000], price: [6_000, 16_000] },
  cleanup: { cu: [200_000, 260_000], price: [6_000, 16_000] },
};

const pick = (lo: number, hi: number, rnd: () => number) => lo + Math.floor(rnd() * (hi - lo + 1));
/** Rounded to `step`, kept within [lo, hi]. */
const roundIn = (x: number, step: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(x / step) * step));

/** A compute limit and price drawn within the kind's band: about half the time round figures, as wallets often set, otherwise any. */
export function drawOwnShape(kind: OwnKind, rnd: () => number = secureRandom): OwnShape {
  const b = OWN_BAND[kind];
  let cu = pick(b.cu[0], b.cu[1], rnd);
  let price = pick(b.price[0], b.price[1], rnd);
  if (rnd() < 0.5) cu = roundIn(cu, 10_000, b.cu[0], b.cu[1]);
  if (rnd() < 0.5) price = roundIn(price, 1_000, b.price[0], b.price[1]);
  return { cu, price };
}

/** The priority fee (lamports) a compute limit and price pay. */
export const priorityOf = (s: OwnShape): bigint => (BigInt(s.cu) * BigInt(s.price) + 999_999n) / 1_000_000n;

/** The most a kind's priority fee can be: what fee estimates shown before a transaction count. */
export const ownPriorityMax = (kind: OwnKind): bigint => priorityOf({ cu: OWN_BAND[kind].cu[1], price: OWN_BAND[kind].price[1] });

/**
 * The price that makes `cu` units cost exactly `priority` lamports (the network rounds the product up).
 * Exact for any limit up to a million units: every shape here is far below that.
 */
export function priceForPriority(cu: number, priority: bigint): number {
  if (!Number.isInteger(cu) || cu <= 0 || cu > 1_000_000 || priority < 0n) throw new Error("bad compute budget");
  return Number((priority * 1_000_000n) / BigInt(cu));
}

/** The largest sliver paid as extra priority: more than that is kept by the address or left out of the deposit instead (see foldDust). */
export const DUST_FOLD_MAX = 20_000n;

/**
 * A deposit's rounding sliver (`dust`, what its address can neither keep nor deposit) paid as extra
 * priority in the same transaction: the shape with a price that makes its priority exactly that much
 * more. Null when the sliver is larger than DUST_FOLD_MAX (the caller deposits a little less instead,
 * so the address keeps at least its rent minimum). A sliver of nothing leaves the shape as it is.
 */
export function foldDust(shape: OwnShape, dust: bigint): OwnShape | null {
  if (dust < 0n || dust > DUST_FOLD_MAX) return null;
  if (dust === 0n) return shape;
  const price = priceForPriority(shape.cu, priorityOf(shape) + dust);
  return { cu: shape.cu, price };
}

// ─── swaps ───

/**
 * Raises a swap's compute limit by a random 2% to 20% (to a random rounding), so it no longer follows
 * the server's fixed formula from its simulation. Only a v0 message's own limit instruction is changed,
 * and only when `fits` (the priority check the app runs anyway) still passes with the new limit;
 * otherwise nothing is changed. Says whether it changed it.
 */
export function jitterComputeLimit(tx: VersionedTransaction, fits: (units: bigint, microLamports: bigint, before: bigint) => boolean, rnd: () => number = secureRandom): boolean {
  if (tx.version !== 0) return false;
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  const budget = ComputeBudgetProgram.programId;
  let limitIx: Uint8Array | null = null;
  let price = 0n;
  for (const ix of msg.compiledInstructions) {
    if (!keys[ix.programIdIndex]?.equals(budget)) continue;
    const d = ix.data;
    if (d[0] === 2 && d.length === 5) limitIx = d;
    if (d[0] === 3 && d.length === 9) price = new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(1, true);
  }
  if (!limitIx) return false;
  const dv = new DataView(limitIx.buffer, limitIx.byteOffset, limitIx.byteLength);
  const units = dv.getUint32(1, true);
  const raised = units + Math.floor(units * (0.02 + 0.18 * rnd()));
  const step = [1, 100, 1_000, 5_000][Math.floor(rnd() * 4)];
  const next = Math.min(1_400_000, Math.ceil(raised / step) * step);
  if (next <= units || !fits(BigInt(next), price, BigInt(units))) return false;
  dv.setUint32(1, next, true);
  return true;
}
