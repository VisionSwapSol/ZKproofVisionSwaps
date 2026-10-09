import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { concat, fromBE, toLE, FIELD } from "./field.ts";
import { META_LEN } from "./notes.ts";

/**
 * Everything about a spend that is not inside the proof itself. Its hash is a
 * public input, so the relayer cannot alter any of it.
 */
export type ExtData = {
  recipient: PublicKey;
  relayer: PublicKey;
  /** lamports leaving the pool in total (recipient + relayer fee + protocol fee) */
  withdraw: bigint;
  /** lamports paid to the relayer out of `withdraw` */
  relayerFee: bigint;
  /** the most the user agreed to pay the protocol, in basis points */
  maxFeeBps: number;
  meta0: Uint8Array;
  meta1: Uint8Array;
};

export function extDataBytes(e: ExtData): Uint8Array {
  if (e.meta0.length !== META_LEN || e.meta1.length !== META_LEN) throw new Error("bad meta length");
  const bps = new Uint8Array(2);
  new DataView(bps.buffer).setUint16(0, e.maxFeeBps, true);
  return concat(
    e.recipient.toBytes(),
    e.relayer.toBytes(),
    toLE(e.withdraw, 8),
    toLE(e.relayerFee, 8),
    bps,
    e.meta0,
    e.meta1,
  );
}

/** sha256 with the top byte cleared, so the value always fits in the field. */
export function extDataHash(e: ExtData): bigint {
  const h = sha256(extDataBytes(e));
  h[0] = 0;
  return fromBE(h);
}

/** -(withdraw) mod p, the circuit's publicAmount for a spend. */
export function publicAmountFor(withdraw: bigint): bigint {
  if (withdraw < 0n) throw new Error("negative withdraw");
  return withdraw === 0n ? 0n : FIELD - withdraw;
}

/** How a withdrawal splits, exactly as the program computes it. */
export function splitWithdraw(withdraw: bigint, relayerFee: bigint, feeBps: number) {
  if (relayerFee > withdraw) throw new Error("relayer fee exceeds amount");
  const net = withdraw - relayerFee;
  const protocolFee = (net * BigInt(feeBps)) / 10000n;
  return { toRecipient: net - protocolFee, protocolFee, relayerFee };
}

/** The pool fee on a deposit, paid on top of `amount`, exactly as the program computes it. */
export function depositFee(amount: bigint, feeBps: number): bigint {
  return (amount * BigInt(feeBps)) / 10000n;
}

/** The largest deposit whose amount plus fee fits in `budget` lamports. */
export function maxDepositFor(budget: bigint, feeBps: number): bigint {
  if (budget <= 0n) return 0n;
  let a = (budget * 10000n) / BigInt(10000 + feeBps);
  while (a + depositFee(a + 1n, feeBps) + 1n <= budget) a++;
  while (a > 0n && a + depositFee(a, feeBps) > budget) a--;
  return a;
}

/**
 * How to move `balance` lamports from one address into the pool in as few
 * deposits as the per-deposit limit allows. Each deposit costs its amount, its
 * fee, the waiting-room rent and the network fee; the last one also carries
 * the rounding dust, so the address ends at exactly zero. Returns the amounts,
 * or [] when not even one smallest deposit fits.
 */
export function depositParts(
  balance: bigint,
  o: { rentPending: bigint; txFee: bigint; feeBps: number; min: bigint; max: bigint },
): bigint[] {
  const per = o.rentPending + o.txFee;
  if (o.max <= 0n) return [];
  // never fewer parts than one big deposit split by the limit; usually exactly that many
  const whole = maxDepositFor(balance - per, o.feeBps);
  const start = whole > o.max ? (whole + o.max - 1n) / o.max : 1n;
  for (let n = start; n <= start + 64n; n++) {
    const budget = balance - n * per;
    if (budget <= 0n) return [];
    const each = maxDepositFor(budget / n, o.feeBps);
    if (each < o.min) return [];
    if (each > o.max) continue;
    const used = (n - 1n) * (each + depositFee(each, o.feeBps));
    const last = maxDepositFor(budget - used, o.feeBps);
    if (last > o.max) continue;
    return [...Array<bigint>(Number(n - 1n)).fill(each), last];
  }
  return [];
}

/** Smallest `withdraw` that delivers at least `want` lamports to the recipient. */
export function grossUp(want: bigint, relayerFee: bigint, feeBps: number): bigint {
  // net - floor(net*bps/1e4) >= want  =>  start from the exact inverse and nudge
  let net = (want * 10000n + BigInt(10000 - feeBps) - 1n) / BigInt(10000 - feeBps);
  while (net - (net * BigInt(feeBps)) / 10000n < want) net++;
  while (net > 0n && net - 1n - ((net - 1n) * BigInt(feeBps)) / 10000n >= want) net--;
  return net + relayerFee;
}
