import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ataFor, JUPITER_PROGRAM, ownerProblem, routeLandsWith, routeShortfall } from "../src/swap.ts";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

function route(owner: PublicKey, dest: PublicKey, tables: AddressLookupTableAccount[] = []) {
  const ix = new TransactionInstruction({
    programId: new PublicKey(JUPITER_PROGRAM),
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1]),
  });
  return new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message(tables));
}

test("a route lands only when it writes to the taker's own token account for the output", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  assert.equal(routeLandsWith(route(owner, ataFor(owner, mint, TOKEN)), [], owner, mint.toBase58()), true);
  assert.equal(routeLandsWith(route(owner, ataFor(owner, mint, TOKEN_2022)), [], owner, mint.toBase58()), true);
  assert.equal(routeLandsWith(route(owner, ataFor(Keypair.generate().publicKey, mint, TOKEN)), [], owner, mint.toBase58()), false);
});

test("a destination found through a lookup table counts too", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const dest = ataFor(owner, mint, TOKEN);
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [dest] },
  });
  const tx = route(owner, dest, [table]);
  assert.equal(tx.message.addressTableLookups.length, 1);
  assert.equal(routeLandsWith(tx, [table], owner, mint.toBase58()), true);
});

// a simulation's "insufficient lamports" line, the way the system program logs it
const short = (have: number, need: number) => ({ err: { InstructionError: [2, { Custom: 1 }] }, logs: [`Transfer: insufficient lamports ${have}, need ${need}`] });
const measure = async (s: { logs?: string[] | null }) => {
  const m = /insufficient lamports (\d+), need (\d+)/.exec((s.logs ?? []).join(" "));
  return m ? BigInt(m[2]) - BigInt(m[1]) : 0n;
};

test("a wallet that covers a route only without its priority fee is short of that fee", async () => {
  // fine at price 0; with the real fee taken first, 2,039,280 of rent meets 1,500,000 left
  const s = await routeShortfall({ err: null }, 4_500_000, async () => short(1_500_000, 2_039_280), measure);
  assert.ok(s > 0n);
  assert.equal(s, 539_280n);
});

test("a route short without a priority fee is short by that fee more", async () => {
  let again = 0;
  const s = await routeShortfall(short(1_000_000, 2_039_280), 300_000, async () => (again++, null), measure);
  assert.equal(s, 1_039_280n + 300_000n);
  assert.equal(again, 0);
});

test("a wallet that covers the route and its fee is not short, and no fee means no second look", async () => {
  assert.equal(await routeShortfall({ err: null }, 300_000, async () => ({ err: null }), measure), 0n);
  let again = 0;
  assert.equal(await routeShortfall({ err: null }, 0, async () => (again++, short(1, 2)), measure), 0n);
  assert.equal(again, 0);
  assert.equal(await routeShortfall(null, 300_000, async () => short(1, 2), measure), 0n);
});

test("a trade the order's own wallet isn't ready for is that wallet's problem, never the token's", () => {
  const key = Keypair.generate().publicKey;
  /** a token account's raw data: balance, and an approval for `delegate` */
  const account = (amount: bigint, delegate: PublicKey | null, delegated: bigint, ext?: Buffer) => {
    const d = Buffer.alloc(165);
    d.writeBigUInt64LE(amount, 64);
    if (delegate) {
      d.writeUInt32LE(1, 72);
      delegate.toBuffer().copy(d, 76);
    }
    d.writeBigUInt64LE(delegated, 121);
    return { data: ext ? Buffer.concat([d, Buffer.from([2]), ext]) : d, executable: false, lamports: 2_039_280, owner: TOKEN };
  };
  const memo = (on: boolean) => Buffer.from([8, 0, 1, 0, on ? 1 : 0]);
  const payer = { data: Buffer.alloc(0), executable: false, lamports: 1e9, owner: PublicKey.default };
  const ready = account(1_000n, key, 1_000n);
  const out = account(0n, null, 0n);
  assert.equal(ownerProblem([ready, out, payer], 1_000n, key.toBase58()), null);
  assert.equal(ownerProblem([ready, account(0n, null, 0n, memo(false)), payer], 1_000n, key.toBase58()), null, "a memo setting that's off changes nothing");
  assert.match(ownerProblem([null, out, payer], 1_000n, key.toBase58())!, /gone/);
  assert.match(ownerProblem([account(999n, key, 1_000n), out, payer], 1_000n, key.toBase58())!, /holds less/);
  assert.match(ownerProblem([account(1_000n, Keypair.generate().publicKey, 1_000n), out, payer], 1_000n, key.toBase58())!, /approval/);
  assert.match(ownerProblem([account(1_000n, key, 999n), out, payer], 1_000n, key.toBase58())!, /approval/);
  assert.match(ownerProblem([ready, null, payer], 1_000n, key.toBase58())!, /output is missing/);
  assert.match(ownerProblem([ready, account(0n, null, 0n, memo(true)), payer], 1_000n, key.toBase58())!, /memo/);
});
