/**
 * Priority fees for user swaps. A person picks a speed; the price per compute unit follows what
 * the route's accounts paid in recent blocks (the busier a token, the more it takes to land),
 * never below the speed's floor, doubles on each retry, and the whole fee stays under the
 * speed's cap. The browser checks the same caps before it signs.
 *
 * Each price is also raised by a random amount (up to 35%), so swaps at the same speed don't all
 * carry one exact, recognizable price. Normal's floor stays low enough that its whole range sits
 * below Fast's floor, so on a quiet network the speeds' ranges never overlap.
 */

export type Speed = "normal" | "fast" | "turbo";

export const SPEEDS: Record<Speed, { floor: number; percentile: number; capLamports: number }> = {
  normal: { floor: 20_000, percentile: 50, capLamports: 300_000 },
  fast: { floor: 150_000, percentile: 75, capLamports: 1_500_000 },
  turbo: { floor: 1_000_000, percentile: 90, capLamports: 5_000_000 },
};

/** Anything a browser sends that isn't a known speed is Normal. */
export const speedOf = (s: unknown): Speed => (s === "fast" || s === "turbo" ? s : "normal");

/** The p-th percentile of the non-zero fees (0 when none were paid). */
export function percentile(fees: number[], p: number): number {
  const xs = fees.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  return xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];
}

/** how much higher than its base a price may be drawn */
const JITTER = 0.35;
/** the highest Normal floor whose jittered prices still stay under Fast's floor (111,111) */
const NORMAL_MAX = Math.floor(SPEEDS.fast.floor / (1 + JITTER));

/**
 * The price (micro-lamports per compute unit) and what it costs in lamports for `units`.
 * `base` is the site's own floor for Normal (PRIORITY_MICROLAMPORTS): it can raise Normal's floor,
 * never below Normal's own or so high that its prices reach Fast's, so the speeds stay apart. `jitter` (0 to 1, random
 * when left out) picks where in the price's range this one lands.
 */
export function priorityPrice(p: { speed: Speed; attempt: number; recent: number[]; units: number; base?: number; jitter?: number }): {
  microLamports: number;
  lamports: number;
} {
  const t = SPEEDS[p.speed];
  const floor = p.speed === "normal" ? Math.min(NORMAL_MAX, Math.max(t.floor, p.base ?? 0)) : t.floor;
  const attempt = Math.max(0, Math.min(3, Math.floor(Number.isFinite(p.attempt) ? p.attempt : 0)));
  const j = Math.max(0, Math.min(1, Number.isFinite(p.jitter) ? p.jitter! : Math.random()));
  let price = Math.max(floor, percentile(p.recent, t.percentile)) * 2 ** attempt * (1 + JITTER * j);
  const units = Math.max(1, p.units);
  // the cap is on the whole fee, so a heavy route gets a lower price rather than a bigger bill
  price = Math.max(1, Math.min(Math.floor(price), Math.floor((t.capLamports * 1_000_000) / units)));
  return { microLamports: price, lamports: Math.ceil((price * units) / 1_000_000) };
}
