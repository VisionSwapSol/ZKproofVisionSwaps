/**
 * Asking after scheduled payments and orders through the status board (VS-40, see sdk/src/board.ts),
 * kept apart from the engine so it can be tested on its own. The app works out which buckets its items
 * fall in from their tokens, asks the server for those buckets (the whole board while it is small),
 * and finds and opens its own entries here, by the tags the answer's own nonce gives them. Nothing in
 * the request names an id or a token, and the server answers whole buckets of everyone's entries, so a
 * poll doesn't show which payments or orders belong together, or to the same person across visits.
 */
import { BOARD_MAX_CHARS, boardEpoch, boardKeys, bucketsOf, readAnswer, tokenHash, type BoardAnswer } from "@visionswap/sdk";

export type BoardItem = { id: string; token: string };

/** How fine the server cuts its board, as last heard, per board (see sdk/src/board.ts). */
export type BoardMemo = { chars: number };

/** An answer the app can read: never taken as "not listed" when it is malformed (that would hand a payment back). */
const readable = (a: BoardAnswer | null | undefined, epoch: number): a is BoardAnswer =>
  !!a && Array.isArray(a.entries) && !a.finer && a.epoch === epoch && typeof a.nonce === "string" && /^[0-9a-f]{32}$/.test(a.nonce);

/**
 * Each item's status from the board, or "unknown" for one the board doesn't list (the server doesn't
 * hold it). `post` sends the buckets (and the hour their keys are for) and returns the server's answer;
 * an answer that says `finer` (the board is too big to send whole), or that cut its buckets by another
 * hour's keys than the ones asked for (the two clocks differ), is asked again once, as the server says.
 */
export async function askBoard<R extends { id: string; status: string }>(
  items: readonly BoardItem[],
  memo: BoardMemo,
  post: (buckets: string[], epoch: number) => Promise<BoardAnswer>,
  unknown: (id: string) => R,
  now: number = Date.now(),
): Promise<R[]> {
  if (!items.length) return [];
  const hashes = items.map((it) => tokenHash(it.token));
  const keysFor = (epoch: number) => hashes.map((h) => boardKeys(h, epoch).k);
  let epoch = boardEpoch(now);
  const asked = memo.chars;
  let a = await post(bucketsOf(keysFor(epoch), asked), epoch);
  // the next ask follows the server's granularity (never finer than it uses, so a request never narrows itself down more than it allows)
  if (Number.isInteger(a?.chars) && a.chars >= 0) memo.chars = Math.min(BOARD_MAX_CHARS, a.chars);
  const otherHour = Number.isInteger(a?.epoch) && a.epoch !== epoch;
  if (otherHour) epoch = a.epoch;
  // asked again: too big to send whole, or answered for buckets cut by another hour's keys (the whole board needs no second look)
  if (a?.finer || (otherHour && Math.min(asked, a.chars) > 0)) a = await post(bucketsOf(keysFor(epoch), memo.chars), epoch);
  if (!readable(a, epoch)) throw new Error("The status board couldn't be read just now.");
  const got = readAnswer(hashes, a);
  return items.map((it, i) => {
    const v = got[i];
    return v && typeof v.status === "string" ? ({ ...v, id: it.id } as unknown as R) : unknown(it.id);
  });
}

/** Whether an error means the server has no board yet (an older server): the app then asks by ids, as before. */
export const noBoard = (e: unknown) => {
  const s = (e as { status?: number } | null)?.status;
  return s === 404 || s === 405;
};
