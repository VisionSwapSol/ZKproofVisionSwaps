/**
 * Which pool root a spend's proof names. The root is public (it is in the instruction), and anyone
 * can work out which tree size it belongs to, so it must never be picked from the positions of the
 * notes being spent: a root chosen as "somewhere after my newest note" points straight at that note.
 *
 * - A spend that goes out at once proves against the newest root (the tip). Its root then says only
 *   when the proof was made, which is about when it lands anyway.
 * - A proof held for later (a scheduled payment) names a root `lag` leaves behind the tip it was made
 *   at, with `lag` drawn on its own from a fixed distribution (uniform over 0..ROOT_LAG_MAX), never
 *   from its notes. It only spends notes that are at least ROOT_LAG_MAX leaves old ("mature"), so
 *   every possible lag covers them: a note that isn't mature yet waits for the pool to move on. It
 *   never falls back to the tip, and a lag is never drawn again until one covers the notes (drawing
 *   until one fits would tie the root to the notes once more).
 */

/** The deepest root a held proof may name, in leaves behind the tip it was made at. */
export const ROOT_LAG_MAX = 32;

/** How many recent roots the program accepts (one per leaf it inserts). */
export const ROOT_HISTORY = 256;

/** Fills a buffer with secure random 32-bit numbers (swappable in tests). */
export type RandomU32 = (buf: Uint32Array) => Uint32Array;
const secureU32: RandomU32 = (buf) => crypto.getRandomValues(buf);

/** A whole number from 0 to `max` (both included), uniform, from the secure random source, with no modulo bias. */
export function secureInt(max: number, rand: RandomU32 = secureU32): number {
  if (!Number.isInteger(max) || max < 0 || max > 0xffff_ffff) throw new Error("max out of range");
  if (max === 0) return 0;
  const span = max + 1;
  // the largest multiple of `span` that fits in 32 bits: draws at or above it are thrown away
  const limit = Math.floor(0x1_0000_0000 / span) * span;
  const buf = new Uint32Array(1);
  for (;;) {
    const x = rand(buf)[0];
    if (x < limit) return x % span;
  }
}

/** A held proof's lag, drawn on its own: uniform over 0..ROOT_LAG_MAX. Each proof draws its own. */
export function drawRootLag(rand: RandomU32 = secureU32, max = ROOT_LAG_MAX): number {
  return secureInt(max, rand);
}

/** Whether a note at leaf `index` is mature in a tree of `size` leaves: every lag up to `maxLag` still holds it. */
export const isMature = (index: number, size: number, maxLag = ROOT_LAG_MAX) => index + 1 + maxLag <= size;

/** The notes that are mature in a tree of `size` leaves (see isMature). */
export function matureNotes<T extends { index: number }>(notes: T[], size: number, maxLag = ROOT_LAG_MAX): T[] {
  return notes.filter((n) => isMature(n.index, size, maxLag));
}

/**
 * The tree size whose root a held proof names, from the leaves known now (`size`) and its own `lag`
 * (drawRootLag). `{ wait }` while its notes aren't mature yet: how many more leaves the pool needs
 * first. The answer depends on the notes only through that wait, never through which root is named.
 */
export function heldRootSize(size: number, inputs: { index: number }[], lag: number, maxLag = ROOT_LAG_MAX): { size: number } | { wait: number } {
  if (!inputs.length) throw new Error("a spend needs at least one note");
  if (!Number.isInteger(lag) || lag < 0 || lag > maxLag) throw new Error("lag out of range");
  const newest = Math.max(...inputs.map((n) => n.index));
  const need = newest + 1 + maxLag;
  if (size < need) return { wait: need - size };
  return { size: size - lag };
}
