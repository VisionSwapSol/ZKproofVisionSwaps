import type { Keys } from "./keys.ts";
import { tryOpen, type OwnedNote } from "./notes.ts";
import type { LeafRecord, PoolEvent } from "./events.ts";

export type Balance = {
  notes: OwnedNote[];
  total: bigint;
  /**
   * Notes that repeat an earlier note's nonce (so its `inner`): only the first one counts. A later
   * copy can only come from someone replaying a deposit's public details, so it is never picked by
   * itself and doesn't count in the balance.
   */
  unexpected: OwnedNote[];
};

/** Every nullifier the pool has ever recorded, from the event stream. */
export function spentSet(events: PoolEvent[]): Set<bigint> {
  const s = new Set<bigint>();
  for (const e of events) if (e.kind === "spent") e.nullifiers.forEach((n) => s.add(n));
  return s;
}

/** A note's nonce as a key: two notes with the same nonce share their `inner` (see noteInner). */
export const nonceKey = (n: { nonce: Uint8Array }) => Array.from(n.nonce, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Trial-opens every leaf with the view key. Runs entirely on the device. A note whose nonce an
 * earlier leaf already used is set aside as unexpected (the first index wins, see Balance).
 */
export function scanNotes(keys: Keys, leaves: LeafRecord[], spent: Set<bigint>): Balance {
  const notes: OwnedNote[] = [];
  const unexpected: OwnedNote[] = [];
  const seen = new Set<string>();
  for (const l of [...leaves].sort((a, b) => a.index - b.index)) {
    const n = tryOpen(keys, l.index, l.leaf, l.meta);
    if (!n) continue;
    const key = nonceKey(n);
    const repeat = seen.has(key);
    seen.add(key);
    if (n.amount <= 0n || spent.has(n.nullifier)) continue;
    (repeat ? unexpected : notes).push(n);
  }
  notes.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : a.index - b.index));
  return { notes, total: notes.reduce((s, n) => s + n.amount, 0n), unexpected };
}

/**
 * Picks at most two notes covering `need`, preferring a single note and,
 * among candidates, the smallest change. Returns null when two notes are not
 * enough; merge notes first in that case.
 */
export function selectInputs(notes: OwnedNote[], need: bigint): OwnedNote[] | null {
  if (need <= 0n) return notes.length ? [notes[notes.length - 1]] : null;
  let best: OwnedNote[] | null = null;
  let bestChange = -1n;
  for (const n of notes) {
    if (n.amount >= need && (bestChange < 0n || n.amount - need < bestChange)) {
      best = [n];
      bestChange = n.amount - need;
    }
  }
  if (best) return best;
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const s = notes[i].amount + notes[j].amount;
      if (s >= need && (bestChange < 0n || s - need < bestChange)) {
        best = [notes[i], notes[j]];
        bestChange = s - need;
      }
    }
  }
  return best;
}

/**
 * A spend always proves two inputs: with one note, the second is a zero-value stand-in. When one
 * note covers a payment, a second free note rides along instead: the smallest one (the oldest of
 * those, on a tie). On-chain the spend looks just the same, its value comes back in the change, and
 * the balance holds one note fewer. `free` must hold only notes free to spend (none a scheduled
 * payment holds, none set aside); anything else is returned as it is.
 */
export function padInputs(pick: OwnedNote[], free: OwnedNote[]): OwnedNote[] {
  if (pick.length !== 1) return pick;
  const [one] = pick;
  let second: OwnedNote | null = null;
  for (const n of free) {
    if (n.index === one.index || n.nullifier === one.nullifier || n.amount <= 0n) continue;
    if (!second || n.amount < second.amount || (n.amount === second.amount && n.index < second.index)) second = n;
  }
  return second ? [one, second] : pick;
}

/** Largest amount spendable in one transaction (the two biggest notes). */
export function maxSingleSpend(notes: OwnedNote[]): bigint {
  const sorted = [...notes].sort((a, b) => (a.amount < b.amount ? 1 : -1));
  return (sorted[0]?.amount ?? 0n) + (sorted[1]?.amount ?? 0n);
}
