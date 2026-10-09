import type { VersionedTransactionResponse } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { Frontier, H2, META_LEN, Reader, eventsFromLogs, fromBE, hex, unhex, type PoolEvent } from "@visionswap/sdk";
import type { IndexEvent, PendingRec, PoolStore } from "./store.ts";
import { log } from "./log.ts";

/**
 * Follows the pool on-chain and keeps a PoolStore in step with it.
 *
 * Pool events reach us as log lines, and Solana drops log lines past 10 KB.
 * So every pool transaction is also read from its instructions (top-level and
 * inner): when the logs are cut short, the events are rebuilt from the
 * instructions and checked against the tree's on-chain root history.
 *
 * Nothing here ever wipes the index. A failed read is retried with backoff;
 * a transaction that can't be applied stops the follower right before it,
 * while the last good copy keeps serving.
 */

/** One instruction as it ran, with its accounts resolved to addresses. */
export type Ix = { program: string; accounts: string[]; data: Uint8Array };
/** The parts of a transaction the follower reads; instructions in the order they ran. */
export type TxView = { signature: string; slot: number; blockTime: number | null; failed: boolean; logs: string[]; ixs: Ix[] };
export type Sig = { signature: string; slot: number; err: unknown };
/** A waiting-room account as the chain holds it (amount -1 when it can't be read as a deposit). */
export type PendingAcct = { depositor: string; amount: bigint; slot: bigint; meta: Uint8Array };
/** The tree account and some waiting-room accounts, read together at `slot` (null where the account is gone). */
export type ChainState = { slot: number; nextIndex: number; pendingLamports: bigint; roots: bigint[]; pending: Map<string, PendingAcct | null> };

export interface Chain {
  /** pool signatures newer than `until`, newest first */
  signatures(until: string | null): Promise<Sig[]>;
  /** null where the node can't return the transaction yet */
  transactions(sigs: string[]): Promise<(TxView | null)[]>;
  state(pendingAccounts: string[]): Promise<ChainState>;
  /** the waiting-room account of a deposit (`inner` in hex) */
  pdaOf(inner: string): string;
}

export function viewOf(signature: string, tx: VersionedTransactionResponse): TxView {
  const m = tx.transaction.message;
  const la = tx.meta?.loadedAddresses;
  const keys = [...m.staticAccountKeys, ...(la?.writable ?? []), ...(la?.readonly ?? [])].map((k) => k.toBase58());
  const inner = new Map<number, { programIdIndex: number; accounts: number[]; data: string }[]>();
  for (const g of tx.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions);
  const ixs: Ix[] = [];
  m.compiledInstructions.forEach((ix, i) => {
    ixs.push({ program: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((k) => keys[k]), data: ix.data });
    for (const c of inner.get(i) ?? []) {
      ixs.push({ program: keys[c.programIdIndex], accounts: c.accounts.map((k) => keys[k]), data: bs58.decode(c.data) });
    }
  });
  return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, failed: !!tx.meta?.err, logs: tx.meta?.logMessages ?? [], ixs };
}

// ─── the pool's own instructions ───

const disc = (name: string) => sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
const IX = { deposit: disc("deposit"), settle: disc("settle"), refund: disc("refund"), transact: disc("transact") };
const EVENT_OF = { deposit: "queued", settle: "settled", refund: "refunded", transact: "spent" } as const;
type IxName = keyof typeof IX;

/** Which pool instruction this is (by its 8-byte discriminator), if any we index. */
export function nameOf(data: Uint8Array): IxName | null {
  for (const [name, d] of Object.entries(IX) as [IxName, Uint8Array][]) {
    if (data.length >= 8 && d.every((v, i) => data[i] === v)) return name;
  }
  return null;
}

function decodeDeposit(ix: Ix) {
  const r = new Reader(ix.data, 8);
  return { depositor: ix.accounts[0], pending: ix.accounts[4], amount: r.u64(), inner: fromBE(r.bytes(32)), meta: r.bytes(META_LEN) };
}

export type PendingInfo = { depositor: string; amount: bigint; inner: bigint; meta: Uint8Array | null };

/**
 * Rebuilds a transaction's pool events from its instructions, exactly as the
 * program would have logged them: a settle inserts H(amount, inner) of the
 * waiting deposit, a transact inserts its two commitments.
 */
export function eventsFromInstructions(
  view: TxView,
  programId: string,
  at: { count: number; frontier: Frontier },
  pendingAt: (account: string) => PendingInfo | null,
): IndexEvent[] {
  const f = new Frontier(at.frontier.toJSON());
  const local = new Map<string, PendingInfo>(); // deposits made earlier in this same transaction
  const out: IndexEvent[] = [];
  for (const ix of view.ixs) {
    if (ix.program !== programId) continue;
    const name = nameOf(ix.data);
    if (name === "deposit") {
      const d = decodeDeposit(ix);
      local.set(d.pending, { depositor: d.depositor, amount: d.amount, inner: d.inner, meta: d.meta });
      out.push({ kind: "queued", depositor: d.depositor, amount: d.amount, inner: d.inner, slot: BigInt(view.slot), meta: d.meta });
    } else if (name === "settle") {
      const acct = ix.accounts[2];
      const p = local.get(acct) ?? pendingAt(acct);
      if (!p) throw new Error("settle of a deposit the index never saw");
      if (!p.meta) throw new Error("settle of a deposit without its note tag");
      const leaf = H2(p.amount, p.inner);
      const index = f.insert(leaf);
      local.delete(acct);
      out.push({ kind: "settled", index, leaf, amount: p.amount, meta: p.meta, root: f.root });
    } else if (name === "refund") {
      const acct = ix.accounts[4];
      const p = local.get(acct) ?? pendingAt(acct);
      local.delete(acct);
      // a deposit the index doesn't hold has nothing to take out of the waiting room
      if (p) out.push({ kind: "refunded", depositor: p.depositor, amount: p.amount, inner: p.inner, byGuard: ix.accounts[0] !== p.depositor });
    } else if (name === "transact") {
      const r = new Reader(ix.data, 8 + 256 + 32);
      const nullifiers: [bigint, bigint] = [fromBE(r.bytes(32)), fromBE(r.bytes(32))];
      const commitments: [bigint, bigint] = [fromBE(r.bytes(32)), fromBE(r.bytes(32))];
      const withdraw = r.u64();
      r.skip(8 + 2); // relayer fee, fee limit
      const metas: [Uint8Array, Uint8Array] = [r.bytes(META_LEN), r.bytes(META_LEN)];
      const index = f.insert(commitments[0]);
      f.insert(commitments[1]);
      out.push({ kind: "spent", index, commitments, metas, nullifiers, withdraw, root: f.root });
    }
  }
  return out;
}

/**
 * A transaction's pool events. The logs are used when they hold exactly the
 * events its instructions produce; when they were cut short the events are
 * rebuilt. Anything else is an error, never a guess.
 */
export function txEvents(
  view: TxView,
  programId: string,
  at: { count: number; frontier: Frontier },
  pendingAt: (account: string) => PendingInfo | null,
): { events: IndexEvent[]; rebuilt: boolean } {
  if (view.failed) return { events: [], rebuilt: false };
  const mine = view.ixs.filter((ix) => ix.program === programId);
  const logged: PoolEvent[] = eventsFromLogs(view.logs, programId);
  const names = mine.map((ix) => nameOf(ix.data)).filter((n): n is IxName => n !== null);
  const kinds = names.map((n) => EVENT_OF[n]);
  const prefix = logged.length <= kinds.length && logged.every((e, i) => e.kind === kinds[i]);
  if (prefix && logged.length === kinds.length) {
    // the deposit instruction carries the note tag the event leaves out
    const deposits = mine.filter((ix) => nameOf(ix.data) === "deposit").map(decodeDeposit);
    let d = 0;
    const events = logged.map((e): IndexEvent => {
      if (e.kind !== "queued") return e;
      const dep = deposits[d++];
      return dep && dep.inner === e.inner ? { ...e, meta: dep.meta } : e;
    });
    return { events, rebuilt: false };
  }
  const truncated = view.logs.some((l) => l.startsWith("Log truncated"));
  if (!truncated || !prefix) throw new Error("the pool's logs and instructions disagree");
  return { events: eventsFromInstructions(view, programId, at, pendingAt), rebuilt: true };
}

// ─── the follower ───

const CHUNK = 24;
/** the chain keeps the last 256 roots */
const ROOT_HISTORY = 256;

export class Follower {
  /** pool signatures still to read, oldest first */
  queue: Sig[] = [];
  private top: string | null = null;
  private running = false;
  private retryAt = 0;
  private failures = 0;
  private rounds = 0;
  private verifiedCount = -1;
  private mismatches = 0;
  private gone = new Map<string, number>();
  /** waiting deposits dropped from the index lately, so a settle or refund listed late can still be rebuilt */
  private recent = new Map<string, { rec: PendingRec; at: number }>();
  /** when the follower last moved on (applied, passed over, or found nothing new) */
  lastProgress = Date.now();
  stuck: { signature: string; reason: string; since: number; tries: number } | null = null;
  lastOk = 0;
  lastError: string | null = null;
  chainCount = 0;
  /** transactions whose events were rebuilt from their instructions */
  rebuiltTxs = 0;
  /** signatures passed over because the pool was already up to date */
  skipped = 0;

  constructor(
    readonly store: PoolStore,
    private chain: Chain,
    private programId: string,
    private name = "indexer",
  ) {}

  get behind() {
    return this.queue.length;
  }

  /** The index disagrees with the chain in a way waiting won't fix. */
  needsRebuild(): boolean {
    return this.mismatches >= 2 || (!!this.stuck && Date.now() - this.stuck.since > 10 * 60_000);
  }

  /** Caught up with the chain and checked against its root. */
  done(): boolean {
    return !this.queue.length && !this.stuck && this.mismatches === 0 && this.verifiedCount === this.store.count;
  }

  /** After the store took over a rebuilt copy. */
  restart() {
    this.queue = [];
    this.top = null;
    this.stuck = null;
    this.mismatches = 0;
    this.verifiedCount = -1;
    this.gone.clear();
    this.recent.clear();
    this.retryAt = 0;
    this.lastProgress = Date.now();
  }

  async syncOnce(): Promise<void> {
    if (this.running || Date.now() < this.retryAt) return;
    this.running = true;
    try {
      await this.step();
      this.failures = 0;
      this.lastOk = Date.now();
      if (!this.queue.length && !this.stuck) this.lastProgress = this.lastOk;
      this.lastError = this.stuck?.reason ?? null;
    } catch (e) {
      // a busy or unreachable RPC: keep everything and look again a little later
      this.failures++;
      this.lastError = (e as Error).message.slice(0, 200);
      this.retryAt = Date.now() + Math.min(60_000, 2500 * 2 ** this.failures);
    } finally {
      if (this.store.dirty) {
        try {
          this.store.save();
        } catch (e) {
          log(`${this.name}: could not save:`, (e as Error).message.slice(0, 120));
        }
      }
      this.running = false;
    }
  }

  private async step() {
    const fresh = await this.chain.signatures(this.top ?? this.store.lastSig);
    if (fresh.length) this.top = fresh[0].signature;
    for (let i = fresh.length - 1; i >= 0; i--) if (!fresh[i].err) this.queue.push(fresh[i]);
    this.rounds++;
    if (!this.queue.length) {
      // the root check costs a call: make it after a change, and now and then
      if (this.verifiedCount !== this.store.count || this.rounds % 10 === 1) this.check(await this.readChain());
      return;
    }

    const at = { st: await this.readChain() };
    let st = at.st;
    if (this.inSync(st)) {
      this.skipQueue();
      this.check(st);
      return;
    }
    let saved = Date.now();
    while (this.queue.length) {
      const chunk = this.queue.slice(0, CHUNK);
      const txs = await this.chain.transactions(chunk.map((s) => s.signature));
      for (let k = 0; k < chunk.length; k++) {
        const tx = txs[k];
        if (!tx) return this.check(st); // not readable on this node yet: carry on next round from here
        if (!(await this.applyTx(tx, at))) return;
        st = at.st;
        this.queue.shift();
      }
      if (Date.now() - saved > 5000) {
        this.store.save();
        saved = Date.now();
      }
      // level with what the chain showed: whatever is left in the queue changes nothing
      if (this.queue.length && this.store.count === st.nextIndex && this.pendingSum() === st.pendingLamports) {
        st = at.st = await this.readChain();
        if (this.inSync(st)) this.skipQueue();
      }
    }
    this.check(st);
  }

  /**
   * Applies one transaction; false when it can't be, and the follower stops
   * right before it. Rebuilt events that add leaves must end on a root the
   * chain has had, or nothing of them is applied. `at` holds the latest chain
   * read and is refreshed here when it is older than the transaction.
   */
  private async applyTx(tx: TxView, at: { st: ChainState }): Promise<boolean> {
    try {
      const { events, rebuilt } = txEvents(tx, this.programId, this.store, (a) => this.pendingAt(a));
      let added = 0;
      let root: bigint | null = null;
      for (const e of events) {
        if (e.kind !== "settled" && e.kind !== "spent") continue;
        added += e.kind === "settled" ? 1 : 2;
        root = e.root;
      }
      if (rebuilt && root !== null) {
        if (at.st.slot < tx.slot) at.st = await this.readChain();
        const after = this.store.count + added;
        // the chain keeps its last 256 roots: anything older is only checked later, as a whole
        if (after <= at.st.nextIndex && at.st.nextIndex - after < ROOT_HISTORY && !at.st.roots.includes(root)) {
          throw new Error("a rebuilt pool transaction doesn't match the chain's root");
        }
      }
      if (events.length) this.store.apply(events, tx.blockTime, tx.signature, tx.slot);
      else this.store.advance(tx.signature, tx.slot);
      if (rebuilt) {
        this.rebuiltTxs++;
        log(`${this.name}: a pool transaction's log was cut short; its events were rebuilt from its instructions`);
      }
      if (this.stuck) log(`${this.name}: moving again`);
      this.stuck = null;
      this.lastProgress = Date.now();
      return true;
    } catch (e) {
      const reason = (e as Error).message.slice(0, 200);
      if (this.stuck?.signature !== tx.signature) {
        this.stuck = { signature: tx.signature, reason, since: Date.now(), tries: 0 };
        log(`${this.name}: stopped at a pool transaction it can't apply (${reason}); the last good copy keeps serving`);
      }
      this.stuck.tries++;
      this.lastError = reason;
      this.retryAt = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(this.stuck.tries, 6));
      return false;
    }
  }

  private pendingSum(): bigint {
    let s = 0n;
    for (const p of this.store.pending.values()) s += BigInt(p.amount);
    return s;
  }

  private pendingAt(account: string): PendingInfo | null {
    for (const p of [...this.store.pending.values(), ...[...this.recent.values()].map((r) => r.rec)]) {
      if (this.chain.pdaOf(p.inner) !== account) continue;
      return { depositor: p.depositor, amount: BigInt(p.amount), inner: BigInt("0x" + p.inner), meta: p.meta ? unhex(p.meta) : null };
    }
    return null;
  }

  /** Whether the chain's account holds exactly the deposit the index has on record. */
  private matches(p: PendingRec, acct: PendingAcct): boolean {
    return (
      acct.depositor === p.depositor && acct.amount === BigInt(p.amount) && acct.slot === BigInt(p.slot) && (!p.meta || hex(acct.meta) === p.meta)
    );
  }

  private async readChain(): Promise<ChainState> {
    const st = await this.chain.state([...this.store.pending.keys()].map((i) => this.chain.pdaOf(i)));
    // a deposit seen without its note tag (from an older index) picks it up from its account
    for (const [inner, p] of this.store.pending) {
      const acct = st.pending.get(this.chain.pdaOf(inner));
      if (!p.meta && acct && acct.meta.length === META_LEN && this.matches(p, acct)) this.store.setPendingMeta(inner, acct.meta);
    }
    return st;
  }

  /**
   * Whether the queued signatures can't change anything: the chain, read no
   * earlier than the newest of them, holds the same leaves, the same waiting
   * lamports, and every deposit we hold still waiting exactly as we hold it
   * (depositor, amount, slot and note tag: a deposit refunded and made again
   * under the same id is caught here). Every deposit is at least the pool's
   * minimum, so equal sums leave no room for one we don't know. Anything they
   * did was undone within them (a deposit and its refund), so they can be
   * passed over without reading each one. Cheap transactions that merely
   * mention the program cost nothing this way.
   */
  private inSync(st: ChainState): boolean {
    const head = this.queue[this.queue.length - 1];
    if (!head || st.slot < head.slot) return false;
    if (st.nextIndex !== this.store.count || st.pendingLamports !== this.pendingSum()) return false;
    for (const [inner, p] of this.store.pending) {
      const acct = st.pending.get(this.chain.pdaOf(inner));
      if (!acct || !this.matches(p, acct)) return false;
    }
    return true;
  }

  private skipQueue() {
    const last = this.queue[this.queue.length - 1];
    this.skipped += this.queue.length;
    this.queue = [];
    this.store.advance(last.signature, last.slot);
    this.lastProgress = Date.now();
  }

  /** Compares with the chain's root history and tidies the waiting room. */
  private check(st: ChainState) {
    this.chainCount = st.nextIndex;
    for (const [inner, r] of this.recent) if (Date.now() - r.at > 3600_000) this.recent.delete(inner);
    for (const [inner, p] of [...this.store.pending]) {
      const acct = st.pending.get(this.chain.pdaOf(inner));
      if (acct === undefined) continue; // not part of this read
      if (acct && this.matches(p, acct)) this.gone.delete(inner);
      else if (!this.queue.length && !this.stuck) {
        // its settle or refund (or a new deposit under its id) was never seen: follow the chain once that has lasted a while
        const first = this.gone.get(inner);
        if (first === undefined) this.gone.set(inner, Date.now());
        else if (Date.now() - first > 60_000) {
          this.gone.delete(inner);
          // kept for an hour, in case its settle or refund is listed late and has to be rebuilt
          this.recent.set(inner, { rec: p, at: Date.now() });
          if (acct && acct.amount > 0n) {
            this.store.replacePending(inner, acct);
            log(`${this.name}: refreshed a waiting deposit from its account`);
          } else {
            this.store.dropPending(inner);
            log(`${this.name}: dropped a waiting deposit that is no longer on-chain`);
          }
        }
      }
    }
    for (const inner of this.gone.keys()) if (!this.store.pending.has(inner)) this.gone.delete(inner);

    const c = this.store.count;
    // the root for `c` leaves is in the chain's history while fewer than 256 leaves came after it
    if (c > st.nextIndex || st.nextIndex - c >= ROOT_HISTORY) return;
    if (st.roots.includes(this.store.frontier.root)) {
      this.verifiedCount = c;
      this.mismatches = 0;
      return;
    }
    this.mismatches++;
    this.verifiedCount = -1;
    if (this.mismatches === 2) log(`${this.name}: the pool index does not match the chain's root`);
  }

  status() {
    return {
      behind: this.queue.length,
      stuckAt: this.stuck?.signature ?? null,
      stuckForSec: this.stuck ? Math.round((Date.now() - this.stuck.since) / 1000) : null,
      mismatch: this.mismatches >= 2,
      /** no step forward for 10 minutes: an RPC that keeps failing, or history this node can't return */
      stalled: Date.now() - this.lastProgress > 10 * 60_000,
    };
  }
}
