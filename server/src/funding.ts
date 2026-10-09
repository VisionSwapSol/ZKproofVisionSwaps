import type { ParsedInstruction, ParsedTransactionWithMeta, PartiallyDecodedInstruction } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { nameOf } from "./poolsync.ts";

/**
 * Deciding who funded an address. Screening looks at every account whose SOL
 * went down in a transaction that paid the address. A few of those are
 * plumbing rather than senders, and screening them would block ordinary use
 * (selling tokens back, moving a Vision wallet's SOL into the pool) for
 * reasons that have nothing to do with the user.
 */

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** Well-known exchange programs whose liquidity pools hold the SOL side of a trade. */
const EXCHANGES = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  "PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY",
]);
/** A bonding-curve launchpad that pays sellers straight from its curve account (account 3 of `sell`). */
const CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const CURVE_SELL = sha256(new TextEncoder().encode("global:sell")).slice(0, 8);

type AnyIx = (ParsedInstruction | PartiallyDecodedInstruction) & { stackHeight?: number | null };
/** An instruction with the program that invoked it (null at the top level, undefined when unknown). */
type Ran = { ix: AnyIx; parent: string | null | undefined };

const startsWith = (data: Uint8Array, d: Uint8Array) => data.length >= d.length && d.every((v, i) => data[i] === v);
const dataOf = (ix: AnyIx) => ("data" in ix ? bs58.decode(ix.data) : new Uint8Array(0));
const accountsOf = (ix: AnyIx) => ("accounts" in ix ? ix.accounts.map((a) => a.toBase58()) : []);

/** Every instruction that ran, with its direct caller worked out from the inner instructions' stack heights. */
function ran(tx: ParsedTransactionWithMeta): Ran[] {
  const out: Ran[] = [];
  const inner = new Map<number, AnyIx[]>();
  for (const g of tx.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions as AnyIx[]);
  tx.transaction.message.instructions.forEach((top, i) => {
    out.push({ ix: top as AnyIx, parent: null });
    const stack: string[] = [top.programId.toBase58()];
    for (const ix of inner.get(i) ?? []) {
      const h = ix.stackHeight;
      if (typeof h !== "number" || h < 2) {
        out.push({ ix, parent: undefined });
        continue;
      }
      stack.length = Math.min(stack.length, h - 1);
      out.push({ ix, parent: stack.length === h - 1 ? stack[h - 2] : undefined });
      stack[h - 1] = ix.programId.toBase58();
    }
  });
  return out;
}

/**
 * Accounts whose SOL went down in `tx` without being a sender to `me`:
 * - the pool's vault (a private withdrawal; that money was screened on its way in);
 * - a pool waiting-room account handing back its own deposit (settle or refund);
 * - this server's own relayer and guard, which only pay network fees;
 * - `me`'s own token accounts (unwrapping its own SOL);
 * - the SOL side of a well-known exchange's pool, moved out by that exchange's
 *   own program from an account no signer of the transaction controls.
 * Everyone else stays a funder, including any wallet that signed.
 */
export function notFunders(tx: ParsedTransactionWithMeta, me: string, ctx: { programId: string; vault: string; own: string[] }): Set<string> {
  const out = new Set<string>([ctx.vault, ...ctx.own]);
  const keys = tx.transaction.message.accountKeys;
  const signers = new Set(keys.filter((k) => k.signer).map((k) => k.pubkey.toBase58()));
  const steps = ran(tx);

  for (const { ix } of steps) {
    const program = ix.programId.toBase58();
    if (program === ctx.programId) {
      const name = nameOf(dataOf(ix));
      const accounts = accountsOf(ix);
      if (name === "settle" && accounts[2]) out.add(accounts[2]);
      if (name === "refund" && accounts[4]) out.add(accounts[4]);
    } else if (program === CURVE_PROGRAM && startsWith(dataOf(ix), CURVE_SELL)) {
      const curve = accountsOf(ix)[3];
      if (curve && !signers.has(curve)) out.add(curve);
    }
  }

  const balances = [...(tx.meta?.preTokenBalances ?? []), ...(tx.meta?.postTokenBalances ?? [])];
  for (const b of balances) {
    const key = keys[b.accountIndex]?.pubkey.toBase58();
    if (!key) continue;
    if (b.owner === me) {
      out.add(key);
      continue;
    }
    if (b.mint !== WSOL) continue;
    // every wrapped SOL that left this account must have been moved by a well-known exchange, on its own authority
    const moves = steps.filter(({ ix }) => {
      if (!TOKEN_PROGRAMS.has(ix.programId.toBase58()) || !("parsed" in ix)) return false;
      const p = ix.parsed as { type?: string; info?: { source?: string } } | null;
      return (p?.type === "transfer" || p?.type === "transferChecked") && p.info?.source === key;
    });
    const byExchange = moves.every(({ ix, parent }) => {
      const auth = ((ix as ParsedInstruction).parsed as { info?: { authority?: string; multisigAuthority?: string } }).info;
      const who = auth?.authority ?? auth?.multisigAuthority;
      return !!parent && EXCHANGES.has(parent) && !!who && !signers.has(who);
    });
    if (moves.length && byExchange && !(b.owner && signers.has(b.owner))) out.add(key);
  }
  return out;
}

/** SOL credits smaller than this (dust, fee refunds) don't count as funding. */
export const FUNDING_MIN = 100_000;

/** One successful transaction touching an address, as screening sees it. */
export type FundingTx = {
  /** the address's balance change, and its balance after */
  gain: number;
  post: number;
  /** every other account whose balance went down in it */
  payers: string[];
  /** deposits (inner ids) the pool handed back to this address in it */
  refunded: string[];
  /** deposits (inner ids) this address put into the waiting room in it */
  queued: string[];
};

/**
 * Who paid the SOL an address holds now, from its transactions newest first. The walk stops
 * where the address was last empty: whatever was paid before that has left already, so an
 * earlier payer (refused once, or long gone) doesn't hold up later, clean payments. A deposit
 * the pool handed back is the same SOL coming home, so while any handed-back deposit hasn't
 * been matched to the transaction that made it, empty points don't count and the walk carries
 * on to the payers that SOL first came from (a move can take several deposits, each handed
 * back on its own, and only the last one empties the address).
 * `complete` says the walk reached an empty point or the start of the history: only then
 * must the credits found explain the whole balance.
 */
export function fundingSince(txs: FundingTx[], historyEnded: boolean): { payers: string[]; received: number; complete: boolean } {
  const payers = new Set<string>();
  const handedBack = new Set<string>();
  let received = 0;
  for (const tx of txs) {
    if (tx.post === 0 && tx.gain <= 0 && handedBack.size === 0) return { payers: [...payers], received, complete: true };
    tx.queued.forEach((q) => handedBack.delete(q));
    tx.refunded.forEach((r) => handedBack.add(r));
    if (tx.gain > 0) received += tx.gain;
    if (tx.gain >= FUNDING_MIN) tx.payers.forEach((p) => payers.add(p));
  }
  return { payers: [...payers], received, complete: historyEnded };
}

/** One page of an address's history, newest first; `next` is where the next older page starts. */
export type FundingPage = { txs: FundingTx[]; next?: string; ended: boolean };

/**
 * Reads up to `maxPages` pages until fundingSince finds where the address was last empty.
 * A wallet in everyday use is rarely empty, so for a longer history the payers of its most
 * recent transactions are the ones screened (as before 1.5.0), and `complete` is false.
 */
export async function fundingWalk(read: (before?: string) => Promise<FundingPage>, maxPages: number) {
  const txs: FundingTx[] = [];
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    let page: FundingPage;
    try {
      page = await read(before);
    } catch (e) {
      // the first page is the address's latest funding: without it nothing can be said; an older
      // page that can't be read right now (a busy RPC) leaves the recent payers to be screened
      if (i === 0) throw e;
      return fundingSince(txs, false);
    }
    txs.push(...page.txs);
    const found = fundingSince(txs, page.ended || !page.next);
    if (found.complete) return found;
    before = page.next;
  }
  // a busy wallet is rarely empty: its most recent payers are screened (complete stays false)
  return fundingSince(txs, false);
}
