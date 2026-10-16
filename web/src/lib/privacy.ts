/**
 * Privacy checks the app makes before a payment, kept apart from the engine so the rules can be
 * tested on their own. Each one only ever suggests: the person chooses Now or Later (owner decision
 * 1), and nothing here holds a payment back.
 *
 *  - Near amount (VS-04): a payment close in size to one of this account's own recent deposits is
 *    easy to match to it on the chain, where both amounts are public. The app says so and suggests Later.
 *  - Pool share (VS-15): the pool's balance is public, so a payment that takes most of what the pool
 *    holds shows which deposits it can have come from. The app says so, calmly.
 *  - Vision-wallet reserve (VS-12): the SOL a Vision wallet keeps for fees on top of a buy is drawn at
 *    random, so its funding doesn't read back the typed buy size.
 *  - Swept notes (VS-12): a note born from a Vision wallet's move back into the pool isn't spent on
 *    its own for an amount close to its own, while another note can do instead.
 */
import { noteLeaf, type OwnedNote } from "@visionswap/sdk";
import { secureRandom } from "./poll";

// ─── this account's own deposits, as this device saw them ───

/** Where a deposit came from: the connected wallet, a Vision wallet (a move back into the pool), a deposit address, or a one-time sending address. */
export type DepositSource = "wallet" | "vision" | "deposit" | "hop";
/** One of this account's deposits, as this device saw it in the waiting room: its note (inner, hex), its amount, and when it was first seen. */
export type OwnDeposit = { inner: string; amount: string; t: number; src: DepositSource };

/** How close counts as close: within 3% (a little wider than a 2% match, so it says so earlier). */
export const NEAR_BPS = 300;
/** How long a deposit counts as recent: two days, and a week for a Vision wallet's move back (its whole trail is public). */
export const NEAR_WINDOW_MS = 48 * 3_600_000;
export const SWEPT_WINDOW_MS = 7 * 86_400_000;
/** Deposits kept on this device: a little over the longest window, the newest 200 at most. */
const KEEP_MS = 8 * 86_400_000;
const KEEP_MAX = 200;

/**
 * The list with the deposits seen now merged in (one per note, first sighting kept) and old ones
 * dropped. `seen`: this account's deposits in the waiting room right now.
 */
export function mergeOwnDeposits(list: readonly OwnDeposit[], seen: readonly { inner: string; amount: bigint; src: DepositSource }[], now: number): OwnDeposit[] {
  const out = new Map(list.filter((d) => now - d.t < KEEP_MS).map((d) => [d.inner, d]));
  for (const s of seen) if (!out.has(s.inner)) out.set(s.inner, { inner: s.inner, amount: s.amount.toString(), t: now, src: s.src });
  return [...out.values()].sort((a, b) => b.t - a.t).slice(0, KEEP_MAX);
}

/** Whether `a` is within `bps` of `b` (b > 0). */
export function nearAmount(a: bigint, b: bigint, bps = NEAR_BPS): boolean {
  if (b <= 0n || a <= 0n) return false;
  const d = a > b ? a - b : b - a;
  return d * 10_000n <= BigInt(bps) * b;
}

/**
 * The recent deposit of this account's that a payment taking `withdraw` out of the pool is close to
 * (the closest one), or null. Both amounts are public on the chain: the deposit's, and what the pool pays out.
 */
export function nearDeposit(withdraw: bigint, deposits: readonly OwnDeposit[], now: number): OwnDeposit | null {
  let best: OwnDeposit | null = null;
  let gap = -1n;
  for (const d of deposits) {
    const window = d.src === "vision" ? SWEPT_WINDOW_MS : NEAR_WINDOW_MS;
    if (now - d.t > window) continue;
    const a = BigInt(d.amount);
    if (!nearAmount(withdraw, a)) continue;
    const g = withdraw > a ? withdraw - a : a - withdraw;
    if (gap < 0n || g < gap) {
      best = d;
      gap = g;
    }
  }
  return best;
}

/** The notes (leaves) born from this account's Vision wallets moving back into the pool lately. */
export function sweptLeaves(deposits: readonly OwnDeposit[], now: number): Set<bigint> {
  const out = new Set<bigint>();
  for (const d of deposits) {
    if (d.src !== "vision" || now - d.t > SWEPT_WINDOW_MS) continue;
    try {
      out.add(noteLeaf(BigInt(d.amount), BigInt("0x" + d.inner)));
    } catch {
      /* a record that doesn't read is no note */
    }
  }
  return out;
}

/**
 * The notes a spend of `withdraw` uses (`pick`, as selectInputs chose them), unless that is one note
 * swept back from a Vision wallet lately whose amount the spend nearly matches: then another note
 * that covers it on its own, when one does (`select` is selectInputs). Otherwise `pick` as it was.
 */
export function avoidLoneSwept(
  pick: OwnedNote[] | null,
  free: readonly OwnedNote[],
  swept: ReadonlySet<bigint>,
  withdraw: bigint,
  select: (notes: OwnedNote[], need: bigint) => OwnedNote[] | null,
): OwnedNote[] | null {
  if (!pick || pick.length !== 1) return pick;
  const one = pick[0];
  if (!swept.has(one.leaf) || !nearAmount(withdraw, one.amount)) return pick;
  const lone = (n: OwnedNote) => swept.has(n.leaf) && nearAmount(withdraw, n.amount);
  const other = select(
    free.filter((n) => !lone(n)),
    withdraw,
  );
  return other && other.length === 1 ? other : pick;
}

// ─── the pool's share ───

/** What the pool holds in notes: the vault's balance less its own rent and the deposits still waiting. */
export function shieldedValue(vaultLamports: bigint, vaultRent: bigint, pendingLamports: bigint): bigint {
  const v = vaultLamports - vaultRent - pendingLamports;
  return v > 0n ? v : 0n;
}

/** The share of what the pool holds (basis points, at most 10,000) that a payment taking `withdraw` out of it would take; null when the pool's value isn't known. */
export function poolShareBps(withdraw: bigint, shielded: bigint | null): number | null {
  if (shielded == null || shielded <= 0n || withdraw <= 0n) return null;
  const bps = (withdraw * 10_000n) / shielded;
  return Number(bps > 10_000n ? 10_000n : bps);
}

/** From this share of the pool on, the app mentions it (a payment that large stands out next to the pool). */
export const LARGE_SHARE_BPS = 5_000;

// ─── what the app says ───

export const NEAR_TEXT =
  "This payment is close in size to a deposit you made recently, and both amounts are public on Solana. Sending it later, at a random moment, puts more time between the two, which makes them harder to match.";
export const NEAR_SWEPT_TEXT =
  "This payment is close in size to SOL a Vision wallet of yours moved back into the pool recently, and both amounts are public on Solana. Sending it later, at a random moment, puts more time between the two, which makes them harder to match.";
export const WALLET_NEAR_TEXT =
  "This payment uses nearly all of the deposit your wallet makes for it, and both amounts are public on Solana. Sending it later, at a random moment, puts more time between the two, which makes them harder to match.";
/** The calm note for a payment that takes a large part of the pool (`pct`: a whole percentage). */
export function largeShareText(pct: number): string {
  const share = pct >= 99 ? "nearly everything" : `about ${pct}% of what`;
  return `This payment takes ${share} the pool holds right now. The pool's total is public, so a payment that large narrows down which deposits it can have come from. Sending it later, when the pool may hold more, or in smaller payments at different times, helps it blend in with the rest.`;
}

// ─── Vision-wallet reserve ───

/**
 * The extra a Vision wallet keeps on top of its fee reserve for one buy: a random amount below half
 * the reserve, to the lamport, from the secure random source. With a fixed reserve, the wallet's
 * funding less that reserve read back the buy size the person typed. All of it comes back when the
 * wallet moves its SOL back into the pool.
 */
export function drawExtraReserve(base: bigint, rnd: () => number = secureRandom): bigint {
  if (base <= 0n) return 0n;
  const span = Number(base / 2n);
  return BigInt(Math.floor(rnd() * span));
}

// ─── reading one's own addresses among others ───

/**
 * `own` addresses mixed with up to `perOwn` decoys each, picked at random from `pool` (a public list
 * everyone downloads, such as the open sending addresses), in random order: a balance read for them
 * then doesn't show which of the addresses asked about are this account's.
 */
export function withDecoys(own: readonly string[], pool: readonly string[], perOwn = 4, rnd: () => number = secureRandom): string[] {
  const mine = new Set(own);
  const others = [...new Set(pool)].filter((a) => !mine.has(a));
  // a partial shuffle: the first `want` of `others` become a uniform random sample
  const want = Math.min(others.length, own.length * perOwn);
  for (let i = 0; i < want; i++) {
    const j = i + Math.floor(rnd() * (others.length - i));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const all = [...mine, ...others.slice(0, want)];
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}
