import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import {
  computeBudget,
  TRANSACT_CU,
  fetchTree,
  extDataHash,
  publicAmountFor,
  predictCredit,
  l1Message,
  n2Message,
  verifyDelivery,
  ownMessage,
  classifyRecipient,
  recipientVerdict,
  RESERVED_ADDRESSES,
  DELIVERY_FEE,
  DELIVERY_V,
  DELIVERY_CU,
  DELIVERY_PRICE_L1,
  DELIVERY_PRICE_N2,
  DELIVERY_MIN_CLIENT,
  type DeliveryInfo,
  type PoolConfig,
  type RecipientClass,
} from "@visionswap/sdk";
import type { SpendProof } from "@visionswap/sdk/prover";
import { config } from "./config.ts";
import { conn, pool, poolConfig, rent, payerUnfunded } from "./chain.ts";
import { screen, screenLocal } from "./screening.ts";
import { store } from "./indexer.ts";
import { fundsStatus, checkFunds } from "./funds.ts";
import { checkSpendProof } from "./zkverify.ts";
import { nonces, sendOwner } from "./nonces.ts";
import { hops } from "./hops.ts";
import { log } from "./log.ts";

/**
 * The relayer submits spends so the user's own wallet never appears on-chain.
 * It pays the network fee and the rent for the two nullifier records, and is
 * repaid by the relayer fee the user agreed to inside the proof. It cannot
 * change the recipient, the amount or any fee: those are bound by the proof.
 */

export async function relayerQuote() {
  const nfRent = await rent(8);
  const priority = BigInt(Math.ceil((TRANSACT_CU * config.priorityMicroLamports) / 1_000_000));
  const cost = 2n * nfRent + 5000n + priority;
  const cfg = await poolConfig().catch(() => null);
  return {
    relayer: config.relayer?.publicKey.toBase58() ?? null,
    cost,
    fee: cost + config.relayerMarginLamports,
    feeBps: cfg?.feeBps ?? null,
    treasury: cfg?.treasury.toBase58() ?? null,
  };
}

export type RelayRequest = {
  proof: string; // base64, 256 bytes
  root: string; // hex
  nullifiers: [string, string];
  commitments: [string, string];
  recipient: string;
  withdraw: string;
  relayerFee: string;
  maxFeeBps: number;
  meta0: string; // base64, 28 bytes
  meta1: string;
};

const malformed = () => Object.assign(new Error("Malformed request."), { status: 400 });
const HEX64 = /^[0-9a-f]{64}$/i;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const U64_MAX = 2n ** 64n - 1n;

/**
 * A relay request rebuilt from exactly its fields, each checked for shape and size, with hex in
 * lower case. Everything that stores, compares or sends a request uses this copy, so the same
 * notes always look the same and nothing extra is ever kept.
 */
export function cleanRequest(raw: unknown): RelayRequest {
  const r = (raw ?? {}) as Record<string, unknown>;
  const hex = (v: unknown) => {
    if (typeof v !== "string" || !HEX64.test(v)) throw malformed();
    return v.toLowerCase();
  };
  const b64 = (v: unknown, len: number) => {
    if (typeof v !== "string" || v.length !== Math.ceil(len / 3) * 4 || !B64.test(v) || Buffer.from(v, "base64").length !== len) throw malformed();
    return v;
  };
  const lamports = (v: unknown) => {
    if (typeof v !== "string" || !/^\d{1,20}$/.test(v) || BigInt(v) > U64_MAX) throw malformed();
    return BigInt(v).toString();
  };
  const pair = (v: unknown): [string, string] => {
    if (!Array.isArray(v) || v.length !== 2) throw malformed();
    return [hex(v[0]), hex(v[1])];
  };
  if (typeof r.recipient !== "string" || r.recipient.length < 32 || r.recipient.length > 44) throw malformed();
  let recipient: string;
  try {
    recipient = new PublicKey(r.recipient).toBase58();
  } catch {
    throw malformed();
  }
  const maxFeeBps = r.maxFeeBps;
  if (typeof maxFeeBps !== "number" || !Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) throw malformed();
  const out: RelayRequest = {
    proof: b64(r.proof, 256),
    root: hex(r.root),
    nullifiers: pair(r.nullifiers),
    commitments: pair(r.commitments),
    recipient,
    withdraw: lamports(r.withdraw),
    relayerFee: lamports(r.relayerFee),
    maxFeeBps,
    meta0: b64(r.meta0, 28),
    meta1: b64(r.meta1, 28),
  };
  if (out.nullifiers[0] === out.nullifiers[1]) throw malformed();
  return out;
}

/**
 * How a payment's recipient gets its SOL (v2 requests; see sdk/src/delivery.ts):
 *  - `delivery`: an outside address. The proof pays a one-time hop, whose signed transfer (L1 on a
 *    recent blockhash, N2 on one of the relayer's nonces) passes `amount` on to `to`.
 *  - `own`: one of this account's own wallets, which signs to show it is: paid by the pool directly.
 */
export type DeliveryBody = {
  to: string;
  /** lamports the recipient gets */
  amount: string;
  leaseId?: string;
  blockhash?: string;
  /** the hop's signatures (base58) over the L1 and N2 transfers */
  l1?: string;
  n2?: string;
  /** the sender confirmed an address only a program can sign for (a multisig vault, say) */
  offCurveOk?: boolean;
};
export type OwnBody = { sig: string };
export type RelayBody = { v: 1 | 2; request: RelayRequest; delivery?: DeliveryBody; own?: OwnBody };

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const sig58 = (v: unknown): string => {
  if (typeof v !== "string" || v.length < 64 || v.length > 90 || !B58.test(v) || bs58.decode(v).length !== 64) throw malformed();
  return v;
};
const key58 = (v: unknown): string => {
  if (typeof v !== "string" || v.length < 32 || v.length > 44 || !B58.test(v)) throw malformed();
  try {
    return new PublicKey(v).toBase58();
  } catch {
    throw malformed();
  }
};

/** A delivery rebuilt from exactly its fields, each checked for shape. */
export function cleanDelivery(raw: unknown): DeliveryBody {
  const d = (raw ?? {}) as Record<string, unknown>;
  if (typeof d !== "object" || Array.isArray(d)) throw malformed();
  if (typeof d.amount !== "string" || !/^\d{1,20}$/.test(d.amount) || BigInt(d.amount) > U64_MAX || BigInt(d.amount) === 0n) throw malformed();
  const out: DeliveryBody = { to: key58(d.to), amount: BigInt(d.amount).toString() };
  if (d.leaseId != null) {
    if (typeof d.leaseId !== "string" || !/^[0-9a-f]{24}$/.test(d.leaseId)) throw malformed();
    out.leaseId = d.leaseId;
  }
  if (d.blockhash != null) {
    if (typeof d.blockhash !== "string" || d.blockhash.length > 44 || !B58.test(d.blockhash) || bs58.decode(d.blockhash).length !== 32) throw malformed();
    out.blockhash = d.blockhash;
  }
  if (d.l1 != null) out.l1 = sig58(d.l1);
  if (d.n2 != null) out.n2 = sig58(d.n2);
  if (d.offCurveOk === true) out.offCurveOk = true;
  return out;
}

/**
 * A relay body: a v2 one ({ v: 2, request, delivery | own }), or a bare request as pages from
 * before deliveries send it (v1; such a page may still pay the relayer, never anyone else).
 */
export function cleanBody(raw: unknown): RelayBody {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.v === undefined && "request" in r) throw malformed();
  // a body cleaned here before
  if (r.v === 1) return { v: 1, request: cleanRequest(r.request) };
  if (r.v === undefined) return { v: 1, request: cleanRequest(r) };
  if (r.v !== 2) throw malformed();
  const out: RelayBody = { v: 2, request: cleanRequest(r.request) };
  if (r.delivery != null) out.delivery = cleanDelivery(r.delivery);
  if (r.own != null) out.own = { sig: sig58((r.own as Record<string, unknown>)?.sig) };
  return out;
}

const updateRequired = () =>
  Object.assign(new Error("VisionSwap was updated. Refresh the page to send this. Nothing was spent."), { status: 426, code: "update_required" });

/**
 * Which way a payment goes. Every spend that pays anyone but the relayer is either a delivery (to a
 * hop) or to one of the sender's own wallets (which signed to say so); anything else is a page
 * from before deliveries, told to refresh.
 */
export function routeOf(b: RelayBody, relayer: PublicKey): "fee" | "own" | "delivery" {
  const w = BigInt(b.request.withdraw);
  const f = BigInt(b.request.relayerFee);
  if (w < f) throw Object.assign(new Error("Amount is below the relayer fee."), { status: 400 });
  if (w === f) {
    // nothing for any recipient (cutting or joining notes): only ever named the relayer itself
    if (b.delivery || b.own) throw malformed();
    if (b.request.recipient !== relayer.toBase58()) throw Object.assign(new Error("A payment that sends nothing names the relayer as its recipient."), { status: 400 });
    return "fee";
  }
  if (b.v !== 2) throw updateRequired();
  if (b.delivery && b.own) throw malformed();
  if (b.own) return "own";
  if (b.delivery) return "delivery";
  throw updateRequired();
}

/**
 * Addresses no payment may go to (nor be delivered from): the relayer and its nonces, the pool's
 * own accounts, this spend's nullifier records, programs and sysvars.
 */
export function reservedSet(cfg: PoolConfig, nullifiers: readonly bigint[]): Set<string> {
  const s = new Set<string>(RESERVED_ADDRESSES);
  for (const k of [config.relayer?.publicKey, config.nonceAuthority?.publicKey, config.guard?.publicKey, cfg.guard, cfg.treasury, cfg.admin, pool.config, pool.vault, pool.tree, pool.programId]) {
    if (k) s.add(k.toBase58());
  }
  for (const n of nullifiers) s.add(pool.nullifier(n).toBase58());
  for (const a of nonces.accounts()) s.add(a);
  return s;
}

const stale = (msg = "This payment needs a fresh signature. Open VisionSwap and it is made for you. Nothing was spent.") =>
  Object.assign(new Error(msg), { status: 409, code: "stale" });
const badRecipient = (msg: string, code = "recipient") => Object.assign(new Error(msg), { status: 400, code });

/** What the app shows for a recipient that can never be paid, by kind. */
export function recipientRefusal(c: RecipientClass): string {
  if (c === "token-account") return "This is a token account. For SOL, paste the main wallet address; on an exchange that's the address on its SOL deposit page.";
  if (c === "reserved") return "This address belongs to VisionSwap or to a program, so it can't receive this payment.";
  return "This address belongs to a program and can't receive SOL here. Check that you copied a wallet or deposit address.";
}

type Delivery = {
  hop: PublicKey;
  to: PublicKey;
  amount: bigint;
  offCurveOk: boolean;
  l1?: { blockhash: string; sig: Uint8Array };
  n2?: { leaseId: string; sig: Uint8Array; account: string; value: string };
};

/**
 * A delivery's checks that need nothing from the chain: addresses, the amount against the pool's fee,
 * and (`sigs`) the hop's signatures over the transfers this server builds itself from the fields.
 */
async function checkDelivery(b: RelayBody, sp: ReturnType<typeof parse>, cfg: PoolConfig, reserved: Set<string>, jobId?: string, sigs = true): Promise<Delivery> {
  const d = b.delivery!;
  const hop = sp.ext.recipient;
  const to = new PublicKey(d.to);
  if (reserved.has(hop.toBase58())) throw malformed();
  const used = hops.get(hop.toBase58());
  if (used && (used.nullifiers[0] !== b.request.nullifiers[0] || used.nullifiers[1] !== b.request.nullifiers[1])) {
    throw stale("This payment's sending address was already used. Refresh the page and try again. Nothing was spent.");
  }
  if (reserved.has(to.toBase58())) throw badRecipient(recipientRefusal("reserved"));
  if (to.equals(hop)) throw malformed();
  if (hops.isHop(to.toBase58())) throw badRecipient("That is the one-time sending address of another payment. Send to the recipient's own address.");
  const amount = BigInt(d.amount);
  const want = amount + DELIVERY_FEE;
  const w = sp.ext.withdraw;
  const f = sp.ext.relayerFee;
  // the program's credit at today's fee (or with no fee, when the treasury can't take one)
  if (cfg.feeBps > b.request.maxFeeBps || (want !== predictCredit(w, f, cfg.feeBps) && want !== w - f)) {
    throw stale("The pool fee changed. Please review the new fee and try again.");
  }
  const rent0 = await rent(0);
  // the hop pays its delivery's fee itself, and the network lets a fee payer keep either nothing or at
  // least the rent minimum once that fee is taken: what it holds then is `amount`, so that is the floor
  // (for every recipient, new or not, and every shape)
  if (amount < rent0) throw badRecipient(`The smallest private send is ${solUp(rent0)} SOL.`, "too_small");
  const out: Delivery = { hop, to, amount, offCurveOk: !!d.offCurveOk };
  if (!sigs) return out;
  if (jobId ? !d.n2 || d.l1 : !d.l1 && !d.n2) throw malformed();
  if (d.l1) {
    if (!d.blockhash) throw malformed();
    const sig = bs58.decode(d.l1);
    if (!verifyDelivery(l1Message({ hop, to, lamports: amount, blockhash: d.blockhash }), sig, hop)) throw stale();
    out.l1 = { blockhash: d.blockhash, sig };
  }
  if (d.n2) {
    const lease = nonces.get(d.leaseId);
    const n = nonces.authorityKey;
    // a scheduled payment's own job's, or (sent now) this very payment's
    const mine = lease?.owner === (jobId ? `job:${jobId}` : sendOwner(b.request.nullifiers));
    if (!lease || !n || lease.state !== "leased" || !mine) throw stale();
    const sig = bs58.decode(d.n2);
    const m = n2Message({ hop, to, lamports: amount, nonceAccount: new PublicKey(lease.account), authority: n, nonce: lease.value });
    if (!verifyDelivery(m, sig, hop)) throw stale();
    out.n2 = { leaseId: d.leaseId!, sig, account: lease.account, value: lease.value };
  }
  return out;
}

const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
/** Rounded up to five places, so the amount named is always enough. */
const solUp = (lamports: bigint) => sol(((lamports + 9_999n) / 10_000n) * 10_000n);

/** A delivery's checks against the chain, when it is about to go: the hop is unused, and the recipient can be paid. */
async function checkDeliveryLive(d: Delivery, reserved: Set<string>) {
  const [hopAcct, toAcct] = await conn.getMultipleAccountsInfo([d.hop, d.to], "confirmed");
  if (hopAcct && hopAcct.lamports > 0) throw stale("This payment's sending address was already used. Refresh the page and try again. Nothing was spent.");
  const c = classifyRecipient(d.to, toAcct ? { owner: toAcct.owner, executable: toAcct.executable, lamports: toAcct.lamports, dataLength: toAcct.data.length } : null, reserved);
  const verdict = recipientVerdict(c);
  if (verdict === "blocked") throw badRecipient(recipientRefusal(c));
  if (verdict === "confirm" && !d.offCurveOk) {
    throw badRecipient("This address is managed by a program, such as a multisig vault. Confirm it in the app to send to it.", "confirm_recipient");
  }
  const rent0 = await rent(0);
  if ((c === "new" || c === "new-off-curve") && d.amount < rent0) {
    throw badRecipient(`The recipient is a new address, so it needs at least ${sol(rent0)} SOL.`, "too_small");
  }
}

/** A payment to one of the sender's own wallets: that wallet signed the spend's notes and its own address. */
function checkOwn(b: RelayBody, sp: ReturnType<typeof parse>, reserved: Set<string>) {
  const to = sp.ext.recipient;
  if (reserved.has(to.toBase58())) throw badRecipient(recipientRefusal("reserved"));
  if (!verifyDelivery(ownMessage(b.request.nullifiers, to), bs58.decode(b.own!.sig), to)) {
    throw Object.assign(new Error("The payment's signature didn't check out. Refresh the page and try again. Nothing was spent."), { status: 400 });
  }
}

/** One's own wallet is an ordinary one (or new): never a token account or a program's. */
async function checkOwnLive(to: PublicKey) {
  const a = await conn.getAccountInfo(to, "confirmed");
  if (a && a.lamports > 0 && (a.executable || !a.owner.equals(SystemProgram.programId) || a.data.length)) {
    throw badRecipient(recipientRefusal(a.executable ? "program" : "program-owned"));
  }
}

/** The delivery terms /api/pool/info publishes (the app sends nothing when they differ from its own). */
export function deliveryInfo(): DeliveryInfo {
  return {
    v: DELIVERY_V,
    cu: DELIVERY_CU,
    priceL1: DELIVERY_PRICE_L1,
    priceN2: DELIVERY_PRICE_N2,
    fee: DELIVERY_FEE.toString(),
    minClient: DELIVERY_MIN_CLIENT,
    nonceAuthority: config.relayer && config.deliveryNonce ? (config.nonceAuthority?.publicKey.toBase58() ?? null) : null,
    nonce: !!config.relayer && config.deliveryNonce,
  };
}

const FRIENDLY: [RegExp, string][] = [
  [/UnknownRoot/, "The pool moved on while your proof was being made. Please try again."],
  [/InvalidProof/, "The proof did not check out. Refresh the page and try again."],
  [/already in use|custom program error: 0x0\b/, "That note has already been spent."],
  [/FeeAboveLimit/, "The pool fee changed. Please review the new fee and try again."],
  [/InsufficientPool/, "The pool can't cover this right now."],
  [/insufficient funds for rent/i, "The recipient needs at least a tiny amount of SOL to exist. Send a bit more."],
];

function friendly(msg: string): string {
  for (const [re, text] of FRIENDLY) if (re.test(msg)) return text;
  // anything else still says what went wrong, so a report can be traced
  const code =
    /Error Code: (\w+)/.exec(msg)?.[1] ?? /custom program error: (0x[0-9a-f]+)/i.exec(msg)?.[1] ?? /"(\w+)"\s*$/.exec(msg.trim())?.[1];
  return `The network refused this payment${code ? ` (${code})` : ""}. Nothing was spent. Please try again.`;
}

/** The relayer can't pay for sends right now. Nothing was sent; it can go out once it is topped up. */
const unfunded = () =>
  Object.assign(new Error("The relayer is being topped up right now, so it can't send this yet. Nothing was spent."), {
    status: 503,
    code: "relayer_unfunded",
  });

// what the relayer keeps for itself on top of one send: its own rent minimum plus a little room
const RELAYER_FLOOR = 890_880n + 200_000n;

const hexToBig = (h: string) => BigInt("0x" + h);

/**
 * Holds a share of the relayer's balance for each send from the moment its balance is checked, so
 * sends checked together can't all count the same lamports. A send that went out keeps its share a
 * little after it lands (`lingerMs`), since the balance read may still be from before it.
 * `balance(true)` asks for a fresh read; null means unknown, and the send is let through.
 */
export function sendBudget(balance: (fresh: boolean) => Promise<bigint | null>, floor: bigint, lingerMs = 12_000) {
  let held: { cost: bigint; until: number }[] = [];
  return {
    /** Takes a share or throws "being topped up". The answer gives it back: `sent` keeps it a little longer. */
    async take(cost: bigint): Promise<(sent: boolean) => void> {
      const now = Date.now();
      held = held.filter((h) => h.until > now);
      const mine = { cost, until: Infinity };
      const need = held.reduce((s, h) => s + h.cost, 0n) + cost + floor;
      held.push(mine);
      const give = (sent: boolean) => {
        if (mine.until === Infinity) mine.until = sent ? Date.now() + lingerMs : 0;
      };
      try {
        let bal = await balance(false);
        // close to the line: a fresh look, since the one kept may be a few sends old
        if (bal != null && bal < need + 4n * cost) bal = (await balance(true)) ?? bal;
        if (bal != null && bal < need) throw unfunded();
      } catch (e) {
        give(false);
        throw e;
      }
      return give;
    },
  };
}

/** A fresh balance read, shared by everyone asking at once and reused for 2 s (an outage doesn't mean a read per send). */
let freshRead: Promise<boolean> | null = null;
let fresh = { at: 0, ok: false };
function readFundsNow(): Promise<boolean> {
  if (Date.now() - fresh.at < 2000) return Promise.resolve(fresh.ok);
  freshRead ??= checkFunds()
    .then(() => true, () => false)
    .then((ok) => {
      fresh = { at: Date.now(), ok };
      freshRead = null;
      return ok;
    });
  return freshRead;
}
const relayerLamports = async () => {
  const l = (await fundsStatus().catch(() => null))?.relayer?.lamports;
  return l == null ? null : BigInt(l);
};
// after a failed fresh read, the last known balance stands (and no second read is started)
const budget = sendBudget(async (now) => (now && !(await readFundsNow()) ? null : relayerLamports()), RELAYER_FLOOR);

/**
 * Notes being relayed right now (nullifier -> until when). A second request for the same notes
 * is refused before anything is simulated or sent, so only one of them can ever be paid for.
 */
const inflight = new Map<string, number>();

/** Claims both notes for `ms`, or says they are already being sent. Synchronous, so two requests can't both pass. */
export function claimNotes(nfs: readonly string[], ms: number, now = Date.now()): boolean {
  for (const [n, until] of inflight) if (until <= now) inflight.delete(n);
  if (nfs.some((n) => inflight.has(n))) return false;
  for (const n of nfs) inflight.set(n, now + ms);
  return true;
}
export function releaseNotes(nfs: readonly string[]) {
  for (const n of nfs) inflight.delete(n);
}
export function notesInFlight(nfs: readonly string[], now = Date.now()): boolean {
  return nfs.some((n) => (inflight.get(n) ?? 0) > now);
}
const keepNotes = (nfs: readonly string[], ms: number) => {
  for (const n of nfs) inflight.set(n, Date.now() + ms);
};

export type Ring = { roots: bigint[]; rootIndex: number; nextIndex: number };

/**
 * The pool's recent roots (the program accepts a proof made against any of them), read at most every
 * `maxAgeMs`, one read at a time. With `notBefore`, only a read begun at or after that moment will do:
 * one already under way may have started before the root the caller is looking for.
 */
export function ringReader(fetch: () => Promise<Ring>) {
  let cache: { at: number; ring: Ring } | null = null;
  let reading: Promise<Ring> | null = null;
  let readAt = 0;
  return {
    async read(maxAgeMs = 10_000, notBefore = 0): Promise<Ring> {
      if (cache && Date.now() - cache.at < maxAgeMs && cache.at >= notBefore) return cache.ring;
      // a read begun too early: let it finish, then start a new one
      while (reading && readAt < notBefore) await reading.catch(() => {});
      if (!reading) {
        const at = (readAt = Date.now());
        reading = fetch()
          .then((ring) => {
            // stamped with when the read began: the pool may have moved on while it ran
            if (!cache || at >= cache.at) cache = { at, ring };
            return ring;
          })
          .finally(() => (reading = null));
      }
      return reading;
    },
    /** The last ring read, however old (null before the first). */
    last: (): Ring | null => cache?.ring ?? null,
  };
}
const rings = ringReader(() => fetchTree(conn, pool).then((t) => ({ roots: t.roots, rootIndex: t.rootIndex, nextIndex: t.nextIndex })));
export const rootRing = (maxAgeMs = 10_000, notBefore = 0) => rings.read(maxAgeMs, notBefore);
export const lastRing = () => rings.last();

function parse(req: RelayRequest, relayer: PublicKey): Pick<SpendProof, "proof" | "root" | "nullifiers" | "commitments" | "ext"> {
  return {
    proof: new Uint8Array(Buffer.from(req.proof, "base64")),
    root: hexToBig(req.root),
    nullifiers: [hexToBig(req.nullifiers[0]), hexToBig(req.nullifiers[1])],
    commitments: [hexToBig(req.commitments[0]), hexToBig(req.commitments[1])],
    ext: {
      recipient: new PublicKey(req.recipient),
      relayer,
      withdraw: BigInt(req.withdraw),
      relayerFee: BigInt(req.relayerFee),
      maxFeeBps: req.maxFeeBps,
      meta0: new Uint8Array(Buffer.from(req.meta0, "base64")),
      meta1: new Uint8Array(Buffer.from(req.meta1, "base64")),
    },
  };
}

export type RelayResult = {
  /** the pool spend's signature (TX1) */
  signature: string;
  pending?: boolean;
  /**
   * For a payment to an outside address, its delivery: TX2's signature once it is out. "pending":
   * sent but not seen to land yet (the finisher follows it); "waiting": only the owner's app can
   * finish it (it does so as soon as it hears this).
   */
  delivery?: { status: "delivered" | "pending" | "waiting"; signature: string | null; hop: string };
};

export type RelayOpts = {
  /**
   * Checks everything that can be checked here (format, fee, notes, root, the proof itself, the
   * sanctions list) without sending or simulating: nothing about the payment leaves this server.
   * Used when a payment is scheduled; the full checks run again when it is sent.
   */
  dryRun?: boolean;
  /** Called with the transaction's signature just before it is first sent; a promise is awaited (a rejection means nothing is sent). */
  onSigned?: (signature: string, lastValidBlockHeight: number) => void | Promise<void>;
  /** the caller's network (its rate-limit key), so each one gets its own share of proof checks */
  ip?: string;
  /** a scheduled payment's id: its nonce lease must be its own, and its delivery is recorded under it */
  jobId?: string;
};

/**
 * Checks a spend and sends it. The answer is the signature once the payment has landed, or
 * `pending` when the network couldn't say in time (it may still land: look before resending).
 * A payment the network certainly dropped, or one the relayer can't pay for right now, is a
 * 503 that says nothing was spent. A payment to an outside address is then delivered (see hops.ts).
 */
export async function relay(raw: RelayBody | RelayRequest, opts: RelayOpts = {}): Promise<RelayResult> {
  const relayer = config.relayer;
  if (!relayer) throw Object.assign(new Error("This server has no relayer."), { status: 503, code: "no_relayer" });
  const b = cleanBody(raw);
  const req = b.request;
  const kind = routeOf(b, relayer.publicKey);
  const sp = parse(req, relayer.publicKey);
  const e = sp.ext;
  const nfs = req.nullifiers;
  // two requests for the same notes: only the first goes on (a dry run only looks)
  if (opts.dryRun ? notesInFlight(nfs) : !claimNotes(nfs, 10 * 60_000)) {
    throw Object.assign(new Error("This payment is already being sent."), { status: 409, code: "in_flight" });
  }
  // once it is on its way, any error is about how it went, never "nothing was spent"
  let broadcast = false;
  // its share of the relayer's balance, given back however this ends
  let give: ((sent: boolean) => void) | undefined;
  // a delivery written down: settled however this ends
  let begun: string | null = null;
  try {
    const q = await relayerQuote();
    if (e.relayerFee < q.cost) {
      throw Object.assign(new Error("The relayer fee no longer covers network costs. Refresh and try again."), {
        status: 409,
      });
    }
    if (store.isSpent(sp.nullifiers[0]) || store.isSpent(sp.nullifiers[1])) {
      throw Object.assign(new Error("That note has already been spent."), { status: 409 });
    }
    const cfg = await poolConfig();
    const reserved = reservedSet(cfg, sp.nullifiers);
    const d = kind === "delivery" ? await checkDelivery(b, sp, cfg, reserved, opts.jobId) : null;
    if (kind === "own") checkOwn(b, sp, reserved);
    if (opts.dryRun) {
      await checkLocal(req, sp, opts.ip ?? "", d ? d.to.toBase58() : e.recipient.toBase58());
      return { signature: "" };
    }
    // a relayer that can't pay for the send says so, instead of failing the payment. Sends checked
    // or still landing haven't left its balance yet, so each of those counts too.
    give = await budget.take(q.cost);
    // a delivery is screened by where it ends up, never by its one-time sending address
    const scr = await screen(d ? d.to.toBase58() : e.recipient.toBase58());
    if (!scr.ok) {
      throw Object.assign(
        new Error(scr.reason === "unavailable" ? "Screening is briefly unavailable." : "This recipient can't receive from VisionSwap."),
        scr.reason === "unavailable" ? { status: 503, code: "screening_unavailable" } : { status: 403 },
      );
    }
    if (d) await checkDeliveryLive(d, reserved);
    if (kind === "own") await checkOwnLive(e.recipient);

    const tx = buildTx1(sp, cfg.treasury, relayer.publicKey);
    const bh = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = bh.blockhash;
    tx.sign(relayer);

    // a delivery: the hop must end up with exactly what its signed transfer sends on, plus that transfer's fee
    const sim = d ? await conn.simulateTransaction(tx, undefined, [d.hop]) : await conn.simulateTransaction(tx);
    if (sim.value.err) {
      if (payerUnfunded(sim.value.err, sim.value.logs)) throw unfunded();
      const logs = (sim.value.logs ?? []).join("\n");
      throw Object.assign(new Error(friendly(logs + " " + JSON.stringify(sim.value.err))), { status: 400 });
    }
    if (d) {
      const credit = sim.value.accounts?.[0]?.lamports;
      if (credit == null || BigInt(credit) !== d.amount + DELIVERY_FEE) {
        throw Object.assign(new Error("The pool fee changed. Please review the new fee and try again."), {
          status: 409,
          code: "stale",
          credit: credit == null ? null : String(credit),
        });
      }
      // sent now on a blockhash alone: that blockhash must still be good, or the delivery couldn't follow
      if (!d.n2 && (await blockhashValid(d.l1!.blockhash)) !== true) {
        throw Object.assign(new Error("This payment's signature ran out of time before it was sent. Nothing was spent. Please try again."), {
          status: 409,
          code: "expired",
        });
      }
    }
    const signature = bs58.encode(tx.signature!);
    if (d) {
      // written down (and saved) before anything is sent: the finisher can always complete it
      try {
        await hops.begin({
          hop: d.hop.toBase58(),
          to: d.to.toBase58(),
          amount: d.amount.toString(),
          nullifiers: [nfs[0], nfs[1]],
          commitments: [req.commitments[0], req.commitments[1]],
          ...(d.l1 ? { l1: { blockhash: d.l1.blockhash, sig: bs58.encode(d.l1.sig) } } : {}),
          ...(d.n2 ? { n2: { leaseId: d.n2.leaseId, sig: bs58.encode(d.n2.sig), account: d.n2.account, value: d.n2.value } } : {}),
          ...(opts.jobId ? { jobId: opts.jobId } : {}),
          tx1: signature,
          lastValid: bh.lastValidBlockHeight,
        });
      } catch (err) {
        if ((err as { status?: number }).status) throw err;
        log(`relayer: couldn't save a delivery before sending it: ${String((err as Error).message).slice(0, 120)}`);
        throw Object.assign(new Error("The relayer couldn't take this right now. Nothing was spent. Please try again."), { status: 503, code: "not_sent" });
      }
      begun = d.hop.toBase58();
    }
    await opts.onSigned?.(signature, bh.lastValidBlockHeight);
    const rawTx = tx.serialize();
    broadcast = true;
    let out: Awaited<ReturnType<typeof land>> | undefined;
    try {
      // a lost reply here doesn't mean it wasn't sent: landing finds out
      await conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      out = await land(signature, rawTx, bh.lastValidBlockHeight, sp.nullifiers);
    } finally {
      // one the network dropped cost nothing; any other may be in the balance only a little later
      give(out !== "dropped");
    }
    /**
     * This send of the payment didn't land, but an earlier send of it may have paid the hop (the same
     * payment sent again after a restart): such a delivery is left to the finisher, never called dropped.
     */
    const notLanded = async () => {
      if (!begun) return;
      const hopBal = await conn.getBalance(new PublicKey(begun), "confirmed").catch(() => null);
      if (store.hasLeaves(sp.commitments) || hopBal !== 0) hops.unsettled(begun);
      else hops.dropped(begun);
    };
    /** TX1 landed: a delivery goes on to its second step (followed only briefly here: the finisher and the app see it through) */
    const landed = async (): Promise<RelayResult> => {
      if (!begun) return { signature };
      const del = await hops.funded(begun, 10_000);
      return { signature, delivery: { ...del, hop: begun } };
    };
    if (out === "confirmed") {
      // the index catches up in a few seconds; until then these notes stay claimed
      keepNotes(nfs, 5 * 60_000);
      return await landed();
    }
    if (out === "failed") {
      releaseNotes(nfs);
      await notLanded();
      const t = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }).catch(() => null);
      throw Object.assign(new Error(friendly((t?.meta?.logMessages ?? []).join("\n"))), { status: 400, signature });
    }
    if (out === "dropped") {
      releaseNotes(nfs);
      if (begun) hops.dropped(begun);
      throw Object.assign(new Error("The network was busy and dropped this payment before it ran. Nothing was spent. Please try again."), {
        status: 503,
        code: "dropped",
      });
    }
    if (out === "spent") {
      // spent, but this transaction wasn't found: its own new notes in the index say whether it was this one
      keepNotes(nfs, 5 * 60_000);
      for (let i = 0; i < 8; i++) {
        if (store.hasLeaves(sp.commitments)) return await landed();
        if (sp.nullifiers.every((n) => store.isSpent(n))) break;
        await wait(2500);
      }
      if (store.hasLeaves(sp.commitments)) return await landed();
      if (sp.nullifiers.every((n) => store.isSpent(n))) {
        await notLanded();
        throw Object.assign(new Error("That note has already been spent."), { status: 409 });
      }
      if (begun) hops.unsettled(begun);
      return { signature, pending: true };
    }
    log("relayer: couldn't tell whether a payment landed; it may still");
    keepNotes(nfs, 5 * 60_000);
    if (begun) hops.unsettled(begun);
    return { signature, pending: true };
  } catch (err) {
    if (broadcast) {
      // the finisher settles a delivery whose payment may still land
      if (begun) hops.unsettled(begun);
      throw err;
    }
    // written down but never sent: nothing to finish
    if (begun) hops.dropped(begun);
    // refused before it was sent: the notes are free for another try (a dry run claimed none), and the answer says nothing was spent
    if (!opts.dryRun) releaseNotes(nfs);
    const e = err as Error & { status?: number };
    if (e.status) throw e;
    log(`relayer: ${String(e.message).slice(0, 200)}`);
    throw Object.assign(new Error("The relayer couldn't take this right now. Nothing was spent. Please try again."), { status: 503, code: "not_sent" });
  } finally {
    // refused before it went out: its share is free at once (after one went out this does nothing)
    give?.(false);
  }
}

const blockhashValid = (blockhash: string) =>
  conn
    .isBlockhashValid(blockhash, { commitment: "confirmed" })
    .then((r) => r.value)
    .catch(() => null);

/** TX1: [compute limit, compute price, transact]. The only payment transaction the relayer signs. */
export function buildTx1(sp: Pick<SpendProof, "proof" | "root" | "nullifiers" | "commitments" | "ext">, treasury: PublicKey, payer: PublicKey): Transaction {
  const tx = new Transaction().add(...computeBudget(TRANSACT_CU, config.priorityMicroLamports), pool.transact(sp, treasury));
  tx.feePayer = payer;
  return tx;
}

/** Proofs that checked out lately (by their whole request), so one handed over again isn't checked again. */
const checkedProofs = new Map<string, number>();
const PROOF_TTL = 10 * 60_000;

/** The checks a scheduled payment gets when it is handed over: all of them local or public pool state. */
async function checkLocal(req: RelayRequest, sp: ReturnType<typeof parse>, ip: string, screened: string) {
  const asked = Date.now();
  const cfg = await poolConfig();
  if (cfg.feeBps > req.maxFeeBps) throw Object.assign(new Error("The pool fee changed. Please review the new fee and try again."), { status: 400 });
  let ring = await rootRing();
  // a proof made on a root newer than the kept list: look again, with a read begun at most a second
  // before this request (a proof takes longer than that to make, so such a read has its root). Any
  // read like that is shared, so roots nobody has seen cost at most about one read a second.
  if (!ring.roots.includes(sp.root)) ring = await rootRing(Infinity, asked - 1000);
  if (!ring.roots.includes(sp.root)) throw Object.assign(new Error("The pool moved on while your proof was being made. Please try again."), { status: 400 });
  const key = createHash("sha256").update(JSON.stringify(req)).digest("hex");
  for (const [k, at] of checkedProofs) if (asked - at > PROOF_TTL) checkedProofs.delete(k);
  if (!checkedProofs.has(key)) {
    const inputs = [sp.root, publicAmountFor(sp.ext.withdraw), extDataHash(sp.ext), ...sp.nullifiers, ...sp.commitments];
    const ok = await checkSpendProof(sp.proof, inputs, ip);
    if (ok === false) throw Object.assign(new Error("The proof did not check out. Refresh the page and try again."), { status: 400 });
    if (ok === true && checkedProofs.size < 50_000) checkedProofs.set(key, asked);
  }
  // the sanctions list only: an outside service hears about the recipient when the payment leaves
  const scr = screenLocal(screened);
  if (!scr.ok) throw Object.assign(new Error("This recipient can't receive from VisionSwap."), { status: 403 });
}

/**
 * The checks a payment named in `prepare` gets before it is given a nonce or a blockhash to sign
 * over: everything `relay` checks without sending (the proof included), so a request that would be
 * refused anyway never takes a nonce. Answers the checked delivery.
 */
export async function precheck(b: RelayBody, ip: string, jobId?: string): Promise<{ hop: PublicKey; to: PublicKey; amount: bigint }> {
  const relayer = config.relayer;
  if (!relayer) throw Object.assign(new Error("This server has no relayer."), { status: 503, code: "no_relayer" });
  const sp = parse(b.request, relayer.publicKey);
  if (routeOf(b, relayer.publicKey) !== "delivery") throw malformed();
  if (notesInFlight(b.request.nullifiers)) throw Object.assign(new Error("This payment is already being sent."), { status: 409, code: "in_flight" });
  const q = await relayerQuote();
  if (sp.ext.relayerFee < q.cost) throw Object.assign(new Error("The relayer fee no longer covers network costs. Refresh and try again."), { status: 409 });
  if (store.isSpent(sp.nullifiers[0]) || store.isSpent(sp.nullifiers[1])) throw Object.assign(new Error("That note has already been spent."), { status: 409 });
  const cfg = await poolConfig();
  const d = await checkDelivery(b, sp, cfg, reservedSet(cfg, sp.nullifiers), jobId, false);
  await checkLocal(b.request, sp, ip, d.to.toBase58());
  return { hop: d.hop, to: d.to, amount: d.amount };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Follows a sent transaction until it has certainly landed, certainly failed, or certainly can't
 * land any more (its blockhash expired with no trace of it, and its notes unspent). It is sent
 * again every few seconds while nothing is seen, since a busy network can drop it on the way.
 * Network trouble is never taken as an answer: past the time limit that is "unknown".
 */
export async function land(
  signature: string,
  raw: Uint8Array,
  lastValid: number,
  nullifiers: [bigint, bigint],
  limitMs = 150_000,
): Promise<"confirmed" | "failed" | "dropped" | "spent" | "unknown"> {
  const started = Date.now();
  let lastSend = started;
  let lastHeight = started;
  while (Date.now() - started < limitMs) {
    await wait(1000);
    const st = (await conn.getSignatureStatuses([signature]).catch(() => null))?.value[0];
    if (st?.err) return "failed";
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return "confirmed";
    if (!st && Date.now() - lastSend > 2500) {
      lastSend = Date.now();
      void conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    if (st || Date.now() - lastHeight < 5000) continue;
    lastHeight = Date.now();
    const height = await conn.getBlockHeight("confirmed").catch(() => null);
    if (height == null || height <= lastValid) continue;
    // expired: it can't land any more, so one last look, history included
    const last = await conn
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .then((r) => r.value[0])
      .catch(() => undefined);
    if (last === undefined) continue;
    if (last?.err) return "failed";
    if (last?.confirmationStatus) return "confirmed";
    const pdas = await conn.getMultipleAccountsInfo(nullifiers.map((n) => pool.nullifier(n)), "confirmed").catch(() => null);
    if (!pdas) continue;
    if (pdas.every((a) => !a)) return "dropped";
    return "spent";
  }
  return "unknown";
}

export async function relayerBalance(): Promise<bigint | null> {
  if (!config.relayer) return null;
  return BigInt(await conn.getBalance(config.relayer.publicKey, "confirmed"));
}
