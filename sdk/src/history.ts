import { SystemProgram, type PublicKey } from "@solana/web3.js";

/**
 * Reading a one-time sending address's history (see delivery.ts): whether it delivered its payment.
 * Shared by the owner's app and the relayer's finisher, so both take a delivery the same way: the
 * first transaction the address paid for itself, after the pool spend that paid it, and only when
 * that holds a standard SOL transfer to the recipient.
 */

/** Whether a transaction holds a standard SOL transfer (the System program's, at its top level) from `from` to `to`. */
export function paysTo(m: { staticAccountKeys: PublicKey[]; compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[] }, from: PublicKey, to: string): boolean {
  const keys = m.staticAccountKeys;
  return m.compiledInstructions.some((ix) => {
    if (!keys[ix.programIdIndex]?.equals(SystemProgram.programId) || ix.data.length < 12) return false;
    const type = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getUint32(0, true);
    return type === 2 && !!keys[ix.accountKeyIndexes[0]]?.equals(from) && keys[ix.accountKeyIndexes[1]]?.toBase58() === to;
  });
}

/** At most this many history pages (of HISTORY_PAGE signatures) and transactions are read in one look at a sending address (see readDelivery). */
export const HISTORY_PAGES = 6;
export const HISTORY_READS = 12;
/** signatures a history page holds (the site's RPC gives at most this many at once) */
export const HISTORY_PAGE = 10;

/**
 * What this device has read of one sending address's history so far (kept for the session, not saved),
 * so every transaction in it is fetched once: a later look lists only what is newer, and reads only
 * what it hasn't read yet. Dust a stranger keeps sending it costs one read each, never one per look.
 */
export type HopHistory = {
  /** listed signatures that didn't fail, newest first: one unbroken stretch from `top` down to `bottom` */
  cands: string[];
  /** the newest and the oldest signature listed (failed ones too) */
  top?: string;
  bottom?: string;
  /** the listing reaches back to the pool spend that paid it, or to its start */
  complete: boolean;
  /** read already, and not a transfer it paid for itself */
  cleared: Set<string>;
  /** the first transaction it paid for itself (its delivery, when that pays the recipient) */
  first?: { sig: string; pays: (to: string) => boolean };
};
export const newHopHistory = (): HopHistory => ({ cands: [], complete: false, cleared: new Set() });

/** One listed signature (getSignaturesForAddress), and one read transaction: whether this address paid for it (its fee payer, and it didn't fail), and then whom it paid. */
export type HistorySig = { signature: string; err: unknown };
export type HistoryTx = { byHop: false } | { byHop: true; pays: (to: string) => boolean };
export type HistoryRpc = {
  /** newest first, at most HISTORY_PAGE, older than `before`, newer than `until`; null when the network couldn't say */
  list(o: { before?: string; until?: string }): Promise<HistorySig[] | null>;
  /** undefined when it can't be read (yet) */
  read(sig: string): Promise<HistoryTx | undefined>;
};

/**
 * Whether a sending address delivered its payment: the first transaction it paid for itself after the
 * pool spend that paid it (`tx1`), which must hold a standard transfer to `to`. Answers that transfer's
 * signature; null when the history shows none (or shows the address paid for something else first);
 * undefined when it can't be told yet: the network couldn't say, or this look's `budget` (pages listed,
 * transactions read) ran out first. What was read is kept in `h`, so the next look carries on from there
 * and a long history (dust a stranger sent it) is read through over a few looks, never all at once.
 */
export async function readDelivery(
  h: HopHistory,
  tx1: string | undefined,
  to: string | undefined,
  rpc: HistoryRpc,
  budget: { pages: number; reads: number } = { pages: HISTORY_PAGES, reads: HISTORY_READS },
): Promise<string | null | undefined> {
  const answer = (f: NonNullable<HopHistory["first"]>) => (!to || f.pays(to) ? f.sig : null);
  if (h.first) return answer(h.first);
  // nothing listed yet: from the newest down
  if (!h.top) Object.assign(h, { cands: [], bottom: undefined, complete: false });
  // what is newer than what was listed before
  if (h.top) {
    const fresh: HistorySig[] = [];
    let before: string | undefined;
    let got = false;
    while (budget.pages > 0) {
      budget.pages--;
      const list = await rpc.list({ until: h.top, ...(before ? { before } : {}) });
      if (!list) return undefined;
      const at = list.findIndex((s) => s.signature === h.top);
      fresh.push(...(at < 0 ? list : list.slice(0, at)));
      before = list.at(-1)?.signature;
      if (at >= 0 || list.length < HISTORY_PAGE || !before) {
        got = true;
        break;
      }
    }
    if (got) {
      if (fresh.length) {
        h.top = fresh[0].signature;
        h.cands = [...fresh.filter((s) => !s.err).map((s) => s.signature), ...h.cands];
      }
    } else {
      // more came in than one look lists: what was listed now is the stretch, read on down from it next time
      // (a look with no pages left lists nothing, and keeps what was listed before)
      if (fresh.length) Object.assign(h, { top: fresh[0].signature, bottom: fresh.at(-1)?.signature, complete: false, cands: fresh.filter((s) => !s.err).map((s) => s.signature) });
      return undefined;
    }
  }
  // older, back to the pool spend or the start
  while (!h.complete) {
    if (budget.pages <= 0) return undefined;
    budget.pages--;
    const list = await rpc.list(h.bottom ? { before: h.bottom } : {});
    if (!list) return undefined;
    if (!h.top && list[0]) h.top = list[0].signature;
    for (const s of list) {
      if (tx1 && s.signature === tx1) {
        h.complete = true;
        break;
      }
      if (!s.err) h.cands.push(s.signature);
      h.bottom = s.signature;
    }
    if (list.length < HISTORY_PAGE || !list.at(-1)) h.complete = true;
  }
  // oldest first: the first transfer it paid for itself is its delivery; anything later (SOL that came back, passed on) comes after it.
  // What others sent it is read once each (a few at a time), and only so many a look
  const left = h.cands.filter((s) => !h.cleared.has(s)).reverse();
  for (let i = 0; i < left.length; ) {
    if (budget.reads <= 0) return undefined;
    const chunk = left.slice(i, i + Math.min(4, budget.reads));
    budget.reads -= chunk.length;
    i += chunk.length;
    const txs = await Promise.all(chunk.map((sig) => rpc.read(sig).catch(() => undefined)));
    // what it didn't pay for is never read again, whatever else this look finds
    chunk.forEach((sig, k) => txs[k]?.byHop === false && h.cleared.add(sig));
    for (let k = 0; k < chunk.length; k++) {
      const t = txs[k];
      // listed but not readable yet: can't be told
      if (!t) return undefined;
      if (!t.byHop) continue;
      h.first = { sig: chunk[k], pays: t.pays };
      return answer(h.first);
    }
  }
  return null;
}
