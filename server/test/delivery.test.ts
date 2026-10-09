import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, MessageV0, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";

// a relayer of its own and nothing from .env: every chain call below is answered by the fake chain
const dir = mkdtempSync(join(tmpdir(), "vs-delivery-"));
const relayerKp = Keypair.fromSeed(new Uint8Array(32).fill(21));
Object.assign(process.env, {
  VISIONSWAP_CONFIG: "",
  NETWORK: "localnet",
  RPC_URL: "http://127.0.0.1:9",
  RPC_FALLBACK_URL: "",
  RELAYER_SECRET: JSON.stringify([...relayerKp.secretKey]),
  GUARD_SECRET: "",
  RANGE_API_KEY: "",
  BLOCKED_ADDRESSES: "",
  DATA_DIR: dir,
  STATE_STORE: "disk",
  PRIORITY_MICROLAMPORTS: "20000",
  RELAYER_MARGIN_LAMPORTS: "150000",
  DELIVERY_NONCE: "on",
});
after(() => rmSync(dir, { recursive: true, force: true }));

const sdk = await import("@visionswap/sdk");
const { config } = await import("../src/config.ts");
const { conn, pool } = await import("../src/chain.ts");
const { relay, cleanBody, routeOf, cleanDelivery } = await import("../src/relayer.ts");
const { hops } = await import("../src/hops.ts");
const { nonces, nonceAddress, sendOwner } = await import("../src/nonces.ts");
const { sendRefusal, inspectSend } = await import("../src/rpc.ts");
const { HopLedger, lookGap, seenMonth, seenMonths, KEEP_SEEN_MS } = await import("../src/hops.ts");
const { l1Message, n2Message, signDelivery, ownMessage, hopLookupMessage, deliveryWithdraw, DELIVERY_FEE, ACCOUNT_DISC, toLE, concat, toBE } = sdk;

const N = config.nonceAuthority!;
const treasury = Keypair.generate().publicKey;
const SYSTEM = SystemProgram.programId;
const FEE_BPS = 80;

// ─── a fake chain ───

type Acct = { lamports: bigint; owner: PublicKey; data: Uint8Array; executable: boolean };
const ledger = new Map<string, Acct>();
const sigStatus = new Map<string, "confirmed" | "failed">();
/** every transaction sent or simulated, decoded: who signed it (blank slots left out) and its instructions */
const seen: { kind: "send" | "simulate"; tx: VersionedTransaction }[] = [];
const fake = {
  /** what TX1 pays its recipient (null: what the program would) */
  credit: null as bigint | null,
  /** lamports someone sends the hop right after TX1 */
  dust: 0n,
  /** whether a blockhash counts as valid (`l1After`: once TX1 has landed) */
  l1Valid: true,
  l1After: true,
  tx2Ok: true,
  blockhash: bs58.encode(randomBytes(32)),
};
const put = (k: PublicKey | string, a: Partial<Acct>) => ledger.set(String(k), { lamports: 0n, owner: SYSTEM, data: new Uint8Array(), executable: false, ...a });
const bal = (k: PublicKey | string) => ledger.get(String(k))?.lamports ?? 0n;
function nonceData(value: string) {
  const d = new Uint8Array(80);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 1, true);
  d.set(N.publicKey.toBytes(), 8);
  d.set(bs58.decode(value), 40);
  return d;
}
function configData() {
  const u64 = (n: bigint) => toLE(n, 8);
  return concat(
    ACCOUNT_DISC.Config,
    Keypair.generate().publicKey.toBytes(),
    new Uint8Array(32),
    Keypair.generate().publicKey.toBytes(),
    treasury.toBytes(),
    toLE(BigInt(FEE_BPS), 2),
    u64(1_000_000n),
    u64(100_000_000_000n),
    u64(0n),
    u64(0n),
    Uint8Array.of(0, 0, 255, 254),
  );
}
const ROOT = 12345n;
function treeData() {
  const roots = new Uint8Array(256 * 32);
  roots.set(toBE(ROOT, 32), 0);
  return concat(ACCOUNT_DISC.Tree, new Uint8Array(40), new Uint8Array(24 + 26 * 32), roots);
}
put(pool.config, { lamports: 1n, owner: pool.programId, data: configData() });
put(pool.tree, { lamports: 1n, owner: pool.programId, data: treeData() });
put(relayerKp.publicKey, { lamports: 10_000_000_000n });
put(treasury, { lamports: 5_000_000n });

const info = (k: PublicKey) => {
  const a = ledger.get(k.toBase58());
  return a && a.lamports > 0n ? { lamports: Number(a.lamports), owner: a.owner, data: Buffer.from(a.data), executable: a.executable, rentEpoch: 0 } : null;
};
const sigOf = (raw: Uint8Array) => bs58.encode(raw.slice(1, 65));
const transactDisc = (await import("@noble/hashes/sha2.js")).sha256(new TextEncoder().encode("global:transact")).slice(0, 8);
const isTransact = (m: VersionedTransaction["message"], ix: { programIdIndex: number; data: Uint8Array }) =>
  m.staticAccountKeys[ix.programIdIndex].equals(pool.programId) && transactDisc.every((b, i) => ix.data[i] === b);

/** Runs a sent transaction the way the chain would, as far as these tests need. */
function apply(raw: Uint8Array) {
  const tx = VersionedTransaction.deserialize(raw);
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const sig = sigOf(raw);
  if (sigStatus.has(sig)) return;
  for (const ix of m.compiledInstructions) {
    const prog = keys[ix.programIdIndex];
    if (isTransact(m, ix)) {
      const data = ix.data;
      const withdraw = new DataView(data.buffer, data.byteOffset).getBigUint64(8 + 256 + 160, true);
      const fee = new DataView(data.buffer, data.byteOffset).getBigUint64(8 + 256 + 168, true);
      const recipient = keys[ix.accountKeyIndexes[1]];
      const credit = fake.credit ?? sdk.predictCredit(withdraw, fee, FEE_BPS);
      put(recipient, { lamports: bal(recipient) + credit + fake.dust });
      if (!fake.l1After) fake.l1Valid = false;
    } else if (prog.equals(SYSTEM)) {
      const type = new DataView(ix.data.buffer, ix.data.byteOffset).getUint32(0, true);
      if (type === 2) {
        const lamports = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(4, true);
        const [from, to] = ix.accountKeyIndexes.map((i) => keys[i]);
        put(from, { lamports: bal(from) - lamports - DELIVERY_FEE });
        const t = ledger.get(to.toBase58());
        put(to, { ...t, lamports: (t?.lamports ?? 0n) + lamports });
      }
      if (type === 4) {
        const acct = keys[ix.accountKeyIndexes[0]];
        put(acct, { lamports: bal(acct), data: nonceData(bs58.encode(randomBytes(32))) });
      }
    }
  }
  sigStatus.set(sig, "confirmed");
}

const c = conn as unknown as Record<string, unknown>;
c.getMinimumBalanceForRentExemption = async (n: number) => (n + 128) * 6960;
c.getAccountInfo = async (k: PublicKey) => info(k);
c.getMultipleAccountsInfo = async (ks: PublicKey[]) => ks.map(info);
c.getBalance = async (k: PublicKey) => Number(bal(k));
c.getLatestBlockhash = async () => ({ blockhash: fake.blockhash, lastValidBlockHeight: 1000 });
c.getBlockHeight = async () => 500;
c.isBlockhashValid = async () => ({ context: { slot: 1 }, value: fake.l1Valid });
c.getSignaturesForAddress = async () => [];
c.getSignatureStatuses = async (sigs: string[]) => ({ context: { slot: 1 }, value: sigs.map((s) => (sigStatus.has(s) ? { slot: 1, confirmations: 1, err: sigStatus.get(s) === "failed" ? {} : null, confirmationStatus: "confirmed" } : null)) });
c.getTransaction = async () => null;
/** a transaction as getTransaction answers it: paid for by `payer`, holding a standard SOL transfer from it to `to` when given */
const paidBy = (payer: PublicKey, to?: PublicKey) => {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  return {
    meta: { err: null },
    transaction: { message: { staticAccountKeys: to ? [payer, to, SystemProgram.programId] : [payer], compiledInstructions: to ? [{ programIdIndex: 2, accountKeyIndexes: [0, 1], data }] : [] } },
  };
};
c.sendRawTransaction = async (raw: Uint8Array) => {
  seen.push({ kind: "send", tx: VersionedTransaction.deserialize(raw) });
  apply(raw);
  return sigOf(raw);
};
c.simulateTransaction = async (tx: Transaction | VersionedTransaction, _o?: unknown, accounts?: PublicKey[]) => {
  const v = tx instanceof VersionedTransaction ? tx : VersionedTransaction.deserialize(tx.serialize({ requireAllSignatures: false }));
  seen.push({ kind: "simulate", tx: v });
  if (tx instanceof VersionedTransaction) return { context: { slot: 1 }, value: { err: fake.tx2Ok ? null : { InstructionError: [3, "Custom"] }, logs: [] } };
  // TX1: what its recipient would hold afterwards
  const m = v.message;
  const ix = m.compiledInstructions.find((i) => isTransact(m, i))!;
  const withdraw = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(8 + 256 + 160, true);
  const fee = new DataView(ix.data.buffer, ix.data.byteOffset).getBigUint64(8 + 256 + 168, true);
  const credit = fake.credit ?? sdk.predictCredit(withdraw, fee, FEE_BPS);
  return {
    context: { slot: 1 },
    value: { err: null, logs: [], accounts: accounts ? accounts.map((a) => ({ lamports: Number(bal(a) + credit), owner: SYSTEM.toBase58(), data: ["", "base64"], executable: false })) : null },
  };
};

// ─── payments ───

const relayerFee = 2_100_000n;
const hex = () => randomBytes(32).toString("hex");
function request(recipient: PublicKey, withdraw: bigint, fee = relayerFee, nullifiers = [hex(), hex()]) {
  return {
    proof: Buffer.alloc(256, 1).toString("base64"),
    root: toBE(ROOT, 32).reduce((s, b) => s + b.toString(16).padStart(2, "0"), ""),
    nullifiers,
    commitments: [hex(), hex()],
    recipient: recipient.toBase58(),
    withdraw: withdraw.toString(),
    relayerFee: fee.toString(),
    maxFeeBps: FEE_BPS,
    meta0: Buffer.alloc(28, 2).toString("base64"),
    meta1: Buffer.alloc(28, 3).toString("base64"),
  };
}

/** A payment of `amount` to `to` through a fresh hop, signed for L1 and (with a lease) N2. */
function payment(
  to: PublicKey,
  amount: bigint,
  o: { lease?: { leaseId?: string; account: string; value: string }; l1?: boolean; signer?: Keypair; offCurveOk?: boolean; nullifiers?: string[] } = {},
) {
  const hop = Keypair.generate();
  const signer = o.signer ?? hop;
  const req = request(hop.publicKey, deliveryWithdraw(amount, relayerFee, FEE_BPS), relayerFee, o.nullifiers);
  const delivery: Record<string, unknown> = { to: to.toBase58(), amount: amount.toString() };
  if (o.l1 !== false) {
    delivery.blockhash = fake.blockhash;
    delivery.l1 = bs58.encode(signDelivery(l1Message({ hop: hop.publicKey, to, lamports: amount, blockhash: fake.blockhash }), signer));
  }
  if (o.lease) {
    delivery.leaseId = o.lease.leaseId;
    delivery.n2 = bs58.encode(signDelivery(n2Message({ hop: hop.publicKey, to, lamports: amount, nonceAccount: new PublicKey(o.lease.account), authority: N.publicKey, nonce: o.lease.value }), signer));
  }
  if (o.offCurveOk) delivery.offCurveOk = true;
  return { hop, body: { v: 2, request: req, delivery } };
}

/** Adds free nonces to the pool (and the chain). */
function stockNonces(n: number) {
  const recs = JSON.parse(nonces.serialize()) as { next: number; recs: object[] };
  for (let i = 0; i < n; i++) {
    const k = recs.next + i;
    const account = nonceAddress(N.publicKey, k).toBase58();
    const value = bs58.encode(randomBytes(32));
    put(account, { lamports: 1_447_680n, data: nonceData(value) });
    recs.recs.push({ account, n: k, value, advancedAt: 0, state: "free" });
  }
  recs.next += n;
  nonces.adopt(JSON.stringify(recs));
}
stockNonces(6);
hops.loaded = true;

const reason = (e: unknown) => {
  const x = e as { status?: number; code?: string; message?: string };
  return `${x.status} ${x.code ?? ""} ${x.message}`;
};
const sends = () => seen.filter((s) => s.kind === "send").length;

/** Who signed (non-blank signatures) */
const signers = (tx: VersionedTransaction) => tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).filter((_, i) => tx.signatures[i].some((b) => b)).map((k) => k.toBase58());

// ─── tests ───

test("a payment to an outside address arrives as a standard transfer from its one-time hop", async () => {
  const to = Keypair.generate().publicKey;
  const amount = 250_000_000n;
  const { hop, body } = payment(to, amount);
  const before = seen.length;
  const res = await relay(cleanBody(body));
  assert.equal(res.delivery?.status, "delivered", JSON.stringify(res));
  assert.equal(bal(to), amount, "exactly the amount");
  assert.equal(bal(hop.publicKey), 0n, "the hop ends at zero");
  const sent = seen.slice(before).filter((s) => s.kind === "send").map((s) => s.tx);
  assert.equal(sent.length, 2);
  const [tx1, tx2] = sent;
  assert.equal(tx1.message.staticAccountKeys.some((k) => k.equals(to)), false, "the recipient isn't in the pool payment");
  assert.deepEqual(signers(tx1), [relayerKp.publicKey.toBase58()]);
  assert.deepEqual(signers(tx2), [hop.publicKey.toBase58()], "the hop alone signs and pays");
  assert.equal(tx2.message.version, "legacy");
  assert.equal(res.delivery?.signature, bs58.encode(tx2.signatures[0]));
  assert.equal(hops.get(hop.publicKey.toBase58())?.status, "delivered");
});

test("when the blockhash has run out by the time the pool payment lands, the nonce delivery goes, signed read-only by N", async () => {
  const to = Keypair.generate().publicKey;
  const amount = 300_000_000n;
  const nullifiers = [hex(), hex()];
  const lease = nonces.lease({ owner: sendOwner(nullifiers), ttlMs: 60_000, scheduled: false })!;
  const value = lease.value;
  const { hop, body } = payment(to, amount, { lease: { leaseId: lease.leaseId, account: lease.account, value }, nullifiers });
  fake.l1After = false;
  try {
    const before = seen.length;
    const res = await relay(cleanBody(body));
    assert.equal(res.delivery?.status, "delivered", JSON.stringify(res));
    assert.equal(bal(to), amount);
    assert.equal(bal(hop.publicKey), 0n);
    const tx2 = seen.slice(before).filter((s) => s.kind === "send").map((s) => s.tx)[1];
    assert.deepEqual(signers(tx2), [hop.publicKey.toBase58(), N.publicKey.toBase58()]);
    assert.equal(tx2.message.isAccountWritable(1), false, "N is read-only");
    assert.equal(tx2.message.recentBlockhash, value, "on the nonce");
    // the nonce moved on with the delivery: once that's final it is free for another payment
    assert.ok(["exposed", "retiring"].includes(nonces.recs.get(lease.account)!.state));
  } finally {
    fake.l1After = true;
    fake.l1Valid = true;
  }
});

test("a pool fee that changed since the proof is refused before anything is sent, as stale", async () => {
  const to = Keypair.generate().publicKey;
  const { hop, body } = payment(to, 200_000_000n);
  fake.credit = 200_000_000n + DELIVERY_FEE + 1_000n;
  try {
    const before = sends();
    await assert.rejects(relay(cleanBody(body)), (e: { status?: number; code?: string; credit?: string }) => e.status === 409 && e.code === "stale" && e.credit === String(200_000_000n + DELIVERY_FEE + 1_000n));
    assert.equal(sends(), before, "nothing sent");
    assert.notEqual(hops.get(hop.publicKey.toBase58())?.status, "sending");
    // the notes are free again: the same proof can be tried once the fee is right
    fake.credit = null;
    const res = await relay(cleanBody(body));
    assert.equal(res.delivery?.status, "delivered");
  } finally {
    fake.credit = null;
  }
});

test("a delivery that can't be written down first is never sent", async () => {
  const to = Keypair.generate().publicKey;
  const { body } = payment(to, 200_000_000n);
  const io = (hops as unknown as { io: { saveNow: () => Promise<void> } }).io;
  const real = io.saveNow;
  io.saveNow = async () => {
    throw new Error("disk full");
  };
  try {
    const before = sends();
    await assert.rejects(relay(cleanBody(body)), (e: { status?: number; code?: string }) => e.status === 503 && e.code === "not_sent");
    assert.equal(sends(), before);
  } finally {
    io.saveNow = real;
  }
});

test("a hop sent a little extra between the two steps waits for its owner's app, which sends it all on", async () => {
  const to = Keypair.generate().publicKey;
  const nullifiers = [hex(), hex()];
  const lease = nonces.lease({ owner: sendOwner(nullifiers), ttlMs: 60_000, scheduled: false })!;
  const { hop, body } = payment(to, 200_000_000n, { lease: { leaseId: lease.leaseId, account: lease.account, value: lease.value }, nullifiers });
  fake.dust = 5_000n;
  try {
    const before = sends();
    const res = await relay(cleanBody(body));
    assert.equal(res.delivery?.status, "waiting");
    assert.equal(sends(), before + 1, "only the pool payment: no delivery of the wrong amount");
    assert.equal(bal(hop.publicKey), 200_000_000n + DELIVERY_FEE + 5_000n);
    assert.equal(nonces.recs.get(lease.account)!.state, "free", "its nonce, never exposed, is free again");
    // the owner's app finishes it, and a poisoning bot sends the emptied hop a few lamports: its own transfer is the delivery
    put(hop.publicKey, { lamports: 7n });
    c.getSignaturesForAddress = async () => [
      { signature: "DustSig11", err: null },
      { signature: "AppSig111", err: null },
    ];
    c.getTransaction = async (s: string) => (s === "AppSig111" ? paidBy(hop.publicKey, to) : s === "DustSig11" ? paidBy(Keypair.generate().publicKey) : null);
    await hops.tick();
    assert.equal(hops.get(hop.publicKey.toBase58())?.status, "delivered");
    assert.equal(hops.get(hop.publicKey.toBase58())?.delivered, "AppSig111", "the hop's own transfer, never the dust sent to it");
  } finally {
    fake.dust = 0n;
    c.getSignaturesForAddress = async () => [];
    c.getTransaction = async () => null;
  }
});

test("a delivery cut short after its pool payment landed is finished by the finisher", async () => {
  const to = Keypair.generate().publicKey;
  const amount = 150_000_000n;
  const hop = Keypair.generate();
  const tx1 = bs58.encode(randomBytes(64));
  const l1 = bs58.encode(signDelivery(l1Message({ hop: hop.publicKey, to, lamports: amount, blockhash: fake.blockhash }), hop));
  await hops.begin({
    hop: hop.publicKey.toBase58(),
    to: to.toBase58(),
    amount: amount.toString(),
    nullifiers: [hex(), hex()],
    commitments: [hex(), hex()],
    l1: { blockhash: fake.blockhash, sig: l1 },
    tx1,
    lastValid: 1000,
  });
  // the server stopped here: the pool payment landed, nothing more happened
  hops.unsettled(hop.publicKey.toBase58());
  sigStatus.set(tx1, "confirmed");
  put(hop.publicKey, { lamports: amount + DELIVERY_FEE });
  await hops.tick();
  assert.equal(hops.get(hop.publicKey.toBase58())?.status, "delivered");
  assert.equal(bal(to), amount);
  assert.equal(bal(hop.publicKey), 0n);
});

test("refused before anything is sent: old pages, wrong routes, bad addresses and bad signatures", async () => {
  const to = Keypair.generate().publicKey;
  const relayer = relayerKp.publicKey;
  const check = async (body: unknown, want: RegExp, jobId?: string) => {
    const before = sends();
    await assert.rejects(relay(cleanBody(body), { dryRun: true, ...(jobId ? { jobId } : {}) }), (e) => want.test(reason(e)), `expected ${want}`);
    assert.equal(sends(), before);
  };
  const ok = payment(to, 200_000_000n);
  // a page from before deliveries: a bare request paying anyone but the relayer
  await check(ok.body.request, /^426 update_required/);
  await check({ v: 2, request: ok.body.request }, /^426 update_required/);
  // a cut or join pays only the relayer
  const join = request(relayer, relayerFee);
  assert.equal(routeOf(cleanBody(join), relayer), "fee");
  await check(request(to, relayerFee), /^400 .*names the relayer/);
  await check({ v: 2, request: join, delivery: ok.body.delivery }, /^400 .*Malformed/);
  // addresses
  const hopAt = (addr: PublicKey) => ({ v: 2, request: { ...ok.body.request, recipient: addr.toBase58() }, delivery: ok.body.delivery });
  await check(hopAt(treasury), /^400 .*Malformed/);
  await check(hopAt(N.publicKey), /^400 .*Malformed/);
  for (const bad of [relayer, treasury, pool.vault, N.publicKey, SYSTEM, new PublicKey(nonces.recs.keys().next().value!)]) {
    await check({ ...ok.body, delivery: { ...ok.body.delivery, to: bad.toBase58() } }, /^400 recipient/);
  }
  await check({ ...ok.body, delivery: { ...ok.body.delivery, to: ok.hop.publicKey.toBase58() } }, /^400 .*Malformed/);
  const otherHop = [...hops.recs.keys()][0];
  await check({ ...ok.body, delivery: { ...ok.body.delivery, to: otherHop } }, /^400 recipient .*one-time sending address/);
  // an amount that isn't what the proof pays (or a fee that moved on)
  await check({ ...ok.body, delivery: { ...ok.body.delivery, amount: "199999999" } }, /^409 stale/);
  // signatures: someone else's, or over another recipient
  const forged = payment(to, 200_000_000n, { signer: Keypair.generate() });
  await check(forged.body, /^409 stale/);
  const other = payment(Keypair.generate().publicKey, 200_000_000n);
  await check({ ...other.body, delivery: { ...other.body.delivery, to: to.toBase58() } }, /^409 stale/);
  await check({ ...ok.body, delivery: { to: to.toBase58(), amount: "200000000" } }, /^400 .*Malformed/);
  // a nonce the relayer doesn't hold, or another payment's
  const ghost = payment(to, 200_000_000n, { l1: false, lease: { leaseId: "ab".repeat(12), account: nonceAddress(N.publicKey, 0).toBase58(), value: bs58.encode(randomBytes(32)) } });
  await check(ghost.body, /^409 stale/);
  // a spare nonce leased to another payment sent now
  const spare = nonces.lease({ owner: sendOwner([hex(), hex()]), ttlMs: 60_000, scheduled: false })!;
  await check(payment(to, 200_000_000n, { lease: { leaseId: spare.leaseId, account: spare.account, value: spare.value } }).body, /^409 stale/);
  nonces.release(spare.leaseId);
  const jobLease = nonces.lease({ owner: "job:" + "cd".repeat(12), tokenHash: "x", ttlMs: 60_000, scheduled: true })!;
  const theirs = payment(to, 2_000_000_000n, { l1: false, lease: { leaseId: jobLease.leaseId, account: jobLease.account, value: jobLease.value } });
  await check(theirs.body, /^409 stale/, "ef".repeat(12));
  // a scheduled payment can't name a new address with less than the rent minimum
  await check(payment(to, 500_000n, { l1: false, lease: { leaseId: jobLease.leaseId, account: jobLease.account, value: jobLease.value } }).body, /^400 too_small/, "cd".repeat(12));
  // everything about it checks out: what is left is the proof itself (fake here)
  await check(ok.body, /^400 .*proof did not check out/);
  await check(theirs.body, /^400 .*proof did not check out/, "cd".repeat(12));
  nonces.release(jobLease.leaseId);
});

test("own wallets carry their own signature; nobody else's address can pass as one", async () => {
  const wallet = Keypair.generate();
  const req = request(wallet.publicKey, 300_000_000n);
  const own = (kp: Keypair) => ({ sig: bs58.encode(ed25519.sign(ownMessage(req.nullifiers, wallet.publicKey), kp.secretKey.slice(0, 32))) });
  await assert.rejects(relay(cleanBody({ v: 2, request: req, own: own(Keypair.generate()) }), { dryRun: true }), /signature didn't check out/);
  const before = seen.length;
  const res = await relay(cleanBody({ v: 2, request: req, own: own(wallet) }));
  assert.equal(res.delivery, undefined, "paid straight from the pool");
  assert.ok(bal(wallet.publicKey) > 0n);
  const tx1 = seen.slice(before).find((s) => s.kind === "send")!.tx;
  assert.ok(tx1.message.staticAccountKeys.some((k) => k.equals(wallet.publicKey)));
});

test("at send time: token accounts, programs and used hops are refused, and an address only a program signs for needs the sender's confirmation", async () => {
  const before = sends();
  const token = Keypair.generate().publicKey;
  put(token, { lamports: 2_039_280n, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), data: new Uint8Array(165) });
  await assert.rejects(relay(cleanBody(payment(token, 200_000_000n).body)), (e) => /^400 recipient .*token account/.test(reason(e)));
  const prog = Keypair.generate().publicKey;
  put(prog, { lamports: 1_000_000n, owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), data: new Uint8Array(36), executable: true });
  await assert.rejects(relay(cleanBody(payment(prog, 200_000_000n).body)), (e) => /^400 recipient .*program/.test(reason(e)));
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault")], Keypair.generate().publicKey)[0];
  await assert.rejects(relay(cleanBody(payment(vault, 200_000_000n).body)), (e) => /^400 confirm_recipient/.test(reason(e)));
  const fresh = Keypair.generate().publicKey;
  await assert.rejects(relay(cleanBody(payment(fresh, 500_000n).body)), (e) => /^400 too_small/.test(reason(e)), "a new address needs the rent minimum");
  const used = payment(Keypair.generate().publicKey, 200_000_000n);
  put(used.hop.publicKey, { lamports: 1n });
  await assert.rejects(relay(cleanBody(used.body)), (e) => /^409 stale/.test(reason(e)), "a hop that already holds something");
  assert.equal(sends(), before, "nothing sent for any of them");
  const confirmed = await relay(cleanBody(payment(vault, 200_000_000n, { offCurveOk: true }).body));
  assert.equal(confirmed.delivery?.status, "delivered");
  assert.equal(bal(vault), 200_000_000n);
});

test("a hop's own delivery can be looked up with the hop's signature only, and only lately", () => {
  const rec = [...hops.recs.values()].find((r) => r.status === "delivered")!;
  // the hop keys of these tests are gone: a fresh record for one we hold
  const hop = Keypair.generate();
  hops.recs.set(hop.publicKey.toBase58(), { ...rec, hop: hop.publicKey.toBase58() });
  const now = Date.now();
  const sign = (kp: Keypair, ts: number) => bs58.encode(ed25519.sign(hopLookupMessage(hop.publicKey, ts), kp.secretKey.slice(0, 32)));
  const r = hops.lookup(hop.publicKey.toBase58(), now, sign(hop, now), now);
  assert.equal(r.status, "delivered");
  assert.equal((r as { to?: string }).to, rec.to);
  // with what the hop signed, so the app checks the recipient against the hop's own signature
  if (rec.l1) assert.deepEqual((r as { l1?: unknown }).l1, rec.l1);
  if (rec.n2) assert.equal((r as { n2?: { sig: string } }).n2?.sig, rec.n2.sig);
  assert.ok(rec.l1 || rec.n2);
  assert.throws(() => hops.lookup(hop.publicKey.toBase58(), now, sign(Keypair.generate(), now), now), (e: { status?: number }) => e.status === 403);
  assert.throws(() => hops.lookup(hop.publicKey.toBase58(), now - 10 * 60_000, sign(hop, now - 10 * 60_000), now), (e: { status?: number }) => e.status === 403);
  const open = hops.open();
  assert.ok(Array.isArray(open.hops));
});

test("a delivery body is rebuilt from its own fields, each checked", () => {
  const good = { to: Keypair.generate().publicKey.toBase58(), amount: "1000000", leaseId: "ab".repeat(12), blockhash: bs58.encode(randomBytes(32)), l1: bs58.encode(randomBytes(64)), n2: bs58.encode(randomBytes(64)), offCurveOk: true, extra: "x" };
  const d = cleanDelivery(good);
  assert.equal("extra" in d, false);
  for (const bad of [{ amount: "0" }, { amount: "1e9" }, { amount: 5 }, { to: "nope" }, { leaseId: "AB".repeat(12) }, { l1: bs58.encode(randomBytes(63)) }, { blockhash: bs58.encode(randomBytes(31)) }]) {
    assert.throws(() => cleanDelivery({ ...good, ...bad }), /Malformed/, JSON.stringify(bad));
  }
  assert.throws(() => cleanBody({ v: 3, request: {} }), /Malformed/);
  assert.throws(() => cleanBody({ request: {} }), /Malformed/, "a v2 body must say so");
});

// ─── the /api/rpc gateway: "send it yourself" pages ───

function selfSend(recipientSigns: boolean, v0: boolean, encoding: "base58" | "base64") {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const sp = {
    proof: new Uint8Array(256),
    root: 1n,
    nullifiers: [2n, 3n] as [bigint, bigint],
    commitments: [4n, 5n] as [bigint, bigint],
    ext: { recipient: recipient.publicKey, relayer: payer.publicKey, withdraw: 10n, relayerFee: 1n, maxFeeBps: 80, meta0: new Uint8Array(28), meta1: new Uint8Array(28) },
  };
  const ix = pool.transact(sp, treasury);
  if (recipientSigns) ix.keys[1].isSigner = true;
  let raw: Uint8Array;
  if (v0) {
    const m = MessageV0.compile({ payerKey: payer.publicKey, recentBlockhash: fake.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 }), ix] });
    const tx = new VersionedTransaction(m);
    tx.sign(recipientSigns ? [payer, recipient] : [payer]);
    raw = tx.serialize();
  } else {
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: fake.blockhash }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 450_000 }), ix);
    tx.sign(...(recipientSigns ? [payer, recipient] : [payer]));
    raw = tx.serialize();
  }
  const text = encoding === "base64" ? Buffer.from(raw).toString("base64") : bs58.encode(raw);
  return { method: "sendTransaction", params: encoding === "base64" ? [text, { encoding: "base64" }] : [text], recipient: recipient.publicKey.toBase58() };
}

test("the gateway sends a pool payment only when its recipient signs too: old self-sends are told to refresh", () => {
  for (const v0 of [false, true]) {
    for (const enc of ["base58", "base64"] as const) {
      assert.match(sendRefusal(selfSend(false, v0, enc)) ?? "", /Refresh the page/, `${v0 ? "v0" : "legacy"} ${enc}`);
      assert.equal(sendRefusal(selfSend(true, v0, enc)), null, `${v0 ? "v0" : "legacy"} ${enc}`);
    }
  }
  // anything else goes as before; what can't be read is refused
  const plain = new Transaction({ feePayer: relayerKp.publicKey, recentBlockhash: fake.blockhash }).add(SystemProgram.transfer({ fromPubkey: relayerKp.publicKey, toPubkey: treasury, lamports: 1 }));
  plain.sign(relayerKp);
  assert.equal(sendRefusal({ method: "sendTransaction", params: [bs58.encode(plain.serialize())] }), null);
  assert.equal(sendRefusal({ method: "getBalance", params: ["x"] }), null);
  assert.match(sendRefusal({ method: "sendTransaction", params: ["not a transaction"] }) ?? "", /not a transaction this gateway can read/);
  assert.match(sendRefusal({ method: "sendTransaction", params: ["AAAA", { encoding: "base64" }] }) ?? "", /not a transaction this gateway can read/);
  assert.match(sendRefusal({ method: "sendTransaction", params: [bs58.encode(plain.serialize()), { encoding: "jsonParsed" }] }) ?? "", /not a transaction this gateway can read/);
});

test("the smallest private send is the rent minimum, whoever the recipient is (the hop pays its own fee and must keep nothing or the rent)", async () => {
  const to = Keypair.generate().publicKey;
  put(to, { lamports: 5_000_000_000n });
  const before = sends();
  await assert.rejects(relay(cleanBody(payment(to, 890_879n).body)), (e) => /^400 too_small The smallest private send is 0\.0009 SOL/.test(reason(e)));
  assert.equal(sends(), before, "nothing sent");
  const p = payment(to, 890_880n);
  const res = await relay(cleanBody(p.body));
  assert.equal(res.delivery?.status, "delivered");
  assert.equal(bal(p.hop.publicKey), 0n);
});

test("a delivery none of whose transfers simulates is tried again for a few minutes before it waits for the owner's app", async () => {
  const to = Keypair.generate().publicKey;
  const p = payment(to, 200_000_000n);
  fake.tx2Ok = false;
  try {
    const res = await relay(cleanBody(p.body));
    assert.equal(res.delivery?.status, "pending", "a node just behind is no reason to give up");
    const rec = hops.get(p.hop.publicKey.toBase58())!;
    assert.equal(rec.status, "funded");
    assert.equal(rec.simFails, 1);
    for (let i = 0; i < 6; i++) await hops.tick();
    assert.equal(rec.status, "funded", "not before a few minutes have passed");
    rec.fundedAt = Date.now() - 4 * 60_000;
    await hops.tick();
    assert.equal(rec.status, "waiting");
    assert.equal(bal(to), 0n, "nothing went out on a transfer that didn't simulate");
  } finally {
    fake.tx2Ok = true;
  }
});

test("a hop the ledger no longer holds: delivered when it paid its own transfer (or holds nothing), otherwise its SOL waits for the app", async () => {
  const hop = Keypair.generate().publicKey;
  put(hop, { lamports: 3_000_000n });
  assert.deepEqual(await hops.settleMissing(hop.toBase58()), { delivered: false });
  const to = Keypair.generate().publicKey;
  c.getSignaturesForAddress = async () => [{ signature: "Dust", err: null }, { signature: "Tx2", err: null }, { signature: "Tx1", err: null }];
  c.getTransaction = async (s: string) => (s === "Tx2" ? paidBy(hop, to) : paidBy(relayerKp.publicKey));
  try {
    assert.deepEqual(await hops.settleMissing(hop.toBase58(), { tx1: "Tx1", to: to.toBase58() }), { delivered: true, signature: "Tx2" }, "dust after it doesn't hide the delivery");
    // the same hop's first transfer of its own paid someone else (the owner's app moved its SOL): never a delivery
    const other = Keypair.generate().publicKey;
    const moved = Keypair.generate().publicKey;
    put(other, { lamports: 0n });
    c.getTransaction = async (s: string) => (s === "Tx2" ? paidBy(other, Keypair.generate().publicKey) : paidBy(relayerKp.publicKey));
    assert.deepEqual(await hops.settleMissing(other.toBase58(), { tx1: "Tx1", to: moved.toBase58() }), { delivered: false, withdrawn: true });
  } finally {
    c.getSignaturesForAddress = async () => [];
    c.getTransaction = async () => null;
  }
  const empty = Keypair.generate().publicKey;
  put(empty, { lamports: 0n });
  assert.deepEqual(await hops.settleMissing(empty.toBase58()), { delivered: true, signature: null });
});

/** A chain whose hop history is `sigs` (newest first), paged as getSignaturesForAddress pages it; counts what it is asked. */
function historyChain(sigs: string[], read: (sig: string) => { byHop: false } | { byHop: true; pays: (to: string) => boolean }, balance: () => bigint) {
  const n = { lists: 0, reads: new Map<string, number>(), balances: 0 };
  const chain = {
    balance: async () => (n.balances++, balance()),
    blockhashValid: async () => true,
    simulate: async () => ({ ok: true }),
    send: async () => {},
    status: async (s: string[]) => s.map(() => null),
    nonceValue: async () => null,
    history: () => ({
      list: async (q: { before?: string; until?: string }) => {
        n.lists++;
        const from = q.before ? sigs.indexOf(q.before) + 1 : 0;
        const end = q.until && sigs.includes(q.until) ? sigs.indexOf(q.until) : sigs.length;
        return sigs.slice(from, end).slice(0, sdk.HISTORY_PAGE).map((signature) => ({ signature, err: null }));
      },
      read: async (sig: string) => {
        n.reads.set(sig, (n.reads.get(sig) ?? 0) + 1);
        return read(sig);
      },
    }),
    tx1State: async () => "landed" as const,
  };
  return { chain, n };
}

test("dust sent to a hop on either side of its first own transfer never hides it: each is read once, over a few passes; one that paid elsewhere ends withdrawn, never delivered", async () => {
  for (const paysRecipient of [true, false]) {
    const hop = Keypair.generate().publicKey.toBase58();
    const to = Keypair.generate().publicKey.toBase58();
    const older = Array.from({ length: 20 }, (_, i) => `Old${i}`);
    const newer = Array.from({ length: 5 }, (_, i) => `New${i}`);
    const sigs = [...newer, "AppTx", ...older, "PoolTx"];
    const { chain, n } = historyChain(sigs, (sig) => (sig === "AppTx" ? { byHop: true, pays: (r) => paysRecipient && r === to } : { byHop: false }), () => 3_000n);
    const changes: string[] = [];
    const l = new HopLedger(chain, nonces, () => null, { save() {}, saveNow: async () => {} });
    l.loaded = true;
    l.onChange = (r) => changes.push(r.status);
    await l.begin({ hop, to, amount: "100000000", nullifiers: [hex(), hex()], commitments: [hex(), hex()], tx1: "PoolTx", lastValid: 0 });
    l.unsettled(hop);
    const rec = l.get(hop)!;
    Object.assign(rec, { status: "waiting", fundedAt: Date.now() });
    await l.tick();
    assert.equal(rec.status, "waiting", "one pass reads only so much: twenty dust transfers sent before it take two");
    await l.tick();
    if (paysRecipient) {
      assert.equal(rec.status, "delivered");
      assert.equal(rec.delivered, "AppTx");
    } else {
      assert.equal(rec.status, "withdrawn", "the owner's app moved its SOL: never taken as its delivery");
      assert.equal(rec.delivered, undefined);
      assert.equal(rec.withdrawnBy, "AppTx");
      assert.equal(l.pending(hop), false);
    }
    assert.deepEqual(changes, [paysRecipient ? "delivered" : "withdrawn"]);
    assert.ok([...n.reads.values()].every((k) => k === 1), "every transaction in its history is read once");
    assert.ok(!n.reads.has("New0"), "what came after its first own transfer is never needed");
    assert.ok(!n.reads.has("PoolTx"), "nor the pool payment that paid it");
  }
});

test("a delivery waiting for its owner's app is looked at less and less often, never every 30 seconds for weeks", async () => {
  assert.equal(lookGap(1), 0);
  assert.equal(lookGap(8), 0);
  assert.equal(lookGap(9), 60_000);
  assert.equal(lookGap(40), 15 * 60_000);
  const hop = Keypair.generate().publicKey.toBase58();
  const amount = 100_000_000n;
  const { chain, n } = historyChain([], () => ({ byHop: false }), () => amount + DELIVERY_FEE + 5_000n);
  const l = new HopLedger(chain, nonces, () => null, { save() {}, saveNow: async () => {} });
  l.loaded = true;
  await l.begin({ hop, to: Keypair.generate().publicKey.toBase58(), amount: amount.toString(), nullifiers: [hex(), hex()], commitments: [hex(), hex()], tx1: "PoolTx", lastValid: 0 });
  l.unsettled(hop);
  const t0 = Date.now();
  Object.assign(l.get(hop)!, { status: "waiting", fundedAt: t0 });
  // an hour of passes, 30 seconds apart
  for (let i = 0; i < 120; i++) await l.tick(t0 + i * 30_000);
  assert.ok(n.balances >= 10 && n.balances <= 20, `looked at ${n.balances} times in an hour`);
  assert.equal(l.get(hop)!.status, "waiting");
});

test("a ledger whose saved copy App Storage hasn't returned yet takes nothing as gone", async () => {
  let restoring = true;
  const fakeChain = {
    balance: async () => 0n,
    blockhashValid: async () => true,
    simulate: async () => ({ ok: true }),
    send: async () => {},
    status: async () => [],
    nonceValue: async () => null,
    history: () => ({ list: async () => [], read: async () => undefined }),
    tx1State: async () => "unknown" as const,
  };
  const l = new HopLedger(fakeChain, nonces, () => null, { save() {}, saveNow: async () => {}, restoring: () => restoring });
  l.loaded = true;
  assert.equal(l.ready(), false);
  assert.equal(l.pending("anything"), null, "unknown, never \"not pending\"");
  restoring = false;
  assert.equal(l.ready(), true);
  assert.equal(l.pending("anything"), false);
});

test("a pool payment the app sent itself is seen at the gateway: its hop is watched and listed once it holds SOL", async () => {
  const req = selfSend(true, false, "base58");
  assert.deepEqual(inspectSend(req).cosigners, [req.recipient], "the co-signing recipient, never the fee payer");
  assert.deepEqual(inspectSend(selfSend(false, false, "base58")).cosigners, []);
  hops.remember(req.recipient);
  assert.equal(hops.isHop(req.recipient), false, "it may be the sender's own wallet: never refused as a recipient for that");
  put(req.recipient, { lamports: 4_000_000n });
  await hops.tick(Date.now() + 3 * 60_000);
  assert.deepEqual(
    hops.open().hops.find((h) => h.hop === req.recipient),
    { hop: req.recipient, lamports: "4000000" },
    "listed within minutes, not only after the daily sweep",
  );
  put(req.recipient, { lamports: 0n });
});

test("a failed read of the nonce while its N2 is followed never counts as expired: the delivery stays pending, its nonce exposed", async () => {
  const { NoncePool } = await import("../src/nonces.ts");
  const hash = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
  const nchain = { read: async () => [], send: async () => true, blockhash: async () => hash(7), rent: async () => 1n, canSpend: async () => false, lamports: async () => [] };
  const pool2 = new NoncePool(N, relayerKp, nchain, { min: 0, max: 10, priority: 0, save() {}, saveNow: async () => {} });
  const account = Keypair.generate().publicKey.toBase58();
  pool2.recs.set(account, { account, n: 0, value: hash(9), advancedAt: 0, state: "free" });
  const owner = "job:" + "a".repeat(24);
  const lease = pool2.lease({ owner, ttlMs: 60_000, scheduled: true })!;
  pool2.bind(lease.leaseId!, owner);
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const amount = 100_000_000n;
  const sig = bs58.encode(signDelivery(n2Message({ hop: hop.publicKey, to, lamports: amount, nonceAccount: new PublicKey(account), authority: N.publicKey, nonce: hash(9) }), hop));
  let reads = 0;
  const l = new HopLedger(
    {
      balance: async () => amount + DELIVERY_FEE,
      blockhashValid: async () => true,
      simulate: async () => ({ ok: true }),
      send: async () => {},
      status: async (s) => s.map(() => null),
      // the first read (picking the delivery) works; every later one, while it is followed, hits an RPC error
      nonceValue: async () => (reads++ === 0 ? hash(9) : undefined),
      history: () => ({ list: async () => [], read: async () => undefined }),
      tx1State: async () => "landed" as const,
    },
    pool2,
    () => N,
    { save() {}, saveNow: async () => {} },
  );
  l.loaded = true;
  await l.begin({ hop: hop.publicKey.toBase58(), to: to.toBase58(), amount: amount.toString(), nullifiers: [hex(), hex()], commitments: [hex(), hex()], n2: { leaseId: lease.leaseId!, sig, account, value: hash(9) }, jobId: "a".repeat(24), tx1: "x", lastValid: 0 });
  const out = await l.funded(hop.publicKey.toBase58(), 7_000);
  assert.equal(out.status, "pending");
  assert.equal(l.get(hop.publicKey.toBase58())!.status, "funded", "the finisher follows it on");
  assert.equal(pool2.recs.get(account)!.state, "exposed", "its nonce is never retired under it");
});

test("a delivery whose nonce lease can't be saved first is never sent", async () => {
  const { NoncePool } = await import("../src/nonces.ts");
  const nchain = { read: async () => [], send: async () => true, blockhash: async () => "", rent: async () => 1n, canSpend: async () => false, lamports: async () => [] };
  const pool2 = new NoncePool(N, relayerKp, nchain, {
    min: 0,
    max: 10,
    priority: 0,
    save() {},
    saveNow: async () => {
      throw new Error("disk full");
    },
  });
  const account = Keypair.generate().publicKey.toBase58();
  pool2.recs.set(account, { account, n: 0, value: "11111111111111111111111111111111", advancedAt: 0, state: "free" });
  const lease = pool2.lease({ owner: "send:x", ttlMs: 60_000, scheduled: false })!;
  const l = new HopLedger({} as never, pool2, () => N, { save() {}, saveNow: async () => {} });
  const hop = Keypair.generate().publicKey.toBase58();
  await assert.rejects(
    l.begin({ hop, to: Keypair.generate().publicKey.toBase58(), amount: "1", nullifiers: [hex(), hex()], commitments: [hex(), hex()], n2: { leaseId: lease.leaseId!, sig: "s", account, value: lease.value }, tx1: "x", lastValid: 0 }),
    /disk full/,
  );
  assert.equal(l.get(hop), undefined, "nothing written down, so nothing is sent");
  assert.equal(lease.hop, undefined);
});

test("the same payment sent again keeps every send; one that landed is found though a later one failed", async () => {
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const base = { hop: hop.publicKey.toBase58(), to: to.toBase58(), amount: "200000000", nullifiers: [hex(), hex()] as [string, string], commitments: [hex(), hex()] as [string, string], lastValid: 400 };
  const first = bs58.encode(randomBytes(64));
  const second = bs58.encode(randomBytes(64));
  await hops.begin({ ...base, tx1: first });
  const rec = await hops.begin({ ...base, tx1: second, lastValid: 450 });
  assert.deepEqual(rec.tx1s, [first]);
  hops.unsettled(base.hop);
  sigStatus.set(first, "confirmed");
  sigStatus.set(second, "failed");
  // the finisher asks the chain about every send of it (the hop holds nothing here, so it only gets as far as funded)
  put(hop.publicKey, { lamports: 0n });
  await hops.tick();
  assert.equal(hops.get(base.hop)!.status, "funded", "a later send failing never hides the one that landed");
});

test("a pool payment the app sent itself is watched only once it has landed, and a flood of ones that never land pushes nothing out", async () => {
  const real = Keypair.generate().publicKey.toBase58();
  const junk = Keypair.generate().publicKey.toBase58();
  const realSig = bs58.encode(randomBytes(64));
  hops.selfSent(realSig, [real], "net-a");
  hops.selfSent(bs58.encode(randomBytes(64)), [junk], "net-b");
  const watched = () => new Set((hops as unknown as { watched: Map<string, number> }).watched.keys());
  assert.ok(!watched().has(real), "not before it is seen landing");
  sigStatus.set(realSig, "confirmed");
  await hops.tick(Date.now() + 30_000);
  assert.ok(watched().has(real));
  assert.ok(!watched().has(junk), "one that never landed is never watched");
  await hops.tick(Date.now() + 5 * 60_000);
  assert.ok(!watched().has(junk));
  // one network can only queue a few at a time
  const pending = () => (hops as unknown as { pendingSelf: Map<string, unknown> }).pendingSelf.size;
  const before = pending();
  for (let i = 0; i < 50; i++) hops.selfSent(bs58.encode(randomBytes(64)), [Keypair.generate().publicKey.toBase58()], "net-flood");
  assert.equal(pending() - before, 20);
});

test("sending addresses stay on the daily look-over for 400 days, kept in monthly files: a refund returned months later is still listed", async () => {
  const day = 86_400_000;
  const now = Date.now();
  const files = new Map<string, string>();
  const chain = { status: async () => [], tx1State: async () => "unknown" as const } as never;
  const io = { save() {}, saveNow: async () => {}, saveSeen: (m: string, d: () => string) => void files.set(m, d()) };
  const [a, b, c] = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58());
  // a ledger saved before the monthly files: its hops move into them
  const l = new HopLedger(chain, nonces, () => null, io);
  l.adopt(JSON.stringify({ v: 1, recs: [], seen: [[a, now - 100 * day], [b, now - 401 * day]], watched: [[c, now - 200 * day]] }));
  await l.tick(now);
  assert.equal(l.isHop(a), true, "delivered 100 days ago: still looked over (it used to go after 90)");
  assert.equal(l.isHop(b), false, "past 400 days it goes");
  assert.ok(!("seen" in JSON.parse(l.serialize())), "the records' file no longer carries them");
  assert.ok(files.has(seenMonth(now - 100 * day)) && files.has(seenMonth(now - 200 * day)));
  assert.equal((JSON.parse(files.get(seenMonth(now - 401 * day))!) as { seen: unknown[] }).seen.length, 0, "the month that ran out is emptied");
  // the next start reads the months back
  const l2 = new HopLedger(chain, nonces, () => null, io);
  for (const m of seenMonths(now)) l2.adoptSeen(files.get(m) ?? null);
  assert.equal(l2.isHop(a), true);
  assert.ok((l2 as unknown as { watched: Map<string, number> }).watched.has(c));
  const months = seenMonths(now);
  assert.equal(months.at(-1), seenMonth(now));
  assert.ok(months.includes(seenMonth(now - KEEP_SEEN_MS + day)) && months.length <= 15);
  // a new delivery is saved to this month's file only
  files.clear();
  l2.loaded = true;
  const hop = Keypair.generate().publicKey.toBase58();
  await l2.begin({ hop, to: Keypair.generate().publicKey.toBase58(), amount: "100000000", nullifiers: [hex(), hex()], commitments: [hex(), hex()], tx1: "PoolTx", lastValid: 0 });
  l2.unsettled(hop);
  await l2.tick(now);
  assert.deepEqual([...files.keys()], [seenMonth(Date.now())]);
  assert.ok(files.get(seenMonth(Date.now()))!.includes(hop));
});

test("a month of sending addresses App Storage gives only after the start replaces the partial copy written meanwhile", async () => {
  const { StateStore, seal, unseal, stateKey } = await import("../src/durable.ts");
  const key = stateKey(new Uint8Array(64).fill(9));
  const now = Date.now();
  const month = seenMonth(now);
  const name = `hops-seen-${month}`;
  const earlier = Keypair.generate().publicKey.toBase58();
  // App Storage holds the month with a hop delivered earlier, but doesn't answer at the start
  const objects = new Map<string, string>();
  let up = false;
  const remote = {
    name: "fake",
    async put(k: string, t: string) {
      if (!up) throw new Error("outage");
      objects.set(k, t);
    },
    async get(k: string) {
      if (!up) throw new Error("outage");
      return objects.get(k);
    },
    async del(k: string) {
      objects.delete(k);
    },
  };
  objects.set(`state/${name}.json`, seal(key, name, JSON.stringify({ v: 1, month, seen: [[earlier, now - 1000]], watched: [] }), "deployment", 1000));
  const store = new StateStore(mkdtempSync(join(dir, "late-")), key, remote, { scope: "deployment", retryMs: [1], recheckMs: [20] });
  const chain = { status: async () => [], tx1State: async () => "unknown" as const } as never;
  const l = new HopLedger(chain, nonces, () => null, { save() {}, saveNow: async () => {}, saveSeen: (m, d) => store.save(`hops-seen-${m}`, d) });
  let lateIn!: () => void;
  const added = new Promise<void>((r) => (lateIn = r));
  assert.equal(
    await store.load(name, (late) => {
      l.adoptSeen(late, true);
      lateIn();
    }),
    null,
  );
  l.loaded = true;
  // a delivery meanwhile: this month is written with only the new hop
  const hop = Keypair.generate().publicKey.toBase58();
  await l.begin({ hop, to: Keypair.generate().publicKey.toBase58(), amount: "100000000", nullifiers: [hex(), hex()], commitments: [hex(), hex()], tx1: "PoolTx", lastValid: 0 });
  l.unsettled(hop);
  await l.tick(now);
  await new Promise((r) => setTimeout(r, 400));
  up = true;
  await added;
  assert.equal(l.isHop(earlier), true);
  await store.flush();
  const stored = JSON.parse(unseal(key, name, objects.get(`state/${name}.json`)!, "deployment").text) as { seen: [string, number][] };
  const held = new Set(stored.seen.map(([h]) => h));
  assert.ok(held.has(earlier), "the hop delivered before the start is still in App Storage's copy");
  assert.ok(held.has(hop), "and so is the one delivered meanwhile");
});

// ─── scheduled payments ───

const { schedule, statuses, startScheduler, stopScheduler, testHooks } = await import("../src/schedule.ts");
const { createHash } = await import("node:crypto");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("a page from before deliveries can't schedule a payout; one in the new format is checked down to its proof", async () => {
  const old = payment(Keypair.generate().publicKey, 200_000_000n);
  await assert.rejects(schedule({ request: old.body.request, window: "1h" }), (e) => /^426 update_required/.test(reason(e)));
  const id = "a1".repeat(12);
  const token = "b2".repeat(16);
  const lease = nonces.lease({ owner: `job:${id}`, tokenHash: sha(token), ttlMs: 60_000, scheduled: true })!;
  const p = payment(Keypair.generate().publicKey, 200_000_000n, { l1: false, lease: { leaseId: lease.leaseId, account: lease.account, value: lease.value } });
  // a delivery's nonce is the job's own: it needs the job's id
  await assert.rejects(schedule({ ...p.body, window: "1h", token }), (e) => /^400 .*Malformed/.test(reason(e)));
  await assert.rejects(schedule({ ...p.body, window: "1h", token, id }), (e) => /^400 .*proof did not check out/.test(reason(e)));
  nonces.release(lease.leaseId);
});

test("scheduled jobs from before deliveries are moved to the new format: stale, notes kept, the owner's app sends them again", () => {
  testHooks.loaded(true);
  const id = "c3".repeat(12);
  const req = request(Keypair.generate().publicKey, 300_000_000n);
  const join = request(relayerKp.publicKey, relayerFee);
  const id2 = "d4".repeat(12);
  const now = Date.now();
  const base = { tokenHash: sha("t"), window: "1h", due: now + 3_600_000, latest: now + 3_600_000, tries: 0 };
  testHooks.restore(
    JSON.stringify([
      { ...base, id, status: "scheduled", req, nullifiers: req.nullifiers },
      { ...base, id: id2, status: "scheduled", req: join, nullifiers: join.nullifiers },
    ]),
  );
  const [a, b] = statuses([id, id2]);
  assert.equal(a.status, "stale");
  assert.match(String(a.error), /new delivery format/);
  assert.equal(b.status, "scheduled", "one that only pays the relayer is still fine");
});

test("a scheduled payment goes out on its nonce while the page is closed, and is sent once its delivery has landed", async () => {
  await startScheduler();
  try {
    const id = "e5".repeat(12);
    const token = "f6".repeat(16);
    const to = Keypair.generate().publicKey;
    const amount = 400_000_000n;
    const lease = nonces.lease({ owner: `job:${id}`, tokenHash: sha(token), ttlMs: 60_000, scheduled: true })!;
    assert.ok(nonces.bind(lease.leaseId!, `job:${id}`));
    const p = payment(to, amount, { l1: false, lease: { leaseId: lease.leaseId, account: lease.account, value: lease.value } });
    const delivery = cleanBody(p.body).delivery;
    const now = Date.now();
    testHooks.restore(
      JSON.stringify([{ id, tokenHash: sha(token), status: "scheduled", v: 2, req: p.body.request, delivery, nullifiers: p.body.request.nullifiers, window: "1h", due: now - 1000, latest: now + 3_600_000, tries: 0 }]),
    );
    let st = statuses([id])[0];
    for (let i = 0; i < 30 && st.status !== "sent"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = statuses([id])[0];
    }
    assert.equal(st.status, "sent", JSON.stringify(st));
    assert.equal(bal(to), amount);
    const rec = hops.get(p.hop.publicKey.toBase58())!;
    assert.equal(rec.jobId, id);
    assert.equal(st.signature, rec.delivered, "the payment's signature is its delivery's");
    assert.equal((st as { tx1?: string }).tx1, rec.tx1);
  } finally {
    await stopScheduler();
  }
});

test("a payment from before deliveries caught mid-send by the update goes stale for its owner's app, never failed", async () => {
  await startScheduler();
  try {
    const id = "a7".repeat(12);
    const req = request(Keypair.generate().publicKey, 300_000_000n);
    const now = Date.now();
    testHooks.restore(
      JSON.stringify([{ id, tokenHash: sha("t"), status: "sending", req, nullifiers: req.nullifiers, window: "1h", due: now - 1000, latest: now + 3_600_000, tries: 0 }]),
    );
    let st = statuses([id])[0];
    for (let i = 0; i < 30 && st.status !== "stale" && st.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      st = statuses([id])[0];
    }
    assert.equal(st.status, "stale", JSON.stringify(st));
    assert.match(String(st.error), /new delivery format.*confirm/);
  } finally {
    await stopScheduler();
  }
});

test("a delivering payment whose delivery the ledger no longer holds is settled from its hop, never called sent while SOL waits there", async () => {
  await startScheduler();
  try {
    const waiting = Keypair.generate().publicKey;
    const done = Keypair.generate().publicKey;
    put(waiting, { lamports: 9_000_000n });
    c.getSignaturesForAddress = async (k: PublicKey) => (k.equals(done) ? [{ signature: "Tx2Done", err: null }] : []);
    c.getTransaction = async (s: string) => (s === "Tx2Done" ? paidBy(done) : null);
    const [a, b] = ["b8".repeat(12), "c9".repeat(12)];
    testHooks.restore(
      JSON.stringify([
        { id: a, tokenHash: sha("t"), status: "delivering", hop: waiting.toBase58(), tx1: "T1a" },
        { id: b, tokenHash: sha("t"), status: "delivering", hop: done.toBase58(), tx1: "T1b" },
      ]),
    );
    let [sa, sb] = statuses([a, b]);
    for (let i = 0; i < 20 && (sb.status !== "sent" || !(sa as { note?: string | null }).note); i++) {
      await new Promise((r) => setTimeout(r, 300));
      [sa, sb] = statuses([a, b]);
    }
    assert.equal(sa.status, "delivering");
    assert.match(String((sa as { note?: string | null }).note), /Ready to finish/);
    assert.equal(sb.status, "sent");
    assert.equal(sb.signature, "Tx2Done");
  } finally {
    c.getSignaturesForAddress = async () => [];
    c.getTransaction = async () => null;
    await stopScheduler();
  }
});

test("a delivering payment whose SOL the owner's app moved elsewhere is never called sent: it ends not delivered, with no Transaction ID", async () => {
  await startScheduler();
  try {
    const to = Keypair.generate().publicKey;
    // one the ledger let go of: its hop's first own transfer went somewhere else (into the pool, say)
    const gone = Keypair.generate().publicKey;
    put(gone, { lamports: 0n });
    c.getSignaturesForAddress = async (k: PublicKey) => (k.equals(gone) ? [{ signature: "DepositTx", err: null }, { signature: "T1g", err: null }] : []);
    c.getTransaction = async (s: string) => (s === "DepositTx" ? paidBy(gone, Keypair.generate().publicKey) : null);
    // one the ledger still holds, moved the same way
    const held = Keypair.generate().publicKey;
    const [a, b] = ["e1".repeat(12), "f2".repeat(12)];
    hops.recs.set(held.toBase58(), {
      hop: held.toBase58(),
      to: to.toBase58(),
      amount: "100000000",
      nullifiers: [hex(), hex()],
      commitments: [hex(), hex()],
      jobId: b,
      tx1: "T1h",
      lastValid: 0,
      tx2: [],
      status: "withdrawn",
      withdrawnBy: "OnwardTx",
      at: Date.now(),
      done: Date.now(),
    });
    testHooks.restore(
      JSON.stringify([
        { id: a, tokenHash: sha("t"), status: "delivering", hop: gone.toBase58(), tx1: "T1g", to: to.toBase58() },
        { id: b, tokenHash: sha("t"), status: "delivering", hop: held.toBase58(), tx1: "T1h", to: to.toBase58() },
      ]),
    );
    let [sa, sb] = statuses([a, b]);
    for (let i = 0; i < 20 && (sa.status === "delivering" || sb.status === "delivering"); i++) {
      await new Promise((r) => setTimeout(r, 300));
      [sa, sb] = statuses([a, b]);
    }
    for (const st of [sa, sb]) {
      assert.equal(st.status, "failed", JSON.stringify(st));
      assert.equal(st.signature, null, "the owner's own transfer is never its Transaction ID");
      assert.match(String(st.error), /Not delivered: its SOL was moved/);
    }
  } finally {
    c.getSignaturesForAddress = async () => [];
    c.getTransaction = async () => null;
    await stopScheduler();
  }
});

test("a delivering payment whose delivery record was taken as dropped is asked about again: one whose pool payment landed is delivered", async () => {
  await startScheduler();
  try {
    const to = Keypair.generate().publicKey;
    const amount = 300_000_000n;
    const hop = Keypair.generate();
    const id = "d1".repeat(12);
    const landedSig = bs58.encode(randomBytes(64));
    const failedSig = bs58.encode(randomBytes(64));
    const base = {
      hop: hop.publicKey.toBase58(),
      to: to.toBase58(),
      amount: amount.toString(),
      nullifiers: [hex(), hex()] as [string, string],
      commitments: [hex(), hex()] as [string, string],
      l1: { blockhash: fake.blockhash, sig: bs58.encode(signDelivery(l1Message({ hop: hop.publicKey, to, lamports: amount, blockhash: fake.blockhash }), hop)) },
      jobId: id,
      lastValid: 400,
    };
    // sent twice (a restart in between): the first landed and paid the hop, the second failed and was taken as dropped
    await hops.begin({ ...base, tx1: landedSig });
    await hops.begin({ ...base, tx1: failedSig });
    sigStatus.set(landedSig, "confirmed");
    sigStatus.set(failedSig, "failed");
    put(hop.publicKey, { lamports: amount + DELIVERY_FEE });
    fake.l1Valid = true;
    hops.dropped(base.hop);
    assert.equal(hops.get(base.hop)!.status, "dropped");
    testHooks.restore(JSON.stringify([{ id, tokenHash: sha("t"), status: "delivering", hop: base.hop, tx1: landedSig }]));
    let st = statuses([id])[0];
    for (let i = 0; i < 30 && st.status !== "sent"; i++) {
      await new Promise((r) => setTimeout(r, 300));
      await hops.tick();
      st = statuses([id])[0];
    }
    assert.equal(st.status, "sent", JSON.stringify(st));
    assert.equal(bal(to), amount);
  } finally {
    await stopScheduler();
  }
});

test("a payment already delivering is answered as going out, never as ended, to a cancel or a fresh hand-over", async () => {
  testHooks.loaded(true);
  const id = "e7".repeat(12);
  const token = "f8".repeat(16);
  testHooks.restore(JSON.stringify([{ id, tokenHash: sha(token), status: "delivering", hop: Keypair.generate().publicKey.toBase58(), tx1: "T1" }]));
  const { cancel } = await import("../src/schedule.ts");
  assert.equal(cancel(id, token).status, "delivering");
  const p = payment(Keypair.generate().publicKey, 200_000_000n, { l1: false, lease: { leaseId: "ab".repeat(12), account: Keypair.generate().publicKey.toBase58(), value: "11111111111111111111111111111111" } });
  await assert.rejects(schedule({ ...p.body, window: "1h", token, id }), (e) => /^409 going .*already going out/.test(reason(e)));
});

test("the relayer signs pool payments and nonce upkeep only, and N signs only the deliveries rebuilt here", () => {
  const relayer = relayerKp.publicKey.toBase58();
  const n = N.publicKey.toBase58();
  assert.ok(seen.length > 10);
  for (const { tx } of seen) {
    const by = signers(tx);
    const keys = tx.message.staticAccountKeys;
    const progs = tx.message.compiledInstructions.map((ix) => keys[ix.programIdIndex].toBase58());
    if (by.includes(relayer)) {
      assert.deepEqual(progs, [ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), pool.programId.toBase58()], "TX1 only");
      assert.equal(keys[0].toBase58(), relayer);
    }
    if (by.includes(n)) {
      assert.equal(by.length, 2, "with the hop");
      assert.equal(tx.message.header.numReadonlySignedAccounts, 1);
      assert.equal(keys[1].toBase58(), n, "read-only signer");
      assert.deepEqual(progs, [SYSTEM.toBase58(), ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), SYSTEM.toBase58()]);
    }
    if (!by.includes(relayer) && !by.includes(n)) assert.equal(by.length, 1, "a delivery the hop alone signed");
  }
});
