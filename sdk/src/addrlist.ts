import { PublicKey } from "@solana/web3.js";

/**
 * The pool's public address list (VS-21): every address that ever deposited into the pool, was paid
 * by it, or paid for one of its transactions, read from the pool's own transactions (chain facts
 * anyone can rebuild). The server publishes it whole (GET /api/pool/addresses), and the app looks
 * for its own Vision wallets, deposit addresses and fee wallets in it inside the browser, instead of
 * asking the network about addresses its account may use one day: those questions, from one
 * connection, told whoever answered them which addresses belong together.
 *
 * A record is 33 bytes: the address, then what it did (ADDR_* bits). An address shows up again when
 * it does something new; a reader ORs its records together.
 */

export const ADDR_REC = 33;
/** it made a deposit (the deposit's signer) */
export const ADDR_DEPOSITED = 1;
/** the pool paid it (a spend's recipient: a Vision wallet, a one-time sending address, a relayer taking its fee) */
export const ADDR_PAID = 2;
/** it submitted a spend and paid its network fee (the relayer, or a fee wallet of someone's own) */
export const ADDR_PAYER = 4;

export function encodeAddrRec(address: PublicKey | string, flags: number): Uint8Array {
  if (!Number.isInteger(flags) || flags < 1 || flags > 255) throw new Error("bad address flags");
  const key = (typeof address === "string" ? new PublicKey(address) : address).toBytes();
  const out = new Uint8Array(ADDR_REC);
  out.set(key, 0);
  out[32] = flags;
  return out;
}

/** The list as an address -> what it did map, from records as served (a cut-off record at the end is left out). */
export function readAddrList(data: Uint8Array, into: Map<string, number> = new Map()): Map<string, number> {
  for (let off = 0; off + ADDR_REC <= data.length; off += ADDR_REC) {
    const a = new PublicKey(data.subarray(off, off + 32)).toBase58();
    into.set(a, (into.get(a) ?? 0) | data[off + 32]);
  }
  return into;
}

/**
 * Indexes from `start` that the list shows were used (`used(i)`), looking past each one found until
 * `gap` in a row weren't: what wallets do with their history, done here on a downloaded list, so
 * nothing about the addresses is asked of anyone. `next` is one past the last one found (at least `start`).
 */
export function listScan(start: number, used: (i: number) => boolean, gap = 20, max = 100_000): { next: number; found: number[] } {
  const found: number[] = [];
  let misses = 0;
  for (let i = 0; misses < gap && i < max; i++) {
    if (used(i)) {
      found.push(i);
      misses = 0;
    } else if (i >= start) misses++;
  }
  return { next: found.length ? Math.max(start, found[found.length - 1] + 1) : start, found };
}
