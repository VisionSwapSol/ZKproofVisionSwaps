import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { Frontier, H2, META_LEN, hex, toBE, type PoolEvent } from "@visionswap/sdk";
import { log } from "./log.ts";

const LEAF_REC = 32 + META_LEN; // leaf || meta

/** `meta` (the note tag, hex) comes from the deposit instruction; it lets a settle be rebuilt when its log line is lost. */
export type PendingRec = { inner: string; depositor: string; amount: string; slot: string; leaf: string; meta?: string };
type State = {
  version: 1;
  programId: string;
  lastSig: string | null;
  lastSlot: number;
  frontier: ReturnType<Frontier["toJSON"]>;
  /** nullifiers.bin may run ahead of this file after a crash; it is cut back to this many on load */
  nfCount?: number;
  pending: PendingRec[];
  spends: { t: number; w: string }[];
  deposits: { t: number; a: string }[];
};

/** A queued event may carry the note tag read from the deposit instruction. */
export type IndexEvent = Exclude<PoolEvent, { kind: "queued" }> | (Extract<PoolEvent, { kind: "queued" }> & { meta?: Uint8Array });

/**
 * Append-only copy of the pool's public history: every leaf with its note
 * tag, every nullifier, and the waiting room. Nothing about users is stored.
 */
export class PoolStore {
  private leaves = Buffer.alloc(LEAF_REC * 1024);
  private nfs = Buffer.alloc(32 * 1024);
  count = 0;
  nfCount = 0;
  nfSet = new Set<string>();
  pending = new Map<string, PendingRec>();
  private leafToInner = new Map<string, string>();
  frontier = new Frontier();
  lastSig: string | null = null;
  lastSlot = 0;
  spends: { t: number; w: bigint }[] = [];
  deposits: { t: number; a: bigint }[] = [];
  /** something changed since the last save */
  dirty = false;

  constructor(
    private dir: string,
    private programId: string,
  ) {
    this.load();
  }

  private get files() {
    return {
      leaves: join(this.dir, "leaves.bin"),
      nfs: join(this.dir, "nullifiers.bin"),
      state: join(this.dir, "state.json"),
    };
  }

  /**
   * Reads the saved index. A damaged or half-written copy never stops the
   * server: it is dropped and the index is rebuilt from the chain.
   */
  private load() {
    const f = this.files;
    if (!existsSync(f.state)) return;
    try {
      const s = JSON.parse(readFileSync(f.state, "utf8")) as State;
      if (!s || typeof s !== "object" || !s.frontier || !Array.isArray(s.pending) || !Array.isArray(s.spends)) {
        throw new Error("unexpected shape");
      }
      if (s.programId !== this.programId) {
        // a different deployment: start over
        this.reset();
        return;
      }
      const n = s.frontier.nextIndex;
      const lb = existsSync(f.leaves) ? readFileSync(f.leaves) : Buffer.alloc(0);
      const nb = existsSync(f.nfs) ? readFileSync(f.nfs) : Buffer.alloc(0);
      const m = s.nfCount ?? Math.floor(nb.length / 32);
      // the files are appended before the state is saved, so after a crash they can be longer: cut them back
      if (lb.length < n * LEAF_REC || nb.length < m * 32) throw new Error("leaf or nullifier file is short");
      if (lb.length > n * LEAF_REC) truncateSync(f.leaves, n * LEAF_REC);
      if (nb.length > m * 32) truncateSync(f.nfs, m * 32);
      this.ensure(n);
      lb.copy(this.leaves, 0, 0, n * LEAF_REC);
      this.count = n;
      this.ensureNf(m);
      nb.copy(this.nfs, 0, 0, m * 32);
      this.nfCount = m;
      for (let i = 0; i < m; i++) this.nfSet.add(nb.subarray(i * 32, i * 32 + 32).toString("hex"));
      this.frontier = new Frontier(s.frontier);
      this.lastSig = s.lastSig;
      this.lastSlot = s.lastSlot;
      for (const p of s.pending) {
        this.pending.set(p.inner, p);
        this.leafToInner.set(p.leaf, p.inner);
      }
      this.spends = s.spends.map((x) => ({ t: x.t, w: BigInt(x.w) }));
      this.deposits = (s.deposits ?? []).map((x) => ({ t: x.t, a: BigInt(x.a) }));
    } catch (e) {
      log(`store: saved pool index unreadable (${(e as Error).message.slice(0, 120)}); rebuilding from the chain`);
      this.reset();
    }
  }

  /** Forgets everything, on disk too. Only for a different deployment or an unreadable copy. */
  reset() {
    const f = this.files;
    for (const p of [f.leaves, f.nfs, f.state]) rmSync(p, { force: true });
    this.clear();
  }

  private clear() {
    this.count = 0;
    this.nfCount = 0;
    this.nfSet.clear();
    this.pending.clear();
    this.leafToInner.clear();
    this.frontier = new Frontier();
    this.lastSig = null;
    this.lastSlot = 0;
    this.spends = [];
    this.deposits = [];
    this.dirty = false;
  }

  /**
   * Takes over a finished rebuild (made in its own folder): its files replace
   * ours and are read back. Until this moment the old copy kept serving.
   */
  adopt(other: PoolStore) {
    other.save();
    const from = other.files;
    const to = this.files;
    for (const k of ["leaves", "nfs", "state"] as const) {
      // a copy with no leaves or nullifiers yet has no file for them
      if (existsSync(from[k])) renameSync(from[k], to[k]);
      else rmSync(to[k], { force: true });
    }
    this.clear();
    this.load();
  }

  private ensure(n: number) {
    if (n * LEAF_REC <= this.leaves.length) return;
    const b = Buffer.alloc(Math.max(n * LEAF_REC, this.leaves.length * 2));
    this.leaves.copy(b);
    this.leaves = b;
  }

  private ensureNf(n: number) {
    if (n * 32 <= this.nfs.length) return;
    const b = Buffer.alloc(Math.max(n * 32, this.nfs.length * 2));
    this.nfs.copy(b);
    this.nfs = b;
  }

  private addLeaf(index: number, leaf: bigint, meta: Uint8Array, pendingLeaves: Buffer[]) {
    if (index !== this.count) throw new Error(`leaf gap: expected ${this.count}, got ${index}`);
    this.ensure(this.count + 1);
    const rec = Buffer.concat([Buffer.from(toBE(leaf)), Buffer.from(meta)]);
    rec.copy(this.leaves, this.count * LEAF_REC);
    this.count++;
    this.frontier.insert(leaf);
    pendingLeaves.push(rec);
  }

  /**
   * Applies one transaction's events, in order. Throws on any inconsistency,
   * and then nothing of that transaction is kept: the index stays exactly
   * where it was, so it can be retried or rebuilt without starting over.
   */
  apply(events: IndexEvent[], blockTime: number | null, sig: string, slot: number) {
    const newLeaves: Buffer[] = [];
    const newNfs: Buffer[] = [];
    const t = blockTime ?? Math.floor(Date.now() / 1000);
    const undo = {
      count: this.count,
      nfCount: this.nfCount,
      frontier: { filled: [...this.frontier.filled], nextIndex: this.frontier.nextIndex, root: this.frontier.root },
      spends: this.spends.length,
      deposits: this.deposits.length,
      maps: [] as [Map<string, unknown>, string, unknown][],
    };
    const put = <V>(m: Map<string, V>, k: string, v: V | undefined) => {
      undo.maps.push([m as Map<string, unknown>, k, m.get(k)]);
      if (v === undefined) m.delete(k);
      else m.set(k, v);
    };
    try {
      for (const e of events) {
        if (e.kind === "queued") {
          const innerHex = hex(toBE(e.inner));
          const leaf = hex(toBE(H2(e.amount, e.inner)));
          put(this.pending, innerHex, {
            inner: innerHex,
            depositor: e.depositor,
            amount: e.amount.toString(),
            slot: e.slot.toString(),
            leaf,
            ...(e.meta ? { meta: Buffer.from(e.meta).toString("hex") } : {}),
          });
          put(this.leafToInner, leaf, innerHex);
        } else if (e.kind === "refunded") {
          const innerHex = hex(toBE(e.inner));
          const p = this.pending.get(innerHex);
          if (p) put(this.leafToInner, p.leaf, undefined);
          put(this.pending, innerHex, undefined);
        } else if (e.kind === "settled") {
          this.addLeaf(e.index, e.leaf, e.meta, newLeaves);
          const lh = hex(toBE(e.leaf));
          const inner = this.leafToInner.get(lh);
          if (inner) {
            put(this.pending, inner, undefined);
            put(this.leafToInner, lh, undefined);
          }
          this.deposits.push({ t, a: e.amount });
          if (this.frontier.root !== e.root) throw new Error("root mismatch after settle");
        } else if (e.kind === "spent") {
          this.addLeaf(e.index, e.commitments[0], e.metas[0], newLeaves);
          this.addLeaf(e.index + 1, e.commitments[1], e.metas[1], newLeaves);
          for (const n of e.nullifiers) {
            const b = Buffer.from(toBE(n));
            this.ensureNf(this.nfCount + 1);
            b.copy(this.nfs, this.nfCount * 32);
            this.nfCount++;
            newNfs.push(b);
          }
          this.spends.push({ t, w: e.withdraw });
          if (this.frontier.root !== e.root) throw new Error("root mismatch after spend");
        }
      }
    } catch (err) {
      this.count = undo.count;
      this.nfCount = undo.nfCount;
      Object.assign(this.frontier, undo.frontier);
      this.spends.length = undo.spends;
      this.deposits.length = undo.deposits;
      for (const [m, k, v] of undo.maps.reverse()) {
        if (v === undefined) m.delete(k);
        else m.set(k, v);
      }
      throw err;
    }
    for (const b of newNfs) this.nfSet.add(b.toString("hex"));
    if (newLeaves.length) appendFileSync(this.files.leaves, Buffer.concat(newLeaves));
    if (newNfs.length) appendFileSync(this.files.nfs, Buffer.concat(newNfs));
    this.advance(sig, slot);
  }

  /** Moves past a transaction that changed nothing in the pool. */
  advance(sig: string, slot: number) {
    this.lastSig = sig;
    this.lastSlot = slot;
    this.dirty = true;
  }

  /** Forgets a waiting deposit whose account is gone from the chain (its end was never seen). */
  dropPending(inner: string) {
    const p = this.pending.get(inner);
    if (!p) return;
    this.leafToInner.delete(p.leaf);
    this.pending.delete(inner);
    this.dirty = true;
  }

  /** Takes a waiting deposit as its account now holds it (a new deposit under the same id the index missed). */
  replacePending(inner: string, a: { depositor: string; amount: bigint; slot: bigint; meta: Uint8Array }) {
    this.dropPending(inner);
    const leaf = hex(toBE(H2(a.amount, BigInt("0x" + inner))));
    const meta = a.meta.length ? { meta: Buffer.from(a.meta).toString("hex") } : {};
    this.pending.set(inner, { inner, depositor: a.depositor, amount: a.amount.toString(), slot: a.slot.toString(), leaf, ...meta });
    this.leafToInner.set(leaf, inner);
    this.dirty = true;
  }

  /** Remembers a waiting deposit's note tag, read from its account. */
  setPendingMeta(inner: string, meta: Uint8Array) {
    const p = this.pending.get(inner);
    if (!p || p.meta) return;
    p.meta = Buffer.from(meta).toString("hex");
    this.dirty = true;
  }

  /** Writes the small state file atomically; call after a batch of `apply`. */
  save() {
    this.dirty = false;
    const cutoff = Math.floor(Date.now() / 1000) - 31 * 86400;
    this.spends = this.spends.filter((s) => s.t >= cutoff);
    this.deposits = this.deposits.filter((s) => s.t >= cutoff);
    const s: State = {
      version: 1,
      programId: this.programId,
      lastSig: this.lastSig,
      lastSlot: this.lastSlot,
      frontier: this.frontier.toJSON(),
      nfCount: this.nfCount,
      pending: [...this.pending.values()],
      spends: this.spends.map((x) => ({ t: x.t, w: x.w.toString() })),
      deposits: this.deposits.map((x) => ({ t: x.t, a: x.a.toString() })),
    };
    const tmp = this.files.state + ".tmp";
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, this.files.state);
  }

  /** Raw leaf records [from, from+limit): 60 bytes each (leaf || meta). */
  leafRange(from: number, limit: number): Buffer {
    const a = Math.max(0, Math.min(from, this.count));
    const b = Math.min(this.count, a + limit);
    return Buffer.from(this.leaves.subarray(a * LEAF_REC, b * LEAF_REC));
  }

  nullifierRange(from: number, limit: number): Buffer {
    const a = Math.max(0, Math.min(from, this.nfCount));
    const b = Math.min(this.nfCount, a + limit);
    return Buffer.from(this.nfs.subarray(a * 32, b * 32));
  }

  /** Whether these notes are in the pool, looking back through the newest `within` leaves. */
  hasLeaves(leaves: bigint[], within = 1 << 20): boolean {
    const want = new Set(leaves.map((l) => Buffer.from(toBE(l)).toString("hex")));
    for (let i = this.count - 1; i >= Math.max(0, this.count - within) && want.size; i--) {
      want.delete(this.leaves.subarray(i * LEAF_REC, i * LEAF_REC + 32).toString("hex"));
    }
    return want.size === 0;
  }

  isSpent(nullifier: bigint): boolean {
    return this.nfSet.has(Buffer.from(toBE(nullifier)).toString("hex"));
  }
}
