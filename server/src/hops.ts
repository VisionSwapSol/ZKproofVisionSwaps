import { PublicKey, VersionedTransaction, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  l1Message,
  n2Message,
  deliveryTransaction,
  signDelivery,
  verifyDelivery,
  hopLookupMessage,
  readNonceAccount,
  readDelivery,
  newHopHistory,
  paysTo,
  HISTORY_PAGE,
  DELIVERY_FEE,
  type HistoryRpc,
  type HopHistory,
} from "@visionswap/sdk";
import { config } from "./config.ts";
import { conn, pool } from "./chain.ts";
import { store } from "./indexer.ts";
import { nonces, type NoncePool } from "./nonces.ts";
import { loadState, saveState, saveStateNow, stateRestoring } from "./durable.ts";
import { rpcHooks } from "./rpc.ts";
import { log } from "./log.ts";

/**
 * Deliveries: the second step of a private payment to an outside address (see sdk/src/delivery.ts).
 * The pool pays a one-time hop address (TX1), and the hop's own transfer (TX2, signed ahead of time
 * in the owner's browser) passes the exact amount on to the recipient as a standard SOL transfer.
 *
 * Before TX1 is sent, its delivery is written down here and saved (if that fails, nothing is sent).
 * The relayer sends TX2 as soon as TX1 has landed. Should that be cut short (a restart, a busy
 * network), the finisher, on the copy that runs the state, picks it up from the record: the hop's
 * balance says whether it was delivered. A hop holding anything but exactly what its signed
 * delivery sends (someone sent it a little extra, or the signed delivery can't be used any more)
 * is "waiting": the owner's app derives the hop's key again and finishes it with a fresh transfer.
 * Nothing is ever stuck for good, and nothing can be sent anywhere the owner didn't sign for.
 *
 * A delivery is the first transaction the hop paid for itself, and only when it holds a standard SOL
 * transfer to the recipient. One that pays elsewhere first is the owner's app moving the SOL (into the
 * private balance, or anywhere the owner picked): "withdrawn", never taken as delivered.
 *
 * Records hold the recipient and amount only while a delivery is open, and two days after.
 */

/** "withdrawn": the owner's app moved its SOL somewhere other than the recipient (see firstSpend) */
export type HopStatus = "sending" | "funded" | "waiting" | "delivered" | "withdrawn" | "dropped";
export type HopRec = {
  hop: string;
  to: string;
  /** lamports the recipient gets */
  amount: string;
  nullifiers: [string, string];
  commitments: [string, string];
  /** the hop's signatures over the deliveries it may be sent with */
  l1?: { blockhash: string; sig: string };
  n2?: { leaseId: string; sig: string; account: string; value: string };
  jobId?: string;
  tx1: string;
  /** earlier sends of the same payment (a try cut short, sent again): any of them may be the one that landed */
  tx1s?: string[];
  /** the block height after which TX1 can't land any more */
  lastValid: number;
  /** every TX2 sent so far (newest last) */
  tx2: string[];
  /** the TX2 that landed */
  delivered?: string;
  /** the hop's own transaction that moved its SOL elsewhere ("withdrawn") */
  withdrawnBy?: string;
  /** passes in a row in which none of its signed deliveries simulated (see deliver) */
  simFails?: number;
  status: HopStatus;
  at: number;
  fundedAt?: number;
  done?: number;
};

export type DeliveryOutcome = { status: "delivered" | "pending" | "waiting"; signature: string | null };

/** What deliveries need from the chain (a stand-in in tests). Reads answer null/undefined when the network couldn't say. */
export type DeliveryChain = {
  balance(hop: string): Promise<bigint | null>;
  blockhashValid(blockhash: string): Promise<boolean | null>;
  /** null: couldn't ask; otherwise whether it would run */
  simulate(raw: Uint8Array): Promise<{ ok: boolean; err?: string } | null>;
  send(raw: Uint8Array): Promise<void>;
  /** undefined: couldn't ask; null: not seen */
  status(sigs: string[], history?: boolean): Promise<("confirmed" | "failed" | null)[] | undefined>;
  nonceValue(account: string): Promise<string | null | undefined>;
  /**
   * The hop's history, read page by page (see readDelivery): which transaction it paid for first
   * (whoever sent it: this relayer, or the owner's app), and whom that paid. Transactions others sent
   * to it (dust, say) never count.
   */
  history(hop: string): HistoryRpc;
  /** for a record caught before its TX1 was settled: whether it landed, certainly can't, or neither yet */
  tx1State(rec: HopRec): Promise<"landed" | "dropped" | "unknown">;
};

const KEEP_DONE_MS = 48 * 3600_000;
const KEEP_WAITING_MS = 30 * 24 * 3600_000;
/**
 * Every hop this server delivered from (and every one it watched) stays on the daily sweep's list for
 * this long, so an exchange returning a deposit months later is still listed for its owner's app: kept
 * in monthly files (see seenMonth), so a new delivery only ever saves the current month's. Past the cap
 * (far more than this many months of deliveries), the oldest go first, and the operator is told.
 */
export const KEEP_SEEN_MS = 400 * 24 * 3600_000;
const MAX_SEEN = 250_000;
/** the monthly file a hop first seen at `at` is kept in ("2026-10") */
export const seenMonth = (at: number) => new Date(at).toISOString().slice(0, 7);
/** the months whose files may hold hops still kept at `now`, oldest first */
export function seenMonths(now = Date.now()): string[] {
  const out: string[] = [];
  const d = new Date(now - KEEP_SEEN_MS);
  d.setUTCDate(1);
  for (let m = seenMonth(d.getTime()); m <= seenMonth(now); d.setUTCMonth(d.getUTCMonth() + 1), m = seenMonth(d.getTime())) out.push(m);
  return out;
}
/** a hop funded this long without being delivered is something the operator should hear about */
export const LATE_MS = 10 * 60_000;
const LOOKUP_WINDOW_MS = 5 * 60_000;
/** a delivery none of whose signed transfers simulates is tried again this many times, over at least this long, before the owner's app is asked */
const SIM_TRIES = 5;
const SIM_WAIT_MS = 3 * 60_000;
/** a hop of a payment the owner's app sent itself is looked at this long after it was seen, every so often, for so long */
const WATCH_AFTER_MS = 2 * 60_000;
const WATCH_EVERY_MS = 10 * 60_000;
const WATCH_FOR_MS = 2 * 3600_000;
/**
 * A payment the owner's app sent itself is watched only once it is seen landing (a payment that can't
 * land costs nothing to send, so anyone could flood the list with those): looked up this long after
 * it passed, and let go if it hasn't landed this long after. At most this many wait, and this many
 * from one network.
 */
const SELF_LOOK_AFTER_MS = 20_000;
const SELF_GIVE_UP_MS = 3 * 60_000;
const MAX_PENDING_SELF = 2_000;
const PENDING_SELF_PER_KEY = 20;
/** one look at a hop's history reads at most this much (what it read is kept, and the next look carries on from there) */
const LOOK_PAGES = 6;
const LOOK_READS = 12;
/** histories kept (open deliveries' and lately lost ones'; dropped oldest first past this) */
const MAX_HISTORIES = 5_000;
/**
 * A delivery still funded or waiting after this many passes of the finisher is looked at less and less
 * often (a minute apart, then two, ... at most this far apart): one the owner's app has to finish may
 * wait weeks, and dust sent to it must never cost reads every 30 seconds for all that time.
 */
const LOOKS_AT_FULL_PACE = 8;
const MAX_LOOK_GAP_MS = 15 * 60_000;
export const lookGap = (passes: number) => (passes <= LOOKS_AT_FULL_PACE ? 0 : Math.min(30_000 * 2 ** (passes - LOOKS_AT_FULL_PACE), MAX_LOOK_GAP_MS));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HopLedger {
  readonly recs = new Map<string, HopRec>();
  /** every hop this server has delivered from lately (hop -> when): an exchange's refund to one is found by the sweep */
  private seen = new Map<string, number>();
  /**
   * Recipients of pool payments the owner's app sent itself through this site's RPC (hop -> when): the
   * sweep looks at them too, so a delivery cut short there is found from any device. Some may be the
   * sender's own wallets, so these are never refused as recipients the way `seen` hops are.
   */
  private watched = new Map<string, number>();
  /** payments the owner's app sent itself, by signature, until they are seen landing (not saved) */
  private pendingSelf = new Map<string, { hops: string[]; at: number; key: string }>();
  /** watched hops found holding SOL since the last sweep, and when each was last looked at (not saved) */
  private recent = new Map<string, string>();
  private lookedAt = new Map<string, number>();
  /** hops some step is working on right now */
  private busy = new Set<string>();
  /** hops holding SOL at the last sweep */
  private openList: { hop: string; lamports: string }[] = [];
  private sweptAt = 0;
  private warnedLate = new Set<string>();
  /** what was read of each hop's history, and the pool spend it is read back to (not saved): see firstSpend */
  private hist = new Map<string, { tx1?: string; h: HopHistory }>();
  /** open deliveries the finisher found unchanged pass after pass, and when each is looked at next (not saved) */
  private nextLook = new Map<string, { passes: number; at: number }>();
  /** told whenever a record's status changes (the scheduler follows its payments' deliveries) */
  onChange?: (rec: HopRec) => void;
  loaded = false;

  constructor(
    private chain: DeliveryChain,
    private pool: NoncePool,
    private authority: () => Keypair | null,
    /** `saveSeen` keeps the hops seen and watched in monthly files of their own (without it, they are saved with the records) */
    private io: { save: () => void; saveNow: () => Promise<void>; restoring?: () => boolean; saveSeen?: (month: string, data: () => string) => void },
  ) {}

  /** months whose seen or watched hops changed since they were last handed to saveSeen */
  private seenDirty = new Set<string>();
  private warnedFull = false;

  serialize(): string {
    if (this.io.saveSeen) return JSON.stringify({ v: 1, recs: [...this.recs.values()] });
    return JSON.stringify({ v: 1, recs: [...this.recs.values()], seen: [...this.seen.entries()], watched: [...this.watched.entries()] });
  }

  /** One month's file of hops seen and watched (see seenMonth). */
  serializeSeen(month: string): string {
    const of = (m: Map<string, number>) => [...m].filter(([, at]) => seenMonth(at) === month);
    return JSON.stringify({ v: 1, month, seen: of(this.seen), watched: of(this.watched) });
  }

  /**
   * Takes one month's saved file (see serializeSeen), adding what isn't held. `late`: App Storage gave
   * it after the start, when this copy may already have written that month with only the hops seen
   * since. What it adds is then saved again, so the full month replaces that partial one in storage
   * (the partial copy would otherwise be uploaded over it, and the earlier hops lost at the next start).
   */
  adoptSeen(text: string | null, late = false) {
    if (!text) return;
    try {
      const o = JSON.parse(text) as { seen?: [string, number][]; watched?: [string, number][] };
      for (const [m, list] of [[this.seen, o.seen], [this.watched, o.watched]] as const)
        for (const [h, at] of list ?? [])
          if (!m.has(h)) {
            m.set(h, at);
            if (late) this.touchSeen(at);
          }
    } catch (e) {
      log(`hops: couldn't read a saved month of sending addresses: ${(e as Error).message}`);
    }
    if (late) this.saveSeen();
  }

  private touchSeen(at: number) {
    this.seenDirty.add(seenMonth(at));
  }

  /** Hands every changed month to saveSeen (or saves the records, which then hold them). */
  private saveSeen() {
    if (!this.seenDirty.size) return;
    const save = this.io.saveSeen;
    if (save) for (const m of this.seenDirty) save(m, () => this.serializeSeen(m));
    else this.io.save();
    this.seenDirty.clear();
  }

  /** Takes the saved ledger: in place of what is held, or (`merge`, a copy App Storage gave late) adding what isn't held. */
  adopt(text: string | null, merge = false) {
    if (!merge) {
      this.recs.clear();
      this.seen.clear();
    }
    if (!text) return;
    try {
      const o = JSON.parse(text) as { recs?: HopRec[]; seen?: [string, number][]; watched?: [string, number][] };
      for (const r of o.recs ?? []) if (!merge || !this.recs.has(r.hop)) this.recs.set(r.hop, r);
      // (a ledger from before the monthly files holds them itself: each goes to its month's file)
      for (const [h, at] of o.seen ?? [])
        if (!this.seen.has(h)) {
          this.seen.set(h, at);
          this.touchSeen(at);
        }
      for (const [h, at] of o.watched ?? [])
        if (!this.watched.has(h)) {
          this.watched.set(h, at);
          this.touchSeen(at);
        }
    } catch (e) {
      log(`hops: couldn't read the saved deliveries: ${(e as Error).message}`);
    }
  }

  get(hop: string): HopRec | undefined {
    return this.recs.get(hop);
  }

  /** Whether this address is (or lately was) a hop: a payment may never be sent to one. */
  isHop(address: string): boolean {
    return this.recs.has(address) || this.seen.has(address);
  }

  /**
   * Whether the ledger can be taken at its word: loaded, and App Storage's copy is in (until then a
   * delivery this copy has no record of may still be on its way back).
   */
  ready(): boolean {
    return this.loaded && !this.io.restoring?.();
  }

  /** Whether a delivery from this hop may still be sent (null while the ledger isn't ready). */
  pending(hop: string): boolean | null {
    if (!this.ready()) return null;
    const r = this.recs.get(hop);
    return !!r && (r.status === "sending" || r.status === "funded" || this.busy.has(hop));
  }

  private set(r: HopRec, status: HopStatus, patch: Partial<HopRec> = {}) {
    const was = r.status;
    Object.assign(r, patch);
    r.status = status;
    if (status === "funded" && !r.fundedAt) r.fundedAt = Date.now();
    if (status === "delivered" || status === "withdrawn" || status === "dropped") {
      r.done = Date.now();
      this.hist.delete(r.hop);
    }
    if (was !== status) this.nextLook.delete(r.hop);
    // its nonce is of no more use (free, or retired first if it was exposed); a scheduled payment
    // whose pool payment didn't land keeps its own, since it goes again on the same signature
    if (status === "delivered" || status === "withdrawn" || status === "waiting" || (status === "dropped" && !r.jobId)) this.pool.release(r.n2?.leaseId);
    this.io.save();
    if (was !== status) this.onChange?.(r);
  }

  /**
   * Writes a delivery down before its TX1 is sent, and resolves only once it is saved: a failed save
   * throws and nothing is sent. A hop is only ever one payment's (the same payment tried again may
   * write it again).
   */
  async begin(rec: Omit<HopRec, "status" | "at" | "tx2">): Promise<HopRec> {
    const cur = this.recs.get(rec.hop);
    if (cur && (cur.nullifiers[0] !== rec.nullifiers[0] || cur.nullifiers[1] !== rec.nullifiers[1] || (cur.status !== "dropped" && cur.status !== "sending"))) {
      throw Object.assign(new Error("This payment's sending address was already used. Refresh the page and try again. Nothing was spent."), { status: 409, code: "stale" });
    }
    // the same payment sent again: an earlier send may still be the one that lands, so each is kept
    const earlier = cur ? [...new Set([...(cur.tx1s ?? []), cur.tx1])].filter((s) => s && s !== rec.tx1).slice(-6) : [];
    const r: HopRec = { ...rec, ...(earlier.length ? { tx1s: earlier, lastValid: Math.max(rec.lastValid, cur!.lastValid) } : {}), tx2: [], status: "sending", at: Date.now() };
    this.recs.set(r.hop, r);
    this.hist.delete(r.hop);
    this.nextLook.delete(r.hop);
    const was = this.seen.get(r.hop);
    if (was !== undefined) this.touchSeen(was);
    this.seen.delete(r.hop);
    this.seen.set(r.hop, r.at);
    this.touchSeen(r.at);
    this.busy.add(r.hop);
    try {
      // its nonce is held for this delivery from now on, with no time limit (let go once it ends), saved
      // like the record: a restart must never free the nonce of a delivery that may still go out
      if (r.n2) await this.pool.take(r.n2.leaseId, r.hop);
      await this.io.saveNow();
    } catch (e) {
      this.recs.delete(r.hop);
      if (cur) this.recs.set(cur.hop, cur);
      this.busy.delete(r.hop);
      throw e;
    }
    return r;
  }

  /**
   * A one-time sending address of a payment the owner's app sent itself (seen passing this site's
   * RPC): watched, so a delivery cut short there is listed in /api/hops/open for any device.
   */
  remember(hop: string, now = Date.now()) {
    if (this.recs.has(hop) || this.watched.has(hop)) return;
    this.watched.set(hop, now);
    this.touchSeen(now);
    this.trimSeen();
    this.saveSeen();
  }

  /** Past the cap, the oldest go first (they are kept in the order they were first seen), and the operator is told once. */
  private trimSeen() {
    for (const m of [this.seen, this.watched]) {
      if (m.size <= MAX_SEEN) continue;
      if (!this.warnedFull) {
        this.warnedFull = true;
        log(`hops: over ${MAX_SEEN} sending addresses are on the daily look-over; the oldest are let go (their owners' apps can still check them all from Your records)`);
      }
      while (m.size > MAX_SEEN) {
        const [h, at] = m.entries().next().value!;
        m.delete(h);
        this.touchSeen(at);
      }
    }
  }

  /**
   * A pool payment sent through this site's RPC by the owner's app itself (signature, its co-signing
   * hops, and the sender's network): its hops are remembered once it is seen landing (see tick).
   */
  selfSent(signature: string, hops: string[], key = "", now = Date.now()) {
    if (!hops.length || this.pendingSelf.has(signature) || this.pendingSelf.size >= MAX_PENDING_SELF) return;
    let mine = 0;
    for (const p of this.pendingSelf.values()) if (p.key === key && ++mine >= PENDING_SELF_PER_KEY) return;
    this.pendingSelf.set(signature, { hops, at: now, key });
  }

  /** Payments the owner's app sent itself that have had time to land: the hops of those that did are watched. */
  private async settleSelfSent(now: number) {
    const ripe = [...this.pendingSelf].filter(([, p]) => now - p.at > SELF_LOOK_AFTER_MS).slice(0, 256);
    if (!ripe.length) return;
    const st = await this.chain.status(ripe.map(([s]) => s), true).catch(() => undefined);
    ripe.forEach(([sig, p], i) => {
      const s = st?.[i];
      if (s === "confirmed") {
        for (const h of p.hops) this.remember(h, now);
        this.pendingSelf.delete(sig);
      } else if (s === "failed" || (s === null && now - p.at > SELF_GIVE_UP_MS) || now - p.at > 5 * SELF_GIVE_UP_MS) this.pendingSelf.delete(sig);
    });
  }

  /**
   * A record taken as dropped while its payment says its pool payment landed: the chain is asked
   * again, and one whose pool payment did land after all goes back to the finisher. Answers what the
   * chain says ("unknown" while it can't tell).
   */
  async recheck(hop: string): Promise<"landed" | "dropped" | "unknown"> {
    const r = this.recs.get(hop);
    if (!r || r.status !== "dropped" || this.busy.has(hop)) return "unknown";
    this.busy.add(hop);
    try {
      const s = await this.chain.tx1State(r).catch(() => "unknown" as const);
      if (s === "landed" && r.status === "dropped") {
        delete r.done;
        this.set(r, "funded");
      }
      return s;
    } finally {
      this.busy.delete(hop);
    }
  }

  /** Its TX1 certainly didn't land: nothing was spent, and its nonce is free again. */
  dropped(hop: string) {
    const r = this.recs.get(hop);
    this.busy.delete(hop);
    if (r && r.status === "sending") this.set(r, "dropped");
  }

  /** Its TX1 may still land (the network couldn't say in time): the finisher follows it. */
  unsettled(hop: string) {
    this.busy.delete(hop);
  }

  /**
   * Its TX1 landed: sends TX2 and follows it for up to `limitMs`. "pending" means a TX2 was sent but
   * not yet seen to land (the finisher follows it), "waiting" that only the owner's app can finish it.
   */
  async funded(hop: string, limitMs = 45_000): Promise<DeliveryOutcome> {
    const r = this.recs.get(hop);
    if (!r) return { status: "waiting", signature: null };
    if (r.status === "sending") this.set(r, "funded");
    this.busy.add(hop);
    try {
      return await this.deliver(r, limitMs, true);
    } finally {
      this.busy.delete(hop);
    }
  }

  /** The hop's balance, waiting a few seconds for it to show (a read can lag just behind the TX1 that paid it). */
  private async balanceAfterFunding(hop: string, fresh: boolean): Promise<bigint | null> {
    let b = await this.chain.balance(hop);
    for (let i = 0; fresh && i < 8 && (b === 0n || b === null); i++) {
      await wait(1000);
      b = await this.chain.balance(hop);
    }
    return b;
  }

  /**
   * The signed deliveries still usable, in the order they're tried: the blockhash one while it's
   * valid, then the nonce one while its nonce holds the value the hop signed over. Each comes with a
   * copy to simulate (the nonce authority's signature left blank) and the real one, which for N2 is
   * only made, by rebuilding the message from the record and signing it with N, once its nonce is
   * marked exposed and saved: from then on that nonce goes to no other payment until it has moved on.
   */
  private async candidates(r: HopRec): Promise<{ list: { shape: "l1" | "n2"; sim: Uint8Array; raw: () => Promise<Uint8Array | null> }[]; unsure: boolean }> {
    const out: { shape: "l1" | "n2"; sim: Uint8Array; raw: () => Promise<Uint8Array | null> }[] = [];
    const hop = new PublicKey(r.hop);
    const to = new PublicKey(r.to);
    const lamports = BigInt(r.amount);
    // the network couldn't say whether one is still usable: not given up on
    let unsure = false;
    const valid = r.l1 ? await this.chain.blockhashValid(r.l1.blockhash) : false;
    if (valid === null) unsure = true;
    if (r.l1 && valid === true) {
      const m = l1Message({ hop, to, lamports, blockhash: r.l1.blockhash });
      const sig = bs58.decode(r.l1.sig);
      if (verifyDelivery(m, sig, hop)) {
        const raw = deliveryTransaction(m, [sig]);
        out.push({ shape: "l1", sim: raw, raw: async () => raw });
      }
    }
    const n = this.authority();
    const lease = this.pool.get(r.n2?.leaseId);
    if (r.n2 && n && lease && lease.account === r.n2.account && (lease.state === "leased" || (lease.state === "exposed" && lease.hop === r.hop))) {
      const m = n2Message({ hop, to, lamports, nonceAccount: new PublicKey(r.n2.account), authority: n.publicKey, nonce: r.n2.value });
      const sig = bs58.decode(r.n2.sig);
      const leaseId = r.n2.leaseId;
      const value = await this.chain.nonceValue(r.n2.account);
      if (value === undefined) unsure = true;
      if (verifyDelivery(m, sig, hop) && value === r.n2.value) {
        out.push({
          shape: "n2",
          sim: deliveryTransaction(m, [sig, new Uint8Array(64)]),
          raw: async () => {
            try {
              await this.pool.expose(leaseId, r.hop);
            } catch {
              return null;
            }
            return deliveryTransaction(m, [sig, signDelivery(m, n)]);
          },
        });
      }
    }
    return { list: out, unsure };
  }

  /**
   * The first transaction the hop paid for itself after the pool spend that paid it (`tx1`), whatever
   * others sent it (dust, say), and whether it paid `to` (a standard SOL transfer, checked as the
   * owner's app checks it): its delivery when it did, the owner's app moving the SOL elsewhere when it
   * didn't. With no `to` known, any counts as the delivery. Null when the history shows none; undefined
   * when it can't be told yet (the network couldn't say, or this look's share of reads ran out first).
   * What was read is kept, so each transaction in its history is read once, a long one over a few looks.
   */
  private async firstSpend(hop: string, tx1: string | undefined, to: string | undefined): Promise<{ sig: string; toRecipient: boolean } | null | undefined> {
    let e = this.hist.get(hop);
    if (!e || e.tx1 !== tx1) {
      e = { tx1, h: newHopHistory() };
      this.hist.delete(hop);
      this.hist.set(hop, e);
      while (this.hist.size > MAX_HISTORIES) this.hist.delete(this.hist.keys().next().value!);
    }
    const h = e.h;
    const sig = await readDelivery(h, tx1, undefined, this.chain.history(hop), { pages: LOOK_PAGES, reads: LOOK_READS }).catch(() => undefined);
    if (sig == null) return sig;
    return { sig, toRecipient: !to || !!h.first?.pays(to) };
  }

  /**
   * A hop that doesn't hold what its delivery sends: was it delivered? See firstSpend. Any send of its
   * pool payment may be the one that landed, so with more than one its history is read to the start.
   */
  private emptiedBy(r: HopRec) {
    return this.firstSpend(r.hop, r.tx1s?.length ? undefined : r.tx1, r.to);
  }

  /** The hop paid for a transaction of its own: delivered when that paid the recipient, otherwise withdrawn. */
  private spentBy(r: HopRec, by: { sig: string; toRecipient: boolean }): DeliveryOutcome {
    if (!by.toRecipient) {
      // the record (and a scheduled payment's job, see schedule.ts) ends here: nothing more is sent from it
      this.set(r, "withdrawn", { withdrawnBy: by.sig });
      return { status: "waiting", signature: null };
    }
    this.set(r, "delivered", { delivered: by.sig });
    return { status: "delivered", signature: by.sig };
  }

  /**
   * A hop with no record here (let go long ago, or lost with the saved ledger) whose payment's TX1
   * (`tx1`, when known) landed: delivered when the first transaction the hop paid for itself went to
   * the recipient (`to`, when known), or when it holds nothing and paid for none (nothing is left to
   * deliver); withdrawn when it paid elsewhere first (the owner's app moved its SOL); otherwise its SOL
   * waits for the owner's app. Null while that can't be told.
   */
  async settleMissing(hop: string, o: { tx1?: string; to?: string } = {}): Promise<{ delivered: true; signature: string | null } | { delivered: false; withdrawn?: true } | null> {
    const bal = await this.chain.balance(hop);
    if (bal === null) return null;
    const by = await this.firstSpend(hop, o.tx1, o.to);
    if (by) return by.toRecipient ? { delivered: true, signature: by.sig } : { delivered: false, withdrawn: true };
    if (bal === 0n) return by === null ? { delivered: true, signature: null } : null;
    return { delivered: false };
  }

  /**
   * Sends the hop's delivery. Each signed delivery is simulated before it is first sent and never
   * sent after a failed simulation, so a delivery that can't run never costs the hop a fee.
   */
  private async deliver(r: HopRec, limitMs: number, fresh = false): Promise<DeliveryOutcome> {
    const expected = BigInt(r.amount) + DELIVERY_FEE;
    const pending = (signature = r.tx2.at(-1) ?? null): DeliveryOutcome => ({ status: "pending", signature });
    // sent before (by this copy, or one before a restart): one of those may have landed
    if (r.tx2.length) {
      const st = await this.chain.status(r.tx2, true);
      const hit = st?.findIndex((s) => s === "confirmed") ?? -1;
      if (hit >= 0) {
        this.set(r, "delivered", { delivered: r.tx2[hit] });
        return { status: "delivered", signature: r.tx2[hit] };
      }
    }
    const bal = await this.balanceAfterFunding(r.hop, fresh);
    if (bal === null) return pending();
    if (bal !== expected) {
      // emptied by one of its deliveries or by the owner's app (a little dust sent to it since changes nothing)
      const by = await this.emptiedBy(r);
      if (by) return this.spentBy(r, by);
      // empty with no transfer of its own: the read lags behind the TX1 that paid it (looked at again later)
      if (bal === 0n) return pending();
      // someone sent it a little extra: only the owner's app can pass on what it really holds
      this.set(r, "waiting");
      return { status: "waiting", signature: null };
    }
    let sentAny = false;
    let refused = false;
    const { list, unsure } = await this.candidates(r);
    if (!list.length && unsure) return pending();
    for (const c of list) {
      const sim = await this.chain.simulate(c.sim);
      if (sim === null) return pending();
      if (!sim.ok) {
        log(`hops: a delivery didn't simulate (${c.shape}): ${String(sim.err ?? "").slice(0, 120)}`);
        refused = true;
        continue;
      }
      // its nonce couldn't be marked exposed (a save failed): nothing was signed, so it is tried again later
      const raw = await c.raw();
      if (!raw) return pending();
      const sig = bs58.encode(raw.slice(1, 65));
      if (!r.tx2.includes(sig)) r.tx2 = [...r.tx2, sig].slice(-6);
      this.io.save();
      sentAny = true;
      await this.chain.send(raw).catch(() => {});
      const out = await this.follow(r, sig, raw, c.shape, limitMs);
      if (out === "confirmed") {
        this.set(r, "delivered", { delivered: sig });
        return { status: "delivered", signature: sig };
      }
      if (out === "unknown") return { status: "pending", signature: sig };
      if (out === "failed") break;
      // expired: it can't land any more, so the next one is tried
    }
    // a send that failed or expired may have moved its balance on meanwhile: looked at again by the finisher
    if (sentAny) {
      const b = await this.chain.balance(r.hop);
      const by = b !== null && b !== expected ? await this.emptiedBy(r) : null;
      if (by) return this.spentBy(r, by);
      if (b === null || b === 0n) return pending();
    }
    // none simulated: often a node just behind the one that saw the hop paid (the account or the
    // blockhash not there yet), so it is tried again for a few minutes before the owner's app is asked
    if (refused && !sentAny) {
      r.simFails = (r.simFails ?? 0) + 1;
      this.io.save();
      if (r.simFails < SIM_TRIES || Date.now() - (r.fundedAt ?? r.at) < SIM_WAIT_MS) return pending();
    }
    this.set(r, "waiting");
    return { status: "waiting", signature: null };
  }

  /** Follows one sent delivery until it lands, fails, can't land any more, or time runs out. */
  private async follow(r: HopRec, sig: string, raw: Uint8Array, shape: "l1" | "n2", limitMs: number): Promise<"confirmed" | "failed" | "expired" | "unknown"> {
    const started = Date.now();
    let lastSend = started;
    let lastLook = started;
    while (Date.now() - started < limitMs) {
      await wait(1000);
      const st = (await this.chain.status([sig]))?.[0];
      if (st === "confirmed") return "confirmed";
      if (st === "failed") return "failed";
      if (st === null && Date.now() - lastSend > 2000) {
        lastSend = Date.now();
        void this.chain.send(raw).catch(() => {});
      }
      if (st !== null || Date.now() - lastLook < 5000) continue;
      lastLook = Date.now();
      // null: the network couldn't say (a failed read is never taken as "it can't land any more")
      let alive: boolean | null;
      if (shape === "l1") alive = await this.chain.blockhashValid(r.l1!.blockhash);
      else {
        const v = await this.chain.nonceValue(r.n2!.account);
        alive = v === undefined ? null : v === r.n2!.value;
      }
      if (alive !== false) continue;
      const last = (await this.chain.status([sig], true))?.[0];
      if (last === undefined) continue;
      if (last === "confirmed") return "confirmed";
      if (last === "failed") return "failed";
      return "expired";
    }
    return "unknown";
  }

  /** One pass of the finisher: every open delivery a step further, and old records let go. */
  async tick(now = Date.now()) {
    for (const r of [...this.recs.values()]) {
      if (this.busy.has(r.hop)) continue;
      const keep = r.status === "waiting" ? KEEP_WAITING_MS : KEEP_DONE_MS;
      if (((r.status === "delivered" || r.status === "withdrawn" || r.status === "dropped") && now - (r.done ?? r.at) > keep) || (r.status === "waiting" && now - (r.fundedAt ?? r.at) > keep)) {
        this.recs.delete(r.hop);
        this.hist.delete(r.hop);
        this.nextLook.delete(r.hop);
        continue;
      }
      // open a while without a change: looked at less often (see lookGap)
      const open = r.status === "funded" || r.status === "waiting";
      const next = this.nextLook.get(r.hop);
      if (open && next && now < next.at) continue;
      const was = r.status;
      this.busy.add(r.hop);
      try {
        if (r.status === "sending") {
          const s = await this.chain.tx1State(r);
          if (s === "dropped") this.set(r, "dropped");
          else if (s === "landed") this.set(r, "funded");
        }
        if (r.status === "funded") await this.deliver(r, 15_000);
        else if (r.status === "waiting") {
          // finished by the owner's app: it holds less than the payment now (dust sent to it since changes nothing)
          const b = await this.chain.balance(r.hop);
          const by = b !== null && b < BigInt(r.amount) ? await this.emptiedBy(r) : null;
          if (by) this.spentBy(r, by);
        }
      } catch (e) {
        log(`hops: ${(e as Error).message}`);
      } finally {
        this.busy.delete(r.hop);
      }
      if (open && r.status === was) {
        const passes = (next?.passes ?? 0) + 1;
        this.nextLook.set(r.hop, { passes, at: now + lookGap(passes) });
      }
      if (r.status === "funded" && now - (r.fundedAt ?? now) > LATE_MS && !this.warnedLate.has(r.hop)) {
        this.warnedLate.add(r.hop);
        log("hops: a delivery has been waiting over 10 minutes after its pool payment landed; the finisher keeps trying");
      }
    }
    // payments the owner's app sent itself: watched once seen landing
    await this.settleSelfSent(now);
    // payments the owner's app sent itself, a few minutes on: one cut short is listed at once, not only after the daily sweep
    const look = [...this.watched].filter(([h, at]) => now - at > WATCH_AFTER_MS && now - at < WATCH_FOR_MS && now - (this.lookedAt.get(h) ?? 0) > WATCH_EVERY_MS);
    for (const [h] of look.slice(0, 20)) {
      this.lookedAt.set(h, now);
      const b = await this.chain.balance(h).catch(() => null);
      if (b === null) continue;
      if (b > 0n) this.recent.set(h, b.toString());
      else this.recent.delete(h);
    }
    for (const [h] of this.lookedAt) if (now - (this.watched.get(h) ?? 0) >= WATCH_FOR_MS) this.lookedAt.delete(h);
    for (const m of [this.seen, this.watched])
      for (const [h, at] of m)
        if (now - at > KEEP_SEEN_MS) {
          m.delete(h);
          this.touchSeen(at);
        }
    this.trimSeen();
    this.saveSeen();
    this.io.save();
  }

  /** Daily: which hops hold SOL (an exchange's refund to a closed one, say), for /api/hops/open. */
  async sweep(read: (hops: string[]) => Promise<(bigint | null)[]>, now = Date.now()) {
    const all = [...new Set([...this.seen.keys(), ...this.recs.keys(), ...this.watched.keys()])];
    const open: { hop: string; lamports: string }[] = [];
    for (let i = 0; i < all.length; i += 100) {
      const part = all.slice(i, i + 100);
      const bals = await read(part);
      part.forEach((h, k) => {
        const b = bals[k];
        if (b && b > 0n) open.push({ hop: h, lamports: b.toString() });
      });
    }
    this.openList = open;
    this.sweptAt = now;
    this.recent.clear();
  }

  /** Hops holding SOL (public chain facts): the owner's app picks out its own here, so it never has to say which are its. */
  open() {
    // a delivery still open shows at once, not only after the next sweep
    const listed = new Set(this.openList.map((o) => o.hop));
    const extra: { hop: string; lamports: string | null }[] = [];
    for (const r of this.recs.values()) if ((r.status === "funded" || r.status === "waiting") && !listed.has(r.hop)) extra.push({ hop: r.hop, lamports: null });
    for (const [hop, lamports] of this.recent) if (!listed.has(hop) && !this.recs.has(hop)) extra.push({ hop, lamports });
    return { at: this.sweptAt || null, hops: [...this.openList, ...extra] };
  }

  /**
   * A hop's own delivery, for the owner's app after it lost its own record: asked with the hop's
   * signature over the hop and the time, so only whoever holds the hop's key learns where it goes.
   */
  lookup(hop: string, ts: number, sig: string, now = Date.now()) {
    let key: PublicKey;
    let s: Uint8Array;
    try {
      key = new PublicKey(hop);
      s = bs58.decode(sig);
    } catch {
      throw Object.assign(new Error("Malformed request."), { status: 400 });
    }
    if (!Number.isSafeInteger(ts) || Math.abs(now - ts) > LOOKUP_WINDOW_MS || !verifyDelivery(hopLookupMessage(key, ts), s, key)) {
      throw Object.assign(new Error("Not allowed."), { status: 403 });
    }
    const r = this.recs.get(key.toBase58());
    if (!r) return { status: "unknown" as const };
    const n = this.pool.authorityKey?.toBase58();
    return {
      status: r.status,
      to: r.to,
      amount: r.amount,
      tx1: r.tx1,
      signature: r.delivered ?? null,
      // what the hop signed: the app checks the recipient against the hop's own signature, not this server's word
      ...(r.l1 ? { l1: { blockhash: r.l1.blockhash, sig: r.l1.sig } } : {}),
      ...(r.n2 && n ? { n2: { account: r.n2.account, authority: n, value: r.n2.value, sig: r.n2.sig } } : {}),
    };
  }

  status(now = Date.now()) {
    const all = [...this.recs.values()];
    return {
      open: all.filter((r) => r.status === "sending" || r.status === "funded").length,
      waiting: all.filter((r) => r.status === "waiting").length,
      late: all.filter((r) => r.status === "funded" && now - (r.fundedAt ?? now) > LATE_MS).length,
      seen: this.seen.size,
    };
  }
}

// ─── the ledger this server runs ───

const chain: DeliveryChain = {
  async balance(hop) {
    return conn
      .getBalance(new PublicKey(hop), "confirmed")
      .then((b) => BigInt(b))
      .catch(() => null);
  },
  async blockhashValid(blockhash) {
    return conn
      .isBlockhashValid(blockhash, { commitment: "confirmed" })
      .then((r) => r.value)
      .catch(() => null);
  },
  async simulate(raw) {
    try {
      // signatures were checked here already (the nonce authority's is added only once it may be sent)
      const r = await conn.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: false, commitment: "confirmed" });
      return r.value.err ? { ok: false, err: JSON.stringify(r.value.err) } : { ok: true };
    } catch {
      return null;
    }
  },
  async send(raw) {
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  },
  async status(sigs, history = false) {
    const r = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: history }).catch(() => null);
    if (!r) return undefined;
    return r.value.map((s) => (!s ? null : s.err ? "failed" : s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "confirmed" : null));
  },
  async nonceValue(account) {
    const a = await conn.getAccountInfo(new PublicKey(account), "confirmed").catch(() => undefined);
    if (a === undefined) return undefined;
    return a ? (readNonceAccount(new Uint8Array(a.data))?.nonce ?? null) : null;
  },
  history(hop) {
    const key = new PublicKey(hop);
    return {
      list: (q) => conn.getSignaturesForAddress(key, { limit: HISTORY_PAGE, ...q }, "confirmed").catch(() => null),
      read: async (sig) => {
        const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }).catch(() => undefined);
        if (!t) return undefined;
        const m = t.transaction.message;
        if (t.meta?.err || !m.staticAccountKeys[0]?.equals(key)) return { byHop: false };
        return { byHop: true, pays: (to: string) => paysTo(m, key, to) };
      },
    };
  },
  async tx1State(r) {
    // every send of this payment: an earlier one may be the one that landed (and a later one then failed)
    const sigs = [...new Set([...(r.tx1s ?? []), r.tx1])];
    const sts = (await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true }).catch(() => null))?.value;
    if (!sts) return "unknown";
    // only once confirmed: one merely processed can still be dropped with its fork
    if (sts.some((st) => st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized"))) return "landed";
    // each one that failed on-chain spent nothing; whether the notes were spent (and by this payment) is asked below
    if (!sts.every((st) => st?.err)) {
      const height = await conn.getBlockHeight("confirmed").catch(() => null);
      if (height == null || height <= r.lastValid) return "unknown";
    }
    const nfs = r.nullifiers.map((n) => pool.nullifier(BigInt("0x" + n)));
    const pdas = await conn.getMultipleAccountsInfo(nfs, "confirmed").catch(() => null);
    if (!pdas) return "unknown";
    if (pdas.every((a) => !a)) return "dropped";
    // spent: by this payment if its own new notes are in the pool (the hop's balance would say so too)
    if (store.hasLeaves(r.commitments.map((c) => BigInt("0x" + c)))) return "landed";
    const b = await conn.getBalance(new PublicKey(r.hop), "confirmed").catch(() => null);
    if (b && b > 0) return "landed";
    return store.isSpent(BigInt("0x" + r.nullifiers[0])) ? "dropped" : "unknown";
  },
};

export const hops: HopLedger = new HopLedger(chain, nonces, () => (config.deliveryNonce ? config.nonceAuthority : null), {
  save: () => saveState("hops", () => hops.serialize()),
  saveNow: () => saveStateNow("hops", () => hops.serialize(), true),
  restoring: () => stateRestoring("hops"),
  saveSeen: (month, data) => saveState(`hops-seen-${month}`, data),
});
nonces.hooks.hopPending = (hop) => hops.pending(hop);
// a payment the owner's app sent itself through this site's RPC: its one-time sending address is watched too, once it has landed
rpcHooks.selfSent = (signature, list, key) => hops.selfSent(signature, list, key);

let timer: NodeJS.Timeout | undefined;
let sweepTimer: NodeJS.Timeout | undefined;
let ticking = false;
const sweepRead = async (list: string[]) => {
  const infos = await conn.getMultipleAccountsInfo(list.map((h) => new PublicKey(h)), "confirmed");
  return infos.map((i) => (i ? BigInt(i.lamports) : 0n));
};
/**
 * On the copy that runs the state (with the scheduler): loads the deliveries and runs the finisher. A
 * copy App Storage gives only after the start is added then; until it is in, the ledger isn't ready
 * (see ready), so nothing takes a delivery it doesn't hold yet as gone.
 */
export async function startHops() {
  clearInterval(timer);
  clearInterval(sweepTimer);
  hops.adopt(await loadState("hops", (late) => hops.adopt(late, true)));
  // the sending addresses on the daily look-over, a file a month (oldest first, so the oldest go first past the cap)
  const months = seenMonths();
  const texts = await Promise.all(months.map((m) => loadState(`hops-seen-${m}`, (late) => hops.adoptSeen(late, true))));
  for (const t of texts) hops.adoptSeen(t);
  hops.loaded = true;
  const run = () => {
    if (ticking) return;
    ticking = true;
    void hops
      .tick()
      .catch((e) => log(`hops: ${(e as Error).message}`))
      .finally(() => (ticking = false));
  };
  timer = setInterval(run, 30_000);
  timer.unref?.();
  run();
  const sweep = () => void hops.sweep(sweepRead).catch((e) => log(`hops: couldn't look over the hops: ${(e as Error).message}`));
  sweepTimer = setInterval(sweep, 24 * 3600_000);
  sweepTimer.unref?.();
  setTimeout(sweep, 60_000).unref();
}
export function stopHops() {
  clearInterval(timer);
  clearInterval(sweepTimer);
  hops.loaded = false;
}
