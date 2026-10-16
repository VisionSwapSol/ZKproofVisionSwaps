import { sha256 } from "@noble/hashes/sha2.js";
import { concat, hex } from "./field.ts";
import { fromBase64, seal, toBase64, unseal } from "./seal.ts";

/**
 * The status board (VS-40): how the app asks after its scheduled payments and orders without naming
 * them. Every job and order the server holds is on the board, its status sealed so only the holder of
 * its token can read it (see seal.ts). The app asks for the buckets its own entries fall in, at a
 * granularity the server sets so each bucket holds many entries (the whole board while it is small),
 * and picks out its own entries in the browser. A poll then says nothing about which payments or
 * orders belong together.
 *
 * The board is public, so watching it must not show when a payment was scheduled or when it ended
 * (that would tie a payment's scheduling to its payout, which "send later" exists to hide):
 *  - an entry carries no lasting name: in each answer it is tagged with a hash of its token's hash and
 *    that answer's own random nonce, so the same entry never shows the same tag twice and can't be
 *    followed from one answer to the next (the app works its own tags out from the answer's nonce);
 *  - every box in an answer is the same size (each status padded to the largest on the board, in steps
 *    of BOARD_PAD, and never below a floor that a finished payment's status fits in) and sealed afresh
 *    for every answer, so a box shows neither what it holds nor when its status changed;
 *  - decoys, random bytes as long as a real box and new in every answer, fill the board up to a size
 *    that only steps at powers of two (64 at least), so its count doesn't move when a payment comes or goes.
 *
 * Buckets: while the board holds fewer than 256 entries everyone gets all of it, so an answer is the
 * same for every asker. A bigger board is cut by bucket keys that change every hour (an epoch); an
 * hour's keys stay put, so polling more often narrows nothing down, though a bucket's count can then
 * move when an entry joins it.
 *
 * Both sides start from the token's SHA-256 (hex): the server keeps exactly that (`tokenHash`), and
 * the app works it out from the token it made. The bucket key, the tag and the sealing key are
 * separate hashes of it, so none reveals anything about the others.
 */

const te = new TextEncoder();

/** How many hex characters of a bucket key or a tag there are (128 bits). */
export const BOARD_KEY_LEN = 32;
/** The fewest entries a bucket should hold on average before the board is cut into finer ones. */
export const BOARD_MIN_BUCKET = 16;
/** The finest buckets ever used (hex characters of the key). */
export const BOARD_MAX_CHARS = 3;
/** The most entries one answer carries when the app asks for coarser buckets than the server uses. */
export const BOARD_MAX_ENTRIES = 3000;
/** Bucket keys change every hour. */
export const BOARD_EPOCH_MS = 3_600_000;
/** Sealed statuses are padded in steps of this many bytes. */
export const BOARD_PAD = 256;
/**
 * The least a sealed status is padded to: a scheduled payment's status and a finished one's (with its
 * signatures and sending address) both fit, so a payment ending doesn't change the size of the boxes.
 */
export const BOARD_MIN_PLAIN = 512;
/** The board is filled up with decoys to at least this many entries, then to the next power of two. */
export const BOARD_MIN_SIZE = 64;
/** A sealed box's bytes beyond the status it holds: its nonce and its tag (see seal.ts). */
const BOX_EXTRA = 32;

/** The hour a moment falls in. */
export const boardEpoch = (now: number): number => Math.floor(now / BOARD_EPOCH_MS);

/** SHA-256 of a token, in hex: what the server stores and what the board starts from. */
export function tokenHash(token: string): string {
  return hex(sha256(te.encode(token)));
}

/** An entry's bucket key for an hour (`k`: never published, it only says which bucket the entry is in), and its sealing key. */
export function boardKeys(tokenHashHex: string, epoch: number): { k: string; key: Uint8Array } {
  const th = String(tokenHashHex).toLowerCase();
  return { k: hex(sha256(te.encode(`vs:board:k:${th}:${epoch}`))).slice(0, BOARD_KEY_LEN), key: sha256(te.encode(`vs:board:s:${th}`)) };
}

/** The tag an entry carries in one answer, from its token's hash and that answer's nonce: new in every answer. */
export function boardTag(tokenHashHex: string, nonce: string): string {
  return hex(sha256(te.encode(`vs:board:t:${String(tokenHashHex).toLowerCase()}:${nonce}`))).slice(0, BOARD_KEY_LEN);
}

/** The bucket granularity (hex characters) for a board of `total` entries: buckets hold BOARD_MIN_BUCKET on average or more. */
export function boardChars(total: number): number {
  let c = 0;
  while (c < BOARD_MAX_CHARS && total / 16 ** (c + 1) >= BOARD_MIN_BUCKET) c++;
  return c;
}

/** How many entries a board holding `real` real ones shows: BOARD_MIN_SIZE at least, else the next power of two. */
export function boardSize(real: number): number {
  let n = BOARD_MIN_SIZE;
  while (n < real) n *= 2;
  return n;
}

/** The buckets (key prefixes of `chars` characters) that hold these keys, each once; [""] for the whole board. */
export function bucketsOf(keys: string[], chars: number): string[] {
  if (chars <= 0) return [""];
  return [...new Set(keys.map((k) => k.slice(0, chars).toLowerCase()))].sort();
}

/** Whether a bucket list as the app sends it is well-formed: one length for all, 0 to BOARD_MAX_CHARS hex characters. */
export function cleanBuckets(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 4096) return null;
  const out = raw.map((x) => String(x).toLowerCase());
  if (!out.length) return [""];
  const len = out[0].length;
  if (len > BOARD_MAX_CHARS || out.some((p) => p.length !== len || !/^[0-9a-f]*$/.test(p))) return null;
  return [...new Set(out)];
}

/** Whether key `k` lies in one of these buckets, read at `chars` characters (a longer prefix is cut to that). */
export function inBuckets(k: string, buckets: string[], chars: number): boolean {
  const c = Math.min(chars, buckets[0]?.length ?? 0);
  if (c <= 0) return true;
  const want = new Set(buckets.map((b) => b.slice(0, c)));
  return want.has(k.slice(0, c));
}

/** One entry as published: its tag in this answer and its sealed status (base64). */
export type BoardEntry = { k: string; box: string };

/**
 * A board answer: the hour its buckets are for, the granularity the server uses now, the answer's own
 * nonce (the entries' tags come from it), and the entries in the buckets asked for (`finer`: too many;
 * ask again at `chars`).
 */
export type BoardAnswer = { epoch: number; chars: number; nonce: string; entries: BoardEntry[]; finer?: boolean };

/** One of the server's entries: its token's hash and its status now. */
export type BoardItem = { th: string; status: unknown };

/** The hour a request names, taken when it is within one hour of the server's own (clocks differ a little), else the server's. */
export function askedEpoch(raw: unknown, now: number): number {
  const own = boardEpoch(now);
  const e = Number(raw);
  return Number.isInteger(e) && Math.abs(e - own) <= 1 ? e : own;
}

/** The size every status on a board is padded to: the largest one's JSON and a byte, rounded up to BOARD_PAD, and at least `floor`. */
export function boardPlainSize(statuses: readonly unknown[], floor = BOARD_MIN_PLAIN): number {
  let n = Math.max(BOARD_PAD, Math.ceil(floor / BOARD_PAD) * BOARD_PAD);
  for (const s of statuses) n = Math.max(n, Math.ceil((te.encode(JSON.stringify(s)).length + 1) / BOARD_PAD) * BOARD_PAD);
  return n;
}

/** A status as sealed: its JSON padded with spaces to `size` bytes (one longer than that keeps its own length, and a space). */
function padded(status: unknown, size: number): Uint8Array {
  const raw = te.encode(JSON.stringify(status));
  const out = new Uint8Array(Math.max(size, raw.length + 1)).fill(0x20);
  out.set(raw);
  return out;
}

/** Seals one status for the board (base64), padded to `size` bytes (`nonce`: 16 bytes, random unless a test passes its own). */
export function sealStatus(tokenHashHex: string, status: unknown, size: number = BOARD_MIN_PLAIN, nonce?: Uint8Array): string {
  return toBase64(seal(boardKeys(tokenHashHex, 0).key, padded(status, size), nonce));
}

/** The status in a box, for the holder of its token's hash; null when the box isn't that one's, was changed, or doesn't read. */
export function openStatus(tokenHashHex: string, box: unknown): Record<string, unknown> | null {
  if (typeof box !== "string") return null;
  const raw = fromBase64(box);
  if (!raw) return null;
  const plain = unseal(boardKeys(tokenHashHex, 0).key, raw);
  if (!plain) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(plain)) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A decoy's bucket key for an hour: from the server's own secret, so decoys sit in the same buckets all hour, like real entries. */
export function decoyKey(secret: Uint8Array, epoch: number, i: number): string {
  return hex(sha256(concat(te.encode(`vs:board:decoy:${epoch}:${i}:`), secret))).slice(0, BOARD_KEY_LEN);
}

/**
 * The server's answer (VS-40): the real entries and decoys in the buckets asked for, at the
 * granularity this board's size calls for. Asked at a finer granularity than that, the buckets are
 * widened to it (so a request never narrows the answer down further than the server allows); asked
 * coarser, the answer is given unless it would carry more than BOARD_MAX_ENTRIES, in which case it
 * says `finer` and carries none. Only the entries answered are sealed, each under a tag made from
 * this answer's nonce; decoys are random bytes as long as a real box. `secret`: the server's own (for
 * the decoys' buckets); `random`: its random source; `floor`: the least a status is padded to.
 */
export function answerBoard(
  real: readonly BoardItem[],
  buckets: string[],
  epoch: number,
  secret: Uint8Array,
  random: (n: number) => Uint8Array,
  floor: number = BOARD_MIN_PLAIN,
): BoardAnswer {
  const size = boardSize(real.length);
  const chars = boardChars(size);
  const asked = buckets[0]?.length ?? 0;
  const c = Math.min(chars, asked);
  const want = c > 0 ? new Set(buckets.map((b) => b.slice(0, c))) : null;
  const picked = want ? real.filter((r) => want.has(boardKeys(r.th, epoch).k.slice(0, c))) : [...real];
  let decoys = size - real.length;
  if (want) {
    decoys = 0;
    for (let i = 0; i < size - real.length; i++) if (want.has(decoyKey(secret, epoch, i).slice(0, c))) decoys++;
  }
  if (asked < chars && picked.length + decoys > BOARD_MAX_ENTRIES) return { epoch, chars, nonce: "", entries: [], finer: true };
  // one size for every box on the board, whichever buckets were asked for
  const plain = boardPlainSize(
    real.map((r) => r.status),
    floor,
  );
  const nonce = hex(random(BOARD_KEY_LEN / 2));
  const entries: BoardEntry[] = picked.map((r) => ({ k: boardTag(r.th, nonce), box: sealStatus(r.th, r.status, plain, random(16)) }));
  for (let i = 0; i < decoys; i++) entries.push({ k: hex(random(BOARD_KEY_LEN / 2)), box: toBase64(random(plain + BOX_EXTRA)) });
  // in tag order: the tags are new in every answer, so the order says nothing either
  entries.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return { epoch, chars, nonce, entries };
}

/**
 * The app's side: each of these entries' statuses in an answer (by their token hashes), found by
 * their tags for this answer and opened; null for one the answer doesn't hold (or a malformed answer).
 */
export function readAnswer(tokenHashes: readonly string[], a: BoardAnswer): (Record<string, unknown> | null)[] {
  if (!a || typeof a.nonce !== "string" || !/^[0-9a-f]{32}$/.test(a.nonce) || !Array.isArray(a.entries)) return tokenHashes.map(() => null);
  const byTag = new Map(a.entries.map((e) => [e?.k, e]));
  return tokenHashes.map((th) => {
    const e = byTag.get(boardTag(th, a.nonce));
    return e ? openStatus(th, e.box) : null;
  });
}
