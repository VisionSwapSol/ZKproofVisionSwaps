import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkJupiterRoute, decodeJupiterRoute, JUPITER_PROGRAM, type JupiterRoute } from "../src/swapcheck.ts";

const JUP = new PublicKey(JUPITER_PROGRAM);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const ata = (o: PublicKey, mint: PublicKey, prog = TOKEN) => PublicKey.findProgramAddressSync([o.toBytes(), prog.toBytes(), mint.toBytes()], ATA)[0];
const rnd = () => Keypair.generate().publicKey;

const DISC = {
  route: [229, 23, 203, 151, 122, 227, 173, 42],
  shared_accounts_route: [193, 32, 155, 51, 65, 214, 156, 129],
  route_v2: [187, 100, 250, 204, 49, 196, 175, 20],
  shared_accounts_route_v2: [209, 152, 83, 147, 124, 254, 216, 233],
  exact_out_route: [208, 51, 239, 151, 123, 43, 237, 92],
};
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
/** a route plan of one step with some opaque swap bytes, as Jupiter would put before (v1) or after (v2) the amounts */
const plan = Buffer.from([1, 0, 0, 0, 7, 1, 2, 3, 100, 0, 1]);

type Amounts = { inAmount: bigint; quoted: bigint; slippage: number; fee: number };
function data(kind: keyof typeof DISC, a: Amounts): Buffer {
  const shared = kind.startsWith("shared");
  const id = shared ? Buffer.from([3]) : Buffer.alloc(0);
  if (kind.endsWith("v2")) return Buffer.concat([Buffer.from(DISC[kind]), id, u64(a.inAmount), u64(a.quoted), u16(a.slippage), u16(a.fee), u16(0), plan]);
  return Buffer.concat([Buffer.from(DISC[kind]), id, plan, u64(a.inAmount), u64(a.quoted), u16(a.slippage), Buffer.from([a.fee])]);
}

/** The accounts of each route kind, from the owner and its source and destination accounts. */
function accounts(kind: keyof typeof DISC, o: { owner: PublicKey; src: PublicKey; dst: PublicKey; inMint: PublicKey; outMint: PublicKey; extraDest?: PublicKey }): PublicKey[] {
  switch (kind) {
    case "route":
    case "exact_out_route":
      return [TOKEN, o.owner, o.src, o.dst, o.extraDest ?? JUP, o.outMint, JUP, rnd(), JUP];
    case "shared_accounts_route":
      return [TOKEN, rnd(), o.owner, o.src, rnd(), rnd(), o.dst, o.inMint, o.outMint, JUP, JUP, rnd(), JUP];
    case "route_v2":
      return [o.owner, o.src, o.dst, o.inMint, o.outMint, TOKEN, TOKEN, o.extraDest ?? JUP, rnd(), JUP];
    default:
      return [rnd(), o.owner, o.src, rnd(), rnd(), o.dst, o.inMint, o.outMint, TOKEN, TOKEN, rnd(), JUP];
  }
}

function swapTx(kind: keyof typeof DISC, a: Amounts, o: Parameters<typeof accounts>[1], tables: AddressLookupTableAccount[] = []) {
  const keys = accounts(kind, o).map((pubkey, i) => ({ pubkey, isSigner: pubkey.equals(o.owner), isWritable: i > 0 && !pubkey.equals(JUP) }));
  const ix = new TransactionInstruction({ programId: JUP, keys, data: data(kind, a) });
  return new VersionedTransaction(new TransactionMessage({ payerKey: o.owner, recentBlockhash: PublicKey.default.toBase58(), instructions: [ix] }).compileToV0Message(tables));
}

const KINDS = ["route", "shared_accounts_route", "route_v2", "shared_accounts_route_v2"] as const;

test("each exact-in route kind decodes to its amounts, minimum and accounts", () => {
  const owner = rnd();
  const mint = rnd();
  for (const kind of KINDS) {
    const o = { owner, src: ata(owner, WSOL), dst: ata(owner, mint), inMint: WSOL, outMint: mint };
    const r = decodeJupiterRoute(swapTx(kind, { inAmount: 250_000_000n, quoted: 1_000_000n, slippage: 150, fee: 0 }, o));
    assert.equal(r.kind, kind);
    assert.equal(r.inAmount, 250_000_000n);
    assert.equal(r.quotedOutAmount, 1_000_000n);
    assert.equal(r.slippageBps, 150);
    assert.equal(r.minOut, 985_000n);
    assert.ok(r.authority.equals(owner));
    assert.ok(r.source.equals(o.src));
    assert.deepEqual(
      r.destinations.map((k) => k.toBase58()),
      [o.dst.toBase58()],
    );
    assert.ok(r.destinationMint.equals(mint));
    checkJupiterRoute(r, { owner, inputMint: WSOL.toBase58(), outputMint: mint.toBase58(), amount: 250_000_000n, slippageBps: 150, maxPlatformFeeBps: 0, minOut: 985_000n, quotedMinOut: 985_000n });
  }
});

test("accounts behind a lookup table are resolved before they are checked", () => {
  const owner = rnd();
  const mint = rnd();
  const thief = ata(rnd(), mint);
  const table = new AddressLookupTableAccount({
    key: rnd(),
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [thief, ata(owner, mint, TOKEN_2022)] },
  });
  const o = { owner, src: ata(owner, WSOL), dst: thief, inMint: WSOL, outMint: mint };
  const r = decodeJupiterRoute(swapTx("route_v2", { inAmount: 5n, quoted: 9n, slippage: 50, fee: 0 }, o, [table]), [table]);
  assert.ok(r.destinations[0].equals(thief));
  assert.throws(() => checkJupiterRoute(r, { owner, inputMint: WSOL.toBase58(), outputMint: mint.toBase58(), amount: 5n, slippageBps: 50, maxPlatformFeeBps: 0 }), /land somewhere other/);
  // the owner's Token-2022 account, from the table, is the owner's own
  const ok = decodeJupiterRoute(swapTx("route_v2", { inAmount: 5n, quoted: 9n, slippage: 50, fee: 0 }, { ...o, dst: ata(owner, mint, TOKEN_2022) }, [table]), [table]);
  checkJupiterRoute(ok, { owner, inputMint: WSOL.toBase58(), outputMint: mint.toBase58(), amount: 5n, slippageBps: 50, maxPlatformFeeBps: 0 });
});

test("hostile routes are refused: other amount, lower minimum, other destination, fee, kind", () => {
  const owner = rnd();
  const mint = rnd();
  const base: Parameters<typeof accounts>[1] = { owner, src: ata(owner, mint), dst: ata(owner, WSOL), inMint: mint, outMint: WSOL };
  const want: Parameters<typeof checkJupiterRoute>[1] = { owner, inputMint: mint.toBase58(), outputMint: WSOL.toBase58(), amount: 1_000n, slippageBps: 100, maxPlatformFeeBps: 0, minOut: 49_500n };
  const amounts = { inAmount: 1_000n, quoted: 50_000n, slippage: 100, fee: 0 };
  const check = (kind: (typeof KINDS)[number], a: Partial<Amounts>, o: Partial<typeof base> = {}, w: Partial<typeof want> = {}) =>
    checkJupiterRoute(decodeJupiterRoute(swapTx(kind, { ...amounts, ...a }, { ...base, ...o })), { ...want, ...w });
  for (const kind of KINDS) {
    check(kind, {});
    // a sale of the wallet's whole balance instead of the amount asked
    assert.throws(() => check(kind, { inAmount: 999_999n }), /different amount/, kind);
    // a minimum of zero (all the price room in the world), or just below the one shown
    assert.throws(() => check(kind, { slippage: 10_000 }), /minimum is lower/, kind);
    assert.throws(() => check(kind, { quoted: 49_000n, slippage: 0 }), /minimum is lower/, kind);
    // output to someone else's account
    assert.throws(() => check(kind, {}, { dst: ata(rnd(), WSOL) }), /land somewhere other/, kind);
    // input taken from an account that isn't the wallet's, or authorised by someone else
    assert.throws(() => check(kind, {}, { src: ata(rnd(), mint) }), /isn't this wallet's/, kind);
    // a platform fee the app doesn't charge
    assert.throws(() => check(kind, { fee: 50 }), /higher fee/, kind);
    check(kind, { fee: 50 }, {}, { maxPlatformFeeBps: 50, minOut: 49_000n });
    // with no minimum shown, the price room may not be wider than the one chosen
    assert.throws(() => check(kind, { slippage: 300 }, {}, { minOut: null }), /more price movement/, kind);
    // nor with one: a minimum the route keeps never makes room wider than chosen acceptable (quoted higher, room wider)
    assert.throws(() => check(kind, { quoted: 60_000n, slippage: 1_000 }), /more price movement/, kind);
    // a narrower room than chosen (the app narrows it to keep a minimum) is fine
    check(kind, { quoted: 50_000n, slippage: 50 });
    // the build's reported minimum must be the one the instruction enforces
    assert.throws(() => check(kind, {}, {}, { quotedMinOut: 49_600n }), /doesn't match its quote/, kind);
  }
  // a v1 route's separate destination counts too
  for (const kind of ["route", "route_v2"] as const) assert.throws(() => check(kind, {}, { extraDest: ata(rnd(), WSOL) }), /land somewhere other/, kind);
  // exact-out routes are never made by the app
  assert.throws(() => decodeJupiterRoute(swapTx("exact_out_route" as never, amounts, base)), /kind of Jupiter route/);
});

test("Jupiter's own stated minimum (rounded up) passes; one unit more than that doesn't", () => {
  // figures from real routes Jupiter's API built (Oct 2026): the API states otherAmountThreshold rounded up,
  // the instruction's quoted_out_amount and slippage_bps give it rounded down
  const real: [bigint, number, bigint][] = [
    [1_041_930n, 50, 1_036_721n],
    [9_599_164n, 100, 9_503_173n],
    [3_071_401n, 300, 2_979_259n],
  ];
  const owner = rnd();
  const mint = rnd();
  for (const kind of KINDS) {
    for (const [quoted, slippage, threshold] of real) {
      const o = { owner, src: ata(owner, WSOL), dst: ata(owner, mint), inMint: WSOL, outMint: mint };
      const r = decodeJupiterRoute(swapTx(kind, { inAmount: 10_000_000n, quoted, slippage, fee: 0 }, o));
      assert.equal(r.minOut + 1n, threshold, "decoded rounded down, one below the API's figure");
      const want = { owner, inputMint: WSOL.toBase58(), outputMint: mint.toBase58(), amount: 10_000_000n, slippageBps: slippage, maxPlatformFeeBps: 0 };
      checkJupiterRoute(r, { ...want, minOut: threshold, quotedMinOut: threshold });
      assert.throws(() => checkJupiterRoute(r, { ...want, minOut: threshold + 1n, quotedMinOut: threshold }), /minimum is lower/, kind);
    }
  }
});

test("a swap must hold exactly one Jupiter route", () => {
  const owner = rnd();
  const msg = (n: number) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: Array.from({ length: n }, () => new TransactionInstruction({ programId: JUP, keys: [], data: Buffer.from(DISC.route) })),
      }).compileToV0Message(),
    );
  assert.throws(() => decodeJupiterRoute(msg(0)), /exactly one/);
  assert.throws(() => decodeJupiterRoute(msg(2)), /exactly one/);
  // too short to hold its amounts
  assert.throws(() => decodeJupiterRoute(msg(1)), /too short|missing an account/);
});

// keep the type in use (the decoder's shape is what the app checks)
export type _R = JupiterRoute;
