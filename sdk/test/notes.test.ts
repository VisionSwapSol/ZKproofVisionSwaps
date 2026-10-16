import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { keysFromSignature } from "../src/keys.ts";
import { encodeMeta, noteInner, noteLeaf, randomNonce, tryOpen, type OwnedNote } from "../src/notes.ts";
import { padInputs, scanNotes, selectInputs } from "../src/wallet-state.ts";
import { concat, toLE } from "../src/field.ts";

const keys = keysFromSignature(new Uint8Array(64).map((_, i) => (i * 29 + 3) & 0xff));
const te = new TextEncoder();

/** A note's meta as versions before tag2 wrote it: the tag from the nonce alone. */
function legacyMeta(nonce: Uint8Array, amount: bigint): Uint8Array {
  const tag = sha256(concat(te.encode("vs:tag"), keys.viewKey, nonce)).slice(0, 8);
  const mask = sha256(concat(te.encode("vs:amt"), keys.viewKey, nonce)).slice(0, 8);
  const enc = toLE(amount, 8);
  for (let i = 0; i < 8; i++) enc[i] ^= mask[i];
  return concat(nonce, tag, enc);
}

/** What someone who saw a note's public details could make: the same inner and meta, a different amount. */
function replant(meta: Uint8Array, amount: bigint, planted: bigint): Uint8Array {
  const out = meta.slice();
  const was = toLE(amount, 8);
  const now = toLE(planted, 8);
  // the public amount reveals the mask: swap one amount for the other under it
  for (let i = 0; i < 8; i++) out[20 + i] ^= was[i] ^ now[i];
  return out;
}

test("new notes carry the amount-bound tag; notes made before still open", () => {
  const nonce = randomNonce();
  const amount = 700_000_000n;
  const inner = noteInner(keys, nonce);
  const meta = encodeMeta(keys, nonce, amount);
  assert.notDeepEqual(meta.slice(12, 20), legacyMeta(nonce, amount).slice(12, 20), "the tag is the new one");
  assert.equal(tryOpen(keys, 4, noteLeaf(amount, inner), meta)?.amount, amount);
  assert.equal(tryOpen(keys, 4, noteLeaf(amount, inner), legacyMeta(nonce, amount))?.amount, amount, "an older note still opens");
});

test("a copied note with another amount doesn't open when the note carries the new tag", () => {
  const nonce = randomNonce();
  const amount = 700_000_000n;
  const inner = noteInner(keys, nonce);
  const planted = 1_000n;
  // under the new tag the forged amount is refused
  assert.equal(tryOpen(keys, 9, noteLeaf(planted, inner), replant(encodeMeta(keys, nonce, amount), amount, planted)), null);
  // (under the old tag it would have opened: that is what the scanner's dedupe is for)
  assert.equal(tryOpen(keys, 9, noteLeaf(planted, inner), replant(legacyMeta(nonce, amount), amount, planted))?.amount, planted);
});

test("the scanner counts a nonce once: a later copy is set aside as unexpected, even after the first is spent", () => {
  const nonce = randomNonce();
  const amount = 500_000_000n;
  const inner = noteInner(keys, nonce);
  const meta = legacyMeta(nonce, amount);
  const other = randomNonce();
  const leaves = [
    { index: 0, leaf: noteLeaf(amount, inner), meta },
    { index: 1, leaf: noteLeaf(300n, noteInner(keys, other)), meta: encodeMeta(keys, other, 300n) },
    // the same inner deposited again by someone else, with an amount of their choosing
    { index: 2, leaf: noteLeaf(9_999n, inner), meta: replant(meta, amount, 9_999n) },
    // and once more with the very same amount
    { index: 3, leaf: noteLeaf(amount, inner), meta },
  ];
  const bal = scanNotes(keys, leaves, new Set());
  assert.deepEqual(
    bal.notes.map((n) => n.index),
    [0, 1],
  );
  assert.equal(bal.total, amount + 300n);
  assert.deepEqual(
    bal.unexpected.map((n) => n.index),
    [2, 3],
  );
  // the first copy spent: the later ones still don't count
  const first = bal.notes.find((n) => n.index === 0)!;
  const after = scanNotes(keys, [...leaves].reverse(), new Set([first.nullifier]));
  assert.deepEqual(
    after.notes.map((n) => n.index),
    [1],
  );
  assert.deepEqual(after.unexpected.map((n) => n.index).sort(), [2, 3]);
});

const note = (index: number, amount: bigint): OwnedNote => ({ index, amount, leaf: BigInt(index + 1), nonce: new Uint8Array(12), blinding: 0n, nullifier: BigInt(1000 + index) });

test("one note covering a payment takes the smallest free note along (the oldest of equals)", () => {
  const big = note(5, 10_000n);
  const free = [big, note(9, 300n), note(2, 300n), note(7, 900n)];
  const pick = selectInputs(free, 4_000n)!;
  assert.deepEqual(
    pick.map((n) => n.index),
    [5],
  );
  assert.deepEqual(
    padInputs(pick, free).map((n) => n.index),
    [5, 2],
  );
  // two notes already: as they are; nothing else free: as it is
  const two = [note(1, 5n), note(3, 6n)];
  assert.equal(padInputs(two, [...two, note(4, 1n)]), two);
  assert.deepEqual(padInputs([big], [big]), [big]);
  // a note only the caller knows to be held is never added: the caller passes free notes only
  assert.deepEqual(
    padInputs([big], [big, note(8, 0n)]).map((n) => n.index),
    [5],
  );
});
