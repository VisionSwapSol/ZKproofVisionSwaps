import { log } from "./log.ts";

/**
 * The order keeper's engine: what to watch, when an order fires, and how its trades are run.
 * It holds no network code of its own (orders.ts hands it the price book and the chain), so the
 * same engine runs in tests on a fake clock.
 *
 *   prices      every fresh price of a watched token is checked against its orders the moment it
 *               arrives; tokens near a trigger are checked every few seconds, far ones every few minutes
 *   triggers    take-profit and limit buy fire on the first crossing (the trade's own quote is the
 *               price gate); a stop-loss arms on one price and fires on a second, newer one
 *   trades      a queue (stop-loss > take-profit > limit buy > DCA) served by a few workers, one trade
 *               at a time per account; every trade is written down before it is sent, and a tracker
 *               settles it from the chain, so nothing is ever bought or sold twice
 *
 * The keeper loop itself never waits for a trade.
 */

export type OrderKind = "sell" | "buy" | "dca";
export type OrderStatus = "pending" | "active" | "filled" | "cancelled" | "expired" | "failed";
export type Trigger = "sl" | "tp" | "buy" | "dca";
export type Stage = "watching" | "armed" | "queued" | "trading" | "sending" | "retrying" | "waiting" | "paused";
export type PriceEntry = { usd: number; at: number; blockId?: number };
/** One take-profit step: sells `amount` (raw token units) once the price reaches `tpUsd`. */
export type Leg = { tpUsd?: number; amount: string; filled?: boolean };
export type Fill = { t: number; sig: string; spent: string; got: string; priceUsd?: number | null; leg?: number; round?: number };
/** A trade that was sent and isn't settled yet. Written down before it goes out. */
export type Attempt = {
  sig: string;
  lastValid: number;
  amount: string;
  trigger: Trigger;
  leg?: number;
  round?: number;
  at: number;
  /** what the quote said would arrive */
  expect: string;
  priceUsd: number | null;
  /** look in the chain's history (set after a restart, or once the trade's blockhash has expired) */
  history?: boolean;
};

export type Order = {
  id: string;
  tokenHash: string;
  /** the order key (bs58); kept only while the order runs */
  secret?: string;
  /** the order key's public half, kept while a trade may still settle */
  delegate?: string;
  kind: OrderKind;
  /** the Vision wallet; kept only while the order runs (or a trade may still settle) */
  owner?: string;
  mint?: string;
  program?: string;
  decimals?: number;
  /** what the approval covers (raw units of the input: the token for sells, lamports of wrapped SOL for buys) */
  amount: string;
  /** input already spent by fills */
  spent?: string;
  tpUsd?: number;
  slUsd?: number;
  trailPct?: number;
  legs?: Leg[];
  buyBelowUsd?: number;
  dca?: { per: string; every: number; count: number; next: number; done: number; paused?: boolean; pausedAt?: number; exact?: boolean };
  /** price room for take-profits, limit buys and DCA */
  slippageBps: number;
  /** price room for the stop-loss */
  slSlippageBps?: number;
  created: number;
  /** when it went live */
  liveAt?: number;
  expires: number;
  status: OrderStatus;
  error?: string | null;
  done?: number;
  fills: Fill[];
  // ── the keeper's working state ──
  lastPrice?: number | null;
  priceAt?: number;
  /** the highest price seen since the order went live (trailing stop) */
  peak?: number;
  /** a stop-loss's first crossing, waiting for a newer price to confirm it */
  armed?: { at: number; blockId?: number; price: number };
  pending?: Attempt;
  retryAt?: number;
  /** the trade `retryAt` holds back (a stop-loss never waits out another trade's backoff) */
  retryFor?: Trigger;
  /** transient failures in a row */
  tries: number;
  /** trades in a row that passed their check-run but failed on-chain */
  chainFails?: number;
  /** route failures in a row, and since when */
  routeFails?: number;
  routeSince?: number;
  /** the last failure of any kind: an hour without one and the counts above start over */
  failAt?: number;
  /** a take-profit or limit buy whose route was worse than its price waits until then */
  coolUntil?: number;
  cools?: number;
  /** a stop-loss's "price came back" refusals (kept apart from the take-profit's) */
  slCools?: number;
  /** a stop-loss whose trade missed its price room waits for a price newer than this */
  afterPrice?: number;
  /** a stop-loss whose route showed a recovered price doesn't arm again before this */
  slQuietUntil?: number;
  /** cancelled while a trade was on its way: that trade still settles */
  cancelAt?: number;
  /** legacy field from 1.4.0 */
  hits?: number;
};

/** One token's breaker (which wallets' trades failed lately, and its pause) and its unpriced-quote timing. */
type MintState = { owners: Set<string>; lastFail: number; trips: number; until: number; probeAt: number; probeFails: number };

/** What the engine needs from the price book (pricebook.ts in production). */
export type Book = {
  getPrice(mint: string): PriceEntry | null;
  setWatch(mint: string, everyMs: number): void;
  clearWatch(mint: string): void;
};

/**
 * A quote as the price gate sees it: what would arrive (`out`), the least the chain allows, and the input
 * that arrives in the route. Jupiter's amounts already allow for the output token's own transfer tax
 * (`outFeeBps`, for reference only).
 */
export type Quote = { out: bigint; threshold: bigint; arrives: bigint; outFeeBps?: number };
/** Throws to refuse a quote; may return a minimum output the trade must then guarantee on-chain. */
export type Gate = (q: Quote) => bigint | undefined;
export type Plan = { trigger: Trigger; amount: bigint; leg?: number; round?: number; slippageBps: number; urgent: boolean; gate?: Gate };
export type Built = { sig: string; lastValid: number; out: string; send(): Promise<unknown> };
export type ApprovalState = { delegate: string | null; delegated: bigint; balance: bigint };
export type SigState = "landed" | "failed" | null;

/** Everything the engine does on the chain and at Jupiter. */
export interface Exec {
  /** builds, checks (simulation required) and signs one trade */
  build(o: Order, plan: Plan): Promise<Built>;
  statuses(sigs: string[], history: boolean): Promise<SigState[]>;
  height(): Promise<number>;
  /** the input account's approval; null when the account is gone */
  approval(o: Order): Promise<ApprovalState | null>;
  /** trades the order's key signed that landed, with their block time (ms) */
  history(o: Order): Promise<{ sig: string; t: number | null }[]>;
  /** what a landed trade actually spent and delivered, when the chain can tell */
  landed(o: Order, sig: string): Promise<{ spent?: string; got?: string } | null>;
  /** an executable quote for selling `amount` (the keeper's lane), for tokens with no market price */
  probe(o: Order, amount: bigint): Promise<Quote>;
  /** false while the relayer is too low on SOL to pay for trades */
  relayerOk(): Promise<boolean>;
  /**
   * SOL's USD price, at most a couple of minutes old; `maxAgeMs` asks for a fresher one (the price
   * gates), `cachedOnly` never waits on the network (a stop-loss sells at market without it)
   */
  solUsd(o?: { maxAgeMs?: number; cachedOnly?: boolean }): Promise<number | null>;
  /** the token's decimals (orders saved by older versions don't carry them) */
  decimals(o: Order): Promise<number>;
}

export type KeeperOpts = {
  now?: () => number;
  random?: () => number;
  /** trades built at once (1-8) */
  workers?: () => number;
  /** the quickest price check the keeper's Jupiter share allows */
  fastMs?: () => number;
  /** called after every change worth keeping (debounced by the caller) */
  save?: () => void;
  /** saves at once and resolves once it is on disk: a trade is written down before it is sent */
  saveNow?: () => Promise<void>;
  /** the size floors: a trade whose tokens mostly moved away is not run for dust */
  limits?: Limits;
  /** SOL's mint: watched while any price order runs, so the price gate always has SOL's price */
  solMint?: string;
  /** quotes for unpriced tokens per minute (a share of the keeper's Jupiter lane) */
  probeBudget?: () => number;
};

/** An error with a kind the keeper acts on. */
export const keeperError = (message: string, code: ErrCode, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { code, ...extra });
/** `account`: something in the order's own Vision wallet (an account of its missing, or changed under the trade), never the token's fault */
export type ErrCode = "busy" | "price" | "recovered" | "slippage" | "route" | "account" | "fatal" | "transient" | "relayer" | "cancelled";

const PRIO: Record<Trigger, number> = { sl: 0, tp: 1, buy: 2, dca: 3 };
const SEC = 1_000;
const MIN = 60_000;
/** a stop-loss's second price must be this much newer when Jupiter gives no block id */
const CONFIRM_MS = 5 * SEC;
/** ... and is taken whatever the block id once this much later (the build's own quote still guards it) */
const CONFIRM_ANYWAY_MS = 30 * SEC;
/** a stop-loss whose price recovered this far above the stop at build time is disarmed */
const RECOVERED = 1.02;
/** no price for this long: a stop-loss checks with a real quote instead */
export const UNPRICED_MS = 3 * MIN;
const PROBE_EVERY = 2 * MIN;
/** route failures this many times, over at least this long, end the order */
const ROUTE_GIVE_UP = 3;
const ROUTE_WINDOW = 30 * MIN;
/** an order's failure counts start over after this long without a failure (longer than any retry wait, so a real streak isn't cut) */
const FAIL_QUIET = 2 * ROUTE_WINDOW;
/** trades on one token failing for this many different wallets pause its take-profits, limit buys and DCA */
const BREAKER_AT = 3;
/** ... counting failures no more than this far apart; a pause this long ago no longer lengthens the next */
const BREAKER_QUIET = 10 * MIN;
const BREAKER_FORGET = 30 * MIN;
/** unpriced-token quotes at once, and the longest a token that has no route waits between them */
const PROBES_AT_ONCE = 2;
const PROBE_MAX_EVERY = 30 * MIN;
const KEEP_DONE_MS = 14 * 24 * 60 * MIN;
const PENDING_TTL = 10 * MIN;
/** a paused DCA ends after this long paused */
const MAX_PAUSE = 90 * 24 * 60 * MIN;
/** after a restart, DCA buys wait until any trade sent just before it has landed or expired (a blockhash lives ~90 s) */
const RESTART_WAIT = 90 * SEC;
export const UNPRICED_ERROR = "No price for this token right now, and no route to sell it. Still checking.";

/**
 * The quickest a token near its trigger is checked, from the Jupiter plan's calls per minute: 5 s on
 * a free plan (60), down to 2 s on a big one, and never slower than 15 s however small the plan.
 */
export const fastCheckMs = (rpm: number) => Math.min(15 * SEC, Math.max(2 * SEC, Math.ceil((5 * MIN) / rpm)));

export class Keeper {
  readonly orders = new Map<string, Order>();
  private queue = new Map<string, { trigger: Trigger; leg?: number; at: number }>();
  private working = new Set<string>();
  /** input accounts with a trade being built or on its way */
  private locks = new Set<string>();
  private byMint = new Map<string, string[]>();
  private watched = new Map<string, number>();
  private mints = new Map<string, MintState>();
  private probing = 0;
  private probesAt: number[] = [];
  private tasks = new Set<Promise<unknown>>();
  private tracking = false;
  private trackedAt = 0;
  private heightAt = 0;
  private lastHeight = 0;
  private fills24: number[] = [];
  private failures24: number[] = [];
  private softDirty = false;
  private softSavedAt = 0;
  private relayerLowSince = 0;
  private dispatchQueued = false;
  /** orders read back after a restart: the chain's history is checked before their first trade */
  private verify = new Set<string>();
  private readonly startedAt: number;
  stopping = false;
  readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly book: Book,
    private readonly exec: Exec,
    private readonly opts: KeeperOpts & { inputKey: (o: Order) => string },
  ) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.startedAt = this.now();
  }

  private save() {
    this.opts.save?.();
  }

  // ─── state ───

  /** Orders read back from storage. Trades that were on their way are settled from the chain first. */
  adopt(list: Order[]): number {
    let added = 0;
    const now = this.now();
    // keys already running here (an order the app handed back while storage answered late)
    const running = new Set([...this.orders.values()].filter((o) => o.status === "active" && o.delegate).map((o) => o.delegate!));
    for (const o of list) {
      if (!o || typeof o.id !== "string" || this.orders.has(o.id)) continue;
      normalize(o);
      if (o.pending) o.pending.history = true;
      if (o.status === "active" && o.delegate && running.has(o.delegate)) {
        // the same approval is already run by the handed-back order: this copy only settles what it sent
        o.status = "cancelled";
        o.done = now;
        o.error = "Replaced by a newer order on the same tokens.";
        this.slim(o);
      }
      if (o.status === "active") {
        this.verify.add(o.id);
        // overdue DCA buys wait until a buy sent just before the restart has settled, then spread over two minutes
        if (o.dca && o.dca.next < now + RESTART_WAIT) o.dca.next = now + RESTART_WAIT + Math.floor(this.random() * 2 * MIN);
      }
      this.orders.set(o.id, o);
      if (o.pending && o.owner) this.locks.add(this.opts.inputKey(o));
      added++;
    }
    this.reindex();
    return added;
  }

  /**
   * Forgets every order, before the list is read again from storage (another copy of the site ran
   * them meanwhile, so the stored list is the newer one). Only while stopped.
   */
  reset() {
    for (const mint of this.watched.keys()) this.book.clearWatch(mint);
    for (const m of [this.orders, this.queue, this.working, this.locks, this.byMint, this.watched, this.mints, this.verify]) m.clear();
    this.stopping = false;
  }

  /** The list as stored (the last seen price is left out: it changes on nearly every check). */
  serialize(): string {
    return JSON.stringify([...this.orders.values()], (k, v) => (k === "lastPrice" ? undefined : v));
  }

  /** Stops: no new trade starts, no price is acted on, and no token is polled for these orders any more. */
  stop() {
    this.stopping = true;
    for (const mint of this.watched.keys()) this.book.clearWatch(mint);
    this.watched.clear();
  }

  /** Starts watching an order that just went live. */
  live(o: Order) {
    const e = o.mint ? this.book.getPrice(o.mint) : null;
    if (e) {
      o.lastPrice = e.usd;
      o.priceAt = e.at;
      if (o.trailPct) o.peak = Math.max(o.peak ?? 0, e.usd);
    } else if (o.trailPct && o.lastPrice) o.peak = Math.max(o.peak ?? 0, o.lastPrice);
    this.reindex();
    this.refreshWatches();
    this.save();
  }

  /** Ends an order: its key and owner are dropped at once (the owner stays while a trade may still settle). */
  finish(o: Order, status: OrderStatus, error?: string | null) {
    o.status = status;
    o.done = this.now();
    if (error !== undefined) o.error = error;
    this.queue.delete(o.id);
    this.slim(o);
    this.reindex();
    this.save();
  }

  private slim(o: Order) {
    delete o.secret;
    delete o.armed;
    delete o.retryAt;
    delete o.retryFor;
    delete o.coolUntil;
    delete o.afterPrice;
    delete o.slQuietUntil;
    delete o.peak;
    delete o.tpUsd;
    delete o.slUsd;
    delete o.trailPct;
    delete o.buyBelowUsd;
    if (o.legs) o.legs = o.legs.map((l) => ({ amount: l.amount, filled: !!l.filled }));
    if (!o.pending && !this.working.has(o.id)) {
      delete o.owner;
      delete o.delegate;
      delete o.mint;
      delete o.program;
    }
  }

  /** Cancels as the owner asked. A trade already on its way still settles: if it lands, the order is filled. */
  cancel(o: Order): { status: OrderStatus; settling?: boolean } {
    if (o.status === "pending") {
      this.finish(o, "cancelled");
      return { status: o.status };
    }
    if (o.status !== "active") return { status: o.status, ...(o.pending ? { settling: true } : {}) };
    const busy = !!o.pending || this.working.has(o.id);
    o.cancelAt = this.now();
    this.finish(o, "cancelled");
    return busy ? { status: o.status, settling: true } : { status: o.status };
  }

  /** Drops a trade waiting in the queue (the owner changed the order's terms: they are looked at afresh). */
  dequeue(o: Order) {
    this.queue.delete(o.id);
  }

  /** New terms start fresh: no waits or counts from the old ones (on-chain failures still count: they cost the relayer fees). */
  freshTerms(o: Order) {
    delete o.armed;
    delete o.coolUntil;
    delete o.cools;
    delete o.slCools;
    delete o.slQuietUntil;
    delete o.retryAt;
    delete o.retryFor;
    delete o.afterPrice;
    o.tries = 0;
    this.routeOk(o);
  }

  // ─── failure counts ───
  // each count is one recent streak: it starts over when the trade gets through, when the trigger's
  // moment passes, or after an hour without a failure, so scattered hiccups never add up to giving up
  // (on-chain failures don't start over when the moment passes: each one cost the relayer a fee)

  /** A route was there (a trade was built, or its quote was looked at): route failures start over. */
  private routeOk(o: Order) {
    delete o.routeFails;
    delete o.routeSince;
  }

  /** A trigger's moment passed without a trade: its backoff doesn't carry over to the next one. */
  private calm(o: Order) {
    delete o.retryAt;
    delete o.retryFor;
    delete o.afterPrice;
    o.tries = 0;
    this.routeOk(o);
  }

  /** Called before a count goes up: after a quiet hour the old counts no longer apply. */
  private streak(o: Order, now: number) {
    if (o.failAt != null && now - o.failAt > FAIL_QUIET) {
      o.tries = 0;
      delete o.chainFails;
      delete o.cools;
      delete o.slCools;
      this.routeOk(o);
    }
    o.failAt = now;
  }

  /** One backoff per order: the newest trade's replaces an older one's (both go once a trade is sent). */
  private retry(o: Order, trigger: Trigger, at: number) {
    o.retryAt = at;
    o.retryFor = trigger;
  }

  /** Until when a trade of this kind is held back (another trade's backoff never holds it). */
  private backoff(o: Order, trigger: Trigger): number {
    return o.retryFor === trigger ? (o.retryAt ?? 0) : 0;
  }

  /** A stop-loss that missed its price room waits for a newer price, but never past the point the price counts as stale. */
  private waitsForPrice(o: Order, now: number): boolean {
    return !!o.afterPrice && now - o.afterPrice < UNPRICED_MS && (this.book.getPrice(o.mint!)?.at ?? 0) <= o.afterPrice;
  }

  // ─── prices ───

  /** A fresh price (or none, null) for a token: checked against its orders straight away. */
  onPrice(mint: string, e: PriceEntry | null) {
    // a stopped keeper (shutdown, or another copy of the site runs the orders now) neither arms nor saves anything
    if (this.stopping) return;
    const ids = this.byMint.get(mint);
    if (!ids) return;
    for (const id of ids) {
      const o = this.orders.get(id);
      if (!o || o.status !== "active" || o.kind === "dca") continue;
      if (!e) continue;
      o.lastPrice = e.usd;
      o.priceAt = e.at;
      if (o.error === UNPRICED_ERROR) o.error = null;
      this.evaluate(o, e);
    }
  }

  /** Effective stop: the fixed stop, or the trailing one, whichever is higher. */
  stopOf(o: Order): number | undefined {
    const trail = o.trailPct && o.peak ? o.peak * (1 - o.trailPct / 100) : 0;
    const s = Math.max(o.slUsd ?? 0, trail);
    return s > 0 ? s : undefined;
  }

  private evaluate(o: Order, e: PriceEntry) {
    const now = this.now();
    if (o.kind === "sell") {
      if (o.trailPct && e.usd > (o.peak ?? 0)) {
        o.peak = e.usd;
        this.softDirty = true;
      }
      // a trade on its way, or being built, decides for itself
      if (o.pending || this.working.has(o.id)) return;
      const stop = this.stopOf(o);
      if (stop != null && e.usd <= stop) {
        // a stop-loss whose route showed the price had come back waits a little before arming again
        if ((o.slQuietUntil ?? 0) > now) return;
        if (!o.armed) {
          o.armed = { at: e.at, price: e.usd, ...(e.blockId != null ? { blockId: e.blockId } : {}) };
          this.save();
          this.watchSoon(o.mint!);
        } else if (newer(o.armed, e)) this.enqueue(o, "sl");
        return;
      }
      if (o.armed) {
        // the price came back above the stop before it sold: start over
        delete o.armed;
        if (this.queue.get(o.id)?.trigger === "sl") this.queue.delete(o.id);
        this.calm(o);
        this.save();
      }
      const leg = nextLeg(o, e.usd);
      // the price fell back before a queued take-profit's turn came: keep watching instead
      if (leg == null && this.queue.get(o.id)?.trigger === "tp") {
        this.queue.delete(o.id);
        this.calm(o);
      }
      if ((o.coolUntil ?? 0) > now) return;
      if (leg != null) this.enqueue(o, "tp", leg);
    } else if (o.kind === "buy") {
      if (o.pending || this.working.has(o.id)) return;
      const hit = o.buyBelowUsd != null && e.usd <= o.buyBelowUsd;
      if (!hit && this.queue.has(o.id)) {
        this.queue.delete(o.id);
        this.calm(o);
      }
      if (hit && (o.coolUntil ?? 0) <= now) this.enqueue(o, "buy");
    }
  }

  private enqueue(o: Order, trigger: Trigger, leg?: number) {
    const q = this.queue.get(o.id);
    if (q && PRIO[q.trigger] <= PRIO[trigger]) return;
    this.queue.set(o.id, { trigger, leg, at: q?.at ?? this.now() });
    // a burst of prices can trigger many orders at once: all of them are queued before any is handed out
    if (!this.dispatchQueued) {
      this.dispatchQueued = true;
      queueMicrotask(() => {
        this.dispatchQueued = false;
        this.dispatch();
      });
    }
  }

  /** Ask for the token's price again soon (an armed stop-loss wants its confirmation). */
  private watchSoon(mint: string) {
    if (this.stopping) return;
    const fast = this.fast();
    if ((this.watched.get(mint) ?? Infinity) > fast) {
      this.watched.set(mint, fast);
      this.book.setWatch(mint, fast);
    }
  }

  private fast() {
    return Math.max(2 * SEC, this.opts.fastMs?.() ?? 5 * SEC);
  }

  /** How often each token is checked: often near a trigger, rarely far from one. */
  refreshWatches() {
    if (this.stopping) return;
    const want = new Map<string, number>();
    const fast = this.fast();
    for (const [mint, ids] of this.byMint) {
      let every = 5 * MIN;
      for (const id of ids) {
        const o = this.orders.get(id);
        if (!o || o.status !== "active" || o.kind === "dca") continue;
        every = Math.min(every, this.intervalFor(o, fast));
      }
      want.set(mint, every);
    }
    if (this.opts.solMint && want.size && !want.has(this.opts.solMint)) want.set(this.opts.solMint, MIN);
    for (const [mint, every] of want) {
      if (this.watched.get(mint) === every) continue;
      this.watched.set(mint, every);
      this.book.setWatch(mint, every);
    }
    for (const mint of [...this.watched.keys()]) {
      if (want.has(mint)) continue;
      this.watched.delete(mint);
      this.book.clearWatch(mint);
    }
  }

  intervalFor(o: Order, fast = this.fast()): number {
    if (o.armed || this.queue.has(o.id) || o.pending) return fast;
    const p = (o.mint && this.book.getPrice(o.mint)?.usd) || o.lastPrice;
    if (!p) return fast;
    const stop = this.stopOf(o);
    const triggers = [stop, o.buyBelowUsd, ...(o.legs ?? []).filter((l) => !l.filled).map((l) => l.tpUsd)].filter((x): x is number => x != null && x > 0);
    if (!triggers.length) return 5 * MIN;
    const d = Math.min(...triggers.map((t) => Math.abs(p - t) / p));
    let every = d <= 0.03 ? fast : d <= 0.1 ? 30 * SEC : d <= 0.25 ? 2 * MIN : 5 * MIN;
    // a trailing stop moves with the price, and a stop-loss is never checked less than every 2 minutes
    if (o.trailPct) every = Math.min(every, 30 * SEC);
    if (stop != null) every = Math.min(every, 2 * MIN);
    return Math.max(fast, every);
  }

  private reindex() {
    this.byMint.clear();
    for (const o of this.orders.values()) {
      if (o.status !== "active" || o.kind === "dca" || !o.mint) continue;
      const ids = this.byMint.get(o.mint);
      if (ids) ids.push(o.id);
      else this.byMint.set(o.mint, [o.id]);
    }
  }

  // ─── the loop ───

  /** One turn of the keeper loop (about every second). Never waits for a trade. */
  tick() {
    const now = this.now();
    for (const o of this.orders.values()) {
      if (o.status !== "active") continue;
      const d = o.dca;
      // a paused DCA's end date moves on by the time it is paused (see resume), up to 90 days paused
      const end = d?.paused && d.pausedAt ? d.pausedAt + MAX_PAUSE : o.expires;
      if (now > end && !o.pending && !this.working.has(o.id)) {
        this.finish(o, "expired", d?.paused ? "This DCA was paused for 90 days, so it ended." : "This order reached its end date.");
        continue;
      }
      if (o.kind === "dca" && d && !d.paused && now >= d.next && !o.pending && !this.working.has(o.id) && !this.queue.has(o.id)) this.enqueue(o, "dca");
    }
    this.refreshWatches();
    this.checkUnpriced();
    if (this.softDirty && now - this.softSavedAt > 30 * SEC) {
      this.softDirty = false;
      this.softSavedAt = now;
      this.save();
    }
    this.dispatch();
    this.spawn(this.track());
  }

  /** Drops ended orders (after 14 days) and pending ones nobody activated (after 10 minutes). */
  sweep() {
    const now = this.now();
    let removed = 0;
    for (const o of [...this.orders.values()]) {
      if (o.status === "pending" && now - o.created > PENDING_TTL) {
        this.orders.delete(o.id);
        removed++;
      } else if (o.done && !o.pending && now - o.done > KEEP_DONE_MS) {
        this.orders.delete(o.id);
        removed++;
      } else if (o.done && !o.pending && o.status !== "active") this.slim(o);
    }
    const day = now - 24 * 60 * MIN;
    this.fills24 = this.fills24.filter((t) => t > day);
    this.failures24 = this.failures24.filter((t) => t > day);
    if (removed) this.save();
    return removed;
  }

  /** Stop-losses on a token with no fresh price check whether a route would sell at or below the stop. */
  private checkUnpriced() {
    const now = this.now();
    this.probesAt = this.probesAt.filter((t) => now - t < MIN);
    const due: { m: MintState; stops: Order[] }[] = [];
    for (const [mint, ids] of this.byMint) {
      const e = this.book.getPrice(mint);
      // a token not priced since the start (or since its last price) for a few minutes
      if (now - (e?.at ?? this.startedAt) < UNPRICED_MS) continue;
      const stops = ids.map((id) => this.orders.get(id)!).filter((o) => o && o.status === "active" && o.kind === "sell" && this.stopOf(o) != null && !o.pending && !this.working.has(o.id));
      if (!stops.length) continue;
      const m = this.mint(mint);
      // a token with no route either is asked less and less often, up to every 30 minutes
      if (now - m.probeAt < Math.min(PROBE_EVERY * 2 ** m.probeFails, PROBE_MAX_EVERY)) continue;
      due.push({ m, stops });
    }
    // the longest-waiting first, a couple at a time and within a share of the lane, so the batched price checks keep their turn
    due.sort((a, b) => a.m.probeAt - b.m.probeAt);
    const budget = Math.max(1, Math.floor(this.opts.probeBudget?.() ?? 6));
    for (const { m, stops } of due) {
      if (this.probing >= PROBES_AT_ONCE || this.probesAt.length >= budget) break;
      // spread out, so tokens that went quiet together aren't all asked again together
      m.probeAt = now + Math.floor(this.random() * 20 * SEC);
      this.probesAt.push(now);
      // the biggest order's quote: it gets the least per token, so no smaller order fires too late
      const big = stops.reduce((a, b) => (left(b) > left(a) ? b : a));
      this.spawn(this.probe(m, big, stops));
    }
  }

  private async probe(m: MintState, big: Order, stops: Order[]) {
    this.probing++;
    try {
      if (big.decimals == null) big.decimals = await this.exec.decimals(big);
      const [q, sol] = await Promise.all([this.exec.probe(big, left(big)), this.exec.solUsd()]);
      if (!sol || q.arrives <= 0n || q.out <= 0n) return;
      m.probeFails = 0;
      const eff = (Number(q.out) / 1e9) * sol / (Number(q.arrives) / 10 ** (big.decimals ?? 0));
      for (const o of stops) {
        if (o.error === UNPRICED_ERROR) o.error = null;
        // the dust guard needs a price, and the last one isn't kept over a restart (a fresh price from the book wins)
        const be = this.book.getPrice(o.mint!);
        if (!be || this.now() - be.at >= UNPRICED_MS) o.lastPrice = eff;
        const stop = this.stopOf(o);
        if (o.status === "active" && stop != null && eff <= stop) {
          // a real quote at or below the stop is the newer price a stop-loss that missed its room waits for
          delete o.afterPrice;
          this.enqueue(o, "sl");
        }
      }
    } catch (e) {
      const code = classify(e as Error & { code?: ErrCode; status?: number });
      if (code === "route" || code === "fatal") {
        // no route either: the order says so, and keeps checking
        m.probeFails = Math.min(m.probeFails + 1, 10);
        for (const o of stops) if (!o.error) o.error = UNPRICED_ERROR;
      } else {
        // Jupiter busy or a hiccup: asked again in 15-30 s, and the order's note stays as it was
        m.probeAt = this.now() - PROBE_EVERY + 15 * SEC + Math.floor(this.random() * 15 * SEC);
      }
    } finally {
      this.probing--;
    }
  }

  // ─── trades ───

  /** Hands queued trades to free workers: stop-losses first, then take-profits, limit buys, DCA; oldest first. */
  dispatch() {
    if (this.stopping) return;
    const max = Math.max(1, Math.min(8, Math.floor(this.opts.workers?.() ?? 3)));
    if (this.working.size >= max || !this.queue.size) return;
    const now = this.now();
    const ready = [...this.queue.entries()]
      .filter(([id, q]) => {
        const o = this.orders.get(id);
        if (!o || o.status !== "active" || o.dca?.paused) {
          this.queue.delete(id);
          return false;
        }
        // a backoff holds back only the trade it was set for (an older one's never delays a stop-loss)
        if (this.backoff(o, q.trigger) > now) return false;
        if (o.pending || this.working.has(id)) return false;
        if (this.waitsForPrice(o, now)) return false;
        // a paused token holds back everything but stop-losses: they back off on their own
        if (o.mint && q.trigger !== "sl" && (this.mints.get(o.mint)?.until ?? 0) > now) return false;
        // the account lock is checked below, only for the trades actually handed out (working out the account is slow)
        return true;
      })
      .sort((a, b) => PRIO[a[1].trigger] - PRIO[b[1].trigger] || a[1].at - b[1].at);
    for (const [id, q] of ready) {
      if (this.working.size >= max) break;
      const o = this.orders.get(id)!;
      const key = this.opts.inputKey(o);
      if (this.locks.has(key)) continue;
      this.queue.delete(id);
      this.working.add(id);
      this.locks.add(key);
      this.spawn(this.run(o, q.trigger, q.leg));
    }
  }

  private spawn(p: Promise<unknown>) {
    const t = p.catch((e) => log(`orders: ${(e as Error).message}`)).finally(() => this.tasks.delete(t));
    this.tasks.add(t);
  }

  /** Waits for every trade being built and every check under way (tests, shutdown). */
  async idle() {
    while (this.tasks.size) await Promise.all([...this.tasks]);
  }

  /** What one trade spends: the remaining tokens (stop-loss), one take-profit step, the limit buy, or one DCA buy. */
  private planOf(o: Order, trigger: Trigger, leg?: number): { amount: bigint; leg?: number; round?: number } {
    const rest = left(o);
    if (trigger === "tp" && leg != null && o.legs?.[leg]) {
      const a = BigInt(o.legs[leg].amount);
      return { amount: a < rest ? a : rest, leg };
    }
    if (trigger === "dca" && o.dca) {
      const round = o.dca.done;
      return { amount: round >= o.dca.count - 1 ? rest : BigInt(o.dca.per) < rest ? BigInt(o.dca.per) : rest, round };
    }
    return { amount: rest };
  }

  /** Whether a queued trade still matches the order's terms (they may have changed while it waited). */
  private due(o: Order, trigger: Trigger, leg?: number): boolean {
    if (trigger === "sl") return o.kind === "sell" && this.stopOf(o) != null;
    if (trigger === "tp") return leg != null && !!o.legs?.[leg] && !o.legs[leg].filled && o.legs[leg].tpUsd != null;
    if (trigger === "buy") return o.buyBelowUsd != null;
    return !!o.dca && !o.dca.paused;
  }

  private async run(o: Order, trigger: Trigger, leg?: number) {
    const key = this.opts.inputKey(o);
    let sent = false;
    try {
      if (!this.due(o, trigger, leg)) return;
      if (!(await this.exec.relayerOk())) throw keeperError("The order service is topping up its fees. Your order will run shortly.", "relayer");
      if (this.relayerLowSince) {
        this.relayerLowSince = 0;
        log("orders: the relayer has SOL again; trades carry on");
      }
      if (o.decimals == null) o.decimals = await this.exec.decimals(o);
      if (this.verify.has(o.id)) {
        // the first trade after a restart: anything the order's key did meanwhile is written down first
        await this.reconcile(o).catch((e) => {
          throw keeperError((e as Error).message, "transient");
        });
        this.verify.delete(o.id);
        this.complete(o);
        if (o.status !== "active" || !this.due(o, trigger, leg)) return;
      }
      let plan = this.planOf(o, trigger, leg);
      const a = await this.exec.approval(o).catch((e) => {
        throw keeperError((e as Error).message, "transient");
      });
      const rest = left(o);
      if (!a || a.delegate !== o.delegate || a.delegated < rest || a.balance < plan.amount) {
        // fewer tokens approved than expected: a trade may have landed that isn't written down yet
        const found = await this.reconcile(o);
        if (o.status !== "active") return;
        if (!a || a.delegate !== o.delegate || a.delegated === 0n || a.balance === 0n) {
          if (!found) this.finish(o, "cancelled", o.kind === "dca" ? "The approval was withdrawn or the SOL moved, so the DCA stopped." : "The approval was withdrawn or the tokens moved, so the order stopped.");
          else this.complete(o);
          return;
        }
        plan = this.planOf(o, trigger, leg);
        const most = a.delegated < a.balance ? a.delegated : a.balance;
        if (plan.amount > most) {
          // most of the tokens (or SOL) left the Vision wallet: the dust left over isn't traded
          if (a.balance < plan.amount && this.dust(o, most)) {
            this.finish(o, "cancelled", o.kind === "sell" ? "The tokens moved out of the Vision wallet, so the order stopped." : "The SOL moved out of the Vision wallet, so the order stopped.");
            return;
          }
          plan = { ...plan, amount: most };
        }
      }
      if (plan.amount <= 0n) {
        this.complete(o);
        return;
      }
      const urgent = trigger === "sl";
      const slippageBps = urgent ? (o.slSlippageBps ?? o.slippageBps) : o.slippageBps;
      // a stop-loss never waits on SOL's price (it sells at market); the take-profit and limit-buy gates want a fresh one
      const sol = await this.exec.solUsd(urgent ? { cachedOnly: true } : trigger === "tp" || trigger === "buy" ? { maxAgeMs: 15 * SEC } : undefined).catch(() => null);
      let priceUsd: number | null = null;
      const gate = this.gateFor(o, trigger, plan.leg, sol, (p) => (priceUsd = p));
      const built = await this.exec.build(o, { trigger, amount: plan.amount, leg: plan.leg, round: plan.round, slippageBps, urgent, gate });
      // cancelled while it was being built: it never goes out
      if (o.status !== "active") throw keeperError("cancelled", "cancelled");
      o.pending = { sig: built.sig, lastValid: built.lastValid, amount: plan.amount.toString(), trigger, at: this.now(), expect: built.out, priceUsd, ...(plan.leg != null ? { leg: plan.leg } : {}), ...(plan.round != null ? { round: plan.round } : {}) };
      sent = true;
      delete o.armed;
      delete o.retryAt;
      delete o.retryFor;
      delete o.afterPrice;
      // it got through to a signed trade: hiccups and route failures start over (on-chain failures count until one lands)
      o.tries = 0;
      this.routeOk(o);
      const m = o.mint ? this.mints.get(o.mint) : undefined;
      if (m) m.owners.clear();
      o.error = null;
      // written to disk before it goes out, so a crash right after the send can't forget it
      if (this.opts.saveNow) await this.opts.saveNow().catch(() => this.save());
      else this.save();
      // cancelled while it was being written down: it never goes out (the tracker drops it once its blockhash expires)
      if (o.status !== "active") return;
      log(`orders: ${o.id.slice(0, 6)} ${trigger} trade sent`);
      // a failed send may still have gone out: the tracker settles it either way
      await built.send().catch((e) => log(`orders: ${o.id.slice(0, 6)} send: ${(e as Error).message.slice(0, 120)}`));
    } catch (e) {
      this.failed(o, trigger, leg, e as Error & { code?: ErrCode; status?: number; priceUsd?: number });
    } finally {
      this.working.delete(o.id);
      if (!sent) this.locks.delete(key);
      // cancelled while it was being built: what was kept for the build goes now
      if (o.status !== "active" && !o.pending) this.slim(o);
      this.dispatch();
    }
  }

  /** Too little to be worth a trade: under half the smallest order the server takes. */
  private dust(o: Order, amount: bigint): boolean {
    const l = this.opts.limits;
    if (!l) return false;
    if (o.kind !== "sell") return amount < (o.kind === "dca" ? l.minDcaBuyLamports : l.minBuyLamports) / 2n;
    const p = o.lastPrice ?? (o.mint ? this.book.getPrice(o.mint)?.usd : undefined);
    return !!p && o.decimals != null && (Number(amount) / 10 ** o.decimals) * p < l.minSellUsd / 2;
  }

  /**
   * The price gate, run on the trade's own quote. Take-profit: what arrives must be worth at least
   * the step's price per token; limit buy: each token may cost at most the limit. A stop-loss sells
   * at market, unless the price has clearly come back above the stop.
   */
  gateFor(o: Order, trigger: Trigger, leg: number | undefined, sol: number | null, seen: (p: number | null) => void): Gate | undefined {
    const dec = o.decimals ?? 0;
    const tokens = (raw: bigint) => Number(raw) / 10 ** dec;
    if (trigger === "tp") {
      const tp = leg != null ? o.legs?.[leg]?.tpUsd : undefined;
      if (!tp) throw keeperError("keeper: no take-profit price", "fatal");
      if (!sol) throw keeperError("Waiting for SOL's price.", "transient");
      return (q) => {
        const eff = ((Number(q.out) / 1e9) * sol) / tokens(q.arrives);
        seen(eff);
        if (eff < tp) throw keeperError(`Waiting for a better price: selling now would get about $${short(eff)} a token.`, "price", { priceUsd: eff });
        // the least SOL that still meets the price; the chain must guarantee it
        return BigInt(Math.ceil((tokens(q.arrives) * tp * 1e9) / sol));
      };
    }
    if (trigger === "buy") {
      const limit = o.buyBelowUsd;
      if (!limit) throw keeperError("keeper: no buy price", "fatal");
      if (!sol) throw keeperError("Waiting for SOL's price.", "transient");
      return (q) => {
        // Jupiter's amounts already allow for a taxed token's transfer tax: `out` is what arrives
        const eff = q.out > 0n ? ((Number(q.arrives) / 1e9) * sol) / tokens(q.out) : Infinity;
        seen(eff);
        if (eff > limit) throw keeperError(`Waiting for a better price: buying now would cost about $${short(eff)} a token.`, "price", { priceUsd: eff });
        // the least that must arrive (the threshold it is held to is counted the same way)
        return BigInt(Math.ceil((((Number(q.arrives) / 1e9) * sol) / limit) * 10 ** dec));
      };
    }
    if (trigger === "sl") {
      const stop = this.stopOf(o);
      return (q) => {
        // the stop was taken away while this trade waited: nothing to sell for
        if (stop == null) throw keeperError("The order has no stop any more.", "recovered");
        if (!sol || q.arrives <= 0n) return undefined;
        const eff = ((Number(q.out) / 1e9) * sol) / tokens(q.arrives);
        seen(eff);
        if (eff > stop * RECOVERED) throw keeperError("The price came back above the stop.", "recovered", { priceUsd: eff });
        return undefined;
      };
    }
    // DCA buys at market; the fill still records its price
    return (q) => {
      if (sol && q.out > 0n) seen(((Number(q.arrives) / 1e9) * sol) / tokens(q.out));
      return undefined;
    };
  }

  private failed(o: Order, trigger: Trigger, leg: number | undefined, e: Error & { code?: ErrCode; status?: number }) {
    const now = this.now();
    const code = classify(e);
    // cancelled (or ended) meanwhile: nothing to try again
    if (o.status !== "active") return;
    const back = () => {
      if (o.status === "active") this.queue.set(o.id, { trigger, leg, at: this.queue.get(o.id)?.at ?? now });
    };
    switch (code) {
      case "cancelled":
        return;
      case "busy":
        // our own Jupiter share is full: just later, never counted against the order
        this.retry(o, trigger, now + 2 * SEC + Math.floor(this.random() * 3 * SEC));
        back();
        return;
      case "relayer":
        if (!this.relayerLowSince) {
          this.relayerLowSince = now;
          log("orders: the relayer is low on SOL; order trades wait until it is topped up");
        }
        this.retry(o, trigger, now + 30 * SEC);
        o.error = e.message;
        back();
        return;
      case "recovered":
        this.streak(o, now);
        this.routeOk(o);
        delete o.armed;
        // its own count, kept short: a stop-loss is back on watch within two minutes
        o.slCools = (o.slCools ?? 0) + 1;
        o.slQuietUntil = now + Math.min(30 * SEC * 2 ** (o.slCools - 1), 2 * MIN);
        this.save();
        return;
      case "price":
        this.streak(o, now);
        this.routeOk(o);
        // a take-profit or limit buy waits for the next crossing, a little longer each time
        o.cools = (o.cools ?? 0) + 1;
        o.coolUntil = now + Math.min(MIN * 2 ** (o.cools - 1), 10 * MIN);
        o.error = e.message;
        this.save();
        return;
      case "slippage":
        this.streak(o, now);
        this.routeOk(o);
        if (trigger === "sl" || trigger === "dca") {
          // the price moved past the room: a stop-loss tries again on the next price, a DCA buy a bit later
          if (trigger === "sl") {
            const p = o.mint ? this.book.getPrice(o.mint) : null;
            if (p && now - p.at < UNPRICED_MS) o.afterPrice = p.at;
            else {
              // no fresh price is coming (Jupiter stopped pricing the token): a few seconds instead
              delete o.afterPrice;
              this.retry(o, trigger, now + 5 * SEC + Math.floor(this.random() * 5 * SEC));
            }
          } else this.retry(o, trigger, now + MIN);
          o.error = "The price moved too fast for the order's price room. Trying again.";
          back();
        } else {
          o.cools = (o.cools ?? 0) + 1;
          o.coolUntil = now + Math.min(MIN * 2 ** (o.cools - 1), 10 * MIN);
          o.error = "The price moved too fast for the order's price room. Waiting for the next chance.";
        }
        this.save();
        return;
      case "fatal":
        this.failures24.push(now);
        log(`orders: ${o.id.slice(0, 6)} ${trigger}: ${e.message.slice(0, 160)}`);
        this.finish(o, "failed", plain(e.message, o));
        return;
      case "route": {
        this.failures24.push(now);
        this.streak(o, now);
        this.trip(o, now);
        o.routeFails = (o.routeFails ?? 0) + 1;
        o.routeSince ??= now;
        log(`orders: ${o.id.slice(0, 6)} ${trigger}: ${e.message.slice(0, 160)}`);
        if (o.routeFails >= ROUTE_GIVE_UP && now - o.routeSince >= ROUTE_WINDOW) {
          this.finish(o, "failed", o.kind === "sell" ? "No market could take this trade for a long while, so the order stopped. Your tokens are still in the Vision wallet." : "No market could take this trade for a long while, so the order stopped. Your SOL is still in the Vision wallet.");
          return;
        }
        o.error = "No route for this trade right now. Trying again.";
        if (trigger === "tp" || trigger === "buy") {
          o.cools = (o.cools ?? 0) + 1;
          o.coolUntil = now + Math.min(2 * MIN * 2 ** (o.cools - 1), 30 * MIN);
        } else {
          this.retry(o, trigger, now + Math.min(30 * SEC * 2 ** (o.routeFails - 1), 10 * MIN));
          back();
        }
        this.save();
        return;
      }
      // this order's own Vision wallet couldn't take the trade (an account of its gone, or its tokens moved under
      // it): it backs off like a hiccup, and the token's breaker never hears of it, so one wallet's state can't
      // pause everyone else's take-profits, limit buys and DCA on the token
      case "account":
      default: {
        // a hiccup (network, RPC, a timeout): back off and try again, never giving up before the order ends
        this.streak(o, now);
        o.tries = (o.tries ?? 0) + 1;
        const fastFirst = trigger === "sl" && o.tries <= 3;
        // a stop-loss keeps trying at least every minute or so
        const base = fastFirst ? 3 * SEC + Math.floor(this.random() * 2 * SEC) : Math.min(5 * SEC * 2 ** (o.tries - 1), trigger === "sl" ? MIN : 5 * MIN);
        this.retry(o, trigger, now + Math.round(base * (fastFirst ? 1 : 0.8 + this.random() * 0.4)));
        o.error = code === "account" ? "This order's Vision wallet couldn't take the trade just now. Trying again shortly." : "Couldn't trade just now. Trying again shortly.";
        if (o.tries === 1 || o.tries % 10 === 0) log(`orders: ${o.id.slice(0, 6)} ${trigger}: ${e.message.slice(0, 160)}`);
        back();
        this.save();
      }
    }
  }

  // ─── settling trades ───

  /** Settles every trade on its way: one status call for all of them, then the chain's history for expired ones. */
  async track() {
    if (this.tracking || this.now() - this.trackedAt < 1_500) return;
    const list = [...this.orders.values()].filter((o) => o.pending);
    if (!list.length) return;
    this.tracking = true;
    this.trackedAt = this.now();
    try {
      const results = new Map<string, SigState>();
      for (const history of [false, true]) {
        const group = list.filter((o) => !!o.pending!.history === history);
        for (let i = 0; i < group.length; i += 256) {
          const chunk = group.slice(i, i + 256);
          const st = await this.exec.statuses(
            chunk.map((o) => o.pending!.sig),
            history,
          );
          chunk.forEach((o, j) => results.set(o.id, st[j] ?? null));
        }
      }
      const now = this.now();
      if ([...results.values()].some((r) => r == null) && now - this.heightAt > 5 * SEC) {
        this.lastHeight = await this.exec.height();
        this.heightAt = now;
      }
      for (const o of list) {
        const p = o.pending;
        if (!p) continue;
        const r = results.get(o.id);
        if (r === "landed") await this.landed(o, p);
        else if (r === "failed") this.failedOnChain(o, p);
        else if (this.lastHeight > p.lastValid) {
          // its blockhash has expired, so it can't land any more: look once more, in the history too
          if (!p.history) p.history = true;
          else await this.expired(o, p);
        }
      }
    } catch (e) {
      log(`orders: couldn't check trades on their way (${(e as Error).message.slice(0, 120)}); trying again`);
    } finally {
      this.tracking = false;
    }
  }

  private async landed(o: Order, p: Attempt, sig = p.sig) {
    const got = await this.exec.landed(o, sig).catch(() => null);
    this.record(o, { t: this.now(), sig, spent: got?.spent ?? p.amount, got: got?.got ?? p.expect, priceUsd: p.priceUsd, ...(p.leg != null ? { leg: p.leg } : {}), ...(p.round != null ? { round: p.round } : {}) }, p.trigger);
    this.release(o);
    this.complete(o);
    if (o.status !== "active") this.slim(o);
    this.save();
    // more take-profit steps may already be crossed
    if (o.status === "active" && o.mint) {
      const e = this.book.getPrice(o.mint);
      if (e && this.now() - e.at < 30 * SEC) this.evaluate(o, e);
    }
  }

  private record(o: Order, f: Fill, trigger: Trigger) {
    if (o.fills.some((x) => x.sig === f.sig)) return;
    o.fills.push(f);
    o.spent = (BigInt(o.spent ?? "0") + BigInt(f.spent)).toString();
    if (f.leg != null && o.legs?.[f.leg]) o.legs[f.leg].filled = true;
    if (o.dca && trigger === "dca") {
      o.dca.done = Math.max(o.dca.done, (f.round ?? o.dca.done) + 1);
      o.dca.next = this.nextRound(o);
    }
    o.error = o.status !== "cancelled" ? null : o.kind === "dca" || left(o) > 0n ? "Part of it went through before the cancel took effect." : "Filled before the cancel took effect.";
    o.tries = 0;
    delete o.chainFails;
    delete o.routeFails;
    delete o.routeSince;
    delete o.cools;
    delete o.slCools;
    delete o.failAt;
    delete o.coolUntil;
    delete o.slQuietUntil;
    if (trigger === "sl") delete o.armed;
    if (o.mint) this.mints.delete(o.mint);
    this.fills24.push(this.now());
    log(`orders: ${o.id.slice(0, 6)} ${trigger} filled`);
  }

  /** Whether the order has nothing left to do after a fill. */
  private complete(o: Order) {
    const rest = left(o);
    let over = rest <= 0n;
    if (o.kind === "sell" && !over) over = this.stopOf(o) == null && !!o.legs?.length && o.legs.every((l) => l.filled);
    if (o.kind === "buy") over = o.fills.length > 0;
    if (o.kind === "dca" && o.dca) over = o.dca.done >= o.dca.count || rest <= 0n;
    if (!over) return;
    // a sell or buy that filled after a cancel is reported as filled: that is what happened
    if (o.status === "active" || (o.status === "cancelled" && o.kind !== "dca")) this.finish(o, "filled", o.status === "cancelled" ? o.error : null);
  }

  /** DCA rounds land a little off the exact interval (up to ±10%, at most 30 minutes) unless asked to be exact. */
  nextRound(o: Order): number {
    const d = o.dca!;
    const every = d.every * SEC;
    const jitter = d.exact ? 0 : (this.random() * 2 - 1) * Math.min(every * 0.1, 30 * MIN);
    return this.now() + every + Math.round(jitter);
  }

  private failedOnChain(o: Order, p: Attempt) {
    this.release(o);
    this.failures24.push(this.now());
    log(`orders: ${o.id.slice(0, 6)} ${p.trigger} trade failed on-chain`);
    if (o.status !== "active") {
      if (o.status === "cancelled") this.slim(o);
      this.save();
      return;
    }
    // a token whose trades keep failing on-chain pauses like one whose routes fail
    const now = this.now();
    this.trip(o, now);
    this.streak(o, now);
    o.chainFails = (o.chainFails ?? 0) + 1;
    // most failures on-chain are the price moving past the room between check and landing
    this.failed(o, p.trigger, p.leg, keeperError("the trade failed on-chain", "slippage"));
    // ... but each costs a network fee: after three in a row, the order waits longer each time
    if (o.status === "active" && o.chainFails >= 3) this.retry(o, p.trigger, Math.max(this.backoff(o, p.trigger), now + Math.min(30 * SEC * 2 ** (o.chainFails - 3), 10 * MIN)));
  }

  /** The trade's blockhash expired and no status was found: the chain's own record decides. */
  private async expired(o: Order, p: Attempt) {
    const found = await this.reconcile(o).catch(() => -1);
    if (found < 0) return; // couldn't ask: next round
    if (o.pending !== p) return;
    if (o.fills.some((f) => f.sig === p.sig)) {
      this.release(o);
      this.complete(o);
      if (o.status !== "active") this.slim(o);
      this.save();
      return;
    }
    // it never landed: the trade is simply tried again
    this.release(o);
    if (o.status === "active") this.queue.set(o.id, { trigger: p.trigger, leg: p.leg, at: this.now() });
    else if (o.status === "cancelled") this.slim(o);
    this.save();
  }

  /**
   * Trades the order's key made that landed but aren't written down (a restart at the wrong
   * moment): each is recorded as a fill. Returns how many were found.
   */
  private async reconcile(o: Order): Promise<number> {
    const seen = await this.exec.history(o);
    let found = 0;
    // no block time yet counts as newest
    const at = (t: number | null) => t ?? Infinity;
    for (const h of seen.sort((a, b) => at(a.t) - at(b.t))) {
      const p = o.pending?.sig === h.sig ? o.pending : undefined;
      // the trade on its way is always this order's; any other must be newer than the order (one with no block time yet is looked at next time)
      if ((!p && (h.t == null || h.t < o.created)) || o.fills.some((f) => f.sig === h.sig)) continue;
      const got = await this.exec.landed(o, h.sig).catch(() => null);
      // the owner's own approval and revoke name the order key too: only its own trades count
      if (!got && !p) continue;
      const spent = got?.spent ?? p?.amount ?? "0";
      // a sell nobody wrote down (a restart right after sending): the take-profit step of that size, if any
      const leg = p ? p.leg : o.kind === "sell" ? legOfSpent(o, spent) : -1;
      const trigger: Trigger = p?.trigger ?? (o.kind === "dca" ? "dca" : o.kind === "buy" ? "buy" : leg != null && leg >= 0 ? "tp" : "sl");
      this.record(
        o,
        { t: this.now(), sig: h.sig, spent, got: got?.got ?? p?.expect ?? "0", priceUsd: p?.priceUsd ?? null, ...(leg != null && leg >= 0 ? { leg } : {}), ...(p?.round != null ? { round: p.round } : o.dca ? { round: o.dca.done } : {}) },
        trigger,
      );
      found++;
    }
    if (found) this.save();
    return found;
  }

  private release(o: Order) {
    delete o.pending;
    if (o.owner) this.locks.delete(this.opts.inputKey(o));
  }

  private mint(m: string) {
    let s = this.mints.get(m);
    if (!s) this.mints.set(m, (s = { owners: new Set(), lastFail: 0, trips: 0, until: 0, probeAt: 0, probeFails: 0 }));
    return s;
  }

  /**
   * A failed trade on a token, for its breaker: failures for several different wallets close together
   * pause the token's take-profits, limit buys and DCA (prices are still watched, and stop-losses keep
   * trying on their own backoff), so one wallet's bad order can't hold up everyone else's.
   */
  private trip(o: Order, now: number) {
    if (!o.mint) return;
    const m = this.mint(o.mint);
    if (m.until > now) return;
    if (now - m.lastFail > BREAKER_QUIET) m.owners.clear();
    // a pause long ago doesn't make the next one longer
    if (m.until && now - m.until > BREAKER_FORGET) m.trips = 0;
    m.lastFail = now;
    m.owners.add(o.owner ?? o.id);
    if (m.owners.size < BREAKER_AT) return;
    m.until = now + Math.min(2 * MIN * 2 ** m.trips, 30 * MIN);
    m.trips++;
    m.owners.clear();
  }

  // ─── reporting ───

  stageOf(o: Order): Stage {
    const now = this.now();
    if (o.pending) return "sending";
    if (this.working.has(o.id)) return "trading";
    if (o.dca?.paused) return "paused";
    const q = this.queue.get(o.id);
    if (q) {
      if ((o.mint && q.trigger !== "sl" && (this.mints.get(o.mint)?.until ?? 0) > now) || this.relayerLowSince) return "waiting";
      return this.backoff(o, q.trigger) > now || this.waitsForPrice(o, now) ? "retrying" : "queued";
    }
    if (o.armed) return "armed";
    return "watching";
  }

  /** When the keeper next looks at this order. */
  nextCheckAt(o: Order): number | null {
    if (o.status !== "active") return null;
    if (o.kind === "dca") return o.dca?.paused ? null : Math.max(o.dca!.next, this.backoff(o, "dca"));
    // a queued trade waits out only its own backoff
    const q = this.queue.get(o.id);
    const back = q ? this.backoff(o, q.trigger) : (o.retryAt ?? 0);
    if (back > this.now()) return back;
    const every = this.watched.get(o.mint ?? "") ?? this.intervalFor(o);
    return (o.priceAt ?? this.now()) + every;
  }

  inFlight(o: Order) {
    return !!o.pending || this.working.has(o.id);
  }

  stats() {
    const now = this.now();
    let active = 0;
    let pending = 0;
    let armed = 0;
    let oldestArmed = 0;
    for (const o of this.orders.values()) {
      if (o.status === "pending") pending++;
      if (o.status !== "active") continue;
      active++;
      if (o.armed) {
        armed++;
        oldestArmed = Math.max(oldestArmed, now - o.armed.at);
      }
    }
    // only trades that could be handed out count, from when they became ready: one waiting out its own
    // backoff, a paused token or a newer price is "retrying" or "waiting", not stalled
    let oldestQueued = 0;
    for (const [id, q] of this.queue) {
      const o = this.orders.get(id);
      if (!o || o.status !== "active" || o.dca?.paused || o.pending || this.working.has(id) || this.waitsForPrice(o, now)) continue;
      const pausedUntil = o.mint && q.trigger !== "sl" ? (this.mints.get(o.mint)?.until ?? 0) : 0;
      const readySince = Math.max(q.at, this.backoff(o, q.trigger), pausedUntil);
      if (readySince <= now) oldestQueued = Math.max(oldestQueued, now - readySince);
    }
    const day = now - 24 * 60 * MIN;
    return {
      active,
      pending,
      watchedTokens: this.watched.size,
      queue: this.queue.size,
      trading: this.working.size,
      sending: [...this.orders.values()].filter((o) => o.pending).length,
      armed,
      oldestArmedSec: Math.round(oldestArmed / 1000),
      oldestQueuedSec: Math.round(oldestQueued / 1000),
      fills24h: this.fills24.filter((t) => t > day).length,
      failures24h: this.failures24.filter((t) => t > day).length,
      pausedTokens: [...this.mints.values()].filter((m) => m.until > now).length,
      relayerLow: !!this.relayerLowSince,
    };
  }
}

/** What an order still has to trade (raw input units). */
export function left(o: Order): bigint {
  const r = BigInt(o.amount) - BigInt(o.spent ?? "0");
  return r > 0n ? r : 0n;
}

/** The lowest take-profit step not yet filled that the price has reached. */
function nextLeg(o: Order, price: number): number | undefined {
  let best: number | undefined;
  (o.legs ?? []).forEach((l, i) => {
    if (l.filled || l.tpUsd == null || price < l.tpUsd) return;
    if (best == null || l.tpUsd < o.legs![best].tpUsd!) best = i;
  });
  return best;
}

/**
 * The take-profit step a sell nobody wrote down filled: of the open steps that size, the lowest-priced
 * one (steps sell lowest price first, whatever order they were entered in).
 */
function legOfSpent(o: Order, spent: string): number {
  let best = -1;
  (o.legs ?? []).forEach((l, i) => {
    if (l.filled || l.amount !== spent) return;
    if (best < 0 || (l.tpUsd ?? Infinity) < (o.legs![best].tpUsd ?? Infinity)) best = i;
  });
  return best;
}

/** A second price that is genuinely a new observation, not the same one read twice. */
function newer(armed: { at: number; blockId?: number }, e: PriceEntry): boolean {
  if (e.at <= armed.at) return false;
  if (e.at - armed.at >= CONFIRM_ANYWAY_MS) return true;
  if (armed.blockId != null && e.blockId != null) return e.blockId !== armed.blockId;
  return e.at - armed.at >= CONFIRM_MS;
}

export function classify(e: Error & { code?: ErrCode; status?: number }): ErrCode {
  if (e.code) return e.code;
  if (e.status === 429) return "busy";
  if (/no route/i.test(e.message)) return "route";
  if (e.status === 400 || e.status === 422) return "route";
  return "transient";
}

/** A plain message for an order that can't go on. */
function plain(msg: string, o: Order): string {
  if (/transfer tax/i.test(msg)) return "This token's transfer tax would take the whole trade, so the order stopped.";
  if (/frozen/i.test(msg)) return "This token's accounts are frozen, so the order can't trade it.";
  return o.kind === "sell" ? "This order can't trade this token, so it stopped. Your tokens are still in the Vision wallet." : "This order can't trade this token, so it stopped. Your SOL is still in the Vision wallet.";
}

const short = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));

/** Fills in what orders saved by older versions don't have. */
export function normalize(o: Order) {
  o.fills ??= [];
  o.tries ??= 0;
  if (o.kind === "sell" && !o.legs && o.tpUsd) o.legs = [{ tpUsd: o.tpUsd, amount: o.amount }];
  if (o.spent == null) o.spent = o.fills.reduce((s, f) => s + BigInt(f.spent || "0"), 0n).toString();
  // 1.4.0 counted every error toward giving up; those counts mean nothing now
  if (o.hits != null) o.tries = 0;
  delete o.hits;
  // 1.4.0 kept one backoff for any trade: a buy's or DCA's is its only trade's; a sell's could be the stop-loss's or a take-profit's, so it goes
  if (o.retryAt != null && !o.retryFor) {
    if (o.kind === "sell") delete o.retryAt;
    else o.retryFor = o.kind;
  }
}

// ─── admission ───

/** A bounded base58 string: checked before decoding, since decoding takes time that grows with the square of the length. */
export const isB58 = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max && /^[1-9A-HJ-NP-Za-km-z]+$/.test(v);

/** Server-side floors, so tiny orders can't run below what their trades cost. */
export type Limits = { minSellUsd: number; minBuyLamports: bigint; minDcaBuyLamports: bigint; minDcaEverySec: number };
export const MAX_SLIPPAGE_BPS = 2500;
export const MAX_DAYS = 90;
export const MAX_LEGS = 4;
const clampBps = (v: unknown, d: number) => {
  const n = Math.round(Number(v ?? d));
  return Math.max(10, Math.min(MAX_SLIPPAGE_BPS, Number.isFinite(n) ? n : d));
};
const pos = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : undefined);
const rawAmount = (x: unknown) => (/^\d{1,20}$/.test(String(x)) && BigInt(String(x)) > 0n ? String(x) : null);
const bad = (m: string, status = 400) => Object.assign(new Error(m), { status });
const usd = (n: number) => (n >= 1 ? n.toFixed(2) : n.toPrecision(3));
const sol = (l: bigint) => String(Number(l) / 1e9);

export type Checked = Pick<Order, "amount" | "tpUsd" | "slUsd" | "trailPct" | "legs" | "buyBelowUsd" | "slippageBps" | "slSlippageBps"> & {
  dca?: { per: string; every: number; count: number; exact: boolean };
  days?: number;
};

/**
 * Checks an order's terms, for a new order (`prev` unset) or an edit of a live one (only the fields
 * given change). `price` is the token's current USD price; `resume` is an order handed back after the
 * server lost it (its approval is already on-chain), which skips the "would trigger straight away"
 * checks and the size floors that only guard new orders.
 */
export function checkOrder(
  kind: OrderKind,
  b: Record<string, unknown>,
  ctx: { price: number | null; decimals: number; resume?: boolean; limits: Limits; prev?: Order },
): Checked {
  const { price, prev, limits } = ctx;
  const fresh = !prev && !ctx.resume;
  const given = (k: string) => Object.hasOwn(b, k) && b[k] !== undefined;
  let amount = prev?.amount ?? "";
  if (!prev || given("amount")) {
    const a = rawAmount(b.amount);
    if (!a) throw bad("Bad amount.");
    if (prev) {
      // an edit can only lower the amount: the approval on-chain is the most it may ever trade
      if (BigInt(a) > BigInt(prev.amount)) throw bad("The amount can only go down: the approval covers no more.");
      if (BigInt(a) <= BigInt(prev.spent ?? "0")) throw bad("That is no more than what has already traded.");
      if (kind === "dca") throw bad("A DCA's amount can't be changed. Cancel it and start a new one.");
    }
    amount = a;
  }
  const out: Checked = { amount, slippageBps: clampBps(given("slippageBps") ? b.slippageBps : prev?.slippageBps, 300) };
  if (!prev || given("days")) out.days = Math.min(MAX_DAYS, Math.max(1, Math.round(Number(b.days ?? 30)) || 30));
  const tokens = (raw: bigint) => Number(raw) / 10 ** ctx.decimals;

  if (kind === "sell") {
    // the stop-loss's own price room; left out, it follows the order's price room (what the app shows)
    if (given("slSlippageBps")) out.slSlippageBps = b.slSlippageBps === null ? undefined : clampBps(b.slSlippageBps, 1500);
    else out.slSlippageBps = prev?.slSlippageBps;
    out.slUsd = given("slUsd") || !prev ? pos(b.slUsd) : prev.slUsd;
    if (given("trailPct") || !prev) {
      if (b.trailPct == null || b.trailPct === 0) out.trailPct = undefined;
      else {
        const t = Number(b.trailPct);
        if (!(Number.isFinite(t) && t >= 1 && t <= 50)) throw bad("A trailing stop follows the price from 1% to 50% below its peak.");
        out.trailPct = t;
      }
    } else out.trailPct = prev.trailPct;
    // take-profit steps: one at tpUsd for the whole amount, or up to 4 of their own
    const filled = (prev?.legs ?? []).filter((l) => l.filled);
    let open: Leg[];
    if (given("legs")) {
      if (!Array.isArray(b.legs)) throw bad("Bad take-profit steps.");
      open = (b.legs as Record<string, unknown>[]).map((l) => {
        const tp = pos(l?.tpUsd);
        const a = rawAmount(l?.amount);
        if (!tp || !a) throw bad("Each take-profit step needs a price and an amount.");
        return { tpUsd: tp, amount: a };
      });
    } else if (given("tpUsd") || !prev) {
      const tp = pos(b.tpUsd);
      open = tp ? [{ tpUsd: tp, amount: (BigInt(amount) - BigInt(prev?.spent ?? "0")).toString() }] : [];
    } else {
      open = (prev.legs ?? []).filter((l) => !l.filled);
      // a lower amount: a single take-profit step keeps covering all of what's left
      if (given("amount") && open.length === 1) open = [{ ...open[0], amount: (BigInt(amount) - BigInt(prev.spent ?? "0")).toString() }];
    }
    if (filled.length + open.length > MAX_LEGS) throw bad(`Use at most ${MAX_LEGS} take-profit steps.`);
    const legs = [...filled, ...open];
    if (!open.length && !out.slUsd && !out.trailPct && !filled.length) throw bad("Set a take-profit price, a stop-loss price, or both.");
    const sum = legs.reduce((s, l) => s + BigInt(l.amount), 0n);
    if (sum > BigInt(amount)) throw bad("The take-profit steps add up to more than the order's tokens.");
    const lowest = Math.min(...open.map((l) => l.tpUsd!));
    if (out.slUsd && open.length && out.slUsd >= lowest) throw bad("The stop-loss has to be below the take-profit.");
    // a price on the wrong side of today's would trade straight away (a typo, most often)
    if (price && !ctx.resume) {
      if ((given("legs") || given("tpUsd") || !prev) && open.some((l) => l.tpUsd! <= price))
        throw bad(`A take-profit at or below today's price ($${usd(price)}) would sell straight away. Set it above $${usd(price)}.`);
      if ((given("slUsd") || !prev) && out.slUsd && out.slUsd >= price)
        throw bad(`A stop-loss at or above today's price ($${usd(price)}) would sell straight away. Set it below $${usd(price)}.`);
    }
    if (fresh || (prev && (given("amount") || given("legs")))) {
      if (!price) throw bad("This token has no market price yet, so a price order can't watch it. Try again once it trades more.");
      const worth = tokens(BigInt(amount) - BigInt(prev?.spent ?? "0")) * price;
      if (fresh && worth < limits.minSellUsd) throw bad(`Orders start at about $${limits.minSellUsd} worth of tokens; this is about $${usd(worth)}.`);
      if (open.some((l) => tokens(BigInt(l.amount)) * price < limits.minSellUsd / 2)) throw bad(`Each take-profit step needs at least about $${limits.minSellUsd / 2} worth of tokens.`);
    }
    out.legs = legs.length ? legs : undefined;
    out.tpUsd = open.length ? lowest : undefined;
    return out;
  }

  if (kind === "buy") {
    out.buyBelowUsd = given("buyBelowUsd") || !prev ? pos(b.buyBelowUsd) : prev.buyBelowUsd;
    if (!out.buyBelowUsd) throw bad("Set the price to buy at.");
    if (price && !ctx.resume && (given("buyBelowUsd") || !prev) && out.buyBelowUsd >= price)
      throw bad(`A limit buy at or above today's price ($${usd(price)}) would buy straight away. Set it below $${usd(price)}.`);
    if (!ctx.resume && BigInt(amount) < limits.minBuyLamports) throw bad(`Orders start at ${sol(limits.minBuyLamports)} SOL.`);
    return out;
  }

  // DCA
  if (prev) {
    out.dca = { per: prev.dca!.per, every: prev.dca!.every, count: prev.dca!.count, exact: given("exact") ? b.exact === true : !!prev.dca!.exact };
    return out;
  }
  const count = Math.round(Number(b.count));
  const every = Math.round(Number(b.every));
  // an order handed back after the server lost it may have just one buy left
  if (!(count >= (ctx.resume ? 1 : 2) && count <= 100)) throw bad("A DCA needs 2 to 100 buys.");
  const hours = limits.minDcaEverySec / 3600;
  if (!(every >= limits.minDcaEverySec && every <= 30 * 86_400))
    throw bad(`Buy at most every ${hours === 1 ? "hour" : hours >= 1 ? `${hours} hours` : `${Math.round(limits.minDcaEverySec / 60)} minutes`} and at least every 30 days.`);
  const per = BigInt(amount) / BigInt(count);
  const floor = ctx.resume ? limits.minDcaBuyLamports / 2n : limits.minDcaBuyLamports;
  if (per < floor || per <= 0n) throw bad(`Each buy needs at least ${sol(limits.minDcaBuyLamports)} SOL: spend more, or make fewer buys.`);
  out.dca = { per: per.toString(), every, count, exact: b.exact === true };
  return out;
}
