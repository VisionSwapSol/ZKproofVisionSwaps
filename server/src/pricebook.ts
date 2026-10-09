import { PublicKey } from "@solana/web3.js";
import { jget, LANES, WAIT, type Lane } from "./jupiter.ts";
import { log } from "./log.ts";

/**
 * One USD price book for the whole server. The order keeper, the app's price display, new orders
 * and the exposure check all read from it, so a token's price is fetched once for everyone, at
 * most 50 tokens per Jupiter call.
 *
 *   getPrice(mint)            the cached entry, no network
 *   prices(mints, opts)       cached when fresh enough, the rest fetched; a mint Jupiter has no
 *                             price for comes back null, a mint that couldn't be fetched is left out
 *   setWatch / clearWatch     keep a mint fresh in the background (the keeper's lane)
 *   onUpdate(cb)              hear about every new price (and null: Jupiter has none for it)
 */

export type PriceEntry = { usd: number; at: number; blockId?: number };
export type PriceOpts = { maxAgeMs: number; lane: Lane; maxWaitMs: number; ip?: string };
type Fetched = Record<string, { usdPrice?: number; blockId?: number } | null>;
type FetchChunk = (ids: string[], o: { lane: Lane; maxWaitMs: number; ip?: string }) => Promise<Fetched>;

const CHUNK = 50;

export class Pricebook {
  private book = new Map<string, PriceEntry>();
  /** mints Jupiter answered without a price, and when */
  private none = new Map<string, number>();
  /** fetches under way, with their lane: a call only joins one at least as important as itself */
  private inflight = new Map<string, { p: Promise<void>; rank: number }>();
  private watches = new Map<string, { every: number; due: number }>();
  private subs: ((mint: string, entry: PriceEntry | null) => void)[] = [];
  private polls: number[] = [];
  private polling = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly fetchChunk: FetchChunk,
    private readonly opts: { maxEntries?: number; now?: () => number; timers?: boolean; maxPolling?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  getPrice(mint: string): PriceEntry | null {
    return this.book.get(mint) ?? null;
  }

  async prices(mints: string[], o: PriceOpts): Promise<Record<string, PriceEntry | null>> {
    const out: Record<string, PriceEntry | null> = {};
    const want = [...new Set(mints.filter(validMint))];
    const need: string[] = [];
    const now = this.now();
    for (const m of want) {
      const e = this.book.get(m);
      const n = this.none.get(m);
      if (e && now - e.at <= o.maxAgeMs) out[m] = this.touch(m, e);
      else if (n != null && now - n <= o.maxAgeMs) out[m] = null;
      else need.push(m);
    }
    // mints already being fetched join that call instead of starting another, unless it is a less
    // important one (a visitor's display price can't make the keeper wait on its short patience)
    const rank = LANES.indexOf(o.lane);
    const joinedWaits = new Set<Promise<void>>();
    const own: Promise<void>[] = [];
    const fresh: string[] = [];
    const joined: string[] = [];
    for (const m of need) {
      const f = this.inflight.get(m);
      if (f && f.rank <= rank) {
        joinedWaits.add(f.p);
        joined.push(m);
      } else fresh.push(m);
    }
    for (let i = 0; i < fresh.length; i += CHUNK) own.push(this.fetch(fresh.slice(i, i + CHUNK), o));
    // our own fetches keep their own deadline; a joined one (the keeper's, say) may take far longer
    // than this caller's patience, so it is waited on only that long
    let t: ReturnType<typeof setTimeout> | undefined;
    const patience = new Promise<void>((r) => {
      t = setTimeout(r, Math.max(0, o.maxWaitMs));
      (t as { unref?: () => void }).unref?.();
    });
    await Promise.all([...own, joinedWaits.size ? Promise.race([Promise.all(joinedWaits), patience]) : undefined]);
    clearTimeout(t);
    // a joined call that came back without some of them: ask again on our own lane, in the time left
    // (one still under way is left to finish: it isn't replaced by a less important one)
    const missed = joined.filter((m) => !this.answered(m, now) && !this.inflight.has(m));
    const left = o.maxWaitMs - (this.now() - now);
    if (missed.length && left > 0) {
      const again: Promise<void>[] = [];
      for (let i = 0; i < missed.length; i += CHUNK) again.push(this.fetch(missed.slice(i, i + CHUNK), { ...o, maxWaitMs: left }));
      await Promise.all(again);
    }
    for (const m of need) {
      const e = this.book.get(m);
      // only answers from this round count; anything older means the fetch failed
      if (e && e.at >= now) out[m] = e;
      else if (this.answered(m, now)) out[m] = null;
    }
    return out;
  }

  /** Keeps `mint` refreshed about every `everyMs` (on the keeper's lane). */
  setWatch(mint: string, everyMs: number) {
    if (!validMint(mint)) return;
    const every = Math.max(1_000, everyMs);
    const w = this.watches.get(mint);
    if (w) {
      w.due = Math.min(w.due, this.now() + every);
      w.every = every;
    } else {
      const e = this.book.get(mint);
      this.watches.set(mint, { every, due: e ? e.at + every : this.now() });
    }
    if (!this.timer && (this.opts.timers ?? true)) {
      this.timer = setInterval(() => void this.poll(), 500);
      this.timer.unref?.();
    }
  }

  clearWatch(mint: string) {
    this.watches.delete(mint);
  }

  onUpdate(cb: (mint: string, entry: PriceEntry | null) => void) {
    this.subs.push(cb);
  }

  /** One round of the background poller: the most overdue watched mints, padded to a full call. */
  async poll() {
    if (this.polling >= (this.opts.maxPolling ?? 2)) return;
    const now = this.now();
    // a visitor's slower fetch of the same mint doesn't count: it may give up long before ours would
    const keeper = LANES.indexOf("keeper");
    const all = [...this.watches.entries()]
      .filter(([m]) => (this.inflight.get(m)?.rank ?? Infinity) > keeper)
      .sort((a, b) => a[1].due - b[1].due);
    if (!all.length || all[0][1].due > now) return;
    // a call costs the same for 1 mint or 50, so the next-due mints ride along
    const batch = all.slice(0, CHUNK).map(([m]) => m);
    this.polling++;
    this.polls.push(now);
    // trimmed here too: stats() may never be asked for
    while (this.polls.length && now - this.polls[0] >= 60_000) this.polls.shift();
    try {
      await this.fetch(batch, { lane: "keeper", maxWaitMs: WAIT.keeper });
    } finally {
      this.polling--;
    }
  }

  stats() {
    const now = this.now();
    this.polls = this.polls.filter((t) => now - t < 60_000);
    let lag = 0;
    for (const w of this.watches.values()) lag = Math.max(lag, now - w.due);
    return { cached: this.book.size, watched: this.watches.size, pollsLastMinute: this.polls.length, oldestDueLagMs: Math.max(0, lag) };
  }

  private fetch(ids: string[], o: { lane: Lane; maxWaitMs: number; ip?: string }): Promise<void> {
    const run = async () => {
      try {
        const j = await this.fetchChunk(ids, o);
        const at = this.now();
        for (const m of ids) {
          // any fetch of a watched mint, whoever asked, counts as its refresh
          const w = this.watches.get(m);
          if (w) w.due = at + w.every;
          const v = j[m];
          const usd = v?.usdPrice;
          if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) {
            const e: PriceEntry = { usd, at, ...(typeof v?.blockId === "number" ? { blockId: v.blockId } : {}) };
            this.none.delete(m);
            this.touch(m, e);
            this.emit(m, e);
          } else {
            this.none.delete(m);
            this.none.set(m, at);
            this.emit(m, null);
          }
        }
        this.trim();
      } catch {
        // busy or down: those mints are simply left out this time
      }
    };
    const p: Promise<void> = run().finally(() => {
      for (const m of ids) if (this.inflight.get(m)?.p === p) this.inflight.delete(m);
    });
    const rank = LANES.indexOf(o.lane);
    for (const m of ids) this.inflight.set(m, { p, rank });
    return p;
  }

  /** Jupiter answered for `mint` (a price, or no price) at or after `since`. */
  private answered(mint: string, since: number): boolean {
    const e = this.book.get(mint);
    const n = this.none.get(mint);
    return (e != null && e.at >= since) || (n != null && n >= since);
  }

  /** Stores (or re-reads) an entry as the most recently used. */
  private touch(mint: string, e: PriceEntry): PriceEntry {
    this.book.delete(mint);
    this.book.set(mint, e);
    return e;
  }

  private emit(mint: string, e: PriceEntry | null) {
    for (const cb of this.subs) {
      try {
        cb(mint, e);
      } catch (err) {
        log("prices: a listener failed:", (err as Error).message.slice(0, 200));
      }
    }
  }

  /** Bounded memory: the least recently used prices go first, watched ones never. */
  private trim() {
    const max = this.opts.maxEntries ?? 5_000;
    for (const m of this.book.keys()) {
      if (this.book.size <= max) break;
      if (!this.watches.has(m)) this.book.delete(m);
    }
    for (const m of this.none.keys()) {
      if (this.none.size <= max) break;
      this.none.delete(m);
    }
  }
}

/** A Solana address in its canonical form (anything else is never sent to Jupiter). */
function validMint(m: string): boolean {
  if (typeof m !== "string" || m.length < 32 || m.length > 44) return false;
  try {
    return new PublicKey(m).toBase58() === m;
  } catch {
    return false;
  }
}

export const pricebook = new Pricebook((ids, o) =>
  jget<Fetched>(`/price/v3?ids=${ids.map(encodeURIComponent).join(",")}`, { ...o, timeoutMs: 8_000 }),
);

export const getPrice = (mint: string) => pricebook.getPrice(mint);
export const prices = (mints: string[], o: PriceOpts) => pricebook.prices(mints, o);
export const setWatch = (mint: string, everyMs: number) => pricebook.setWatch(mint, everyMs);
export const clearWatch = (mint: string) => pricebook.clearWatch(mint);
export const onUpdate = (cb: (mint: string, entry: PriceEntry | null) => void) => pricebook.onUpdate(cb);
export const priceStats = () => pricebook.stats();
