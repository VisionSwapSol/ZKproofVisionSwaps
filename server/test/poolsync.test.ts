import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, type TransactionInstruction } from "@solana/web3.js";
import { EVENT_DISC, Frontier, H2, MerkleTree, Pool, concat, hex, toBE, toLE } from "@visionswap/sdk";
import { PoolStore } from "../src/store.ts";
import { Follower, txEvents, type Chain, type ChainState, type Ix, type PendingAcct, type Sig, type TxView } from "../src/poolsync.ts";

const pool = new Pool(Keypair.generate().publicKey);
const PID = pool.programId.toBase58();
const treasury = Keypair.generate().publicKey;
const relayer = Keypair.generate().publicKey;
const meta = (n: number) => new Uint8Array(28).fill(n);
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const ixOf = (ix: TransactionInstruction): Ix => ({
  program: ix.programId.toBase58(),
  accounts: ix.keys.map((k) => k.pubkey.toBase58()),
  data: new Uint8Array(ix.data),
});
const innerHex = (inner: bigint) => hex(toBE(inner));

/** A pool on a pretend chain: transactions in order, and the tree and waiting room they leave behind. */
class FakeChain implements Chain {
  txs: TxView[] = [];
  tree = new MerkleTree();
  roots: bigint[] = new Array(256).fill(0n);
  rootIndex = 0;
  pendingLamports = 0n;
  live = new Map<string, PendingAcct>();
  slot = 100;
  failNext = 0;
  txCalls = 0;

  constructor() {
    this.roots[0] = this.tree.root();
  }
  private insert(leaf: bigint) {
    this.tree.append([leaf]);
    this.rootIndex = (this.rootIndex + 1) % 256;
    this.roots[this.rootIndex] = this.tree.root();
  }
  private open: TxView | null = null;
  private push(ixs: Ix[], logs: string[]): TxView {
    if (this.open) {
      this.open.ixs.push(...ixs);
      this.open.logs.push(...logs);
      return this.open;
    }
    const v: TxView = { signature: `sig${this.txs.length}`, slot: ++this.slot, blockTime: 1_700_000_000, failed: false, logs, ixs };
    this.txs.push(v);
    return v;
  }
  /** several pool instructions in one transaction */
  together(fn: () => void): TxView {
    this.open = { signature: `sig${this.txs.length}`, slot: this.slot + 1, blockTime: 1_700_000_000, failed: false, logs: [], ixs: [] };
    try {
      fn();
    } finally {
      this.txs.push(this.open);
      this.slot++;
    }
    const v = this.open;
    this.open = null;
    return v;
  }
  /** the newest transactions this many are not listed yet (a node whose signature list lags its accounts) */
  lag = 0;
  private logs(events: Uint8Array[], cut: boolean) {
    if (cut) return [`Program ${PID} invoke [1]`, "Log truncated"];
    return [`Program ${PID} invoke [1]`, ...events.map((e) => `Program data: ${b64(e)}`), `Program ${PID} success`];
  }

  deposit(amount: bigint, inner: bigint, tag: Uint8Array, cut = false) {
    const depositor = Keypair.generate().publicKey;
    const ix = pool.deposit({ depositor, amount, inner, meta: tag, attestationExpiry: 0n, maxFeeBps: 0 });
    this.live.set(pool.pending(inner).toBase58(), { depositor: depositor.toBase58(), amount, slot: BigInt(this.slot + 1), meta: tag });
    this.pendingLamports += amount;
    const ev = concat(EVENT_DISC.DepositQueued, depositor.toBytes(), toLE(amount, 8), toBE(inner), toLE(BigInt(this.slot + 1), 8));
    return this.push([ixOf(ix)], this.logs([ev], cut));
  }
  settle(amount: bigint, inner: bigint, tag: Uint8Array, cut = false) {
    const pda = pool.pending(inner);
    const depositor = Keypair.generate().publicKey;
    this.live.delete(pda.toBase58());
    this.pendingLamports -= amount;
    const leaf = H2(amount, inner);
    const index = this.tree.size;
    this.insert(leaf);
    const ev = concat(EVENT_DISC.DepositSettled, toLE(BigInt(index), 8), toBE(leaf), toLE(amount, 8), tag, toBE(this.tree.root()));
    return this.push([ixOf(pool.settle(pda, depositor, treasury))], this.logs([ev], cut));
  }
  refund(amount: bigint, inner: bigint, cut = false) {
    const pda = pool.pending(inner);
    this.live.delete(pda.toBase58());
    this.pendingLamports -= amount;
    const who = Keypair.generate().publicKey;
    const ev = concat(EVENT_DISC.DepositRefunded, who.toBytes(), toLE(amount, 8), toBE(inner), new Uint8Array([0]));
    return this.push([ixOf(pool.refund(who, pda, who))], this.logs([ev], cut));
  }
  spend(c: [bigint, bigint], n: [bigint, bigint], withdraw: bigint, cut = false) {
    const ix = pool.transact(
      {
        proof: new Uint8Array(256),
        root: this.tree.root(),
        nullifiers: n,
        commitments: c,
        ext: { recipient: Keypair.generate().publicKey, relayer, withdraw, relayerFee: 0n, maxFeeBps: 0, meta0: meta(7), meta1: meta(8) },
      },
      treasury,
    );
    const index = this.tree.size;
    this.insert(c[0]);
    this.insert(c[1]);
    const ev = concat(
      EVENT_DISC.Spent,
      toLE(BigInt(index), 8),
      toBE(c[0]),
      toBE(c[1]),
      meta(7),
      meta(8),
      toBE(n[0]),
      toBE(n[1]),
      toLE(withdraw, 8),
      toBE(this.tree.root()),
    );
    return this.push([ixOf(ix)], this.logs([ev], cut));
  }
  /** a cheap transaction that only lists the program among its accounts */
  noise() {
    return this.push([{ program: "11111111111111111111111111111111", accounts: [PID], data: new Uint8Array(4) }], []);
  }

  async signatures(until: string | null): Promise<Sig[]> {
    const from = until ? this.txs.findIndex((t) => t.signature === until) + 1 : 0;
    return this.txs
      .slice(0, this.txs.length - this.lag)
      .slice(from)
      .map((t) => ({ signature: t.signature, slot: t.slot, err: null }))
      .reverse();
  }
  async transactions(sigs: string[]) {
    this.txCalls++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("429 Too Many Requests");
    }
    return sigs.map((s) => this.txs.find((t) => t.signature === s) ?? null);
  }
  async state(accounts: string[]): Promise<ChainState> {
    return {
      slot: this.slot,
      nextIndex: this.tree.size,
      pendingLamports: this.pendingLamports,
      roots: [...this.roots],
      pending: new Map(accounts.map((a) => [a, this.live.get(a) ?? null])),
    };
  }
  pdaOf(inner: string) {
    return pool.pending(BigInt("0x" + inner)).toBase58();
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vs-sync-"));
  const chain = new FakeChain();
  const store = new PoolStore(dir, PID);
  const f = new Follower(store, chain, PID, "test");
  const again = () => ((f as unknown as { retryAt: number }).retryAt = 0);
  return { dir, chain, store, f, again };
}

test("events lost to a cut-short log are rebuilt from the pool's instructions", async () => {
  const { dir, chain, store, f } = setup();
  try {
    chain.deposit(2_000_000_000n, 11n, meta(1)); // full logs: the note tag comes from the instruction
    chain.deposit(1_000_000_000n, 12n, meta(2), true);
    chain.settle(2_000_000_000n, 11n, meta(1), true);
    chain.settle(1_000_000_000n, 12n, meta(2), true);
    chain.spend([501n, 502n], [901n, 902n], 300_000_000n, true);
    chain.deposit(5_000_000n, 13n, meta(3), true);
    chain.refund(5_000_000n, 13n, true);
    chain.spend([503n, 504n], [903n, 904n], 0n); // full logs again: their root confirms everything before

    await f.syncOnce();
    assert.equal(f.stuck, null);
    assert.equal(store.count, 6);
    assert.equal(store.frontier.root, chain.tree.root());
    assert.equal(store.pending.size, 0);
    assert.ok(store.isSpent(901n) && store.isSpent(904n));
    assert.equal(f.rebuiltTxs, 6);
    assert.ok(f.done(), "checked against the chain's root");
    assert.deepEqual(store.leafRange(0, 1).subarray(32), Buffer.from(meta(1)), "the leaf keeps its note tag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a busy RPC never wipes the index; it waits and carries on", async () => {
  const { dir, chain, store, f, again } = setup();
  try {
    chain.deposit(1_000_000_000n, 21n, meta(1));
    chain.settle(1_000_000_000n, 21n, meta(1));
    await f.syncOnce();
    assert.equal(store.count, 1);
    const sig = store.lastSig;

    chain.spend([601n, 602n], [911n, 912n], 0n);
    chain.failNext = 1;
    again();
    await f.syncOnce();
    assert.equal(store.count, 1, "nothing lost");
    assert.equal(store.lastSig, sig);
    assert.match(f.lastError ?? "", /429/);
    assert.deepEqual(store.leafRange(0, 1).length, 60, "the last good copy keeps serving");

    await f.syncOnce();
    assert.equal(store.count, 1, "waits before the next try");
    again();
    await f.syncOnce();
    assert.equal(store.count, 3);
    assert.equal(f.lastError, null);
    assert.equal(store.frontier.root, chain.tree.root());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transaction that can't be applied stops the index there instead of resetting it", async () => {
  const { dir, chain, store, f, again } = setup();
  try {
    chain.deposit(1_000_000_000n, 31n, meta(1));
    chain.settle(1_000_000_000n, 31n, meta(1));
    await f.syncOnce();
    const sig = store.lastSig;
    // a deposit the index never saw (its own transaction is missing here), settled with a cut-short log
    chain.live.set(pool.pending(32n).toBase58(), { depositor: relayer.toBase58(), amount: 7_000_000n, slot: 1n, meta: meta(2) });
    chain.pendingLamports += 7_000_000n;
    const bad = chain.settle(7_000_000n, 32n, meta(2), true);
    chain.spend([701n, 702n], [921n, 922n], 0n);

    await f.syncOnce();
    assert.equal(f.stuck?.signature, bad.signature);
    assert.equal(store.count, 1, "kept, not reset");
    assert.equal(store.lastSig, sig);
    assert.ok(f.behind >= 2);
    assert.equal(f.status().stuckAt, bad.signature);

    // the same again on retry: still stuck, still serving
    again();
    await f.syncOnce();
    assert.equal(store.count, 1);
    assert.equal(f.stuck?.signature, bad.signature);
    assert.equal(f.needsRebuild(), false, "not yet: waiting first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transactions that change nothing in the pool are passed over without reading them", async () => {
  const { dir, chain, store, f } = setup();
  try {
    chain.deposit(1_000_000_000n, 41n, meta(1));
    await f.syncOnce();
    const calls = chain.txCalls;
    for (let i = 0; i < 500; i++) chain.noise();
    await f.syncOnce();
    assert.equal(chain.txCalls, calls, "no transaction was fetched");
    assert.equal(store.lastSig, chain.txs[chain.txs.length - 1].signature);
    assert.equal(f.skipped, 500);
    assert.equal(store.pending.size, 1);

    // noise followed by a real settle: everything is read again
    for (let i = 0; i < 30; i++) chain.noise();
    chain.settle(1_000_000_000n, 41n, meta(1));
    await f.syncOnce();
    assert.equal(store.count, 1);
    assert.equal(store.pending.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a waiting deposit whose account vanished unseen is eventually dropped", async () => {
  const { dir, chain, store, f, again } = setup();
  try {
    chain.deposit(1_000_000_000n, 51n, meta(1));
    await f.syncOnce();
    assert.equal(store.pending.size, 1);
    // its refund never reaches the index (as with a lost log line before this fix)
    chain.live.clear();
    chain.pendingLamports = 0n;
    const realNow = Date.now;
    try {
      for (const dt of [0, 30_000, 61_000, 122_000]) {
        Date.now = () => realNow() + dt;
        again();
        (f as unknown as { rounds: number }).rounds = 0; // make every round look at the chain
        await f.syncOnce();
      }
    } finally {
      Date.now = realNow;
    }
    assert.equal(store.pending.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("logs that disagree with the instructions are refused, not guessed at", () => {
  const chain = new FakeChain();
  const v = chain.spend([801n, 802n], [931n, 932n], 0n);
  const wrong: TxView = { ...v, ixs: [] };
  assert.throws(() => txEvents(wrong, PID, { count: 0, frontier: new Frontier() }, () => null));
});

test("the store loads a damaged copy as empty, trims files that ran ahead, and applies all or nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "vs-store2-"));
  try {
    const s = new PoolStore(dir, "ProgX");
    const tree = new MerkleTree();
    s.apply([{ kind: "queued", depositor: "D", amount: 5n, inner: 61n, slot: 1n, meta: meta(4) }], 1, "a", 1);
    assert.equal(s.pending.get(innerHex(61n))?.meta, hex(meta(4)));
    tree.append([H2(5n, 61n)]);
    s.apply([{ kind: "settled", index: 0, leaf: H2(5n, 61n), amount: 5n, meta: meta(4), root: tree.root() }], 2, "b", 2);
    s.save();

    // all or nothing: a good spend followed by a gap leaves no trace
    const before = { count: s.count, root: s.frontier.root, nf: s.nfCount };
    s.apply([{ kind: "queued", depositor: "E", amount: 9n, inner: 62n, slot: 3n }], 3, "c", 3);
    tree.append([71n, 72n]);
    assert.throws(() =>
      s.apply(
        [
          { kind: "refunded", depositor: "E", amount: 9n, inner: 62n, byGuard: false },
          { kind: "spent", index: 1, commitments: [71n, 72n], metas: [meta(1), meta(2)], nullifiers: [1n, 2n], withdraw: 0n, root: tree.root() },
          { kind: "settled", index: 9, leaf: 1n, amount: 1n, meta: meta(0), root: 0n },
        ],
        4,
        "d",
        4,
      ),
    );
    assert.deepEqual({ count: s.count, root: s.frontier.root, nf: s.nfCount }, before);
    assert.ok(s.pending.has(innerHex(62n)), "the refund was undone too");
    assert.ok(!s.isSpent(1n));
    assert.equal(s.lastSig, "c");

    // files appended past the last save (a crash mid-way) are cut back on load
    appendFileSync(join(dir, "leaves.bin"), Buffer.alloc(120));
    const again = new PoolStore(dir, "ProgX");
    assert.equal(again.count, 1);
    assert.equal(statSync(join(dir, "leaves.bin")).size, 60);
    assert.equal(again.frontier.root, s.frontier.root);

    // a damaged state file no longer stops the server: it rebuilds instead
    writeFileSync(join(dir, "state.json"), "{ not json");
    const damaged = new PoolStore(dir, "ProgX");
    assert.equal(damaged.count, 0);
    assert.equal(damaged.lastSig, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an index that disagrees with the chain's root is rebuilt aside and swapped in", async () => {
  const { dir, chain, store, f, again } = setup();
  const aside = mkdtempSync(join(tmpdir(), "vs-rebuild-"));
  try {
    chain.deposit(1_000_000_000n, 81n, meta(1));
    chain.settle(1_000_000_000n, 81n, meta(1));
    // a copy that went wrong somehow: right length, wrong leaf
    const wrong = new Frontier();
    wrong.insert(12345n);
    store.apply([{ kind: "settled", index: 0, leaf: 12345n, amount: 1n, meta: meta(9), root: wrong.root }], 1, "x", 1);
    store.advance(chain.txs[chain.txs.length - 1].signature, chain.slot);

    await f.syncOnce();
    again();
    await f.syncOnce();
    assert.ok(f.needsRebuild());
    assert.equal(store.count, 1, "the old copy keeps serving meanwhile");

    const r = new Follower(new PoolStore(aside, PID), chain, PID, "rebuild");
    await r.syncOnce();
    assert.ok(r.done());
    store.adopt(r.store);
    f.restart();
    assert.equal(store.frontier.root, chain.tree.root());
    await f.syncOnce();
    assert.ok(f.done() && !f.needsRebuild());
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(aside, { recursive: true, force: true });
  }
});

test("a deposit indexed without its note tag picks it up from its account before a rebuilt settle", async () => {
  const { dir, chain, store, f } = setup();
  try {
    chain.deposit(3_000_000n, 91n, meta(5));
    await f.syncOnce();
    const p = store.pending.get(innerHex(91n))!;
    delete p.meta; // as saved by an older version
    (f as unknown as { rounds: number }).rounds = 0; // the first look after a restart reads the waiting room
    await f.syncOnce();
    assert.ok(p.meta);
    chain.settle(3_000_000n, 91n, meta(5), true);
    await f.syncOnce();
    assert.equal(f.stuck, null);
    assert.equal(store.count, 1);
    assert.equal(store.frontier.root, chain.tree.root());
    assert.deepEqual(store.leafRange(0, 1).subarray(32), Buffer.from(meta(5)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deposit refunded and made again under the same id in one transaction is read, not passed over", async () => {
  const { dir, chain, store, f } = setup();
  try {
    chain.deposit(3_000_000_000n, 101n, meta(1));
    await f.syncOnce();
    const before = store.pending.get(innerHex(101n))!.depositor;
    // same id, a smaller amount from someone else, and a second deposit making up the difference:
    // leaves, waiting lamports and "the account is there" all look unchanged
    chain.together(() => {
      chain.refund(3_000_000_000n, 101n);
      chain.deposit(1_000_000_000n, 101n, meta(2));
      chain.deposit(2_000_000_000n, 102n, meta(3));
    });
    await f.syncOnce();
    assert.equal(f.skipped, 0, "not passed over");
    const p = store.pending.get(innerHex(101n))!;
    assert.notEqual(p.depositor, before);
    assert.equal(p.amount, "1000000000");
    assert.ok(store.pending.has(innerHex(102n)));

    // its settle, with the log cut short, rebuilds the leaf the chain really inserted
    chain.settle(1_000_000_000n, 101n, meta(2), true);
    await f.syncOnce();
    assert.equal(f.stuck, null);
    assert.equal(store.frontier.root, chain.tree.root());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rebuilt transaction that doesn't land on a root the chain has had is not applied", async () => {
  const { dir, chain, store, f } = setup();
  try {
    chain.deposit(4_000_000_000n, 111n, meta(1));
    await f.syncOnce();
    const sig = store.lastSig;
    store.pending.get(innerHex(111n))!.amount = "5000000000"; // a stale record, however it came about
    const bad = chain.settle(4_000_000_000n, 111n, meta(1), true);
    await f.syncOnce();
    assert.equal(f.stuck?.signature, bad.signature);
    assert.match(f.stuck?.reason ?? "", /root/);
    assert.equal(store.count, 0, "the wrong leaf was never served");
    assert.equal(store.lastSig, sig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a settle listed after its deposit was dropped can still be rebuilt", async () => {
  const { dir, chain, store, f, again } = setup();
  try {
    chain.deposit(2_000_000_000n, 121n, meta(4));
    await f.syncOnce();
    chain.settle(2_000_000_000n, 121n, meta(4), true);
    chain.lag = 1; // the account is gone, but the node doesn't list the settle yet
    const realNow = Date.now;
    try {
      for (const dt of [0, 30_000, 61_000, 122_000]) {
        Date.now = () => realNow() + dt;
        again();
        (f as unknown as { rounds: number }).rounds = 0;
        await f.syncOnce();
      }
    } finally {
      Date.now = realNow;
    }
    assert.equal(store.pending.size, 0, "dropped");
    chain.lag = 0;
    again();
    await f.syncOnce();
    assert.equal(f.stuck, null);
    assert.equal(store.count, 1);
    assert.equal(store.frontier.root, chain.tree.root());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an index that can't move on for ten minutes reports it", async () => {
  const { dir, chain, f, again } = setup();
  try {
    chain.deposit(1_000_000_000n, 131n, meta(1));
    await f.syncOnce();
    assert.equal(f.status().stalled, false);
    chain.spend([801n, 802n], [941n, 942n], 0n);
    chain.failNext = 100; // an RPC that keeps refusing
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 11 * 60_000;
      again();
      await f.syncOnce();
      assert.ok(f.lastError);
      assert.equal(f.status().stalled, true);
    } finally {
      Date.now = realNow;
    }
    chain.failNext = 0;
    again();
    await f.syncOnce();
    assert.equal(f.status().stalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
