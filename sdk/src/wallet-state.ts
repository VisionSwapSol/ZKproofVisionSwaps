import type { Keys } from "./keys.ts";
import { tryOpen, type OwnedNote } from "./notes.ts";
import type { LeafRecord, PoolEvent } from "./events.ts";

export type Balance = {
  notes: OwnedNote[];
  total: bigint;
};

/** Every nullifier the pool has ever recorded, from the event stream. */
export function spentSet(events: PoolEvent[]): Set<bigint> {
  const s = new Set<bigint>();
  for (const e of events) if (e.kind === "spent") e.nullifiers.forEach((n) => s.add(n));
  return s;
}

/** Trial-opens every leaf with the view key. Runs entirely on the device. */
export function scanNotes(keys: Keys, leaves: LeafRecord[], spent: Set<bigint>): Balance {
  const notes: OwnedNote[] = [];
  for (const l of leaves) {
    const n = tryOpen(keys, l.index, l.leaf, l.meta);
    if (n && n.amount > 0n && !spent.has(n.nullifier)) notes.push(n);
  }
  notes.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : a.index - b.index));
  return { notes, total: notes.reduce((s, n) => s + n.amount, 0n) };
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

/** Largest amount spendable in one transaction (the two biggest notes). */
export function maxSingleSpend(notes: OwnedNote[]): bigint {
  const sorted = [...notes].sort((a, b) => (a.amount < b.amount ? 1 : -1));
  return (sorted[0]?.amount ?? 0n) + (sorted[1]?.amount ?? 0n);
}
