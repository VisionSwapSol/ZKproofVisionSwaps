/**
 * Small pure helpers behind how the app looks at the chain: lookups split into groups the RPC
 * accepts, random order and pacing (so one person's addresses don't arrive together), finding
 * used addresses by their history, backing off when nothing changes, and spacing out deposits.
 */

/** Solana's RPC answers at most 100 addresses in one getMultipleAccounts. */
export const MAX_KEYS = 100;

export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A whole number from lo to hi (both included), uniform, from the secure random source (draws that would bias it are thrown away). */
export function randInt(lo: number, hi: number): number {
  if (hi <= lo) return lo;
  const span = hi - lo + 1;
  const limit = Math.floor(0x1_0000_0000 / span) * span;
  const buf = new Uint32Array(1);
  for (;;) {
    const x = crypto.getRandomValues(buf)[0];
    if (x < limit) return lo + (x % span);
  }
}

/** A number in [0, 1) from the secure random source (53 bits): used wherever Math.random would be. */
export function secureRandom(): number {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return (hi * 2 ** 21 + (lo >>> 11)) / 2 ** 53;
}

export function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 0, 1, …, n-1 */
export const range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

/**
 * Runs `fn` over `items`, at most `limit` at a time, each after a short random pause
 * ([lo, hi] ms), so a list of lookups trickles out instead of leaving in one burst.
 */
export async function paced<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, pause: [number, number] = [0, 0]): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const k = next++;
      if (pause[1] > 0) await sleep(randInt(pause[0], pause[1]));
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

/**
 * Finds which numbered addresses were ever used, the way wallets do: look from `start` on, a few
 * at a time, and stop after `gap` unused ones in a row. Returns the count in use (the highest used
 * index + 1, at least `start`) and the used indexes it found.
 */
export async function gapScan(
  start: number,
  used: (i: number) => Promise<boolean>,
  gap = 10,
  group = 3,
): Promise<{ next: number; found: number[] }> {
  const found: number[] = [];
  let misses = 0;
  let i = start;
  while (misses < gap) {
    const batch = range(Math.min(group, gap - misses)).map((k) => i + k);
    const hits = await Promise.all(batch.map(used));
    batch.forEach((j, k) => {
      if (hits[k]) {
        found.push(j);
        misses = 0;
      } else misses++;
    });
    i += batch.length;
  }
  return { next: found.length ? Math.max(start, found[found.length - 1] + 1) : start, found };
}

/** Seconds between syncs: quick while something is going on, slower the longer nothing changes. */
const IDLE_STEPS = [9, 12, 18, 27, 40, 60];

/** How long until the next sync, from how many syncs in a row found nothing new. A little random, so it never ticks like a clock. */
export function syncDelay(idle: number, lively: boolean): number {
  const s = lively ? IDLE_STEPS[0] : IDLE_STEPS[Math.min(Math.max(idle, 0), IDLE_STEPS.length - 1)];
  return Math.round(s * 1000 * (0.85 + randInt(0, 300) / 1000));
}

/**
 * Takes one dormant item at a time, now and then: a shuffled pass through the whole list, with a
 * random wait of `every` ms between turns. One per request: items looked up together would be
 * tied together, and shuffled groups would tie them all up after a few passes.
 */
export class Rotation {
  private queue: number[] = [];
  private due = 0;
  constructor(private every: [number, number]) {}

  /** The next item to look at, or null when it isn't time yet. */
  take(now: number, all: number[]): number | null {
    if (now < this.due || !all.length) return null;
    const live = new Set(all);
    this.queue = this.queue.filter((i) => live.has(i));
    if (!this.queue.length) this.queue = shuffle(all);
    this.due = now + randInt(this.every[0], this.every[1]);
    return this.queue.shift()!;
  }

  /** Makes the next turn due right away. */
  soon() {
    this.due = 0;
  }

  /** Forgets the pass (another account is opened next). */
  clear() {
    this.queue = [];
    this.due = 0;
  }
}

/** When each waiting deposit address may move into the pool (ms timestamps), by index. */
export type MovePlan = Record<number, number>;

/**
 * Plans moves so several payments never go into the pool back to back: each newly ready address
 * gets a time a random `gap` after the one before it, in random order. The first goes at once
 * when nothing moved recently; `now` is given to `instant` (a payment the owner is watching arrive).
 */
export function planMoves(
  now: number,
  ready: number[],
  plan: MovePlan,
  lastMove: number,
  gap: [number, number],
  instant: number | null = null,
): MovePlan {
  const ok = new Set(ready);
  const next: MovePlan = {};
  for (const [k, t] of Object.entries(plan)) if (ok.has(Number(k))) next[Number(k)] = t;
  if (instant != null && ok.has(instant) && next[instant] == null) next[instant] = now;
  let tail = Math.max(lastMove, ...Object.values(next), 0);
  for (const i of shuffle(ready.filter((i) => next[i] == null))) {
    next[i] = Math.max(now, tail + randInt(gap[0], gap[1]));
    tail = next[i];
  }
  return next;
}

/** Takes `moved` off the plan and pushes the rest back where needed, so the next one still waits a random gap. */
export function afterMove(now: number, plan: MovePlan, moved: number, gap: [number, number]): MovePlan {
  const next: MovePlan = { ...plan };
  delete next[moved];
  let tail = now;
  for (const [k, t] of Object.entries(next).sort((a, b) => a[1] - b[1])) {
    const i = Number(k);
    if (t < tail + gap[0]) next[i] = tail + randInt(gap[0], gap[1]);
    tail = next[i];
  }
  return next;
}

/** The address whose turn it is to move, if any: never sooner than `minGap` after the last move. */
export function dueMove(now: number, plan: MovePlan, lastMove: number, minGap: number): number | null {
  if (lastMove && now - lastMove < minGap) return null;
  let best: number | null = null;
  for (const [k, t] of Object.entries(plan)) if (t <= now && (best == null || t < plan[best])) best = Number(k);
  return best;
}

/**
 * Whether the pool data holds every one of `commitments` (hex): the new notes of a spend. `leaves`
 * holds `count` records of `rec` bytes, each starting with its 32-byte commitment. Only records from
 * `from` on are read (a spend's new notes always come after the notes it spent), newest first.
 */
export function leavesHold(leaves: Uint8Array, count: number, rec: number, commitments: string[], from = 0): boolean {
  const want = new Set(commitments.map((c) => c.toLowerCase().padStart(64, "0")));
  for (let i = count - 1; i >= Math.max(0, from) && want.size; i--) {
    let h = "";
    for (let k = i * rec; k < i * rec + 32; k++) h += leaves[k].toString(16).padStart(2, "0");
    want.delete(h);
  }
  return want.size === 0;
}
