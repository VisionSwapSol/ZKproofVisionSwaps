import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  BOARD_EPOCH_MS,
  BOARD_MAX_CHARS,
  BOARD_MAX_ENTRIES,
  BOARD_MIN_BUCKET,
  BOARD_MIN_PLAIN,
  BOARD_MIN_SIZE,
  BOARD_PAD,
  answerBoard,
  askedEpoch,
  boardChars,
  boardEpoch,
  boardKeys,
  boardPlainSize,
  boardSize,
  boardTag,
  bucketsOf,
  cleanBuckets,
  decoyKey,
  inBuckets,
  openStatus,
  readAnswer,
  sealStatus,
  tokenHash,
  type BoardAnswer,
} from "../src/board.ts";
import { fromBase64 } from "../src/seal.ts";

const th = (i: number) => tokenHash(`token-${i}`);
const E = 491_000;
const rand = (n: number) => new Uint8Array(randomBytes(n));
const secret = new Uint8Array(32).fill(7);
const boxLen = (box: string) => fromBase64(box)!.length;
const SIG = "5".repeat(88);

test("a token's hash is its SHA-256 in hex, as the server stores it", () => {
  assert.equal(tokenHash("abc"), createHash("sha256").update("abc").digest("hex"));
});

test("only the token's holder opens its status, and a changed box opens for nobody", () => {
  const box = sealStatus(th(1), { status: "scheduled", rootsLeft: 140 });
  assert.deepEqual(openStatus(th(1), box), { status: "scheduled", rootsLeft: 140 });
  assert.equal(openStatus(th(2), box), null);
  assert.equal(openStatus(th(1), box.slice(0, -4) + "AAAA"), null);
  assert.equal(openStatus(th(1), 42), null);
  // the bucket key changes every hour, the sealing key doesn't, and neither is the other nor a tag
  assert.notEqual(boardKeys(th(1), E).k, boardKeys(th(1), E + 1).k);
  assert.deepEqual(boardKeys(th(1), E).key, boardKeys(th(1), E + 1).key);
  assert.notEqual(Buffer.from(boardKeys(th(1), E).key).toString("hex").slice(0, 32), boardKeys(th(1), E).k);
  assert.notEqual(boardTag(th(1), "00".repeat(16)), boardKeys(th(1), E).k);
  // every seal is new, so watching a box doesn't show when its status changed
  assert.notEqual(sealStatus(th(1), { status: "scheduled" }), sealStatus(th(1), { status: "scheduled" }));
});

test("every box on a board is the same size, whatever it holds, decoys included", () => {
  // a scheduled payment, and a finished one with its signatures and sending address: both under the floor
  const real = [
    { th: th(1), status: { status: "scheduled", signature: null, error: null, note: null, hop: "A".repeat(44), soon: false, rootsLeft: 140 } },
    { th: th(2), status: { status: "done", signature: SIG, error: null, note: null, tx1: SIG, hop: "A".repeat(44) } },
  ];
  const a = answerBoard(real, [""], E, secret, rand);
  assert.equal(a.entries.length, BOARD_MIN_SIZE);
  const sizes = new Set(a.entries.map((e) => boxLen(e.box)));
  assert.deepEqual([...sizes], [16 + BOARD_MIN_PLAIN + 16], "one size for all");
  // a status longer than the floor makes every box bigger, in steps of BOARD_PAD: never just its own
  const long = [...real, { th: th(3), status: { status: "failed", error: "x".repeat(600) } }];
  const b = answerBoard(long, [""], E, secret, rand);
  assert.deepEqual([...new Set(b.entries.map((e) => boxLen(e.box)))], [16 + 3 * BOARD_PAD + 16]);
  assert.equal(readAnswer([th(3)], b)[0]?.error, "x".repeat(600));
  // the size comes from the whole board, not the buckets asked for
  assert.equal(boardPlainSize([{ a: 1 }]), BOARD_MIN_PLAIN);
  assert.equal(boardPlainSize([{ a: "x".repeat(700) }], 768), 768);
  assert.equal(boardPlainSize([{ a: "x".repeat(800) }], 768), 1024);
});

test("an entry is tagged afresh in every answer, so it can't be followed from one to the next", () => {
  const real = Array.from({ length: 10 }, (_, i) => ({ th: th(i), status: { status: "scheduled", i } }));
  const a = answerBoard(real, [""], E, secret, rand);
  const b = answerBoard(real, [""], E, secret, rand);
  assert.match(a.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(a.nonce, b.nonce);
  // no tag shows twice across two answers, real or decoy, and no box either
  const ta = new Set(a.entries.map((e) => e.k));
  assert.ok(b.entries.every((e) => !ta.has(e.k)));
  const ba = new Set(a.entries.map((e) => e.box));
  assert.ok(b.entries.every((e) => !ba.has(e.box)));
  // the app finds its own by the answer's nonce, in either answer
  assert.deepEqual(readAnswer([th(3)], a), [{ status: "scheduled", i: 3 }]);
  assert.deepEqual(readAnswer([th(3)], b), [{ status: "scheduled", i: 3 }]);
  // neither a token's hash, nor an hour's bucket key, ever appears in an answer
  const text = JSON.stringify(a);
  assert.ok(!text.includes(th(3)) && !text.includes(boardKeys(th(3), E).k));
});

test("an answer the app can't read gives nobody a status, and decoys open for nobody", () => {
  const real = [{ th: th(1), status: { status: "scheduled" } }];
  const a = answerBoard(real, [""], E, secret, rand);
  assert.deepEqual(readAnswer([th(1), th(2)], a), [{ status: "scheduled" }, null]);
  assert.deepEqual(readAnswer([th(1)], { ...a, nonce: "nope" }), [null]);
  assert.deepEqual(readAnswer([th(1)], { ...a, entries: "x" } as unknown as BoardAnswer), [null]);
  // every other entry is a decoy: no token opens it
  const mine = boardTag(th(1), a.nonce);
  assert.ok(a.entries.filter((e) => e.k !== mine).every((e) => openStatus(th(1), e.box) === null && openStatus(th(2), e.box) === null));
});

test("the hour: the app's own when it is within one of the server's, else the server's", () => {
  const now = E * BOARD_EPOCH_MS + 10;
  assert.equal(boardEpoch(now), E);
  assert.equal(askedEpoch(E - 1, now), E - 1);
  assert.equal(askedEpoch(E + 1, now), E + 1);
  assert.equal(askedEpoch(E + 2, now), E);
  assert.equal(askedEpoch("nope", now), E);
});

test("the board is filled up with decoys to a size that steps only at powers of two", () => {
  assert.equal(boardSize(0), BOARD_MIN_SIZE);
  assert.equal(boardSize(64), 64);
  assert.equal(boardSize(65), 128);
  assert.equal(boardSize(1000), 1024);
  const real = Array.from({ length: 10 }, (_, i) => ({ th: th(i), status: { status: "scheduled" } }));
  assert.equal(answerBoard(real, [""], E, secret, rand).entries.length, 64);
  // one more payment, or one fewer: the same size
  assert.equal(answerBoard(real.slice(1), [""], E, secret, rand).entries.length, 64);
  assert.equal(answerBoard([], [""], E, secret, rand).entries.length, 64);
  // decoys sit in the same buckets all hour (as real entries do), and elsewhere the next hour
  assert.equal(decoyKey(secret, E, 5), decoyKey(secret, E, 5));
  assert.notEqual(decoyKey(secret, E, 5), decoyKey(secret, E + 1, 5));
});

test("buckets get finer only once each holds many entries", () => {
  assert.equal(boardChars(0), 0);
  assert.equal(boardChars(16 * BOARD_MIN_BUCKET - 1), 0);
  assert.equal(boardChars(16 * BOARD_MIN_BUCKET), 1);
  assert.equal(boardChars(256 * BOARD_MIN_BUCKET), 2);
  assert.equal(boardChars(10 ** 9), BOARD_MAX_CHARS);
});

test("the app's buckets, and the server's reading of them", () => {
  assert.deepEqual(bucketsOf(["ab12", "ac99", "ab00"], 0), [""]);
  assert.deepEqual(bucketsOf(["ab12", "ac99", "ab00"], 2), ["ab", "ac"]);
  assert.deepEqual(cleanBuckets([]), [""]);
  assert.deepEqual(cleanBuckets(["AB", "ab"]), ["ab"]);
  assert.equal(cleanBuckets(["ab", "a"]), null);
  assert.equal(cleanBuckets(["zz"]), null);
  assert.equal(cleanBuckets(["abcd"]), null);
  assert.equal(cleanBuckets("ab"), null);
  assert.ok(inBuckets("abff", ["ab"], 2));
  assert.ok(!inBuckets("acff", ["ab"], 2));
  assert.ok(inBuckets("acff", ["ab"], 1));
  assert.ok(inBuckets("zz", [""], 3));
});

test("a small board is answered whole whatever was asked: a poll never singles anyone out", () => {
  const real = Array.from({ length: 40 }, (_, i) => ({ th: th(i), status: { i } }));
  const a = answerBoard(real, ["0f", "a1"], E, secret, rand);
  assert.equal(a.chars, 0);
  assert.equal(a.epoch, E);
  assert.equal(a.entries.length, 64);
  assert.equal(readAnswer(real.map((r) => r.th), a).filter(Boolean).length, 40, "everyone's entry is in it");
  // in tag order, and the tags are new each time, so the order says nothing either
  const ks = a.entries.map((e) => e.k);
  assert.deepEqual(ks, [...ks].sort());
});

test("a big board answers whole buckets of the server's own size, never narrower ones", () => {
  const real = Array.from({ length: 900 }, (_, i) => ({ th: th(i), status: { i } }));
  // 1,024 entries: buckets of one character (64 each on average); asked at 3 characters, the server widens to 1
  assert.equal(boardChars(boardSize(real.length)), 1);
  const mine = boardKeys(th(7), E).k;
  const a = answerBoard(real, [mine.slice(0, 3)], E, secret, rand);
  assert.equal(a.chars, 1);
  assert.deepEqual(readAnswer([th(7)], a), [{ i: 7 }]);
  // exactly the real entries of that one-character bucket, and the decoys of it
  const inBucket = real.filter((r) => boardKeys(r.th, E).k[0] === mine[0]);
  const opened = readAnswer(
    real.map((r) => r.th),
    a,
  ).filter(Boolean);
  assert.equal(opened.length, inBucket.length);
  let decoys = 0;
  for (let i = 0; i < 1024 - 900; i++) if (decoyKey(secret, E, i)[0] === mine[0]) decoys++;
  assert.equal(a.entries.length, inBucket.length + decoys);
  assert.ok(a.entries.length >= BOARD_MIN_BUCKET);
  // asked for the whole board while it is still small enough, it is answered whole
  assert.equal(answerBoard(real, [""], E, secret, rand).entries.length, 1024);
});

test("a board too big to send whole says how fine to ask instead", () => {
  const real = Array.from({ length: BOARD_MAX_ENTRIES + 500 }, (_, i) => ({ th: th(i), status: {} }));
  const whole = answerBoard(real, [""], E, secret, rand);
  assert.equal(whole.finer, true);
  assert.equal(whole.entries.length, 0);
  assert.equal(whole.chars, boardChars(boardSize(real.length)));
  const again = answerBoard(real, bucketsOf([boardKeys(th(3), E).k], whole.chars), E, secret, rand);
  assert.ok(!again.finer);
  assert.deepEqual(readAnswer([th(3)], again), [{}]);
});
