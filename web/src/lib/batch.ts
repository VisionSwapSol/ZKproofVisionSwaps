// Batches: one action across several Vision wallets (a buy spread over new wallets or made with
// wallets already funded, a sale, a move back, a send), run one wallet at a time with a gap
// between them. The planning (amounts, minimums, gaps) and the state machine (what each wallet's
// item is at, what a reload finds, what to say at the end) live here, pure, so the tests pin them
// down. The engine runs the items; the page only shows them.
import { fundAmounts, walletName } from "./vwallets";

export type BatchKind = "buyFrom" | "buyNew" | "sell" | "move" | "send";
export type ItemStatus = "waiting" | "running" | "done" | "failed" | "skipped";
/** "spaced": a random 10 to 60 s between wallets (harder to link them); "fast": just the spacing the server's limits need. */
export type Pacing = "spaced" | "fast";

/** One wallet's part of a batch. Amounts are lamports (or token units for a sale) as strings, so it keeps in storage. */
export type BatchItem = {
  /** the Vision wallet (a buy into new wallets learns it when the wallet is taken) */
  index?: number;
  amount: string;
  /** the least of the token this part may get (scaled from the quote shown); dropped on a retry, which takes a fresh price */
  minOut?: string;
  status: ItemStatus;
  sig?: string;
  error?: string;
  /** what the wallet held of the token before its first try (a sale sells only what is still owed of its share) */
  before?: string;
  /** a sale's last swap is `sig`, good until this block height: looked up before the sale is tried again */
  lvh?: number;
  /** tokens that arrived (raw), for a buy */
  got?: string;
  /** a buy whose SOL is in its wallet already: its next try finishes it, with no second pool fee */
  finish?: boolean;
  /** retries made by themselves after a busy server */
  tries?: number;
};

export type Batch = {
  id: string;
  kind: BatchKind;
  items: BatchItem[];
  pacing: Pacing;
  /** when the next wallet's turn comes */
  nextAt: number;
  /** waiting for the person: after a reload or an unlock, nothing goes on until "Continue" */
  paused: boolean;
  created: number;
  mint?: string;
  symbol?: string;
  decimals?: number;
  program?: string | null;
  slippageBps?: number;
  auto?: boolean;
  speed?: string;
  /** a buy with "All of it": each wallet spends what it holds then, less its reserve */
  all?: boolean;
  /** a send's address */
  to?: string;
  /** "Stop the rest" was pressed: nothing more starts, even a wallet a reload finds unstarted */
  stopped?: boolean;
};

/** At least this many wallets make a batch (one is today's single action), and at most this many. */
export const BATCH_MIN = 2;
export const BATCH_MAX = 10;
/** The least each wallet's part may be: enough to buy with, or to move back into the pool, later. */
export const PART_MIN = 20_000_000n;
/** "Back to back": the least gap between wallets, so the server's per-person limits (swaps 20 a minute, payments 12) are never hit. */
export const FAST_GAP = 6_000;
/** After a busy server: wait this long, then try that wallet again (twice at most). */
export const BUSY_GAP = 30_000;
export const BUSY_TRIES = 2;

/** The least a wallet's part may be: PART_MIN, or more when moving it back later needs more (sweepMin less the reserve it keeps). */
export function partMin(sweepMin: bigint | null, reserve: bigint): bigint {
  const back = sweepMin != null ? sweepMin - reserve : 0n;
  return back > PART_MIN ? back : PART_MIN;
}

/**
 * `total` split into `n` parts that add up to it exactly. With `vary`, each part is moved by up to
 * about 3% either way (and rounded to 0.0001 SOL, the last one carrying the rounding), so the
 * parts don't look alike. `rnd` gives numbers in [0, 1).
 */
export function splitAmounts(total: bigint, n: number, vary: boolean, rnd: () => number = Math.random, floor = 0n): bigint[] {
  if (n <= 0) return [];
  if (!vary) {
    const each = total / BigInt(n);
    return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - each * BigInt(n - 1) : each));
  }
  // each moved by up to 1.5% either way, then all moved together so they still add up: none ends more than 3% away
  const d = Array.from({ length: n }, () => (rnd() * 2 - 1) * 150);
  const mean = d.reduce((s, x) => s + x, 0) / n;
  const out: bigint[] = [];
  let sum = 0n;
  for (let i = 0; i < n - 1; i++) {
    const ppm = BigInt(Math.round((1 + (d[i] - mean) / 10_000) * 1_000_000));
    let a = (total * ppm) / (BigInt(n) * 1_000_000n);
    a -= a % 100_000n;
    out.push(a);
    sum += a;
  }
  out.push(total - sum);
  return liftTo(out, floor);
}

/**
 * Parts below `floor` raised to it, what they gained taken from the largest parts, so the total
 * stays the same. Only when the total allows it (n × floor or more); otherwise unchanged.
 */
export function liftTo(parts: bigint[], floor: bigint): bigint[] {
  const total = parts.reduce((s, a) => s + a, 0n);
  if (floor <= 0n || !parts.some((a) => a < floor) || total < floor * BigInt(parts.length)) return parts;
  const out = parts.map((a) => (a < floor ? floor : a));
  let owe = out.reduce((s, a) => s + a, 0n) - total;
  while (owe > 0n) {
    let k = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[k]) k = i;
    const take = out[k] - floor < owe ? out[k] - floor : owe;
    if (take <= 0n) break;
    out[k] -= take;
    owe -= take;
  }
  return out;
}

/** `n` parts of about `each` (the same, or with `vary` each moved by up to 3%), never below `floor`. */
export const eachAmounts = (each: bigint, n: number, vary: boolean, rnd: () => number = Math.random, floor = 0n) => fundAmounts(each, n, vary, rnd, floor);

/** "All of it": what each wallet can spend, keeping `reserve` for its fees (whole thousands of lamports; 0 when it can't). */
export function allOfIt(lamports: bigint[], reserve: bigint): bigint[] {
  return lamports.map((l) => {
    const a = l - reserve;
    return a > 0n ? a - (a % 1_000n) : 0n;
  });
}

/** A share of a holding: `pct` percent of it (all of it at 100). */
export const shareOf = (amount: bigint, pct: number) => (pct >= 100 ? amount : (amount * BigInt(Math.round(pct))) / 100n);

/** The least one part may get, scaled from the least the whole quote promised (rounded down). */
export function scaleMinOut(minOut: bigint, part: bigint, total: bigint): bigint {
  return total > 0n ? (minOut * part) / total : 0n;
}

/** The gap before the next wallet's turn. */
export function gapMs(pacing: Pacing, rnd: () => number = Math.random): number {
  return pacing === "fast" ? FAST_GAP : 10_000 + Math.floor(rnd() * 50_001);
}

/** A busy server (a per-person limit, or Jupiter's shared allowance), not a real refusal: worth a second try a little later. */
export const busyError = (msg: string) => /too many|rate limit|\b429\b|busy/i.test(msg);

/**
 * A wallet's reason for "Didn't go through: …" in plain words: no repeated lead-in, no technical
 * detail from the network, and where its SOL is left to the summary, which says it once.
 */
export function plainReason(msg: string): string {
  let m = msg.replace(/^(the swap didn't go through|didn't go through)[:.]\s*/i, "").trim();
  if (/could not find mint|invalid mint|no route|not tradable|no market/i.test(m)) return "no market for this token right now";
  if (busyError(m)) return "the service was busy just then";
  if (/price (has )?moved/i.test(m)) return "the price moved past your price tolerance";
  m = m
    .replace(/\s*(Your|The|Its) [\d.,]+ SOL is safe in Vision wallet #\d+[\s\S]*$/, "")
    .replace(/\s*The SOL is still in Vision wallet #\d+[\s\S]*$/, "")
    .replace(/[.\s]+$/, "");
  if (!m) return "no reason given";
  // (a name keeps its capital)
  return /^(Vision|Jupiter|Solana|SOL\b)/.test(m) ? m : m.charAt(0).toLowerCase() + m.slice(1);
}

// ─── the state machine ───

const live = (s: ItemStatus) => s === "waiting" || s === "running";

export const nextWaiting = (b: Batch) => b.items.findIndex((x) => x.status === "waiting");

/** Nothing left to run or running: done, failed or stopped, wallet by wallet. */
export const batchFinished = (b: Batch) => !b.items.some((x) => live(x.status));

export function batchCounts(b: Batch) {
  const c = { done: 0, failed: 0, skipped: 0, waiting: 0, running: 0, total: b.items.length };
  for (const x of b.items) c[x.status]++;
  return c;
}

/** One item changed (a new batch: the engine saves it as it is). */
export function setItem(b: Batch, k: number, patch: Partial<BatchItem>): Batch {
  return { ...b, items: b.items.map((x, i) => (i === k ? { ...x, ...patch } : x)) };
}

/** "Stop the rest": the wallets that haven't had their turn keep what they hold. A running one finishes. */
export function stopRest(b: Batch): Batch {
  return { ...b, paused: false, stopped: true, items: b.items.map((x) => (x.status === "waiting" ? { ...x, status: "skipped" } : x)) };
}

/** "Try those again": the ones that didn't go through (or were stopped) get another turn, at today's price (no old minimum). */
export function retryFailed(b: Batch, now: number): Batch {
  return {
    ...b,
    paused: false,
    stopped: false,
    nextAt: now,
    items: b.items.map((x) => {
      if (x.status !== "failed" && x.status !== "skipped") return x;
      const { error: _e, minOut: _m, tries: _t, ...rest } = x;
      return { ...rest, status: "waiting" };
    }),
  };
}

/** A batch read back from this device (a reload, an unlock): an unfinished one waits for "Continue". */
export function onLoad(b: Batch): Batch {
  return batchFinished(b) ? { ...b, paused: false } : { ...b, paused: true };
}

/** What a look at the chain says about the wallet of an item that was running when the page went away. */
export type Facts = {
  /** a buy of this device is waiting to finish in it (BuyIntent) */
  intent: boolean;
  /** what it holds of the batch's token (raw) */
  held: bigint;
  lamports: bigint;
  /** the least "Move back" can move (null: unknown) */
  sweepMin: bigint | null;
  /** a deposit from it is in the waiting room */
  waiting: boolean;
};

/**
 * Where an item left "running" got to, from the chain, before anything is tried again: nothing is
 * ever paid or bought twice. A buy whose SOL reached its wallet finishes there (no second pool
 * fee); one whose payment never went out simply runs again; a sale whose tokens went, or a move
 * or send whose SOL went, is done.
 */
export function resolveRunning(b: Batch, x: BatchItem, f: Facts | null): BatchItem {
  const r = resolveOne(b, x, f);
  // after "Stop the rest", a wallet found unstarted keeps what it holds
  return b.stopped && r.status === "waiting" ? { ...r, status: "skipped" } : r;
}

function resolveOne(b: Batch, x: BatchItem, f: Facts | null): BatchItem {
  if (x.status !== "running") return x;
  if (b.kind === "buyNew" && x.index == null) return { ...x, status: "waiting" };
  if (!f) return x;
  switch (b.kind) {
    case "buyNew":
    case "buyFrom": {
      const before = BigInt(x.before ?? "0");
      if (f.held > before) return { ...x, status: "done", got: (f.held - before).toString(), finish: false };
      if (f.intent) return { ...x, status: "waiting", finish: true };
      // no buy waiting: its payment (or swap) never went out
      if (b.kind === "buyNew" && f.lamports > 0n) {
        return { ...x, status: "failed", error: `The SOL is in ${walletName(x.index!)}, but its buy didn't start. Buy from there, or move it back.` };
      }
      return { ...x, status: "waiting" };
    }
    case "sell":
      return f.held < BigInt(x.before ?? "0") ? { ...x, status: "done" } : { ...x, status: "waiting" };
    case "move":
      return f.waiting || (f.sweepMin != null && f.lamports < f.sweepMin) ? { ...x, status: "done" } : { ...x, status: "waiting" };
    case "send":
      return f.lamports === 0n ? { ...x, status: "done" } : { ...x, status: "waiting" };
  }
}

/**
 * How an item ends after a failed try. A busy server gets another turn a little later (when
 * nothing was spent); a buy whose SOL is already in its wallet is marked to finish there.
 */
export function afterFailure(b: Batch, x: BatchItem, msg: string, intent: boolean): { item: BatchItem; again: boolean } {
  const buy = b.kind === "buyNew" || b.kind === "buyFrom";
  const finish = buy && intent;
  if (busyError(msg) && !finish && (x.tries ?? 0) < BUSY_TRIES) return { item: { ...x, status: "waiting", tries: (x.tries ?? 0) + 1 }, again: true };
  return { item: { ...x, status: "failed", error: msg, finish }, again: false };
}

// ─── in words ───

/** The name of an item's wallet: "Vision wallet #3", or "New wallet" before a new one is taken. */
export const itemName = (x: BatchItem) => (x.index != null ? walletName(x.index) : "New wallet");

const doing = (b: Batch) =>
  b.kind === "sell"
    ? `Selling ${b.symbol ?? "the token"}`
    : b.kind === "move"
      ? "Moving back to your private balance"
      : b.kind === "send"
        ? "Sending to one address"
        : `Buying ${b.symbol ?? "the token"}`;

const pastOf: Record<BatchKind, string> = { buyNew: "bought", buyFrom: "bought", sell: "sold", move: "moved back", send: "sent" };

/** The batch card's title: "Buying BONK · 3 of 7 done". */
export function batchTitle(b: Batch): string {
  const c = batchCounts(b);
  return `${doing(b)} · ${c.done} of ${c.total} done`;
}

/** After a reload or an unlock: "Buying BONK in 5 wallets · 2 done". */
export function resumeLine(b: Batch): string {
  const c = batchCounts(b);
  return `${doing(b)} in ${c.total} wallets · ${c.done} done`;
}

const n1 = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What a finished batch says: "5 of 7 bought. 2 didn't go through; their SOL is safe in their wallets." */
export function batchSummary(b: Batch): string {
  const c = batchCounts(b);
  const past = pastOf[b.kind];
  const head = c.done === c.total ? (c.total === 2 ? `Both ${past}.` : `All ${c.total} ${past}.`) : `${c.done} of ${c.total} ${past}.`;
  const parts: string[] = [head];
  if (c.failed) {
    const f = c.failed;
    let tail: string;
    if (b.kind === "buyNew") {
      const held = b.items.filter((x) => x.status === "failed" && (x.finish || /^The SOL is in/.test(x.error ?? ""))).length;
      const none = f - held;
      tail =
        held === 0
          ? "nothing was spent for them."
          : none === 0
            ? n1(held, "its SOL is safe in its new wallet.", "their SOL is safe in their new wallets.")
            : `nothing was spent for ${none}, and ${held} ${n1(held, "keeps its SOL in its new wallet.", "keep their SOL in their new wallets.")}`;
    } else if (b.kind === "buyFrom") tail = n1(f, "its SOL is safe in its wallet.", "their SOL is safe in their wallets.");
    else if (b.kind === "sell") tail = n1(f, "its tokens are still in its wallet.", "their tokens are still in their wallets.");
    else if (b.kind === "send") tail = n1(f, "nothing was sent from it.", "nothing was sent from them.");
    else tail = n1(f, "what didn't move is still in its wallet.", "what didn't move is still in their wallets.");
    parts.push(`${f} didn't go through; ${tail}`);
  }
  if (c.skipped) parts.push(`${c.skipped} ${n1(c.skipped, "was", "were")} stopped before ${n1(c.skipped, "its", "their")} turn.`);
  return parts.join(" ");
}
