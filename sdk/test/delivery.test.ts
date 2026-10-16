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
  VersionedMessage,
  VersionedTransaction,
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
  RUNTIME_RESERVED_KEYS,
  lookalike,
  ownMessage,
  hopLookupMessage,
  sameDeliveryTerms,
  DELIVERY_V,
  FIXED_SHAPE,
  SHAPE_BAND,
  priceFor,
  shapeOk,
  randomShape,
  readShape,
  shapeJson,
  type DeliveryShape,
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
  // all 31 of the runtime's reserved keys are refused (a delivery to one could never land)
  assert.equal(new Set(RUNTIME_RESERVED_KEYS).size, 31);
  for (const a of RUNTIME_RESERVED_KEYS) {
    assert.ok(RESERVED_ADDRESSES.includes(a), a);
    assert.equal(classifyRecipient(new PublicKey(a), null), "reserved", a);
  }
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

// ─── shapes the sender picks ───

/** The compute limit and price a message asks for, and its format, read back by Solana's own library. */
function budgetOf(m: Uint8Array) {
  const msg = VersionedMessage.deserialize(m);
  const keys = msg.staticAccountKeys;
  let units = 0;
  let price = 0n;
  for (const ix of msg.compiledInstructions) {
    if (!keys[ix.programIdIndex].equals(ComputeBudgetProgram.programId)) continue;
    if (ix.data[0] === 2) units = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(1, true);
    if (ix.data[0] === 3) price = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(1, true);
  }
  return { msg, units, price };
}

test("a delivery that names no shape is the fixed one, byte for byte, and naming the fixed shape changes nothing", () => {
  const l1 = { hop: hop.publicKey, to, lamports, blockhash };
  const n2 = { hop: hop.publicKey, to, lamports, nonceAccount, authority: authority.publicKey, nonce };
  assert.deepEqual(l1Message({ ...l1, shape: FIXED_SHAPE }), l1Message(l1));
  assert.deepEqual(n2Message({ ...n2, shape: FIXED_SHAPE }), n2Message(n2));
  assert.equal(priceFor(DELIVERY_CU, DELIVERY_FEE - 5_000n), DELIVERY_PRICE_L1);
  assert.equal(priceFor(DELIVERY_CU, DELIVERY_FEE - 10_000n), DELIVERY_PRICE_N2);
  assert.equal(shapeOk(FIXED_SHAPE), true);
});

test("every shape in the band costs the hop exactly its fee, for L1 and N2 alike", () => {
  let x = 7;
  const rand = () => {
    x = (x * 48271) % 2147483647;
    return x / 2147483647;
  };
  const seenV0 = new Set<boolean>();
  for (let i = 0; i < 2_000; i++) {
    const s = randomShape(rand);
    assert.ok(shapeOk(s), JSON.stringify(shapeJson(s)));
    seenV0.add(s.v0);
    const a = budgetOf(l1Message({ hop: hop.publicKey, to, lamports, blockhash, shape: s }));
    assert.equal(a.units, s.cuL1);
    assert.equal(deliveryFeeOf(1, Number(a.price), a.units), s.fee, `L1 ${JSON.stringify(shapeJson(s))}`);
    const b = budgetOf(n2Message({ hop: hop.publicKey, to, lamports, nonceAccount, authority: authority.publicKey, nonce, shape: s }));
    assert.equal(b.units, s.cuN2);
    assert.equal(deliveryFeeOf(2, Number(b.price), b.units), s.fee, `N2 ${JSON.stringify(shapeJson(s))}`);
    assert.equal(a.msg.version === 0, s.v0);
  }
  assert.equal(seenV0.size, 2, "both formats are drawn");
  // the band's edges, every limit in it
  for (let cu = SHAPE_BAND.cuMin; cu <= SHAPE_BAND.cuMax; cu += 37) {
    for (const fee of [SHAPE_BAND.feeMin, 12_345n, SHAPE_BAND.feeMax]) {
      assert.equal(deliveryFeeOf(1, priceFor(cu, fee - 5_000n), cu), fee);
      assert.equal(deliveryFeeOf(2, priceFor(cu, fee - 10_000n), cu), fee);
    }
  }
});

test("a v0 delivery is the same transfer, read back by Solana's own library, and a hop's signature over it holds", () => {
  const s: DeliveryShape = { fee: 15_000n, cuL1: 3_000, cuN2: 4_200, v0: true };
  const m = l1Message({ hop: hop.publicKey, to, lamports, blockhash, shape: s });
  const msg = VersionedMessage.deserialize(m);
  assert.equal(msg.version, 0);
  assert.deepEqual(Buffer.from(msg.serialize()), Buffer.from(m), "round trip");
  assert.deepEqual(msg.addressTableLookups, []);
  assert.deepEqual(msg.staticAccountKeys.map((k) => k.toBase58()), [hop.publicKey, to, SystemProgram.programId, ComputeBudgetProgram.programId].map((k) => k.toBase58()));
  assert.equal(msg.recentBlockhash, blockhash);
  const raw = deliveryTransaction(m, [signDelivery(m, hop)]);
  const tx = VersionedTransaction.deserialize(raw);
  assert.equal(ed25519.verify(tx.signatures[0], tx.message.serialize(), hop.publicKey.toBytes()), true);
  const transfer = tx.message.compiledInstructions[2];
  assert.deepEqual(Buffer.from(transfer.data), SystemProgram.transfer({ fromPubkey: hop.publicKey, toPubkey: to, lamports }).data);
  // N2 as v0: the nonce advance first, the authority a read-only signer
  const n = n2Message({ hop: hop.publicKey, to, lamports, nonceAccount, authority: authority.publicKey, nonce, shape: s });
  const nm = VersionedMessage.deserialize(n);
  assert.equal(nm.version, 0);
  assert.equal(nm.recentBlockhash, nonce);
  assert.equal(nm.isAccountSigner(1) && !nm.isAccountWritable(1), true);
  const ntx = VersionedTransaction.deserialize(deliveryTransaction(n, [signDelivery(n, hop), signDelivery(n, authority)]));
  assert.equal(ntx.signatures.length, 2);
  assert.throws(() => deliveryTransaction(n, [signDelivery(n, hop)]), /number of signatures/);
  // a v0 message and the legacy one sign different bytes
  assert.notDeepEqual(l1Message({ hop: hop.publicKey, to, lamports, blockhash, shape: { ...s, v0: false } }), m);
});

test("shapes outside the band are refused, on the wire and when building", () => {
  const ok = { fee: "15000", cuL1: 3000, cuN2: 3000, v0: false };
  assert.deepEqual(readShape(ok), { fee: 15_000n, cuL1: 3000, cuN2: 3000, v0: false });
  assert.equal(readShape(undefined), undefined);
  for (const bad of [
    { ...ok, fee: "10999" },
    { ...ok, fee: "30001" },
    { ...ok, fee: 15000 },
    { ...ok, cuL1: 1199 },
    { ...ok, cuN2: 8001 },
    { ...ok, cuL1: 2000.5 },
    { ...ok, v0: "yes" },
    { ...ok, fee: "1e5" },
    "15000",
  ]) {
    assert.throws(() => readShape(bad), /bad delivery shape/, JSON.stringify(bad));
  }
  assert.throws(() => l1Message({ hop: hop.publicKey, to, lamports, blockhash, shape: { fee: 50_000n, cuL1: 3000, cuN2: 3000, v0: false } }), /bad delivery shape/);
  // the withdraw follows the shape's fee
  const w = deliveryWithdraw(1_000_000n, 1_500_000n, 80, undefined, 15_000n);
  assert.equal(predictCredit(w, 1_500_000n, 80), 1_015_000n);
});
