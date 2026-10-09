import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemInstruction, SystemProgram, ComputeBudgetProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { NoncePool, nonceAddress, buildCreate, buildRetire, buildClose, seedOf, type NonceChain } from "../src/nonces.ts";
import { nonceAuthorityFrom } from "../src/config.ts";

const payer = Keypair.fromSeed(new Uint8Array(32).fill(41));
const authority = nonceAuthorityFrom(payer.secretKey);
const hash = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
const randomHex = () => Buffer.from(Keypair.generate().publicKey.toBytes()).toString("hex");

/** 80 bytes of an initialized nonce account. */
function nonceData(auth: PublicKey, value: string) {
  const d = new Uint8Array(80);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 1, true);
  d.set(auth.toBytes(), 8);
  d.set(bs58.decode(value), 40);
  return d;
}

/** A chain holding nonce accounts; `send` runs CREATE and RETIRE the way the System program would. */
function fakeChain(o: { refuse?: boolean } = {}) {
  const accounts = new Map<string, { data: Uint8Array; finalized: Uint8Array }>();
  const sent: Transaction[] = [];
  let next = 100;
  const chain: NonceChain & { accounts: typeof accounts; sent: Transaction[]; finalize(): void } = {
    accounts,
    sent,
    finalize() {
      for (const a of accounts.values()) a.finalized = a.data;
    },
    async read(list, commitment) {
      return list.map((k) => {
        const a = accounts.get(k.toBase58());
        return a ? (commitment === "finalized" ? a.finalized : a.data) : null;
      });
    },
    async send(tx) {
      sent.push(tx);
      if (o.refuse) return false;
      for (const ix of tx.instructions) {
        if (!ix.programId.equals(SystemProgram.programId)) continue;
        const type = SystemInstruction.decodeInstructionType(ix);
        if (type === "InitializeNonceAccount") {
          const p = SystemInstruction.decodeNonceInitialize(ix);
          const d = nonceData(p.authorizedPubkey, hash(next++));
          accounts.set(p.noncePubkey.toBase58(), { data: d, finalized: d });
        }
        if (type === "AdvanceNonceAccount") {
          const p = SystemInstruction.decodeNonceAdvance(ix);
          const a = accounts.get(p.noncePubkey.toBase58())!;
          a.data = nonceData(p.authorizedPubkey, hash(next++));
        }
        if (type === "WithdrawNonceAccount") {
          const p = SystemInstruction.decodeNonceWithdraw(ix);
          if (p.lamports === 1_447_680) accounts.delete(p.noncePubkey.toBase58());
        }
      }
      return true;
    },
    async blockhash() {
      return hash(7);
    },
    async rent() {
      return 1_447_680n;
    },
    async canSpend() {
      return true;
    },
    async lamports(list) {
      return list.map((k) => (accounts.has(k.toBase58()) ? 1_447_680n : null));
    },
  };
  return chain;
}

function pool(chain: NonceChain, o: { min?: number; max?: number; saveNow?: () => Promise<void>; restoring?: () => boolean; auth?: Keypair } = {}) {
  let saves = 0;
  const p = new NoncePool(o.auth ?? authority, payer, chain, {
    min: o.min ?? 8,
    max: o.max ?? 100,
    priority: 1000,
    save: () => void saves++,
    saveNow: o.saveNow ?? (async () => void saves++),
    restoring: o.restoring,
  });
  return Object.assign(p, { saves: () => saves });
}

/** RETIRE transactions sent so far. */
const retires = (chain: { sent: Transaction[] }) =>
  chain.sent.filter((tx) => tx.instructions.some((ix) => ix.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(ix) === "AdvanceNonceAccount")).length;

/** Signers that actually signed a transaction (not the blank slots). */
const signedBy = (tx: Transaction) => tx.signatures.filter((s) => s.signature && s.signature.some((b) => b)).map((s) => s.publicKey.toBase58());

test("the nonce authority comes from the relayer's secret: fixed, and nothing like the relayer itself", () => {
  assert.equal(nonceAuthorityFrom(payer.secretKey).publicKey.toBase58(), authority.publicKey.toBase58());
  assert.notEqual(authority.publicKey.toBase58(), payer.publicKey.toBase58());
  assert.notEqual(nonceAuthorityFrom(Keypair.generate().secretKey).publicKey.toBase58(), authority.publicKey.toBase58());
});

test("nonce addresses are createAccountWithSeed's, so the pool can always be found again", async () => {
  for (const n of [0, 1, 999_999]) {
    const want = await PublicKey.createWithSeed(authority.publicKey, seedOf(n), SystemProgram.programId);
    assert.equal(nonceAddress(authority.publicKey, n).toBase58(), want.toBase58());
  }
  assert.equal(seedOf(42), "vsn-000042");
});

test("CREATE and RETIRE hold nothing but nonce instructions; N only ever signs read-only", () => {
  const create = buildCreate(payer.publicKey, authority.publicKey, [0, 1, 2, 3], 1_447_680n, hash(7), 1000);
  create.sign(payer, authority);
  assert.ok(create.serialize().length <= 1232, "four fit in one transaction");
  assert.throws(() => buildCreate(payer.publicKey, authority.publicKey, [0, 1, 2, 3, 4], 1n, hash(7), 1000));
  const retire = buildRetire(payer.publicKey, authority.publicKey, Array.from({ length: 20 }, (_, i) => nonceAddress(authority.publicKey, i)), hash(7), 1000);
  retire.sign(payer, authority);
  assert.ok(retire.serialize().length <= 1232, "twenty fit in one transaction");
  for (const tx of [create, retire]) {
    assert.deepEqual(signedBy(tx).sort(), [payer.publicKey.toBase58(), authority.publicKey.toBase58()].sort());
    const msg = tx.compileMessage();
    const n = msg.accountKeys.findIndex((k) => k.equals(authority.publicKey));
    assert.equal(msg.isAccountWritable(n), false, "N is never debited");
    assert.equal(msg.accountKeys[0].toBase58(), payer.publicKey.toBase58(), "the relayer pays");
    for (const ix of tx.instructions) {
      assert.ok(ix.programId.equals(SystemProgram.programId) || ix.programId.equals(ComputeBudgetProgram.programId));
      if (!ix.programId.equals(SystemProgram.programId)) continue;
      const type = SystemInstruction.decodeInstructionType(ix);
      assert.ok(["CreateWithSeed", "InitializeNonceAccount", "AdvanceNonceAccount"].includes(type), type);
      if (type === "CreateWithSeed") {
        const p = SystemInstruction.decodeCreateWithSeed(ix);
        assert.equal(p.fromPubkey.toBase58(), payer.publicKey.toBase58());
        assert.equal(p.space, 80);
      }
    }
  }
});

test("the pool stocks itself in batches of four, and a scheduled payment asking again keeps its nonce", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 8 });
  // nothing in use: the minimum, or the spare sixteen if that is more; at most three transactions a tick
  assert.equal(p.target(), 16);
  await p.tick();
  assert.equal(p.status().free, 12);
  assert.equal(chain.sent.length, 3, "CREATE transactions of four");
  await p.tick();
  assert.equal(p.status().free, 16);
  for (const tx of chain.sent) assert.deepEqual(signedBy(tx).sort(), [payer.publicKey.toBase58(), authority.publicKey.toBase58()].sort());
  const a = p.lease({ owner: "job:aa", tokenHash: "t1", ttlMs: 60_000, scheduled: true })!;
  assert.equal(a.state, "leased");
  const again = p.lease({ owner: "job:aa", tokenHash: "t1", ttlMs: 60_000, scheduled: true })!;
  assert.equal(again.leaseId, a.leaseId, "the same lease while it hasn't been exposed");
  assert.throws(() => p.lease({ owner: "job:aa", tokenHash: "other", ttlMs: 60_000, scheduled: true }), (e: { status?: number }) => e.status === 403);
  const b = p.lease({ owner: "send:1", ttlMs: 60_000, scheduled: false })!;
  assert.notEqual(b.account, a.account, "one payment per nonce");
  assert.equal(p.lease({ owner: "send:1", ttlMs: 60_000, scheduled: false })!.leaseId, b.leaseId, "a payment sent now asking again gets its own lease back");
  // leases only asked for grow the pool only up to a bound (asking is free); ones a payment took up count in full
  assert.equal(p.target(), Math.ceil(2 * 1.2) + 16);
  p.bind(a.leaseId!, "job:aa");
  await p.take(b.leaseId!, "HOP");
  assert.equal(p.target(), Math.ceil(2 * 1.2) + 16);
});

test("a lease never exposed goes back at once with its value unchanged; an exposed one only once its value has moved on, final", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const a = p.lease({ owner: "send:1", ttlMs: 60_000, scheduled: false })!;
  const value = a.value;
  p.release(a.leaseId);
  assert.equal(a.state, "free");
  assert.equal(a.value, value);
  assert.equal(p.get(a.leaseId!), undefined);

  const b = p.lease({ owner: "send:2", ttlMs: 60_000, scheduled: false })!;
  const id = b.leaseId!;
  await p.take(id, "HOP");
  await p.expose(id, "HOP");
  assert.equal(b.state, "exposed");
  assert.equal(b.exposedValue, b.value);
  await assert.rejects(p.expose(id, "OTHER"), /lease lost/, "exposed for one delivery only");
  // the delivery it was exposed for is still going: nothing happens to it
  p.hooks.hopPending = () => true;
  await p.tick();
  assert.equal(b.state, "exposed");
  assert.equal(retires(chain), 0, "nothing advanced while its delivery may land");
  // let go: retired by the relayer (one RETIRE), free only once the new value is final
  p.release(id);
  assert.equal(b.state, "retiring");
  await p.tick();
  assert.equal(retires(chain), 1);
  assert.equal(b.state, "retiring", "the advance isn't final yet");
  chain.finalize();
  await p.tick();
  assert.equal(b.state, "free");
  assert.notEqual(b.value, b.exposedValue ?? value);
  assert.equal(b.exposedValue, undefined);
});

test("an exposed nonce whose delivery landed is free once that is final, with no RETIRE", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const b = p.lease({ owner: "send:2", ttlMs: 60_000, scheduled: false })!;
  await p.expose(b.leaseId!, "HOP");
  // the delivery advanced it
  const a = chain.accounts.get(b.account)!;
  a.data = nonceData(authority.publicKey, hash(250));
  chain.finalize();
  p.hooks.hopPending = () => false;
  p.release(b.leaseId);
  await p.tick();
  assert.equal(b.state, "free");
  assert.equal(b.value, hash(250));
  assert.equal(retires(chain), 0);
});

test("exposing is saved before it resolves; a failed save means the delivery isn't sent", async () => {
  const chain = fakeChain();
  let fail = false;
  const p = pool(chain, {
    min: 4,
    saveNow: async () => {
      if (fail) throw new Error("disk full");
    },
  });
  await p.tick();
  const b = p.lease({ owner: "send:2", ttlMs: 60_000, scheduled: false })!;
  await p.take(b.leaseId!, "HOP");
  fail = true;
  await assert.rejects(p.expose(b.leaseId!, "HOP"), /disk full/);
  assert.equal(b.state, "leased", "not saved: back as it was, so nothing needs retiring");
  assert.equal(b.exposedValue, undefined);
  assert.equal(b.hop, "HOP");
  fail = false;
  await p.expose(b.leaseId!, "HOP");
  assert.equal(b.state, "exposed", "tried again later, it goes");
});

test("one payment sent now holds one lease however often it asks, and asking alone grows the pool only a little", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  await p.tick();
  const size = p.status().total;
  assert.equal(size, 16);
  const first = p.lease({ owner: "send:samepayment", ttlMs: 60_000, scheduled: false, ip: "net1" })!;
  for (let i = 0; i < 20; i++) assert.equal(p.lease({ owner: "send:samepayment", ttlMs: 60_000, scheduled: false, ip: "net1" })!.leaseId, first.leaseId);
  assert.equal(p.status().leased, 1);
  for (let i = 0; i < 10; i++) p.lease({ owner: `send:other${i}`, ttlMs: 60_000, scheduled: false });
  assert.equal(p.target(), Math.ceil(11 * 1.2) + 16, "a busy spell grows the pool a little");
  // however many are asked for, unbound leases count only up to a few dozen
  for (let i = 0; i < 200; i++) {
    const account = Keypair.generate().publicKey.toBase58();
    p.recs.set(account, { account, n: 10_000 + i, value: hash(9), advancedAt: 0, state: "leased", leaseId: `x${i}`, owner: `send:junk${i}`, until: Date.now() + 60_000 });
  }
  assert.equal(p.target(), Math.ceil(32 * 1.2) + 16);
});

test("after the relayer's key changes, nonces made under the old authority are left out and new ones made", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const old = new Set(p.recs.keys());
  const job = p.lease({ owner: "job:aa", tokenHash: "t", ttlMs: 60_000, scheduled: true })!;
  p.bind(job.leaseId!, "job:aa");
  const other = nonceAuthorityFrom(Keypair.generate().secretKey);
  const q = pool(chain, { min: 4, auth: other });
  q.adopt(p.serialize());
  await q.tick();
  await q.tick();
  for (const a of old) assert.equal(q.recs.has(a), false, "an old-authority nonce is never handed out");
  assert.equal(q.get(job.leaseId), undefined, "its job's lease is gone (the job goes stale and its owner's app signs again)");
  assert.equal(q.status().free, 16, "new ones under the current authority");
  for (const r of q.recs.values()) assert.equal(r.account, nonceAddress(other.publicKey, r.n).toBase58());
  // one at a current seed address that turns out to be under another authority is left out too
  const odd = [...q.recs.values()][0];
  chain.accounts.get(odd.account)!.data = nonceData(authority.publicKey, hash(200));
  await q.reconcile();
  assert.equal(q.recs.has(odd.account), false);
});

test("until App Storage's copy is in, no nonce is handed out, freed, retired or made", async () => {
  const chain = fakeChain();
  let restoring = true;
  const p = pool(chain, { min: 4, restoring: () => restoring });
  await p.tick();
  assert.equal(chain.sent.length, 0, "nothing made yet");
  assert.equal(p.lease({ owner: "send:1", ttlMs: 60_000, scheduled: false }), null);
  restoring = false;
  await p.tick();
  assert.equal(p.status().free, 12);
  // past the grace, it goes on without it
  const q = pool(chain, { min: 4, restoring: () => true });
  q.begin(Date.now() - 11 * 60_000);
  await q.tick();
  assert.ok(q.status().total > 0);
});

test("a late copy from storage puts back the leases a start had only found on-chain", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const job = p.lease({ owner: "job:ee", tokenHash: "t", ttlMs: 60_000, scheduled: true })!;
  p.bind(job.leaseId!, "job:ee");
  const exposed = p.lease({ owner: "send:2", ttlMs: 60_000, scheduled: false })!;
  await p.expose(exposed.leaseId!, "HOP");
  // a start that read nothing from storage finds them all on-chain, as placeholders to retire
  const q = pool(chain, { min: 4 });
  await q.reconcile();
  assert.equal(q.recs.get(job.account)!.state, "retiring");
  q.adopt(p.serialize(), true);
  assert.equal(q.recs.get(job.account)!.state, "leased", "the saved lease wins over the placeholder");
  assert.equal(q.get(job.leaseId)?.account, job.account);
  assert.equal(q.recs.get(exposed.account)!.state, "exposed");
  assert.equal(q.recs.get([...q.recs.keys()].find((a) => a !== job.account && a !== exposed.account)!)!.state, "retiring", "free ones stay retiring");
});

test("a pool whose saved copy was lost is found whole on-chain, past its first seeds", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 30 });
  for (let i = 0; i < 4; i++) await p.tick();
  assert.equal(p.status().total, 30);
  const q = pool(chain, { min: 4 });
  await q.reconcile();
  assert.equal(q.status().total, 30);
  assert.equal(q.status().retiring, 30, "every one retired before reuse");
});

test("making nonces: the seed counter is saved first, and an address already there is never made over", async () => {
  const chain = fakeChain();
  let fail = true;
  const p = pool(chain, {
    min: 4,
    saveNow: async () => {
      if (fail) throw new Error("disk full");
    },
  });
  await p.tick();
  assert.equal(chain.sent.length, 0, "nothing sent when the counter couldn't be saved");
  assert.equal(JSON.parse(p.serialize()).next, 0);
  // someone funded seed 2's address; a creation nobody saw land left a nonce of the pool's at seed 5
  const junk = nonceAddress(authority.publicKey, 2).toBase58();
  chain.accounts.set(junk, { data: new Uint8Array(0), finalized: new Uint8Array(0) });
  const mine = nonceAddress(authority.publicKey, 70).toBase58();
  fail = false;
  const q = pool(chain, { min: 4 });
  await q.reconcile();
  chain.accounts.set(nonceAddress(authority.publicKey, 5).toBase58(), { data: nonceData(authority.publicKey, hash(220)), finalized: nonceData(authority.publicKey, hash(220)) });
  chain.accounts.set(mine, { data: nonceData(authority.publicKey, hash(221)), finalized: nonceData(authority.publicKey, hash(221)) });
  await q.tick();
  assert.equal(q.recs.has(junk), false, "skipped");
  assert.equal(q.recs.get(nonceAddress(authority.publicKey, 5).toBase58())?.state, "retiring", "one of the pool's: retired before use");
  for (const tx of chain.sent) {
    for (const ix of tx.instructions) {
      if (!ix.programId.equals(SystemProgram.programId) || SystemInstruction.decodeInstructionType(ix) !== "CreateWithSeed") continue;
      const made = SystemInstruction.decodeCreateWithSeed(ix).newAccountPubkey.toBase58();
      assert.notEqual(made, junk);
      assert.notEqual(made, nonceAddress(authority.publicKey, 5).toBase58());
    }
  }
});

test("a pool far bigger than it needs for hours closes the extra free nonces, and their rent goes back to the relayer", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 60 });
  for (let i = 0; i < 6; i++) await p.tick();
  assert.equal(p.status().total, 60);
  (p as unknown as { opts: { min: number } }).opts.min = 4;
  const now = Date.now();
  await p.tick(now);
  assert.equal(p.status().total, 60, "not at once: a busy spell may come back");
  await p.tick(now + 6 * 3600_000 + 1);
  assert.equal(p.status().total, 50, "ten per transaction, newest seeds first");
  assert.equal(Math.max(...[...p.recs.values()].map((r) => r.n)), 49);
  await p.tick(now + 6 * 3600_000 + 2);
  assert.equal(p.status().total, 16 + 32, "down to the target and its margin");
  await p.tick(now + 7 * 3600_000);
  assert.equal(p.status().total, 48);
  const close = chain.sent.find((tx) => tx.instructions.some((ix) => ix.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(ix) === "WithdrawNonceAccount"))!;
  assert.deepEqual(signedBy(close).sort(), [payer.publicKey.toBase58(), authority.publicKey.toBase58()].sort());
  for (const ix of close.instructions.filter((x) => x.programId.equals(SystemProgram.programId))) {
    const w = SystemInstruction.decodeNonceWithdraw(ix);
    assert.equal(w.toPubkey.toBase58(), payer.publicKey.toBase58(), "the rent goes back to the relayer");
  }
  const msg = close.compileMessage();
  assert.equal(msg.isAccountWritable(msg.accountKeys.findIndex((k) => k.equals(authority.publicKey))), false, "N is never debited");
  const full = buildClose(payer.publicKey, authority.publicKey, Array.from({ length: 10 }, (_, i) => ({ account: nonceAddress(authority.publicKey, i), lamports: 1_447_680n })), hash(7), 1000);
  full.sign(payer, authority);
  assert.ok(full.serialize().length <= 1232, "ten fit in one transaction");
});

test("lapsed leases go back; job leases follow their job; leases a delivery took follow it", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 6 });
  await p.tick();
  const now = Date.now();
  const lapsed = p.lease({ owner: "send:1", ttlMs: 1000, scheduled: false }, now - 5000)!;
  const job = p.lease({ owner: "job:bb", tokenHash: "t", ttlMs: 60_000, scheduled: true })!;
  assert.equal(p.bind(job.leaseId!, "job:bb"), true);
  assert.equal(p.bind(job.leaseId!, "job:cc"), false, "only to its own job");
  const taken = p.lease({ owner: "send:2", ttlMs: 1000, scheduled: false }, now - 5000)!;
  await p.take(taken.leaseId!, "HOP2");
  let jobLive: boolean | null = true;
  let hopOpen: boolean | null = true;
  p.hooks.ownerLive = () => jobLive;
  p.hooks.hopPending = () => hopOpen;
  await p.tick();
  assert.equal(lapsed.state, "free", "never taken up: lapsed");
  assert.equal(job.state, "leased", "its job still waits");
  assert.equal(taken.state, "leased", "its delivery is still going, past the time limit");
  jobLive = null;
  hopOpen = null;
  await p.tick();
  assert.equal(job.state, "leased", "unknown is never taken as gone");
  assert.equal(taken.state, "leased");
  jobLive = false;
  hopOpen = false;
  await p.tick();
  assert.equal(job.state, "free");
  assert.equal(taken.state, "free");
});

test("after a restart, unused leases for payments sent now go back, and nonces the saved pool lost are retired before reuse", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 8 });
  await p.tick();
  const total = p.status().total;
  const unused = p.lease({ owner: "send:1", ttlMs: 60_000, scheduled: false })!;
  const taken = p.lease({ owner: "send:2", ttlMs: 60_000, scheduled: false })!;
  await p.take(taken.leaseId!, "HOP");
  const job = p.lease({ owner: "job:dd", tokenHash: "t", ttlMs: 60_000, scheduled: true })!;
  // the saved pool lost two of its nonces (say, a copy saved before they were made)
  const saved = JSON.parse(p.serialize()) as { recs: { account: string }[] };
  const lost = saved.recs.filter((r) => r.account !== unused.account && r.account !== taken.account && r.account !== job.account).slice(0, 2);
  saved.recs = saved.recs.filter((r) => !lost.includes(r));
  const q = pool(chain, { min: 8 });
  q.adopt(JSON.stringify(saved));
  await q.reconcile();
  assert.equal(q.recs.get(unused.account)!.state, "free");
  assert.equal(q.recs.get(taken.account)!.state, "leased", "a delivery took it");
  assert.equal(q.recs.get(job.account)!.state, "leased");
  for (const l of lost) assert.equal(q.recs.get(l.account)?.state, "retiring", "found again on-chain, retired before reuse");
  assert.equal(q.status().total, total);
  // merged later from storage: nothing held here is replaced
  q.adopt(p.serialize(), true);
  for (const l of lost) assert.equal(q.recs.get(l.account)?.state, "retiring");
});

test("a pool the network won't stock waits before trying again, and no lease is handed out when none is free", async () => {
  const chain = fakeChain({ refuse: true });
  const p = pool(chain, { min: 4 });
  await p.tick();
  assert.equal(p.status().total, 0);
  const tries = chain.sent.length;
  await p.tick();
  assert.equal(chain.sent.length, tries, "backed off");
  assert.equal(p.lease({ owner: "send:1", ttlMs: 1000, scheduled: false }), null);
});

test("one network can't hold every nonce through payments it never sends", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 70, max: 200 });
  for (let i = 0; i < 20; i++) await p.tick();
  assert.ok(p.status().free >= 61);
  for (let i = 0; i < 60; i++) assert.ok(p.lease({ owner: `send:${i}`, ttlMs: 60_000, scheduled: false, ip: "net1" }));
  assert.throws(() => p.lease({ owner: "send:x", ttlMs: 60_000, scheduled: false, ip: "net1" }), (e: { status?: number }) => e.status === 429);
  assert.ok(p.lease({ owner: "send:y", ttlMs: 60_000, scheduled: false, ip: "net2" }), "others still can");
});

test("a delivery that landed before its lease was let go costs no RETIRE, and the nonce is free with the value the chain holds", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const lease = p.lease({ owner: "job:aaaaaaaaaaaaaaaaaaaaaaaa", ttlMs: 60_000, scheduled: true })!;
  p.bind(lease.leaseId!, "job:aaaaaaaaaaaaaaaaaaaaaaaa");
  await p.expose(lease.leaseId!, "HOP");
  // the N2 lands (confirmed, not final yet) and the ledger lets the lease go
  const a = chain.accounts.get(lease.account)!;
  a.data = nonceData(authority.publicKey, hash(200));
  p.release(lease.leaseId!);
  await p.tick(Date.now() + 40_000);
  assert.equal(retires(chain), 0, "already moved on: nothing to advance");
  assert.equal(lease.state, "retiring", "free only once that is final");
  a.finalized = a.data;
  await p.tick(Date.now() + 80_000);
  assert.equal(lease.state, "free");
  assert.equal(lease.value, hash(200), "the value the next payment signs over is the chain's");
});

test("a retiring nonce is freed with the newest value even when its own RETIRE is not final yet", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const lease = p.lease({ owner: "send:1", ttlMs: 60_000, scheduled: false })!;
  await p.expose(lease.leaseId!, "HOP");
  p.release(lease.leaseId!);
  await p.tick(Date.now() + 40_000);
  assert.equal(retires(chain), 1, "its delivery may still land: advanced here");
  const a = chain.accounts.get(lease.account)!;
  const advanced = a.data;
  // the delivery landed first after all and is final; the RETIRE moved it again, only confirmed so far
  a.finalized = nonceData(authority.publicKey, hash(201));
  await p.tick(Date.now() + 80_000);
  assert.equal(lease.state, "free");
  assert.equal(lease.value, bs58.encode(advanced.slice(40, 72)), "the confirmed value, never the older final one");
  assert.equal(retires(chain), 1);
});

test("a lease about to be handed out is read again, so one whose value moved on unseen is signed over the chain's", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const lease = p.lease({ owner: "job:bbbbbbbbbbbbbbbbbbbbbbbb", ttlMs: 60_000, scheduled: true })!;
  const before = lease.value;
  assert.equal((await p.confirmValue(lease)).value, before, "unchanged when the chain agrees");
  chain.accounts.get(lease.account)!.data = nonceData(authority.publicKey, hash(202));
  assert.equal((await p.confirmValue(lease)).value, hash(202));
  // the network couldn't say: kept as it was
  const broken = { ...chain, read: async () => Promise.reject(new Error("429")) } as NonceChain;
  const q = pool(broken, { min: 0 });
  q.recs.set(lease.account, { ...lease });
  assert.equal((await q.confirmValue(q.recs.get(lease.account)!)).value, hash(202));
});

test("a note holds one lease not taken up at a time, however many ids ask for it", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 70, max: 200 });
  for (let i = 0; i < 20; i++) await p.tick();
  const free = p.status().free;
  const note = "ab".repeat(32);
  for (let i = 0; i < 40; i++) {
    const id = i.toString(16).padStart(24, "0");
    assert.ok(p.lease({ owner: `job:${id}`, tokenHash: "t", ttlMs: 60_000, scheduled: true, nullifiers: [note, randomHex()] }));
  }
  assert.equal(p.status().leased, 1, "each new id let the one before go");
  assert.equal(p.status().free, free - 1);
  // a payment sent now with the same note (a fresh proof has a new padding note): also one at a time
  for (let i = 0; i < 5; i++) p.lease({ owner: `send:${i}`, ttlMs: 60_000, scheduled: false, nullifiers: [note, randomHex()] });
  assert.equal(p.status().leased, 1);
  // a lease a payment took up is never let go this way
  const kept = p.lease({ owner: "job:" + "c".repeat(24), tokenHash: "t", ttlMs: 60_000, scheduled: true, nullifiers: [note, randomHex()] })!;
  p.bind(kept.leaseId!, "job:" + "c".repeat(24));
  p.lease({ owner: "job:" + "d".repeat(24), tokenHash: "t", ttlMs: 60_000, scheduled: true, nullifiers: [note, randomHex()] });
  assert.equal(kept.state, "leased");
  assert.equal(p.get(kept.leaseId!), kept);
});

test("one network holds only a few payments being scheduled at once", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 70, max: 200 });
  for (let i = 0; i < 20; i++) await p.tick();
  for (let i = 0; i < 12; i++) assert.ok(p.lease({ owner: `job:${i}`, tokenHash: "t", ttlMs: 60_000, scheduled: true, ip: "net1" }));
  assert.throws(() => p.lease({ owner: "job:x", tokenHash: "t", ttlMs: 60_000, scheduled: true, ip: "net1" }), (e: { status?: number }) => e.status === 429);
  assert.ok(p.lease({ owner: "send:now", ttlMs: 60_000, scheduled: false, ip: "net1" }), "a payment sent now still can");
  assert.ok(p.lease({ owner: "job:y", tokenHash: "t", ttlMs: 60_000, scheduled: true, ip: "net2" }), "others still can");
});

test("a lease a delivery took is saved before the delivery goes, so a restart from what was saved keeps it", async () => {
  const chain = fakeChain();
  let saved = "";
  let fail = false;
  const p: NoncePool = new NoncePool(authority, payer, chain, {
    min: 4,
    max: 100,
    priority: 1000,
    save: () => {},
    saveNow: async () => {
      if (fail) throw new Error("disk full");
      saved = p.serialize();
    },
  });
  await p.tick();
  const lease = p.lease({ owner: "send:abc", ttlMs: 60_000, scheduled: false, ip: "net1" })!;
  fail = true;
  await assert.rejects(p.take(lease.leaseId!, "HOP"), /disk full/);
  assert.equal(lease.hop, undefined, "not saved: back as it was");
  assert.ok(lease.until);
  fail = false;
  await p.take(lease.leaseId!, "HOP");
  const q = pool(chain, { min: 4 });
  q.adopt(saved);
  assert.equal(q.recs.get(lease.account)!.state, "leased", "the delivery's nonce isn't freed by a restart");
  assert.equal(q.recs.get(lease.account)!.hop, "HOP");
});

test("nonces whose CREATE showed only after the read are taken in once they appear", async () => {
  const chain = fakeChain();
  let hide = 0;
  const lagging: NonceChain = {
    ...chain,
    read: async (list, c) => (hide > 0 ? (hide--, list.map(() => null)) : chain.read(list, c)),
    // the CREATE landed, but its answer timed out and the read right after it lags
    send: async (tx) => {
      await chain.send(tx);
      hide = 1;
      return false;
    },
  };
  const p = pool(lagging, { min: 4 });
  await p.tick();
  assert.equal(p.status().total, 0);
  assert.equal(chain.accounts.size, 4, "made on-chain");
  await p.tick();
  assert.equal(p.status().free, 4, "found and taken in, with no restart");
  assert.equal(chain.sent.length, 1, "and not made again");
});

test("a nonce found on-chain whose finalized read lags behind its confirmed one is never freed with the older value", async () => {
  const chain = fakeChain();
  const p = pool(chain, { min: 4 });
  await p.tick();
  const r = [...p.recs.values()].find((x) => x.state === "free")!;
  const a = chain.accounts.get(r.account)!;
  // an advance only confirmed so far: the start found it at its confirmed value
  const old = a.data;
  a.data = nonceData(authority.publicKey, hash(203));
  a.finalized = old;
  Object.assign(r, { state: "retiring", value: hash(203), exposedValue: hash(203) });
  await p.tick(Date.now() + 40_000);
  assert.equal(r.state, "retiring", "not free on a finalized read that is only behind");
  assert.equal(retires(chain), 1, "still holding the value it was found at: advanced here");
  chain.finalize();
  await p.tick(Date.now() + 80_000);
  assert.equal(r.state, "free");
  assert.equal(r.value, bs58.encode(a.data.slice(40, 72)));
});
