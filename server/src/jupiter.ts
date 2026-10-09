import { config, jupiterBase } from "./config.ts";
import { log } from "./log.ts";

/**
 * Every call this server makes to Jupiter goes through one limiter. Jupiter counts all of them
 * against one allowance per account (swaps, prices and token lookups alike), so the limiter
 * shares that allowance between four lanes, each with a guaranteed share:
 *
 *   exec         swaps someone asked for, and the order keeper's trades          40%
 *   interactive  quotes, token search, prices for a new order                     30%
 *   keeper       the order keeper's price checks                                  25%
 *   background   display prices, the exposure check, top tokens                    5%
 *
 * A lane under its share always gets the next free call ahead of a lane over it; a share a lane
 * isn't using is lent to the others. Visitors' lanes also cap each visitor, so one busy tab
 * can't fill the queue; in exec the order keeper's trades go ahead of visitors' builds. The
 * allowance starts from JUPITER_RPM and grows by itself when Jupiter's replies show a bigger plan
 * (up to JUPITER_RPM_MAX); after a 429 everyone backs off, then comes back a step a minute.
 */

export type Lane = "exec" | "interactive" | "keeper" | "background";
export const LANES: readonly Lane[] = ["exec", "interactive", "keeper", "background"];
const SHARE: Record<Lane, number> = { exec: 0.4, interactive: 0.3, keeper: 0.25, background: 0.05 };
/** lanes fed straight by visitors' requests */
const PUBLIC = new Set<Lane>(["interactive", "background"]);

/** How long each kind of call may wait for its turn. */
export const WAIT = { swap: 12_000, keeper: 20_000, quote: 5_000, search: 4_000, price: 2_000 } as const;

const WINDOW = 60_000;
/** Jupiter's gateway also counts in 10-second windows, so a minute's calls can't all go at once */
const BURST_WINDOW = 10_000;
/** a visitor may have this many Jupiter calls waiting at once (their swap builds counted apart) */
const PER_IP_QUEUED = 2;
/** whose waiting calls a waiter counts toward: a visitor's builds never wait on their own price refreshes */
const queuedKey = (lane: Lane, ip: string) => (lane === "exec" ? `exec|${ip}` : ip);
const MAX_QUEUE = 200;
const LEARN_MS = 15 * 60_000;
/** 429s counted for the stats this long */
const LIMITED_MS = 5 * 60_000;

export const busy = (retryAfter = 3) =>
  Object.assign(new Error("Jupiter is busy right now. Try again in a few seconds."), { status: 429, retryAfter });
/** one visitor used their share while others were waiting too */
const tooQuick = (retryAfter: number) =>
  Object.assign(new Error(`You're checking prices quickly. Try again in ${retryAfter} seconds.`), { status: 429, retryAfter });

type Waiter = { lane: Lane; ip?: string; at: number; deadline: number; resolve: () => void; reject: (e: Error) => void };
type Sent = { t: number; lane: Lane; ip?: string };
type HeaderLike = { get(name: string): string | null };

export class JupiterLimiter {
  private sent: Sent[] = [];
  private queues: Record<Lane, Waiter[]> = { exec: [], interactive: [], keeper: [], background: [] };
  private ipQueued = new Map<string, number>();
  private ipSent = new Map<string, number>();
  private pausedUntil = 0;
  private learned: { at: number; rpm: number }[] = [];
  /** the allowance after a 429, and when it was cut: it grows back a tenth of the plan a minute */
  private penalty: { rpm: number; at: number } | null = null;
  /** the length of Jupiter's counting window, once a reply has shown it */
  private windowMs: number | null = null;
  private limited: number[] = [];
  private limitedTotal = 0;
  private refused: Record<Lane, number> = { exec: 0, interactive: 0, keeper: 0, background: 0 };
  private waits: Record<Lane, number[]> = { exec: [], interactive: [], keeper: [], background: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = 0;
  private readonly now: () => number;
  private readonly timers: boolean;

  constructor(
    private readonly opts: { rpm: number; rpmMax: number; now?: () => number; timers?: boolean },
  ) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? true;
  }

  /** Calls per minute the plan allows: JUPITER_RPM, or the bigger plan Jupiter's replies showed. */
  baseCapacity(): number {
    const now = this.now();
    this.learned = this.learned.filter((s) => now - s.at < LEARN_MS);
    let c = this.opts.rpm;
    for (const s of this.learned) c = Math.max(c, Math.min(s.rpm, this.opts.rpmMax));
    return c;
  }

  /** Calls per minute Jupiter allows us right now (less for a while after a 429). */
  capacity(): number {
    const base = this.baseCapacity();
    if (!this.penalty) return base;
    const steps = Math.floor((this.now() - this.penalty.at) / 60_000);
    const rpm = this.penalty.rpm + steps * Math.ceil(base * 0.1);
    if (rpm < base) return rpm;
    this.penalty = null;
    return base;
  }

  /** What we actually use: 90%, leaving room for clock drift and retries. */
  usable(): number {
    return Math.max(1, Math.floor(this.capacity() * 0.9));
  }

  /** Visitors' calls each may make per minute. */
  perIpMax(): number {
    return Math.max(8, Math.floor(this.usable() * 0.15));
  }

  /**
   * Waits for a turn in `lane`, or throws 'busy' (429) if it can't come within `maxWaitMs`.
   * `ip` marks a visitor's call: in exec it only limits how many of theirs may wait at once
   * (the server's own trades carry none and go first). `retry` marks a second call for one the
   * visitor already had a turn for: their own caps don't refuse it, but it still waits as theirs.
   */
  turn(lane: Lane, o: { maxWaitMs: number; ip?: string; retry?: boolean }): Promise<void> {
    const now = this.now();
    const ip = PUBLIC.has(lane) || lane === "exec" ? o.ip : undefined;
    this.prune(now);
    if (ip && !o.retry && (this.ipQueued.get(queuedKey(lane, ip)) ?? 0) >= PER_IP_QUEUED) {
      this.refused[lane]++;
      return Promise.reject(busy());
    }
    // a visitor's own cap only matters when others want the room too; on a quiet site it's theirs
    const contended = this.queues[lane].length > 0 || this.sent.length >= this.usable() / 2;
    if (ip && !o.retry && PUBLIC.has(lane) && contended && (this.ipSent.get(ip) ?? 0) >= this.perIpMax()) {
      this.refused[lane]++;
      const oldest = this.sent.find((s) => s.ip === ip)?.t ?? now;
      return Promise.reject(tooQuick(Math.max(1, Math.ceil((oldest + WINDOW - now) / 1000))));
    }
    if (this.pausedUntil - now > o.maxWaitMs || this.estimate(lane, now, ip) > o.maxWaitMs || this.queues[lane].length >= MAX_QUEUE) {
      this.refused[lane]++;
      return Promise.reject(busy(Math.max(3, Math.ceil((this.pausedUntil - now) / 1000))));
    }
    return new Promise<void>((resolve, reject) => {
      this.queues[lane].push({ lane, ip, at: now, deadline: now + Math.max(0, o.maxWaitMs), resolve, reject });
      if (ip) this.ipQueued.set(queuedKey(lane, ip), (this.ipQueued.get(queuedKey(lane, ip)) ?? 0) + 1);
      this.pump();
    });
  }

  /** Learns from a Jupiter reply: its plan's size, a full window, or a 429. */
  observe(h: HeaderLike, status: number) {
    const now = this.now();
    const cur = num(h.get("x-ratelimit-current"));
    const rem = num(h.get("x-ratelimit-remaining"));
    const reset = num(h.get("x-ratelimit-reset"));
    const resetAt = reset != null && reset > 0 ? (reset > 1e9 ? reset * 1000 : now + reset * 1000) : null;
    // with one call in Jupiter's window, the reset is exactly one window away
    if (cur != null && cur <= 1 && resetAt != null) {
      const w = resetAt - now;
      if (w > 0 && w <= 120_000) this.windowMs = w <= 2_000 ? 1_000 : w <= 15_000 ? 10_000 : 60_000;
    }
    if (status !== 429 && cur != null && rem != null && rem >= 0 && this.windowMs) {
      const rpm = ((cur + rem) * WINDOW) / this.windowMs;
      if (rpm > this.opts.rpm) {
        this.learned.push({ at: now, rpm });
        if (this.learned.length > 100) this.learned.shift();
      }
    }
    if (status === 429) {
      this.limited.push(now);
      if (this.limited.length > 1_000) this.limited.shift();
      this.limitedTotal++;
      const wait = resetAt != null ? resetAt - now : 5_000;
      this.pausedUntil = Math.max(this.pausedUntil, now + Math.min(Math.max(wait, 1_000), 60_000));
      // calls already out when a window fills all come back 429: that is one cut, not one each,
      // and never below a quarter of the plan
      if (!this.penalty || now - this.penalty.at >= (this.windowMs ?? BURST_WINDOW)) {
        const floor = Math.max(5, Math.floor(this.baseCapacity() * 0.25));
        this.penalty = { rpm: Math.max(floor, Math.floor(this.capacity() * 0.7)), at: now };
      }
    } else if (rem != null && rem <= 0 && resetAt != null) {
      // the window is already full (another copy of the site, or another app on the same Jupiter account)
      this.pausedUntil = Math.max(this.pausedUntil, Math.min(resetAt, now + 60_000));
    }
    this.pump();
  }

  /** Hands out every turn that is free now, and sets a timer for the next one. */
  pump() {
    const now = this.now();
    this.prune(now);
    for (const lane of LANES) {
      const q = this.queues[lane];
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].deadline > now) continue;
        const [w] = q.splice(i, 1);
        this.unqueue(w);
        this.refused[lane]++;
        w.reject(busy());
      }
    }
    for (;;) {
      const lane = this.pick();
      if (!lane) break;
      const free = this.nextFree(now);
      if (free > now) {
        this.wake(free);
        break;
      }
      // in exec, the order keeper's trades (no visitor) go before visitors' builds
      const q = this.queues[lane];
      const first = lane === "exec" ? q.findIndex((x) => !x.ip) : 0;
      const [w] = q.splice(Math.max(0, first), 1);
      this.unqueue(w);
      // only visitors' lanes count toward their per-minute cap
      const ip = PUBLIC.has(lane) ? w.ip : undefined;
      this.sent.push({ t: now, lane, ip });
      if (ip) this.ipSent.set(ip, (this.ipSent.get(ip) ?? 0) + 1);
      const waits = this.waits[lane];
      waits.push(now - w.at);
      if (waits.length > 50) waits.shift();
      w.resolve();
    }
    let deadline = Infinity;
    for (const lane of LANES) for (const w of this.queues[lane]) deadline = Math.min(deadline, w.deadline);
    if (deadline < Infinity) this.wake(deadline);
  }

  stats() {
    const now = this.now();
    this.prune(now);
    const usable = this.usable();
    const lanes = Object.fromEntries(
      LANES.map((l) => {
        const w = this.waits[l];
        return [
          l,
          {
            // waits and queue depth only: per-lane counts would show when trades and orders happen
            queued: this.queues[l].length,
            avgWaitMs: w.length ? Math.round(w.reduce((a, b) => a + b, 0) / w.length) : 0,
            maxWaitMs: w.length ? Math.max(...w) : 0,
            refused: this.refused[l],
          },
        ];
      }),
    );
    return {
      perMinute: this.capacity(),
      usable,
      configured: this.opts.rpm,
      usedLastMinute: this.sent.length,
      pausedForMs: Math.max(0, this.pausedUntil - now),
      rateLimited5m: this.limited.length,
      rateLimitedTotal: this.limitedTotal,
      lanes,
    };
  }

  /** The lane whose waiter goes next: under-share lanes first, then by priority. */
  private pick(): Lane | null {
    let lender: Lane | null = null;
    for (const lane of LANES) {
      if (!this.queues[lane].length) continue;
      if (this.room(lane) > 0) return lane;
      lender ??= lane;
    }
    return lender;
  }

  /** Calls `lane` may still make this minute before it is over its share. */
  private room(lane: Lane): number {
    let used = 0;
    for (const s of this.sent) if (s.lane === lane) used++;
    return this.usable() * SHARE[lane] - used;
  }

  /**
   * About how long a new call in `lane` would wait: the next free turn, then one turn for each
   * waiting call pick() would serve first. A lane under its share is only passed by busier
   * lanes' calls that are still under their own share and rank above it; a lane over its share
   * also waits for every higher lane and for any lane still under its share.
   */
  private estimate(lane: Lane, now: number, ip?: string): number {
    // a keeper trade in exec only waits behind other keeper trades of its own lane
    const mine = lane === "exec" && !ip ? this.queues.exec.filter((w) => !w.ip).length : this.queues[lane].length;
    const under = this.room(lane) > mine;
    const rank = LANES.indexOf(lane);
    let ahead = mine;
    for (const l of LANES) {
      const q = this.queues[l].length;
      if (l === lane || !q) continue;
      const higher = LANES.indexOf(l) < rank;
      const share = Math.min(q, Math.max(0, Math.ceil(this.room(l))));
      if (under) ahead += higher ? share : 0;
      else ahead += higher ? q : share;
    }
    return Math.max(0, this.nextFree(now) - now) + (ahead * WINDOW) / this.usable();
  }

  /** When the next call may go (now, if a turn is free). */
  private nextFree(now: number): number {
    let at = Math.max(now, this.pausedUntil);
    const usable = this.usable();
    const n = this.sent.length;
    if (n >= usable) at = Math.max(at, this.sent[n - usable].t + WINDOW);
    const burst = Math.max(1, Math.ceil((usable * BURST_WINDOW) / WINDOW));
    let recent = 0;
    for (let i = n - 1; i >= 0 && this.sent[i].t > now - BURST_WINDOW; i--) recent++;
    if (recent >= burst) at = Math.max(at, this.sent[n - burst].t + BURST_WINDOW);
    return at;
  }

  private prune(now: number) {
    while (this.limited.length && now - this.limited[0] >= LIMITED_MS) this.limited.shift();
    while (this.sent.length && this.sent[0].t <= now - WINDOW) {
      const s = this.sent.shift()!;
      if (s.ip) {
        const left = (this.ipSent.get(s.ip) ?? 1) - 1;
        if (left > 0) this.ipSent.set(s.ip, left);
        else this.ipSent.delete(s.ip);
      }
    }
  }

  private unqueue(w: Waiter) {
    if (!w.ip) return;
    const k = queuedKey(w.lane, w.ip);
    const left = (this.ipQueued.get(k) ?? 1) - 1;
    if (left > 0) this.ipQueued.set(k, left);
    else this.ipQueued.delete(k);
  }

  private wake(at: number) {
    if (!this.timers) return;
    if (this.timer && this.timerAt <= at) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, Math.max(1, at - this.now()));
    this.timer.unref?.();
  }
}

const num = (v: string | null): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const limiter = new JupiterLimiter({ rpm: config.jupiterRpm, rpmMax: config.jupiterRpmMax });

export type CallOpts = { lane: Lane; maxWaitMs: number; ip?: string; timeoutMs?: number; retry?: boolean };

const headers = (): Record<string, string> => (config.jupiterKey ? { "x-api-key": config.jupiterKey } : {});

/**
 * Without a key, calls use api.jup.ag's keyless allowance (lite-api.jup.ag is being retired).
 * Should Jupiter ever refuse keyless calls there, the site moves to lite-api while it still answers.
 */
let lite = false;
export const jupiterHost = () => (lite ? "https://lite-api.jup.ag" : jupiterBase());

async function jfetch(path: string, init: RequestInit, o: CallOpts): Promise<string> {
  const deadline = Date.now() + o.maxWaitMs;
  for (let attempt = 0; attempt < 2; attempt++) {
    // a retry is part of a call the visitor already had a turn for: their own cap doesn't refuse it
    await limiter.turn(o.lane, { maxWaitMs: Math.max(0, deadline - Date.now()), ip: o.ip, retry: o.retry || attempt > 0 });
    const r = await fetch(`${jupiterHost()}${path}`, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
    const text = await r.text();
    limiter.observe(r.headers, r.status);
    if ((r.status === 401 || r.status === 403) && !config.jupiterKey && !config.jupiterBase && !lite) {
      lite = true;
      log("jupiter: keyless calls were refused, switching to lite-api.jup.ag. A free JUPITER_API_KEY fixes this for good.");
      continue;
    }
    // a 429 pauses everyone until Jupiter's window frees up; this call gets one more turn
    if (r.status === 429) continue;
    if (!r.ok) throw Object.assign(new Error(jupError(text) ?? `Jupiter returned ${r.status}`), { status: r.status >= 500 ? 502 : 400 });
    return text;
  }
  throw busy();
}

export async function jget<T>(path: string, o: CallOpts): Promise<T> {
  return JSON.parse(await jfetch(path, { headers: headers() }, o)) as T;
}

export async function jpost<T>(path: string, body: unknown, o: CallOpts): Promise<T> {
  const init = { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(body) };
  return JSON.parse(await jfetch(path, init, { timeoutMs: 15_000, ...o })) as T;
}

export function jupError(text: string): string | null {
  try {
    const j = JSON.parse(text) as { error?: string; errorCode?: string };
    // a route that can't take the whole amount is not "no route": a smaller amount may well go through
    if (j.errorCode === "ROUTE_PLAN_DOES_NOT_CONSUME_ALL_THE_AMOUNT" || /consume all/i.test(j.error ?? "")) {
      return "That's more than this token's markets can take at once. Try a smaller amount.";
    }
    if (j.errorCode === "COULD_NOT_FIND_ANY_ROUTE" || /route/i.test(j.error ?? "")) return "No route for this pair right now.";
    return j.error ?? null;
  } catch {
    return null;
  }
}
