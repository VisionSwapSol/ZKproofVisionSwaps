import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkSwapSpend, lastPart, leftOver, maxWithdraw, mergePlan, roomFor, settlePayer, speedEstimate, sweepAmount, sweepParts, SETTLE_FEE_MIN, SPEED_CAP, speedOf } from "../src/lib/trade.ts";
import { depositFee, maxDepositFor } from "@visionswap/sdk";

const SOL = 1_000_000_000n;
const FEE = 2_000_000n;
const tenths = (n: number) => Array.from({ length: n }, () => SOL / 10n);

test("a spend that one or two notes cover needs no joins", () => {
  assert.deepEqual(mergePlan([SOL, SOL / 2n], FEE, SOL), { merges: 0, cost: 0n, ok: true, pieces: 2 });
  assert.deepEqual(mergePlan([SOL, SOL / 2n], FEE, (SOL * 3n) / 2n), { merges: 0, cost: 0n, ok: true, pieces: 2 });
});

test("ten 0.1 SOL notes: the joins a spend needs are counted, fees included", () => {
  // 0.55 SOL needs six notes (four joins): 0.6 - 4 x 0.002 = 0.592
  const p = mergePlan(tenths(10), FEE, (SOL * 55n) / 100n);
  assert.equal(p.ok, true);
  assert.equal(p.merges, 4);
  assert.equal(p.cost, 4n * FEE);
  // the old loop gave up after four joins without trying the fourth join's result; five are counted here
  assert.equal(mergePlan(tenths(10), FEE, (SOL * 595n) / 1000n).merges, 5);
});

test("a spend the joins can't make fit is refused before any join is paid", () => {
  // ten 0.1 notes hold 1 SOL, but joining all of them costs 8 x 0.002
  const p = mergePlan(tenths(10), FEE, SOL - FEE);
  assert.equal(p.ok, false);
  assert.equal(p.pieces, 10);
  // and at most this many joins are ever planned
  assert.equal(mergePlan(tenths(30), FEE, SOL * 2n, 16).ok, false);
});

test("the most one spend can take, joins included", () => {
  assert.equal(maxWithdraw([], FEE), 0n);
  assert.equal(maxWithdraw([SOL], FEE), SOL);
  assert.equal(maxWithdraw([SOL, SOL], FEE), 2n * SOL);
  assert.equal(maxWithdraw(tenths(10), FEE), SOL - 8n * FEE);
  // a dust note isn't worth joining: it would cost more than it adds
  assert.equal(maxWithdraw([SOL, SOL, 1_000n], FEE), 2n * SOL);
  // whatever maxWithdraw says is always a plan that works
  for (const notes of [tenths(10), [SOL, SOL / 3n, SOL / 7n, 5_000_000n], tenths(3)]) {
    assert.equal(mergePlan(notes, FEE, maxWithdraw(notes, FEE)).ok, true);
  }
});

test("moving SOL into the pool: rent, fee and reserve come off, and dust below the smallest deposit stays", () => {
  const fit = (b: bigint) => (b * 10_000n) / 10_080n; // a 0.8% deposit fee
  const base = { reclaim: 0n, txFee: 11_200n, rentPending: 1_705_200n, minDeposit: 10_000_000n, fit };
  const r = sweepAmount({ ...base, lamports: 50_000_000n, reserve: 0n });
  assert.equal(r.budget, 50_000_000n - 11_200n - 1_705_200n);
  assert.equal(r.amount, fit(r.budget));
  // a partial sale keeps the reserve, which can push it under the smallest deposit
  assert.equal(sweepAmount({ ...base, lamports: 15_900_000n, reserve: 6_000_000n }).amount, 0n);
  // nothing at all
  assert.equal(sweepAmount({ ...base, lamports: 1_000n, reserve: 0n }).amount, 0n);
});

// ─── swap checks ───

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const ataOf = (o: PublicKey, m: PublicKey) => PublicKey.findProgramAddressSync([o.toBytes(), TOKEN.toBytes(), m.toBytes()], ATA)[0];

function swapTx(o: { owner: PublicKey; units: number; price: number; wrap: bigint; dest: PublicKey }) {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: o.units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: o.price }),
    SystemProgram.transfer({ fromPubkey: o.owner, toPubkey: ataOf(o.owner, WSOL), lamports: o.wrap }),
    new TransactionInstruction({
      programId: JUP,
      keys: [
        { pubkey: o.owner, isSigner: true, isWritable: false },
        { pubkey: ataOf(o.owner, WSOL), isSigner: false, isWritable: true },
        { pubkey: o.dest, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([1, 2, 3]),
    }),
  ];
  return new VersionedTransaction(new TransactionMessage({ payerKey: o.owner, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
}

test("a swap that pays a normal fee, wraps the trade's SOL and lands in the wallet passes", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const tx = swapTx({ owner, units: 300_000, price: 20_000, wrap: SOL, dest: ataOf(owner, mint) });
  checkSwapSpend(tx, [], { owner, outputMint: mint.toBase58(), lamportsIn: SOL, speed: "normal" });
});

test("a swap is refused when its fee is over the speed's cap, it wraps more than the trade, or its tokens land elsewhere", () => {
  const owner = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const ok = { owner, units: 300_000, price: 20_000, wrap: SOL, dest: ataOf(owner, mint) };
  const opts = { owner, outputMint: mint.toBase58(), lamportsIn: SOL, speed: "normal" as const };
  // 1.4M units at 1M micro-lamports is 0.0014 SOL of fee: over Normal's cap
  assert.throws(() => checkSwapSpend(swapTx({ ...ok, units: 1_400_000, price: 1_000_000 }), [], opts), /network fee/);
  // Turbo allows that, but not ten times as much
  checkSwapSpend(swapTx({ ...ok, units: 1_400_000, price: 1_000_000 }), [], { ...opts, speed: "turbo" });
  assert.throws(() => checkSwapSpend(swapTx({ ...ok, units: 1_400_000, price: 10_000_000 }), [], { ...opts, speed: "turbo" }), /network fee/);
  checkSwapSpend(swapTx({ ...ok, units: 1_000_000, price: 4_000 }), [], { ...opts, speed: "fast" });
  assert.throws(() => checkSwapSpend(swapTx({ ...ok, wrap: SOL * 2n }), [], opts), /more SOL/);
  assert.throws(() => checkSwapSpend(swapTx({ ...ok, dest: ataOf(Keypair.generate().publicKey, mint) }), [], opts), /land somewhere/);
});

test("the speed caps grow with the speed, and anything unknown is Normal", () => {
  assert.ok(SPEED_CAP.normal < SPEED_CAP.fast && SPEED_CAP.fast < SPEED_CAP.turbo);
  assert.equal(speedOf("warp"), "normal");
  assert.equal(speedOf("turbo"), "turbo");
});

test("the room that keeps a fresh route's minimum at the least the person was shown", () => {
  // shown 90 as the least; a fresh route promising 91 may only give up 1
  const bps = roomFor(91n, 90n)!;
  assert.equal(bps, 109);
  assert.ok((91n * BigInt(10_000 - bps)) / 10_000n >= 90n);
  for (const [out, min] of [[1_000_003n, 990_000n], [123_456_789n, 120_000_000n], [10_000n, 9_000n]] as const) {
    const b = roomFor(out, min)!;
    assert.ok((out * BigInt(10_000 - b)) / 10_000n >= min, `${out} ${min}`);
  }
  // a route worse than the least shown, or one leaving under 0.1% room, can't keep the promise
  assert.equal(roomFor(89n, 90n), null);
  assert.equal(roomFor(100_000n, 99_950n), null);
  assert.equal(roomFor(0n, 0n), null);
});

test("a speed's usual fee is well under its cap", () => {
  assert.equal(speedEstimate("normal"), 6_000n);
  assert.equal(speedEstimate("fast"), 45_000n);
  assert.equal(speedEstimate("turbo"), 300_000n);
  for (const s of ["normal", "fast", "turbo"] as const) assert.ok(speedEstimate(s) <= SPEED_CAP[s]);
});

test("without joins (sending it yourself), one spend takes at most the two largest notes", () => {
  assert.equal(maxWithdraw([SOL / 10n, SOL / 2n, SOL / 4n], 0n, 0), SOL / 2n + SOL / 4n);
  assert.equal(maxWithdraw([SOL], 0n, 0), SOL);
});

test("adding a waiting deposit to the pool never has the connected wallet pay for a Vision wallet or deposit address", () => {
  const wallet = Keypair.generate().publicKey.toBase58();
  const other = Keypair.generate().publicKey.toBase58();
  const rentWallet = 890_880n;
  for (const ownLamports of [0n, SETTLE_FEE_MIN, rentWallet, rentWallet + 4_999n, rentWallet + SETTLE_FEE_MIN - 1n, rentWallet + SETTLE_FEE_MIN, SOL, null]) {
    // the depositor is the Vision wallet or deposit address, whatever wallet is connected (even one that matches it)
    for (const depositor of [other, wallet]) {
      for (const w of [wallet, other, null]) {
        const p = settlePayer({ fromAddress: true, ownLamports, rentWallet, depositor, wallet: w });
        assert.notEqual(p, "wallet");
        // the fee is paid by the address only when it stays open afterwards
        assert.equal(p, ownLamports !== null && ownLamports >= rentWallet + SETTLE_FEE_MIN ? "own" : "server");
      }
    }
  }
  // the wallet's own deposit: it pays only when it is the wallet that made it
  assert.equal(settlePayer({ fromAddress: false, ownLamports: null, rentWallet, depositor: wallet, wallet }), "wallet");
  assert.equal(settlePayer({ fromAddress: false, ownLamports: null, rentWallet, depositor: wallet, wallet: other }), "server");
  assert.equal(settlePayer({ fromAddress: false, ownLamports: null, rentWallet, depositor: wallet, wallet: null }), "server");
});

test("a Vision wallet holding more than one deposit may take goes back in parts that each fit, ending at zero", () => {
  const feeBps = 30;
  const rentPending = 1_670_400n;
  const txFeeFirst = 5_000n * 2n + 2_000n; // the first part also closes accounts
  const txFee = 5_000n * 2n + 1_200n;
  const max = 25n * SOL;
  const min = SOL / 100n;
  const reclaim = 2_039_280n;
  const lamports = 30n * SOL + 123_457n;
  const parts = sweepParts({ lamports, reclaim, txFee: txFeeFirst, rentPending, reserve: 0n, feeBps, min, max });
  assert.equal(parts.length, 2);
  for (const a of parts) assert.ok(a <= max && a >= min);
  // sent as the move does: every part but the last as planned, the last from what is left
  let left = lamports + reclaim;
  for (const [k, a] of parts.entries()) {
    const fee = k === 0 ? txFeeFirst : txFee;
    if (k < parts.length - 1) {
      left -= a + depositFee(a, feeBps) + rentPending + fee;
      continue;
    }
    const last = lastPart({ lamports: left, txFee: fee, rentPending, reserve: 0n, feeBps, max, rentWallet: 890_880n });
    assert.ok(last.amount <= max && last.amount >= min);
    assert.ok(last.dust >= 0n && last.dust < 890_880n, "only a sliver rides along");
    left -= last.amount + depositFee(last.amount, feeBps) + rentPending + fee + last.dust;
  }
  assert.equal(left, 0n, "parts, fees, rent and network fees add up to the balance exactly");
  // one that fits in one deposit is a single part, as before
  assert.deepEqual(sweepParts({ lamports: 2n * SOL, reclaim: 0n, txFee, rentPending, reserve: 0n, feeBps, min, max }), [
    sweepAmount({ lamports: 2n * SOL, reclaim: 0n, txFee, rentPending, reserve: 0n, minDeposit: min, fit: (b) => maxDepositFor(b, feeBps) }).amount,
  ]);
  // too little for the smallest deposit: nothing
  assert.deepEqual(sweepParts({ lamports: min / 2n, reclaim: 0n, txFee, rentPending, reserve: 0n, feeBps, min, max }), []);
});

test("the last part keeps back the reserve and never pushes more than a sliver into the waiting account", () => {
  const base = { txFee: 11_200n, rentPending: 1_670_400n, feeBps: 30, max: 25n * SOL, rentWallet: 890_880n };
  // a reserve stays in the wallet: no dust rides along
  assert.equal(lastPart({ ...base, lamports: 3n * SOL, reserve: 5_000_000n }).dust, 0n);
  // more than the limit arrived meanwhile: the rest stays in the wallet instead of riding along
  const big = lastPart({ ...base, lamports: 40n * SOL, reserve: 0n });
  assert.equal(big.amount, base.max);
  assert.equal(big.dust, 0n);
});

test("a sweep whose last part hit the limit because more arrived meanwhile isn't finished", () => {
  const p = { txFee: 10_000n, rentPending: 2_000_000n, reserve: 0n, feeBps: 30, min: SOL / 100n, max: 25n * SOL, nextTxFee: 10_000n };
  // 30 SOL there when the last part was planned: it took 25, and about 5 is still to go
  const big = lastPart({ lamports: 30n * SOL, txFee: p.txFee, rentPending: p.rentPending, reserve: 0n, feeBps: p.feeBps, max: p.max, rentWallet: 890_880n });
  assert.equal(big.amount, p.max);
  assert.equal(leftOver({ ...p, lamports: 30n * SOL, amount: big.amount, dust: big.dust }), true);
  // what fit went in whole: nothing left worth a deposit
  const all = lastPart({ lamports: 10n * SOL, txFee: p.txFee, rentPending: p.rentPending, reserve: 0n, feeBps: p.feeBps, max: p.max, rentWallet: 890_880n });
  assert.equal(leftOver({ ...p, lamports: 10n * SOL, amount: all.amount, dust: all.dust }), false);
  // just over the limit: the sliver above it is below the smallest deposit
  const edge = 25n * SOL + depositFee(25n * SOL, p.feeBps) + p.txFee + p.rentPending + 1_000_000n;
  const e = lastPart({ lamports: edge, txFee: p.txFee, rentPending: p.rentPending, reserve: 0n, feeBps: p.feeBps, max: p.max, rentWallet: 890_880n });
  assert.equal(leftOver({ ...p, lamports: edge, amount: e.amount, dust: e.dust }), false);
});
