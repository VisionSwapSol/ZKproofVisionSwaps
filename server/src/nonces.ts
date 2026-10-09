import { createHash, randomBytes, randomInt } from "node:crypto";
import { PublicKey, SystemProgram, Transaction, type Keypair } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat, computeBudget, readNonceAccount, NONCE_SPACE } from "@visionswap/sdk";
import { config } from "./config.ts";
import { conn, rent, confirm } from "./chain.ts";
import { fundsStatus } from "./funds.ts";
import { loadState, saveState, saveStateNow, stateRestoring } from "./durable.ts";
import { log } from "./log.ts";

/**
 * The relayer's durable nonces. A payment sent while its owner's page is closed (send later, a
 * split payment's later parts) is delivered by an N2 transaction the owner's browser signed ahead
 * of time, on one of these nonces instead of a blockhash, so it keeps until it is sent.
 *
 * Each nonce account is made by the relayer (which pays its rent) under the nonce authority N (a
 * key derived from the relayer's secret that holds no SOL), at an address derived from N and a
 * numbered seed, so the whole pool can always be found again on-chain.
 *
 * A nonce goes free → leased (one payment's, while it waits; nothing about it has left this server)
 * → exposed (N has signed that payment's delivery and it has been sent: only once the nonce's value
 * has moved on, at finalized, can no copy of it land any more) → free. A lease that is let go
 * without ever being exposed is free again at once, since the owner's signature alone can never
 * land an N2. One let go while exposed is "retiring": the relayer advances it itself (N signs
 * read-only, the relayer pays) and it is free once the change is final.
 *
 * Every nonce is used by one payment at a time, so a payment sent late never lands on a nonce that
 * another has meanwhile been given. The leases are kept in durable state like scheduled payments.
 */

export type NonceState = "free" | "leased" | "exposed" | "retiring";
export type NonceRec = {
  account: string;
  /** the seed number it was made with */
  n: number;
  /** its value as last read (a blockhash, in base58) */
  value: string;
  /** when its value last changed, as far as this server saw (ms) */
  advancedAt: number;
  state: NonceState;
  leaseId?: string;
  /** whose lease: "job:<id>" for a scheduled payment, "send:<hash of its notes>" for one sent now */
  owner?: string;
  /** a scheduled payment's token hash: only its owner gets the same lease again */
  tokenHash?: string;
  /** a lease not yet taken up (no payment holds it yet) ends at this moment */
  until?: number;
  /** the hop of the delivery it was exposed for, and the value that delivery was signed over */
  hop?: string;
  exposedValue?: string;
  /** when the relayer last tried to advance it (retiring) */
  retiredAt?: number;
  /** a lease not yet taken up: the notes of the payment it was asked for (one such lease per note) */
  nfs?: string[];
};

/** What the pool needs from the chain (a stand-in in tests). */
export type NonceChain = {
  /** each account's data, or null when it doesn't exist */
  read(accounts: PublicKey[], commitment: "confirmed" | "finalized"): Promise<(Uint8Array | null)[]>;
  /** sends a signed transaction; true once it is confirmed */
  send(tx: Transaction): Promise<boolean>;
  blockhash(): Promise<string>;
  /** the rent of one nonce account */
  rent(): Promise<bigint>;
  /** whether the relayer can spend this much on new nonce accounts now */
  canSpend(lamports: bigint): Promise<boolean>;
  /** each account's balance, or null when it doesn't exist (or the network couldn't say) */
  lamports(accounts: PublicKey[]): Promise<(bigint | null)[]>;
};

export const SEED_PREFIX = "vsn-";
export const seedOf = (n: number) => SEED_PREFIX + String(n).padStart(6, "0");
/** made in one transaction at most (five don't fit), advanced in one at most, and closed in one at most */
const CREATE_BATCH = 4;
const RETIRE_BATCH = 20;
const CLOSE_BATCH = 10;
/** looking for the pool on-chain: seeds are read past the last one known until this many in a row are missing */
const SCAN_GAP = 64;
/** spare nonces kept past the target; more than that for this long, and the extra ones are closed (their rent goes back to the relayer) */
const SHRINK_MARGIN = 32;
const SHRINK_AFTER_MS = 6 * 3600_000;
/** after the start, how long the pool waits for App Storage's copy before it squares itself with the chain anyway */
const RESTORE_GRACE_MS = 10 * 60_000;
/** a lease not yet taken up: for a payment sent now, and for one being scheduled (handing it over takes seconds once it is signed) */
export const SEND_TTL = 3 * 60_000;
export const SCHEDULE_TTL = 10 * 60_000;
/** leases not yet taken up that one network may hold (fewer for payments being scheduled), and fewer when the pool is nearly full */
const PER_IP = 60;
const PER_IP_SCHEDULED = 12;
const PER_IP_CROWDED = 10;
/** leases not yet taken up count towards the pool's size up to this many: a busy spell grows it a little, never without limit */
const UNBOUND_GROW = 32;
/** a CREATE whose accounts didn't show is looked for this long (past its blockhash's life) */
const PENDING_CREATE_MS = 3 * 60_000;

/** Whose lease a payment sent now holds: its notes' own, so asking again for the same payment gets the same nonce. */
export const sendOwner = (nullifiers: readonly string[]) => `send:${createHash("sha256").update(`${nullifiers[0]}:${nullifiers[1]}`).digest("hex").slice(0, 32)}`;

/** The nonce account for seed `n` (createAccountWithSeed's address, worked out here without a round trip). */
export function nonceAddress(authority: PublicKey, n: number): PublicKey {
  return new PublicKey(sha256(concat(authority.toBytes(), new TextEncoder().encode(seedOf(n)), SystemProgram.programId.toBytes())));
}

/**
 * CREATE: up to four new nonce accounts, each made at its seed address (the relayer pays, N signs as
 * the base) and initialized with N as its authority. Nothing else is in it.
 */
export function buildCreate(payer: PublicKey, authority: PublicKey, seeds: number[], lamports: bigint, blockhash: string, priority: number): Transaction {
  if (!seeds.length || seeds.length > CREATE_BATCH) throw new Error("bad batch");
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...computeBudget(10_000 * seeds.length, priority));
  for (const n of seeds) {
    const account = nonceAddress(authority, n);
    tx.add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: payer,
        newAccountPubkey: account,
        basePubkey: authority,
        seed: seedOf(n),
        lamports: Number(lamports),
        space: NONCE_SPACE,
        programId: SystemProgram.programId,
      }),
      SystemProgram.nonceInitialize({ noncePubkey: account, authorizedPubkey: authority }),
    );
  }
  return tx;
}

/**
 * CLOSE: up to ten free nonces withdrawn whole to the relayer, which closes them and gives their rent
 * back (N signs read-only, the relayer pays). Nothing else is in it.
 */
export function buildClose(payer: PublicKey, authority: PublicKey, accounts: { account: PublicKey; lamports: bigint }[], blockhash: string, priority: number): Transaction {
  if (!accounts.length || accounts.length > CLOSE_BATCH) throw new Error("bad batch");
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...computeBudget(5_000 * accounts.length, priority));
  for (const a of accounts) {
    tx.add(SystemProgram.nonceWithdraw({ noncePubkey: a.account, authorizedPubkey: authority, toPubkey: payer, lamports: Number(a.lamports) }));
  }
  return tx;
}

/** RETIRE: advances up to twenty nonces (N signs read-only, the relayer pays). Nothing else is in it. */
export function buildRetire(payer: PublicKey, authority: PublicKey, accounts: PublicKey[], blockhash: string, priority: number): Transaction {
  if (!accounts.length || accounts.length > RETIRE_BATCH) throw new Error("bad batch");
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(...computeBudget(5_000 * accounts.length, priority));
  for (const a of accounts) tx.add(SystemProgram.nonceAdvance({ noncePubkey: a, authorizedPubkey: authority }));
  return tx;
}

export type LeaseAsk = {
  /** "job:<id>", or "send:<hash of the payment's notes>" (one lease per payment, however often it asks) */
  owner: string;
  tokenHash?: string;
  ttlMs: number;
  /** a scheduled payment: the nonce idle longest, so its value says little about when it was scheduled */
  scheduled: boolean;
  /** the asker's network (rate-limit key), for the per-network cap */
  ip?: string;
  /** the payment's notes: a note holds one lease not yet taken up at a time, whoever asks for it */
  nullifiers?: readonly string[];
};

export class NoncePool {
  readonly recs = new Map<string, NonceRec>();
  private byLease = new Map<string, NonceRec>();
  /** not saved: which network asked for each lease not yet taken up */
  private leaseIp = new Map<string, string>();
  private nextSeed = 0;
  private creating = false;
  private ticking = false;
  /** squared with the chain since the start (see reconcile), and when that start was */
  private reconciled = false;
  private startedAt = Date.now();
  /** free nonces being closed right now: never leased meanwhile */
  private closing = new Set<string>();
  /** since when the pool has held more spare nonces than it keeps (0: it doesn't) */
  private overSince = 0;
  /** nonces left out because they were made under another authority (told once) */
  private toldForeign = false;
  /** a lease about to be handed out held an older value than the chain (told once) */
  private toldDrift = false;
  /** not saved (a restart finds them on-chain, see reconcile): seeds whose CREATE may still land, and until when */
  private pendingCreate = new Map<number, number>();

  constructor(
    private authority: Keypair | null,
    private payer: Keypair | null,
    private chain: NonceChain,
    private opts: {
      min: number;
      max: number;
      priority: number;
      /** saves the pool a moment later */
      save: () => void;
      /** saves the pool before it resolves, or rejects */
      saveNow: () => Promise<void>;
      /** true while App Storage's copy of the pool hasn't been read yet (it may hold leases this copy lacks) */
      restoring?: () => boolean;
    },
  ) {}

  /**
   * Set by the scheduler and the delivery ledger: whether a lease's owner still holds it, and whether
   * the delivery an exposed nonce was signed for may still be sent (null while that can't be told yet).
   */
  readonly hooks: { ownerLive?: (owner: string) => boolean | null; hopPending?: (hop: string) => boolean | null } = {};
  /** after making nonces failed: not tried again before this */
  private stockAfter = 0;

  get authorityKey(): PublicKey | null {
    return this.authority?.publicKey ?? null;
  }

  serialize(): string {
    return JSON.stringify({ v: 1, next: this.nextSeed, recs: [...this.recs.values()] });
  }

  /** Takes the saved pool: in place of what is held, or (`merge`, a copy App Storage gave late) adding what isn't held. */
  adopt(text: string | null, merge = false) {
    if (!merge) {
      this.recs.clear();
      this.byLease.clear();
      this.nextSeed = 0;
    }
    if (!text) return;
    try {
      const o = JSON.parse(text) as { next?: number; recs?: NonceRec[] };
      this.nextSeed = Math.max(this.nextSeed, Number(o.next) || 0);
      for (const r of o.recs ?? []) {
        // a lease for a payment sent now that no delivery took up doesn't outlive a restart (that payment's app asks again)
        if (r.state === "leased" && r.owner?.startsWith("send:") && !r.hop) {
          r.state = "free";
          delete r.leaseId;
          delete r.owner;
          delete r.tokenHash;
          delete r.until;
          delete r.nfs;
        }
        const cur = this.recs.get(r.account);
        // merged late: what is held here is newer, except a nonce the start found on-chain and hasn't
        // retired yet, which the saved copy knows better (a payment may hold it)
        const placeholder = !!cur && cur.state === "retiring" && !cur.leaseId && cur.retiredAt === undefined && cur.value === r.value;
        if (merge && cur && !(placeholder && (r.state === "leased" || r.state === "exposed"))) continue;
        this.recs.set(r.account, r);
        if (r.leaseId) this.byLease.set(r.leaseId, r);
        this.nextSeed = Math.max(this.nextSeed, r.n + 1);
      }
    } catch (e) {
      log(`nonces: couldn't read the saved pool: ${(e as Error).message}`);
    }
  }

  private count(state: NonceState) {
    let n = 0;
    for (const r of this.recs.values()) if (r.state === state) n++;
    return n;
  }

  status() {
    return { total: this.recs.size, free: this.count("free"), leased: this.count("leased"), exposed: this.count("exposed"), retiring: this.count("retiring") };
  }

  private toFree(r: NonceRec) {
    if (r.leaseId) {
      this.byLease.delete(r.leaseId);
      this.leaseIp.delete(r.leaseId);
    }
    r.state = "free";
    delete r.leaseId;
    delete r.owner;
    delete r.tokenHash;
    delete r.until;
    delete r.hop;
    delete r.exposedValue;
    delete r.retiredAt;
    delete r.nfs;
  }

  /**
   * A nonce for one payment, or null when none is free. A scheduled payment asking again (a fresh
   * proof, or a hand-back) gets the same lease while it hasn't been exposed. Throws a 403 when that
   * payment's lease is someone else's, and a 429 when the asker's network holds too many.
   */
  lease(a: LeaseAsk, now = Date.now()): NonceRec | null {
    // until App Storage's copy is in, a nonce free here may be a payment's there
    if (!this.authority || this.opts.restoring?.()) return null;
    for (const r of this.byLease.values()) {
      if (r.owner !== a.owner || r.state !== "leased") continue;
      if (r.tokenHash !== a.tokenHash) throw Object.assign(new Error("Not allowed."), { status: 403 });
      if (r.until) r.until = Math.max(r.until, now + a.ttlMs);
      return r;
    }
    // a note holds one lease not yet taken up at a time: one asked for under another id (or by another proof
    // of the same payment) goes back, so asking over and over under fresh ids never holds more than one nonce
    const nfs = [...new Set((a.nullifiers ?? []).map((n) => String(n).toLowerCase()))];
    if (nfs.length) {
      for (const r of [...this.byLease.values()]) {
        if (r.state === "leased" && r.until && r.owner !== a.owner && r.nfs?.some((n) => nfs.includes(n))) this.toFree(r);
      }
    }
    if (a.ip) {
      const mine = [...this.leaseIp.entries()].flatMap(([id, ip]) => {
        const r = ip === a.ip ? this.byLease.get(id) : undefined;
        return r?.until ? [r] : [];
      });
      const open = mine.length;
      const scheduling = mine.filter((r) => r.owner?.startsWith("job:")).length;
      const crowded = this.recs.size >= this.opts.max * 0.8 && this.count("free") < this.recs.size * 0.2;
      if (open >= PER_IP || (a.scheduled && scheduling >= PER_IP_SCHEDULED) || (crowded && open >= PER_IP_CROWDED)) {
        throw Object.assign(new Error("Too many payments are being prepared from your network right now. Try again later."), { status: 429 });
      }
    }
    const free = [...this.recs.values()].filter((r) => r.state === "free" && !this.closing.has(r.account));
    if (!free.length) return null;
    // a scheduled payment: one of the nonces idle longest; one sent now: any
    if (a.scheduled) free.sort((x, y) => x.advancedAt - y.advancedAt);
    const r = a.scheduled ? free[randomInt(Math.min(8, free.length))] : free[randomInt(free.length)];
    r.state = "leased";
    r.leaseId = randomBytes(12).toString("hex");
    r.owner = a.owner;
    if (a.tokenHash) r.tokenHash = a.tokenHash;
    r.until = now + a.ttlMs;
    if (nfs.length) r.nfs = nfs;
    this.byLease.set(r.leaseId, r);
    if (a.ip) this.leaseIp.set(r.leaseId, a.ip);
    this.opts.save();
    return r;
  }

  get(leaseId: string | undefined): NonceRec | undefined {
    return leaseId ? this.byLease.get(leaseId) : undefined;
  }

  /** A payment took its lease up: it is kept for as long as that payment holds it, with no time limit. */
  bind(leaseId: string, owner: string) {
    const r = this.byLease.get(leaseId);
    if (!r || r.owner !== owner || r.state !== "leased") return false;
    delete r.until;
    delete r.nfs;
    this.leaseIp.delete(leaseId);
    this.opts.save();
    return true;
  }

  /**
   * A delivery is about to go out on this lease: held for it, with no time limit, until the delivery
   * ledger lets it go. Saved before it resolves (a restart must never free a nonce a delivery holds),
   * or rejects with the lease as it was.
   */
  async take(leaseId: string, hop: string): Promise<void> {
    const r = this.byLease.get(leaseId);
    if (!r || r.state !== "leased") return;
    const was = { hop: r.hop, until: r.until, nfs: r.nfs, ip: this.leaseIp.get(leaseId) };
    delete r.until;
    delete r.nfs;
    r.hop = hop;
    this.leaseIp.delete(leaseId);
    try {
      await this.opts.saveNow();
    } catch (e) {
      if (r.state === "leased" && this.byLease.get(leaseId) === r) {
        if (was.hop === undefined) delete r.hop;
        else r.hop = was.hop;
        if (was.until !== undefined) r.until = was.until;
        if (was.nfs) r.nfs = was.nfs;
        if (was.ip) this.leaseIp.set(leaseId, was.ip);
      }
      throw e;
    }
  }

  /**
   * A lease about to be handed out, checked against the chain: a nonce no payment has signed over yet
   * whose value moved on without this pool seeing it (a read that lagged) takes the value the chain
   * holds now, so the payment signs over one that can land. Network trouble changes nothing.
   */
  async confirmValue(r: NonceRec, now = Date.now()): Promise<NonceRec> {
    const data = await this.chain.read([new PublicKey(r.account)], "confirmed").catch(() => null);
    const d = data?.[0] ? readNonceAccount(data[0]) : null;
    if (!d || r.state !== "leased" || d.nonce === r.value) return r;
    if (this.authority && !d.authority.equals(this.authority.publicKey)) return r;
    if (!this.toldDrift) {
      this.toldDrift = true;
      log("nonces: a leased nonce held an older value than the chain; it was read again before use");
    }
    r.value = d.nonce;
    r.advancedAt = now;
    this.opts.save();
    return r;
  }

  /**
   * Marks the lease exposed, before N signs its delivery and it is sent. Saved before it resolves:
   * a restart must never hand out a nonce that a sent delivery may still land on.
   */
  async expose(leaseId: string, hop: string): Promise<NonceRec> {
    const r = this.byLease.get(leaseId);
    if (!r || (r.state !== "leased" && !(r.state === "exposed" && r.hop === hop))) throw new Error("lease lost");
    const was = r.state === "leased" ? { hop: r.hop, until: r.until } : null;
    if (was) {
      r.state = "exposed";
      r.hop = hop;
      r.exposedValue = r.value;
      delete r.until;
    }
    try {
      await this.opts.saveNow();
    } catch (e) {
      // not saved: back as it was, so the delivery is tried again later (nothing was signed, nothing needs retiring)
      if (was) {
        r.state = "leased";
        delete r.exposedValue;
        if (was.hop === undefined) delete r.hop;
        else r.hop = was.hop;
        if (was.until !== undefined) r.until = was.until;
      }
      throw e;
    }
    return r;
  }

  /** Lets a lease go: free at once when never exposed, else retired first (see tick). */
  release(leaseId: string | undefined) {
    const r = leaseId ? this.byLease.get(leaseId) : undefined;
    if (!r) return;
    if (r.state === "leased") this.toFree(r);
    else if (r.state === "exposed") r.state = "retiring";
    this.opts.save();
  }

  /** The pool's own addresses: never a payment's recipient. */
  accounts(): Set<string> {
    return new Set(this.recs.keys());
  }

  /**
   * Startup (the first tick): every nonce made under N that the saved pool doesn't know (the pool was
   * lost, or a creation was cut short) is taken in as retiring, since a delivery may still be waiting
   * on it, and any made under another authority is left out. (Leases for payments sent now that no
   * delivery took up are let go as the saved pool is read, see adopt.)
   */
  async reconcile(now = Date.now()) {
    if (!this.authority) return;
    const auth = this.authority.publicKey;
    // made under an earlier authority (the relayer's key was changed): of no use with this one
    for (const r of [...this.recs.values()]) if (r.account !== nonceAddress(auth, r.n).toBase58()) this.dropForeign(r);
    // the seeds are read until a long run of them is missing, so a pool whose saved copy was lost is found whole
    let last = this.nextSeed - 1;
    for (const r of this.recs.values()) last = Math.max(last, r.n);
    for (let start = 0; start <= last + SCAN_GAP; start += 100) {
      const ns: number[] = [];
      for (let n = start; n < start + 100; n++) if (!this.recs.has(nonceAddress(auth, n).toBase58())) ns.push(n);
      if (!ns.length) continue;
      const data = await this.chain.read(ns.map((n) => nonceAddress(auth, n)), "confirmed");
      ns.forEach((n, k) => {
        const d = data[k] ? readNonceAccount(data[k]!) : null;
        if (!d || !d.authority.equals(auth)) return;
        const account = nonceAddress(auth, n).toBase58();
        this.recs.set(account, { account, n, value: d.nonce, advancedAt: now, state: "retiring", exposedValue: d.nonce });
        this.nextSeed = Math.max(this.nextSeed, n + 1);
        last = Math.max(last, n);
      });
    }
    // free ones moved on by a delivery this server didn't see land: their new value
    await this.refresh([...this.recs.values()].filter((r) => r.state === "free"), false, now);
    this.reconciled = true;
    this.opts.save();
  }

  /** Leaves out a nonce made under another authority: no payment can use it now, and only that key can give its rent back. */
  private dropForeign(r: NonceRec) {
    this.recs.delete(r.account);
    if (r.leaseId) {
      this.byLease.delete(r.leaseId);
      this.leaseIp.delete(r.leaseId);
    }
    if (!this.toldForeign) {
      this.toldForeign = true;
      log("nonces: nonce accounts made under an earlier relayer key were left out (only that key can recover their rent); new ones are made under the current key");
    }
  }

  /**
   * Reads these nonces and takes in their values, as confirmed (the newest a payment can sign over).
   * With `final`, an exposed or retiring one is free once its value has moved on at finalized (only then
   * can no copy of the delivery it was exposed for land any more). Returns each one's confirmed value.
   */
  private async refresh(list: NonceRec[], final: boolean, now: number): Promise<Map<string, string>> {
    const confirmed = new Map<string, string>();
    for (let i = 0; i < list.length; i += 100) {
      const part = list.slice(i, i + 100);
      const keys = part.map((r) => new PublicKey(r.account));
      // finalized first: a confirmed read made after it is never the older one
      const fin = final ? await this.chain.read(keys, "finalized") : null;
      const conf = await this.chain.read(keys, "confirmed");
      part.forEach((r, k) => {
        const raw = conf[k] ?? fin?.[k] ?? null;
        if (!raw) {
          // gone (never made, or closed by hand): not a nonce of this pool any more
          if (r.state === "free" || r.state === "retiring") {
            this.recs.delete(r.account);
            if (r.leaseId) this.byLease.delete(r.leaseId);
          }
          return;
        }
        const dc = readNonceAccount(raw);
        if (!dc) return;
        if (this.authority && !dc.authority.equals(this.authority.publicKey)) return this.dropForeign(r);
        const df = fin ? (fin[k] ? readNonceAccount(fin[k]!) : null) : dc;
        // moved on for good: final, and the confirmed value (the one kept, the newest) isn't the old one
        // either (a finalized read just behind, or a confirmed one just behind, waits for the next look)
        const moved = !!df && df.nonce !== r.exposedValue && dc.nonce !== r.exposedValue;
        confirmed.set(r.account, dc.nonce);
        if (dc.nonce !== r.value) {
          r.value = dc.nonce;
          r.advancedAt = now;
        }
        if ((r.state === "exposed" || r.state === "retiring") && moved) this.toFree(r);
      });
    }
    return confirmed;
  }

  /**
   * Every few seconds on the copy that runs the state: lapsed leases are let go, leases whose payment
   * is gone are released, exposed and retiring nonces are looked at (final values only) and retired,
   * and the pool is kept stocked.
   */
  async tick(now = Date.now()) {
    if (this.ticking || !this.authority || !this.payer) return;
    // App Storage's copy may hold leases this one lacks: nothing is freed, retired or made before it is in (or long overdue)
    if (this.opts.restoring?.() && now - this.startedAt < RESTORE_GRACE_MS) return;
    this.ticking = true;
    try {
      if (!this.reconciled) await this.reconcile(now);
      for (const r of [...this.recs.values()]) {
        if (r.state === "leased" && r.until && r.until < now) this.toFree(r);
        else if (r.state === "leased" && !r.until && r.owner?.startsWith("job:") && this.hooks.ownerLive?.(r.owner) === false) this.toFree(r);
        else if (r.state === "leased" && !r.until && r.owner?.startsWith("send:") && (!r.hop || this.hooks.hopPending?.(r.hop) === false)) this.toFree(r);
        else if (r.state === "exposed" && r.hop && this.hooks.hopPending?.(r.hop) === false) r.state = "retiring";
      }
      const watch = [...this.recs.values()].filter((r) => r.state === "exposed" || r.state === "retiring");
      const confirmed = watch.length ? await this.refresh(watch, true, now) : new Map<string, string>();
      // advanced here only while it still holds the value its delivery was signed over: one that has moved
      // on already (its delivery landed, or an earlier RETIRE did) just waits for that to be final
      const stuck = [...this.recs.values()].filter((r) => r.state === "retiring" && now - (r.retiredAt ?? 0) > 30_000 && confirmed.get(r.account) === r.exposedValue);
      for (let i = 0; i < stuck.length && i < RETIRE_BATCH * 3; i += RETIRE_BATCH) {
        const part = stuck.slice(i, i + RETIRE_BATCH);
        part.forEach((r) => (r.retiredAt = now));
        const tx = buildRetire(this.payer.publicKey, this.authority.publicKey, part.map((r) => new PublicKey(r.account)), await this.chain.blockhash(), this.opts.priority);
        tx.sign(this.payer, this.authority);
        await this.chain.send(tx).catch(() => false);
      }
      await this.adoptPending();
      await this.stock();
      await this.shrink(now);
      this.opts.save();
    } catch (e) {
      log(`nonces: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** The start: the pool squares itself with the chain on its first tick, once App Storage's copy is in. */
  begin(now = Date.now()) {
    this.startedAt = now;
    this.reconciled = false;
    this.overSince = 0;
  }

  /**
   * How many nonces the pool should hold: some to spare over those in use, within the limits. Leases
   * not yet taken up (payments being prepared, which asking alone gets) count only up to a few dozen,
   * so a busy spell grows the pool a little but asking can never grow it without limit.
   */
  target(): number {
    let inUse = 0;
    let unbound = 0;
    for (const r of this.recs.values()) {
      if (r.state === "exposed" || r.state === "retiring" || (r.state === "leased" && !r.until)) inUse++;
      else if (r.state === "leased") unbound++;
    }
    return Math.min(this.opts.max, Math.max(this.opts.min, Math.ceil((inUse + Math.min(unbound, UNBOUND_GROW)) * 1.2) + 16));
  }

  /**
   * A pool that has held many more free nonces than it needs for hours (after a busy spell) closes the
   * extra ones, newest seeds first, and their rent goes back to the relayer. Only free ones: no
   * payment holds them and no delivery can land on them.
   */
  private async shrink(now: number) {
    const extra = this.recs.size - this.target() - SHRINK_MARGIN;
    if (extra <= 0) {
      this.overSince = 0;
      return;
    }
    if (!this.overSince) this.overSince = now;
    if (now - this.overSince < SHRINK_AFTER_MS || !this.authority || !this.payer) return;
    const pick = [...this.recs.values()]
      .filter((r) => r.state === "free")
      .sort((a, b) => b.n - a.n)
      .slice(0, Math.min(extra, CLOSE_BATCH));
    if (!pick.length) return;
    const keys = pick.map((r) => new PublicKey(r.account));
    pick.forEach((r) => this.closing.add(r.account));
    try {
      const bals = await this.chain.lamports(keys);
      const list = pick.flatMap((_, i) => (bals[i] ? [{ account: keys[i], lamports: bals[i]! }] : []));
      if (!list.length) return;
      const tx = buildClose(this.payer.publicKey, this.authority.publicKey, list, await this.chain.blockhash(), this.opts.priority);
      tx.sign(this.payer, this.authority);
      await this.chain.send(tx).catch(() => false);
      // whatever the answer, the chain says which are gone
      const data = await this.chain.read(keys, "confirmed");
      pick.forEach((r, i) => {
        if (!data[i] && this.recs.get(r.account) === r && r.state === "free") this.recs.delete(r.account);
      });
      this.opts.save();
    } finally {
      pick.forEach((r) => this.closing.delete(r.account));
    }
  }

  /**
   * Seeds whose CREATE was sent but whose account didn't show (a read that lagged, or a CREATE that
   * landed after its answer timed out): taken in as free once they appear (made here a moment ago, so
   * no payment ever held them), and let go once their CREATE can't land any more.
   */
  private async adoptPending() {
    if (!this.pendingCreate.size || !this.authority) return;
    const auth = this.authority.publicKey;
    const seeds = [...this.pendingCreate.keys()].slice(0, 100);
    const data = await this.chain.read(seeds.map((n) => nonceAddress(auth, n)), "confirmed");
    const now = Date.now();
    seeds.forEach((n, i) => {
      if (!data[i]) {
        if (this.pendingCreate.get(n)! < now) this.pendingCreate.delete(n);
        return;
      }
      this.pendingCreate.delete(n);
      const d = readNonceAccount(data[i]!);
      const account = nonceAddress(auth, n).toBase58();
      if (d && d.authority.equals(auth) && !this.recs.has(account)) this.recs.set(account, { account, n, value: d.nonce, advancedAt: now, state: "free" });
    });
  }

  /** Makes nonces until the pool holds its target (a few transactions per call). */
  private async stock() {
    if (this.creating || !this.authority || !this.payer || Date.now() < this.stockAfter) return;
    const want = this.target() - this.recs.size - this.pendingCreate.size;
    if (want <= 0) return;
    this.creating = true;
    try {
      const rent = await this.chain.rent();
      const auth = this.authority.publicKey;
      for (let made = 0; made < Math.min(want, CREATE_BATCH * 3); ) {
        const k = Math.min(CREATE_BATCH, want - made);
        if (!(await this.chain.canSpend(rent * BigInt(k) + 50_000n))) return;
        const all = Array.from({ length: k }, (_, i) => this.nextSeed + i);
        this.nextSeed += k;
        // the seed counter is saved first: a restart never makes the same address twice (and finds any made, see reconcile)
        try {
          await this.opts.saveNow();
        } catch {
          this.nextSeed -= k;
          this.stockAfter = Date.now() + 60_000;
          return;
        }
        made += k;
        // an address already there is never made over: one of this pool's (a creation nobody saw land) is
        // retired before use, and anything else someone put there is skipped (that seed is never used)
        const there = await this.chain.read(all.map((n) => nonceAddress(auth, n)), "confirmed");
        const seeds = all.filter((n, i) => {
          if (!there[i]) return true;
          const d = readNonceAccount(there[i]!);
          const account = nonceAddress(auth, n).toBase58();
          if (d && d.authority.equals(auth) && !this.recs.has(account)) {
            this.recs.set(account, { account, n, value: d.nonce, advancedAt: Date.now(), state: "retiring", exposedValue: d.nonce });
          }
          return false;
        });
        if (!seeds.length) continue;
        const tx = buildCreate(this.payer.publicKey, auth, seeds, rent, await this.chain.blockhash(), this.opts.priority);
        tx.sign(this.payer, this.authority);
        const ok = await this.chain.send(tx).catch(() => false);
        // whatever the answer, the chain says which were made (a read just behind a confirmed CREATE is asked again)
        const keys = seeds.map((n) => nonceAddress(auth, n));
        let data = await this.chain.read(keys, "confirmed");
        for (let t = 0; ok && t < 3 && data.some((x) => !x); t++) {
          await new Promise((r) => setTimeout(r, 1500));
          data = await this.chain.read(keys, "confirmed");
        }
        const now = Date.now();
        let got = 0;
        seeds.forEach((n, i) => {
          if (!data[i]) {
            // not there (yet): a CREATE can still land until its blockhash runs out, so it is looked for again
            this.pendingCreate.set(n, now + PENDING_CREATE_MS);
            return;
          }
          const d = readNonceAccount(data[i]!);
          if (!d || !d.authority.equals(auth)) return;
          const account = nonceAddress(auth, n).toBase58();
          this.recs.set(account, { account, n, value: d.nonce, advancedAt: now, state: "free" });
          got++;
        });
        this.opts.save();
        if (!got) {
          // nothing was made (the network refused, or is busy): later, not on every tick
          this.stockAfter = now + 5 * 60_000;
          log("nonces: couldn't make new nonce accounts just now; trying again in 5 minutes");
          return;
        }
      }
    } finally {
      this.creating = false;
    }
  }
}

// ─── the pool this server runs ───

const chain: NonceChain = {
  async read(accounts, commitment) {
    const infos = await conn.getMultipleAccountsInfo(accounts, commitment);
    return infos.map((i) => (i ? new Uint8Array(i.data) : null));
  },
  async send(tx) {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
    return (await confirm(sig, 60_000)) === "confirmed";
  },
  async blockhash() {
    return (await conn.getLatestBlockhash("confirmed")).blockhash;
  },
  rent: () => rent(NONCE_SPACE),
  async lamports(accounts) {
    const infos = await conn.getMultipleAccountsInfo(accounts, "confirmed").catch(() => null);
    return infos ? infos.map((i) => (i ? BigInt(i.lamports) : null)) : accounts.map(() => null);
  },
  async canSpend(lamports) {
    // the pool is stocked only from what the relayer holds over its own minimum, never from the SOL sends need
    const bal = (await fundsStatus().catch(() => null))?.relayer?.lamports;
    return bal != null && BigInt(bal) - lamports > config.relayerMinLamports;
  },
};

export const nonces: NoncePool = new NoncePool(config.deliveryNonce ? config.nonceAuthority : null, config.relayer, chain, {
  min: config.noncePoolMin,
  max: config.noncePoolMax,
  priority: config.priorityMicroLamports,
  save: () => saveState("nonces", () => nonces.serialize()),
  saveNow: () => saveStateNow("nonces", () => nonces.serialize(), true),
  restoring: () => stateRestoring("nonces"),
});

let timer: NodeJS.Timeout | undefined;
/** On the copy that runs the state (with the scheduler): loads the pool, squares it with the chain, and keeps it up. */
export async function startNonces() {
  clearInterval(timer);
  // a copy App Storage gives only after the start adds the nonces this server doesn't hold
  nonces.adopt(await loadState("nonces", (late) => nonces.adopt(late, true)));
  if (!nonces.authorityKey) return;
  // squared with the chain on its first tick, once App Storage's copy is in (see tick)
  nonces.begin();
  timer = setInterval(() => void nonces.tick(), 15_000);
  timer.unref?.();
  void nonces.tick();
}
export function stopNonces() {
  clearInterval(timer);
}
