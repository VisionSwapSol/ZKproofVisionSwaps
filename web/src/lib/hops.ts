import { PublicKey, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  DELIVERY_FEE,
  RESERVED_ADDRESSES,
  deliveryTransaction,
  deliveryWithdraw,
  hopLookupMessage,
  l1Message,
  lookalike,
  n2Message,
  predictCredit,
  readNonceAccount,
  signDelivery,
  verifyDelivery,
  type RecipientClass,
  type TreasuryView,
} from "@visionswap/sdk";
import { ls } from "./idb";

/**
 * Deliveries, as the app sees them (see sdk/src/delivery.ts). A private payment to an address
 * outside this account is sealed to a one-time sending address (the "hop"), whose key only this
 * browser can make. The pool pays the hop, and the hop passes the exact amount on to the recipient
 * in a standard SOL transfer it signed here first. This module keeps the rules that need no network:
 * the amounts, the signatures, the checks on a recipient, and a ledger on this device of every
 * delivery it started, so one that was interrupted is always finished, never lost.
 */

/** The version of this app: a server asking for a newer one gets a "refresh the page" instead of a payment. */
export const APP_VERSION = "1.6.0";

/** Whether version `a` is newer than `b` ("1.10.0" is newer than "1.9.2"; anything unreadable counts as 0). */
export function newerVersion(a: string, b: string): boolean {
  const p = (v: string) => v.split(".").map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

// ─── amounts ───

/**
 * A private payment of exactly `amount` to an outside address: what leaves the private balance
 * (`withdraw`), and how it splits. The hop receives `amount` plus the delivery fee and pays that
 * fee itself, so the recipient gets `amount` to the lamport.
 */
export function payQuote(amount: bigint, relayerFee: bigint, feeBps: number, treasury?: TreasuryView) {
  const withdraw = deliveryWithdraw(amount, relayerFee, feeBps, treasury);
  const credit = predictCredit(withdraw, relayerFee, feeBps, treasury);
  return { withdraw, relayerFee, protocolFee: withdraw - relayerFee - credit, deliveryFee: DELIVERY_FEE, toRecipient: credit - DELIVERY_FEE };
}

/**
 * What a delivery from a hop holding `balance` sends on (the hop pays the fee and ends at zero), or
 * why it can't. The hop pays its own fee, and the network lets a fee payer keep either nothing or at
 * least the rent minimum once the fee is taken: what it holds then is what it sends, so that must be
 * at least the rent minimum, whoever the recipient is ("too-small"; the SOL can go into the pool instead).
 */
export function finishAmount(balance: bigint, rentMin: bigint): { lamports: bigint } | { problem: "empty" | "too-small" } {
  const lamports = balance - DELIVERY_FEE;
  if (lamports <= 0n) return { problem: "empty" };
  if (lamports < rentMin) return { problem: "too-small" };
  return { lamports };
}

// ─── signatures ───

const b58 = (u: Uint8Array) => bs58.encode(u);

export type NonceLease = { account: string; value: string; authority: string };

/** The hop's signature over the delivery sent now (L1, on a recent blockhash), as the relayer takes it. */
export function l1Sig(hop: Keypair, to: PublicKey, lamports: bigint, blockhash: string): string {
  return b58(signDelivery(l1Message({ hop: hop.publicKey, to, lamports, blockhash }), hop));
}

/** The hop's signature over the delivery on a durable nonce (N2), which the relayer can send while the page is closed. */
export function n2Sig(hop: Keypair, to: PublicKey, lamports: bigint, n: NonceLease): string {
  return b58(
    signDelivery(n2Message({ hop: hop.publicKey, to, lamports, nonceAccount: new PublicKey(n.account), authority: new PublicKey(n.authority), nonce: n.value }), hop),
  );
}

/**
 * Whether a nonce account, as read from the chain, is the one the relayer said it would use: owned by
 * the System program, initialized, under the relayer's published nonce authority, at that value.
 */
export function nonceOk(acct: { owner: PublicKey | string; data: Uint8Array } | null, lease: NonceLease, authority: string | null): boolean {
  if (!acct || !authority || lease.authority !== authority) return false;
  const owner = typeof acct.owner === "string" ? acct.owner : acct.owner.toBase58();
  if (owner !== "11111111111111111111111111111111") return false;
  const n = readNonceAccount(acct.data);
  return !!n && n.authority.toBase58() === authority && n.nonce === lease.value;
}

/** A delivery made here (the owner finishing one, or sending returned SOL on): L1 for everything the hop holds, less its fee. */
export function finishTransaction(hop: Keypair, to: PublicKey, lamports: bigint, blockhash: string): Uint8Array {
  const m = l1Message({ hop: hop.publicKey, to, lamports, blockhash });
  return deliveryTransaction(m, [signDelivery(m, hop)]);
}

/** What the relayer remembers of a hop's delivery (POST /api/hops/lookup), with what the hop signed. */
export type HopLookup = {
  status: string;
  to?: string;
  amount?: string;
  l1?: { blockhash: string; sig: string };
  n2?: { account: string; authority: string; value: string; sig: string };
};

/**
 * The recipient of a hop's delivery as the relayer remembers it, trusted only when the hop's own
 * signature (made in this account's browser) covers a transfer to that address for that amount:
 * nobody can name another recipient for SOL waiting at a hop. Null otherwise.
 */
export function trustedRecipient(hop: PublicKey, r: HopLookup): string | null {
  if (!r.to || !r.amount) return null;
  try {
    const to = new PublicKey(r.to);
    const lamports = BigInt(r.amount);
    if (r.l1 && verifyDelivery(l1Message({ hop, to, lamports, blockhash: r.l1.blockhash }), bs58.decode(r.l1.sig), hop)) return to.toBase58();
    if (r.n2) {
      const m = n2Message({ hop, to, lamports, nonceAccount: new PublicKey(r.n2.account), authority: new PublicKey(r.n2.authority), nonce: r.n2.value });
      if (verifyDelivery(m, bs58.decode(r.n2.sig), hop)) return to.toBase58();
    }
  } catch {
    // anything malformed is trusted no more than a missing answer
  }
  return null;
}

/** The body that asks the relayer about a hop's own delivery, signed by the hop (see /api/hops/lookup). */
export function lookupBody(hop: Keypair, ts: number) {
  return { hop: hop.publicKey.toBase58(), ts, sig: b58(signDelivery(hopLookupMessage(hop.publicKey, ts), hop)) };
}

/**
 * A message signed by a sending address, for an exchange that asks the sender of a deposit to show
 * it controls that address. The text is signed as it is (UTF-8), the way wallets sign messages.
 */
export function signText(hop: Keypair, text: string): string {
  return b58(signDelivery(new TextEncoder().encode(text), hop));
}

/**
 * Whether a refusal says the pool's fee changed under the payment (nothing was spent): the app then reads
 * the pool again at once, so a second try is worked out from the new fee instead of being refused again.
 */
export function feeChanged(code: unknown, message: string): boolean {
  return code === "stale" || /pool fee changed/i.test(message);
}

// ─── recipients ───

/** What the app says about a recipient it can't pay, by kind. */
export function refusalText(c: RecipientClass): string {
  if (c === "token-account") return "This is a token account. For SOL, paste the main wallet address; on an exchange that's the address on its SOL deposit page.";
  if (c === "reserved") return "This address belongs to VisionSwap or to a program, so it can't receive this payment.";
  if (c === "nonce-account") return "This address holds a durable nonce, not a wallet, so it can't receive this payment. Check that you copied a wallet or deposit address.";
  return "This address belongs to a program and can't receive SOL here. Check that you copied a wallet or deposit address.";
}

export const OFF_CURVE_TEXT = "This address is managed by a program, such as a multisig vault. Continue if you copied it from that app.";

/**
 * Whether an address can be paid, judged without the network: null when it can, otherwise why not.
 * `reserved` holds the pool's own addresses and the relayer's, `hops` this account's sending addresses.
 */
export function recipientProblem(address: string, reserved: ReadonlySet<string>, hops: ReadonlySet<string>): string | null {
  let key: PublicKey;
  try {
    key = new PublicKey(address);
  } catch {
    return "That doesn't look like a Solana address.";
  }
  const a = key.toBase58();
  if (RESERVED_ADDRESSES.includes(a) || reserved.has(a)) return refusalText("reserved");
  if (hops.has(a)) return "That is the one-time sending address of one of your payments. Send to the recipient's own address.";
  return null;
}

/** Whether an address only a program can sign for (a multisig vault, say): those are paid once the sender confirms. */
export const offCurve = (address: string) => !PublicKey.isOnCurve(new PublicKey(address).toBytes());

/** A recent recipient that looks like `address` at a glance but isn't it (address-poisoning spam). */
export function poisoned(address: string, recent: readonly string[]): string | null {
  return lookalike(address, recent);
}

// ─── the ledger on this device ───

/**
 * One delivery this device started. "proved": the proof names the hop, and it may or may not have
 * gone; "sent": the pool paid (or is paying) the hop; "waiting": the hop holds SOL only this app can
 * pass on; "delivered": the recipient has it (`tx2` is the Transaction ID); "returned": SOL that
 * came back to the hop later went into the private balance.
 */
export type LegStatus = "proved" | "sent" | "waiting" | "delivered" | "returned";
export type HopLeg = {
  hop: string;
  /** the spend's change note (hex): the hop's key is made from it */
  out0: string;
  to: string;
  /** lamports the recipient gets */
  amount: string;
  status: LegStatus;
  at: number;
  tx1?: string;
  tx2?: string;
  /** the relayer's delivery as it answered, before it was seen landing: looked up first when the leg is checked */
  tx2cand?: string;
  /** a scheduled payment's id */
  job?: string;
  /** sent by the owner's own fee payer (the relayer never heard of it) */
  self?: boolean;
  done?: number;
  /** when the app last saw its sending address holding a payment (refreshed about daily): kept while it does */
  held?: number;
};

const KEEP_OPEN_MS = 30 * 24 * 3_600_000;
const KEEP_DONE_MS = 60 * 24 * 3_600_000;
/**
 * A proof that may never have gone: two weeks, so one the relayer delivered after the page closed
 * (it leaves its sending address at zero) is still found, and written down, when the app is next opened.
 */
const KEEP_PROVED_MS = 14 * 24 * 3_600_000;
const MAX_LEGS = 400;
/** how often a leg still holding a payment has that written down (see HopLeg.held) */
export const HELD_MARK_MS = 24 * 3_600_000;

export const legsKey = (fp: string) => `vs:hops:${fp}`;

/**
 * The ledger as it should be kept: finished ones for two months, unsent proofs for two weeks, open
 * ones a month, and any whose sending address was seen holding a payment within the last month for as
 * long as it keeps holding one (a delivery only the app can finish may wait for months). Past the
 * cap, finished ones and proofs go first (oldest first): an open one is never pushed out by count.
 */
export function pruneLegs(legs: HopLeg[], now = Date.now()): HopLeg[] {
  const holding = (l: HopLeg) => l.status !== "delivered" && l.status !== "returned" && l.held !== undefined && now - l.held < KEEP_OPEN_MS;
  const kept = legs.filter((l) => {
    const age = now - (l.done ?? l.at);
    if (l.status === "delivered" || l.status === "returned") return age < KEEP_DONE_MS;
    if (holding(l)) return true;
    if (l.status === "proved") return age < KEEP_PROVED_MS;
    return age < KEEP_OPEN_MS;
  });
  if (kept.length <= MAX_LEGS) return kept;
  const open = (l: HopLeg) => l.status === "sent" || l.status === "waiting" || holding(l);
  let room = Math.max(0, MAX_LEGS - kept.filter(open).length);
  return kept.filter((l) => open(l) || room-- > 0);
}

/** The ledger with `leg` in it (newest first; one per hop). */
export function upsertLeg(legs: HopLeg[], leg: HopLeg): HopLeg[] {
  return [leg, ...legs.filter((l) => l.hop !== leg.hop)];
}

/** One leg changed as it is now; a delivered or returned one never goes back to an earlier state. */
export function patchLeg(legs: HopLeg[], hop: string, patch: Partial<HopLeg>): HopLeg[] {
  const rank: Record<LegStatus, number> = { proved: 0, sent: 1, waiting: 1, delivered: 2, returned: 3 };
  return legs.map((l) => {
    if (l.hop !== hop) return l;
    if (patch.status && rank[patch.status] < rank[l.status]) {
      // an earlier step reported late: keep what is known
      const rest = { ...patch };
      delete rest.status;
      return { ...l, ...rest };
    }
    return { ...l, ...patch };
  });
}

export function readLegs(fp: string): HopLeg[] {
  return pruneLegs(ls.get<HopLeg[]>(legsKey(fp), []));
}

export function writeLegs(fp: string, legs: HopLeg[]) {
  ls.set(legsKey(fp), pruneLegs(legs));
}

// ─── the activity lines of deliveries ───

type DeliveryLine = { sig?: string; delivery?: { hop: string; onward?: boolean } };

/** Whether the activity has a line for the delivery from `hop` (SOL sent on after it came back has lines of its own). */
export function hasDeliveryLine(activity: readonly DeliveryLine[], hop: string): boolean {
  return activity.some((x) => x.delivery?.hop === hop && !x.delivery.onward);
}

/** The activity with the delivery's Transaction ID on its lines that have none yet; null when it has no line. */
export function fillDeliveryLine<T extends DeliveryLine>(activity: readonly T[], hop: string, sig: string): T[] | null {
  if (!hasDeliveryLine(activity, hop)) return null;
  return activity.map((x) => (x.delivery?.hop !== hop || x.delivery.onward || x.sig ? x : { ...x, sig }));
}

/**
 * The sending addresses a check of all of them found holding SOL, as kept for the later looks: after
 * such a check (`deep`), what it found; otherwise what was kept, less those a look found empty now.
 * One not worked out from this account's notes yet on this look (not in `mine`) stays as it was.
 */
export function keptFound(saved: readonly string[], mine: ReadonlySet<string>, deep: boolean, found: readonly string[], emptied: ReadonlySet<string>): string[] {
  if (deep) return [...new Set([...found, ...saved.filter((h) => !mine.has(h))])];
  return saved.filter((h) => !emptied.has(h));
}

/**
 * The relayer answers 30 lookups a minute from one network (the background look shares them): a scan
 * asks a few straight away, then one every LOOKUP_GAP_MS, so a check of many old sending addresses
 * never runs into the limit and takes a refund it couldn't look up as nothing there.
 */
export const LOOKUP_BURST = 5;
export const LOOKUP_GAP_MS = 2_500;
/** How long to wait before a scan's `k`th lookup (counting from 0). */
export const lookupWait = (k: number) => (k < LOOKUP_BURST ? 0 : LOOKUP_GAP_MS);

/** The least a sending address must hold to be shown at all (see sortOpen): less is dust or rent, worth no lookup. */
export const worthShowing = (lamports: bigint, rentMin: bigint) => lamports > 0n && lamports >= rentMin + DELIVERY_FEE;

/**
 * Whether every note of the open account has been read (the leaves downloaded up to the pool's count
 * last heard, and each opened): until then, sending addresses worked out from the notes are only some.
 */
export function notesRead<K>(o: { scannedFor: K | null; keys: K; scannedTo: number; leafCount: number; total: number }): boolean {
  return o.scannedFor === o.keys && o.leafCount >= o.total && o.scannedTo >= o.leafCount;
}

/**
 * What "Check all my sending addresses" says: how many hold SOL, and how many couldn't be looked up
 * just now (never "none" while some couldn't be: those may be the very refund the owner waits for).
 */
export function checkedText(r: { found: number; unread: number }): string {
  const n = (k: number) => (k === 1 ? "1 sending address" : `${k} sending addresses`);
  const later = r.unread
    ? `${r.unread === 1 ? "1 more holding SOL" : `${r.unread} more holding SOL`} couldn't be checked just now. Try again in a minute.`
    : "";
  if (r.found) return `Found ${n(r.found)} holding SOL: see Deliveries.${later ? ` ${later}` : ""}`;
  if (r.unread) return `${n(r.unread)} holding SOL couldn't be checked just now. Try again in a minute.`;
  return "None of your sending addresses holds SOL.";
}

/** Addresses this device paid lately (newest first), for spotting a lookalike pasted from a poisoned history. */
export function recentRecipients(legs: readonly HopLeg[], jobs: readonly { to: string; created: number }[]): string[] {
  const all = [...legs.map((l) => ({ to: l.to, t: l.at })), ...jobs.map((j) => ({ to: j.to, t: j.created }))].sort((a, b) => b.t - a.t);
  return [...new Set(all.map((x) => x.to))].slice(0, 50);
}

// ─── what is open ───

/** Over its payment and the delivery fee, the most a sending address may hold and still be finished by itself (dust someone sent it). */
export const AUTO_FINISH_SLACK = 1_000_000n;

/**
 * Whether the open app may finish a delivery by itself: the address holds what an undelivered payment
 * does (give or take a little dust). Anything else, such as an exchange's refund, is the owner's to decide.
 */
export const autoFinishable = (lamports: bigint, amount: bigint) => lamports >= amount + DELIVERY_FEE && lamports <= amount + DELIVERY_FEE + AUTO_FINISH_SLACK;

/** The network couldn't say whether a payment landed: it may still. Nothing may be sent again until that's known. */
export class MaybeSent extends Error {}

/**
 * Said before anything is sent, when a sending address's history can't be read: nothing is sent from it
 * on a guess. Often a moment's network trouble; when it lasts, the SOL can still go into the private
 * balance or anywhere the owner picks (the "look" kind of HopView).
 */
export const HISTORY_UNREAD =
  "Couldn't tell from this sending address's history whether this delivery already went, so nothing was sent. You can try again later, or move the SOL into your private balance or send it somewhere else.";
/** Said after a finishing transfer failed while its sending address was emptied, and the history can't say by what: it may have gone. */
export const EMPTIED_UNREAD = "This sending address was emptied, so the delivery may have gone. Check your activity in a minute before sending it again.";
/**
 * A scheduled payment whose sending address paid for something other than its delivery first: this
 * account moved its SOL (into the private balance, or on to an address the owner picked) before it went.
 * The relayer says the same in the same words.
 */
export const MOVED_ELSEWHERE = "Not delivered: its SOL was moved from its one-time sending address by your app (into your private balance, or to an address you picked).";
/** Said when a delivery's sending address holds something other than its payment: the owner decides. */
export const NEEDS_LOOK = "This delivery's sending address needs a look before anything is sent from it.";

/**
 * Before finishing a delivery from its sending address: `by` is what its history says (deliveredFrom:
 * the delivery's signature, null for none, undefined when it can't be told). Delivered already: that
 * is the answer, and nothing there now is sent again. Can't be told: nothing is sent, however it was
 * started (by itself or by the owner). Finishing by itself ("auto") also needs the address to hold
 * what an undelivered payment does (`amount`, when this device knows it). Not finishing (`false`):
 * a plain send, nothing to check.
 */
export function finishGate(
  by: string | null | undefined,
  finishing: false | "manual" | "auto",
  lamports: bigint,
  amount?: bigint,
): { delivered: string } | { refuse: string } | { send: true } {
  if (!finishing) return { send: true };
  if (by) return { delivered: by };
  if (by === undefined) return { refuse: HISTORY_UNREAD };
  if (finishing === "auto" && amount !== undefined && !autoFinishable(lamports, amount)) return { refuse: NEEDS_LOOK };
  return { send: true };
}

/**
 * After a finishing transfer failed while its sending address was emptied (by the relayer's transfer,
 * or by this very one landing late): `first` is what the history says (as finishGate's `by`). Delivered:
 * that is the answer. Can't be told: it may have gone, so never "nothing was sent" (a transfer still
 * pending keeps its own "may still go through"). Otherwise the transfer's own error stands.
 */
export function afterFailedFinish(first: string | null | undefined, err: unknown): string {
  if (first) return first;
  if (first === undefined) {
    if (err instanceof MaybeSent || (err as { pending?: unknown } | null)?.pending === true) throw err;
    throw new MaybeSent(EMPTIED_UNREAD);
  }
  throw err;
}

/**
 * After this app moved SOL out of a sending address whose delivery is still open: how that delivery
 * stands. `by` is what its history says (deliveredFrom: the delivery's signature, null for none found,
 * undefined when it can't be told); `move` is this move (its signature, where it went); `recipient` is
 * where the delivery goes; `elsewhere` says the history read shows the address paying for something
 * else first. Its history showing the delivery: delivered. This move paying the recipient: delivered
 * by this move (a history read just after it may not list it yet). Not delivered only when the history
 * shows the address paid elsewhere first; anything less certain (a read behind the chain) is left open
 * for a later look, so a delivery that went is never shown as not delivered.
 */
export function moveOutVerdict(o: {
  by: string | null | undefined;
  move?: { sig: string; to: string };
  recipient?: string | null;
  elsewhere: boolean;
}): { delivered: string } | { notDelivered: true } | null {
  if (o.by) return { delivered: o.by };
  if (o.move && o.recipient && o.move.to === o.recipient) return { delivered: o.move.sig };
  if (o.by === null && o.elsewhere) return { notDelivered: true };
  return null;
}

/**
 * A hop of this account holding SOL: a delivery to finish, SOL that came back to it after one, or one
 * whose history can't be told ("look": it may or may not have delivered, so it is never finished on a
 * guess, and the owner may move the SOL into the private balance or send it anywhere instead).
 */
export type HopView = { hop: string; lamports: bigint; to: string | null; kind: "finish" | "returned" | "look" };

/**
 * Sorts this account's open hops: one whose delivery never landed is to be finished (to its
 * recipient); one already delivered that holds SOL again got it back (an exchange refund, say).
 * A hop whose SOL went back into the pool keeps only the waiting room's rent coming home, which isn't shown.
 * Nor is one holding too little to send on (`rentMin`, see finishAmount): a few lamports a stranger
 * sent it (address-poisoning dust) are nobody's payment. `known` says what the relayer remembers of
 * hops this device has no record of. `unread` are ones whose history couldn't be told when last
 * looked at: one that would be finished is shown for a look instead (never finished on a guess).
 */
export function sortOpen(
  open: readonly { hop: string; lamports: bigint }[],
  legs: readonly HopLeg[],
  known: ReadonlyMap<string, { delivered: boolean; to: string | null }> = new Map(),
  rentBack = 0n,
  rentMin = 0n,
  unread: ReadonlySet<string> = new Set(),
): HopView[] {
  const out: HopView[] = [];
  for (const o of open) {
    if (!worthShowing(o.lamports, rentMin)) continue;
    const leg = legs.find((l) => l.hop === o.hop);
    if (leg?.status === "returned" && o.lamports <= rentBack + DELIVERY_FEE) continue;
    const k = known.get(o.hop);
    const delivered = leg ? leg.status === "delivered" || leg.status === "returned" : (k?.delivered ?? true);
    out.push({ hop: o.hop, lamports: o.lamports, to: leg?.to ?? k?.to ?? null, kind: delivered ? "returned" : unread.has(o.hop) ? "look" : "finish" });
  }
  return out;
}

export {
  HISTORY_PAGES,
  HISTORY_READS,
  HISTORY_PAGE,
  newHopHistory,
  readDelivery,
  type HopHistory,
  type HistorySig,
  type HistoryTx,
  type HistoryRpc,
} from "@visionswap/sdk";
