import { test } from "node:test";
import assert from "node:assert/strict";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  Keypair,
  Message,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  ComputeBudgetInstruction,
  Transaction,
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  keysFromMaster,
  hopWallet,
  gasWallet,
  visionWallet,
  depositWallet,
  orderKey,
  randomMaster,
  splitWithdraw,
  predictCredit,
  deliveryWithdraw,
  deliveryFeeOf,
  DELIVERY_FEE,
  DELIVERY_CU,
  DELIVERY_PRICE_L1,
  DELIVERY_PRICE_N2,
  l1Message,
  n2Message,
  deliveryTransaction,
  signDelivery,
  verifyDelivery,
  readNonceAccount,
  classifyRecipient,
  recipientVerdict,
  RESERVED_ADDRESSES,
  lookalike,
  ownMessage,
  hopLookupMessage,
  sameDeliveryTerms,
  DELIVERY_V,
} from "../src/index.ts";

const keys = keysFromMaster(new Uint8Array(32).fill(7));

test("a hop is fixed by the account and the change note, and differs from every other derived wallet", () => {
  const a = hopWallet(keys, 123n);
  assert.equal(a.publicKey.toBase58(), hopWallet(keys, 123n).publicKey.toBase58(), "deterministic");
  assert.notEqual(a.publicKey.toBase58(), hopWallet(keys, 124n).publicKey.toBase58(), "one per change note");
  assert.notEqual(a.publicKey.toBase58(), hopWallet(keysFromMaster(new Uint8Array(32).fill(8)), 123n).publicKey.toBase58(), "one per account");
  const others = new Set<string>();
  for (let i = 0; i < 4; i++) {
    for (const k of [gasWallet(keys, i), visionWallet(keys, i), depositWallet(keys, i), orderKey(keys, i)]) others.add(k.publicKey.toBase58());
  }
  // a small change note's 32 bytes start like any 4-byte index: the domain keeps them apart
  for (let i = 0n; i < 4n; i++) assert.equal(others.has(hopWallet(keys, i).publicKey.toBase58()), false);
  // a field element as big as a leaf can be
  assert.ok(hopWallet(keys, (1n << 254n) - 1n).publicKey);
});

test("both delivery shapes cost the hop exactly the same fee", () => {
  assert.equal(deliveryFeeOf(1, DELIVERY_PRICE_L1), DELIVERY_FEE);
  assert.equal(deliveryFeeOf(2, DELIVERY_PRICE_N2), DELIVERY_FEE);
  assert.equal(DELIVERY_FEE, 12_000n);
  assert.equal(sameDeliveryTerms({ v: DELIVERY_V, cu: DELIVERY_CU, priceL1: DELIVERY_PRICE_L1, priceN2: DELIVERY_PRICE_N2, fee: "12000" }), true);
  assert.equal(sameDeliveryTerms({ v: DELIVERY_V, cu: DELIVERY_CU, priceL1: DELIVERY_PRICE_L1 + 1, priceN2: DELIVERY_PRICE_N2, fee: "12000" }), false);
});

/** The program's own arithmetic (lib.rs transact), written out separately from predictCredit. */
function program(withdraw: bigint, relayerFee: bigint, bps: number, treasury?: { lamports: bigint; rentMin: bigint }) {
  const net = withdraw - relayerFee;
  let protocol = (net * BigInt(bps)) / 10000n;
  if (protocol > 0n && treasury && !(treasury.lamports + protocol >= treasury.rentMin)) protocol = 0n;
  return net - protocol;
}

let seed = 0x9e3779b97f4a7c15n;
const rnd = (max: bigint) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
  return seed % max;
};

test("the predicted credit matches the program's, including an emptied treasury", () => {
  for (let i = 0; i < 100_000; i++) {
    const relayerFee = rnd(3_000_000n);
    const withdraw = relayerFee + rnd(i % 3 === 0 ? 2_000_000n : 50_000_000_000n);
    const bps = Number(rnd(501n));
    const treasury = i % 2 ? { lamports: rnd(1_000_000n), rentMin: 890_880n } : undefined;
    const want = program(withdraw, relayerFee, bps, treasury);
    assert.equal(predictCredit(withdraw, relayerFee, bps, treasury), want);
    if (!treasury) assert.equal(splitWithdraw(withdraw, relayerFee, bps).toRecipient, want);
  }
});

test("the withdraw for a delivery makes the hop receive exactly the amount plus the delivery fee", () => {
  for (let i = 0; i < 20_000; i++) {
    const amount = 1n + rnd(i % 2 ? 1_000_000n : 100_000_000_000n);
    const relayerFee = 1_000_000n + rnd(2_000_000n);
    const bps = Number(rnd(501n));
    const treasury = i % 3 === 0 ? { lamports: rnd(900_000n), rentMin: 890_880n } : undefined;
    const w = deliveryWithdraw(amount, relayerFee, bps, treasury);
    assert.equal(program(w, relayerFee, bps, treasury) - DELIVERY_FEE, amount, `amount ${amount} bps ${bps}`);
    // and it is the smallest such withdraw for a treasury that always takes its fee
    if (!treasury) assert.notEqual(program(w - 1n, relayerFee, bps), amount + DELIVERY_FEE);
  }
  assert.throws(() => deliveryWithdraw(0n, 1n, 80));
});

const hop = Keypair.fromSeed(new Uint8Array(32).fill(1));
const to = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const authority = Keypair.fromSeed(new Uint8Array(32).fill(3));
const nonceAccount = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
const blockhash = bs58.encode(new Uint8Array(32).fill(5));
const nonce = bs58.encode(new Uint8Array(32).fill(6));
const lamports = 1_234_567_890n;

test("L1 is byte for byte the message Solana's own library writes, and a standard transfer", () => {
  const m = l1Message({ hop: hop.publicKey, to, lamports, blockhash });
  const ref = new Message({
    header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 2 },
    accountKeys: [hop.publicKey, to, SystemProgram.programId, ComputeBudgetProgram.programId],
    recentBlockhash: blockhash,
    instructions: [
      { programIdIndex: 3, accounts: [], data: bs58.encode(ComputeBudgetProgram.setComputeUnitLimit({ units: DELIVERY_CU }).data) },
      { programIdIndex: 3, accounts: [], data: bs58.encode(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DELIVERY_PRICE_L1 }).data) },
      { programIdIndex: 2, accounts: [0, 1], data: bs58.encode(SystemProgram.transfer({ fromPubkey: hop.publicKey, toPubkey: to, lamports }).data) },
    ],
  });
  assert.deepEqual(Buffer.from(m), ref.serialize());
  const tx = deliveryTransaction(m, [signDelivery(m, hop)]);
  assert.equal(tx.length, 267);
  const back = Transaction.from(tx);
  assert.equal(back.feePayer!.toBase58(), hop.publicKey.toBase58());
  assert.equal(back.verifySignatures(), true);
  assert.equal(back.instructions.length, 3);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(back.instructions[0]).units, DELIVERY_CU);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(back.instructions[1]).microLamports, BigInt(DELIVERY_PRICE_L1));
  const t = SystemInstruction.decodeTransfer(back.instructions[2]);
  assert.equal(t.fromPubkey.toBase58(), hop.publicKey.toBase58());
  assert.equal(t.toPubkey.toBase58(), to.toBase58());
  assert.equal(t.lamports, lamports);
  // the same transaction built the ordinary way has the same bytes
  const built = new Transaction({ feePayer: hop.publicKey, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: DELIVERY_CU }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DELIVERY_PRICE_L1 }),
    SystemProgram.transfer({ fromPubkey: hop.publicKey, toPubkey: to, lamports }),
  );
  assert.deepEqual(built.serializeMessage(), Buffer.from(m));
});

test("N2 is the same transfer on a durable nonce, with the nonce authority signing read-only", () => {
  const f = { hop: hop.publicKey, to, lamports, nonceAccount, authority: authority.publicKey, nonce };
  const m = n2Message(f);
  const ref = new Message({
    header: { numRequiredSignatures: 2, numReadonlySignedAccounts: 1, numReadonlyUnsignedAccounts: 3 },
    accountKeys: [hop.publicKey, authority.publicKey, nonceAccount, to, SystemProgram.programId, SYSVAR_RECENT_BLOCKHASHES_PUBKEY, ComputeBudgetProgram.programId],
    recentBlockhash: nonce,
    instructions: [
      { programIdIndex: 4, accounts: [2, 5, 1], data: bs58.encode(SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: authority.publicKey }).data) },
      { programIdIndex: 6, accounts: [], data: bs58.encode(ComputeBudgetProgram.setComputeUnitLimit({ units: DELIVERY_CU }).data) },
      { programIdIndex: 6, accounts: [], data: bs58.encode(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: DELIVERY_PRICE_N2 }).data) },
      { programIdIndex: 4, accounts: [0, 3], data: bs58.encode(SystemProgram.transfer({ fromPubkey: hop.publicKey, toPubkey: to, lamports }).data) },
    ],
  });
  assert.deepEqual(Buffer.from(m), ref.serialize());
  const tx = deliveryTransaction(m, [signDelivery(m, hop), signDelivery(m, authority)]);
  assert.equal(tx.length, 437);
  const back = Transaction.from(tx);
  assert.equal(back.verifySignatures(), true);
  assert.equal(back.feePayer!.toBase58(), hop.publicKey.toBase58());
  const adv = SystemInstruction.decodeNonceAdvance(back.instructions[0]);
  assert.equal(adv.noncePubkey.toBase58(), nonceAccount.toBase58());
  assert.equal(adv.authorizedPubkey.toBase58(), authority.publicKey.toBase58());
  const t = SystemInstruction.decodeTransfer(back.instructions[3]);
  assert.equal(t.toPubkey.toBase58(), to.toBase58());
  assert.equal(t.lamports, lamports);
  const msg = Message.from(m);
  assert.equal(msg.isAccountWritable(1), false, "the nonce authority can't be debited");
  assert.equal(msg.isAccountSigner(1), true);
  assert.throws(() => deliveryTransaction(m, [signDelivery(m, hop)]), /number of signatures/);
});

test("a delivery signature covers every byte: any change at all fails it", () => {
  for (const m of [l1Message({ hop: hop.publicKey, to, lamports, blockhash }), n2Message({ hop: hop.publicKey, to, lamports, nonceAccount, authority: authority.publicKey, nonce })]) {
    const sig = signDelivery(m, hop);
    assert.equal(verifyDelivery(m, sig, hop.publicKey), true);
    assert.equal(verifyDelivery(m, sig, to), false, "someone else's key");
    for (let i = 0; i < m.length; i++) {
      const bad = m.slice();
      bad[i] ^= 1 << (i % 8);
      assert.equal(verifyDelivery(bad, sig, hop.publicKey), false, `byte ${i}`);
    }
    assert.equal(verifyDelivery(m, sig.slice(0, 63), hop.publicKey), false);
    assert.equal(verifyDelivery(m, new Uint8Array(64), hop.publicKey), false);
  }
  // a different recipient or amount is a different message
  const sig = signDelivery(l1Message({ hop: hop.publicKey, to, lamports, blockhash }), hop);
  assert.equal(verifyDelivery(l1Message({ hop: hop.publicKey, to: authority.publicKey, lamports, blockhash }), sig, hop.publicKey), false);
  assert.equal(verifyDelivery(l1Message({ hop: hop.publicKey, to, lamports: lamports + 1n, blockhash }), sig, hop.publicKey), false);
});

test("a delivery never names one address twice, nor sends nothing", () => {
  assert.throws(() => l1Message({ hop: hop.publicKey, to: hop.publicKey, lamports, blockhash }), /twice/);
  assert.throws(() => n2Message({ hop: hop.publicKey, to: nonceAccount, lamports, nonceAccount, authority: authority.publicKey, nonce }), /twice/);
  assert.throws(() => l1Message({ hop: hop.publicKey, to: SystemProgram.programId, lamports, blockhash }), /twice/);
  assert.throws(() => l1Message({ hop: hop.publicKey, to, lamports: 0n, blockhash }), /amount/);
  assert.throws(() => l1Message({ hop: hop.publicKey, to, lamports, blockhash: "abc" }), /blockhash/);
});

test("a nonce account is read only when initialized", () => {
  const data = new Uint8Array(80);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 1, true);
  data.set(authority.publicKey.toBytes(), 8);
  data.set(bs58.decode(nonce), 40);
  assert.deepEqual(readNonceAccount(data), { authority: authority.publicKey, nonce });
  dv.setUint32(4, 0, true);
  assert.equal(readNonceAccount(data), null, "uninitialized");
  assert.equal(readNonceAccount(new Uint8Array(81)), null);
});

test("recipients: wallets go, addresses only a program signs for are confirmed, the rest never", () => {
  const sys = SystemProgram.programId;
  const wallet = Keypair.generate().publicKey;
  const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], sys)[0];
  assert.equal(PublicKey.isOnCurve(pda.toBytes()), false);
  const acct = (o: Partial<{ owner: PublicKey | string; executable: boolean; lamports: number; dataLength: number }>) => ({ owner: sys, executable: false, lamports: 5_000_000, dataLength: 0, ...o });
  const table: [PublicKey, Parameters<typeof classifyRecipient>[1], string, string][] = [
    [wallet, null, "new", "ok"],
    [wallet, acct({ lamports: 0 }), "new", "ok"],
    [pda, null, "new-off-curve", "confirm"],
    [wallet, acct({}), "wallet", "ok"],
    [pda, acct({}), "off-curve", "confirm"],
    [wallet, acct({ dataLength: 80 }), "nonce-account", "blocked"],
    [wallet, acct({ dataLength: 10 }), "program-owned", "blocked"],
    [wallet, acct({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", dataLength: 165 }), "token-account", "blocked"],
    [wallet, acct({ owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", dataLength: 170 }), "token-account", "blocked"],
    [wallet, acct({ executable: true, owner: "BPFLoaderUpgradeab1e11111111111111111111111" }), "program", "blocked"],
    [wallet, acct({ owner: "Stake11111111111111111111111111111111111111", dataLength: 200 }), "program-owned", "blocked"],
    [sys, acct({ executable: true, owner: "NativeLoader1111111111111111111111111111111" }), "reserved", "blocked"],
    [new PublicKey("SysvarRent111111111111111111111111111111111"), acct({}), "reserved", "blocked"],
  ];
  for (const [address, a, cls, verdict] of table) {
    const c = classifyRecipient(address, a);
    assert.equal(c, cls, address.toBase58());
    assert.equal(recipientVerdict(c), verdict);
  }
  assert.equal(classifyRecipient(wallet, acct({}), new Set([wallet.toBase58()])), "reserved", "the pool's own addresses");
  // every reserved address is a real one
  for (const a of RESERVED_ADDRESSES) assert.equal(new PublicKey(a).toBase58(), a);
});

test("a lookalike of a recent recipient is caught; the same address isn't", () => {
  const real = "HtrDenLfTjEJingoFDKuLcQUibrMsb8cbNSgKWY7z8FE";
  const fake = "HtrDzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz8FE";
  assert.equal(lookalike(fake, [real]), real);
  assert.equal(lookalike(real, [real]), null);
  assert.equal(lookalike(real, ["9h2nojgAzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"]), null);
});

test("an own-wallet proof is the wallet's signature over the spend's notes and its own address", () => {
  const w = Keypair.generate();
  const nfs = ["0a".repeat(32), "0b".repeat(32)] as const;
  const m = ownMessage(nfs, w.publicKey);
  assert.equal(m.length, 9 + 64 + 32);
  const sig = ed25519.sign(m, w.secretKey.slice(0, 32));
  assert.equal(verifyDelivery(m, sig, w.publicKey), true);
  assert.equal(verifyDelivery(ownMessage(["0a".repeat(32), "0c".repeat(32)], w.publicKey), sig, w.publicKey), false, "another spend");
  assert.notDeepEqual(hopLookupMessage(w.publicKey, 1), hopLookupMessage(w.publicKey, 2));
  assert.throws(() => ownMessage(["0a".repeat(32)], w.publicKey));
});

test("random keys and amounts always give a message the library reads back the same", () => {
  for (let i = 0; i < 200; i++) {
    const h = Keypair.generate();
    const t = Keypair.generate().publicKey;
    const lam = 1n + rnd(1n << 63n);
    const m = l1Message({ hop: h.publicKey, to: t, lamports: lam, blockhash: bs58.encode(randomMaster()) });
    const back = Transaction.populate(Message.from(m));
    assert.equal(SystemInstruction.decodeTransfer(back.instructions[2]).lamports, lam);
  }
});
