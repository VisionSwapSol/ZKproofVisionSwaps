/**
 * Proofs handed to the relayer that didn't go through, or scheduled ones cancelled while it held them
 * (VS-31), kept apart from the engine so the rules can be tested on their own. A proof stays valid
 * while the root it names is in the pool's list of recent roots (about a day at today's pace), and
 * nothing on the chain ties it to a moment: whoever holds it could still send it later. If the same
 * payment were then made again with other notes, its recipient could be paid twice. So a payment
 * sent again after a dropped or cancelled proof spends the very notes that proof spends: only one of
 * the two can ever land. Other payments may use those notes freely (if they land first, the dropped
 * proof can't land at all).
 */

/** A proof that was handed over and didn't go: who it paid and how much, its notes (nullifiers, hex), the root it names, and its delivery shape. */
export type DroppedProof = { to: string; amount: string; nfs: string[]; root: string; at: number; shape?: unknown };

/** How long a dropped proof is kept at most (its root has long left the pool's list by then). */
export const DROPPED_KEEP_MS = 3 * 86_400_000;

/** The list with `d` in it (one per set of notes), newest first, old ones gone. */
export function noteDropped(list: readonly DroppedProof[], d: DroppedProof, now: number): DroppedProof[] {
  const key = (x: DroppedProof) => [...x.nfs].sort().join();
  return [d, ...list.filter((x) => key(x) !== key(d))].filter((x) => now - x.at < DROPPED_KEEP_MS).slice(0, 50);
}

/**
 * The dropped proof a payment of `amount` to `to` has to reuse the notes of, or null. Only while all
 * of its notes are still this account's and unspent (`live`, by nullifier hex): once any is spent, the
 * dropped proof can never land.
 */
export function droppedFor(list: readonly DroppedProof[], to: string, amount: bigint, live: ReadonlySet<string>, now: number): DroppedProof | null {
  for (const d of list) {
    if (now - d.at >= DROPPED_KEEP_MS || d.to !== to || d.amount !== amount.toString()) continue;
    if (d.nfs.length && d.nfs.every((n) => live.has(n))) return d;
  }
  return null;
}

/**
 * The ones that can still land: notes all unspent (`live`), root still in the pool's list
 * (`rootLive`: true, false, or null when not known, which keeps it), and not too old.
 */
export function pruneDropped(list: readonly DroppedProof[], live: ReadonlySet<string>, rootLive: (root: string) => boolean | null, now: number): DroppedProof[] {
  return list.filter((d) => now - d.at < DROPPED_KEEP_MS && d.nfs.every((n) => live.has(n)) && rootLive(d.root) !== false);
}

/** Said when a payment handed to the relayer didn't go through. */
export const DROPPED_TEXT = "If you send it again, the app uses the same notes, so it can only ever be paid once.";
