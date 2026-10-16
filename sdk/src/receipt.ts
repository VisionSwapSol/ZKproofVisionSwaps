import { PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { fromBE, toBE, hex, unhex, fromLE } from "./field.ts";
import { H2, H3 } from "./poseidon.ts";
import { eventsFromLogs, type PoolEvent } from "./events.ts";
import type { Keys } from "./keys.ts";

/**
 * Payment receipts ("proof of source", P1-1): one payment that left the pool, the notes it spent,
 * and where those notes came from, back to the deposits that made them, and nothing else about the
 * account. Anyone can check one against the public chain, without trusting VisionSwap and without
 * a viewing key.
 *
 * Why it works with no circuit or program change: a note's leaf is Poseidon(amount, inner), and its
 * nullifier is Poseidon(leaf, index, sig) with sig = Poseidon(privKey, leaf, index). Revealing `sig`
 * for one note lets anyone recompute that note's nullifier and find it in the payment's Spent event;
 * `sig` doesn't reveal the private key (a Poseidon preimage) and can't spend anything (the circuit
 * derives the public key from the private key inside the proof). It can't be made up for someone
 * else's spend either: that would need a Poseidon preimage.
 *
 * Opening a spend's two outputs (amount and inner, both of them: the Spent event always carries two)
 * proves conservation: the circuit enforces inputs = outputs + withdraw, every amount is range-checked
 * to 64 bits so the sums can't wrap, and so if the opened inputs alone balance, any input left
 * unopened is zero-value padding. A note that was change from an earlier spend of the same account
 * can open that spend too, back to deposits; each level shows one more of the owner's own links, so
 * the app lets them stop. A note received privately from someone else ends the trail there.
 *
 * Behind a switch that is off (web/src/lib/features.ts, owner decision D12) until the circuit and
 * program owner signs off this argument.
 */

export const RECEIPT_KIND = "visionswap-payment-receipt";
export const RECEIPT_VERSION = 1;
/** The most spends one receipt opens, and the most transactions a check reads. */
export const RECEIPT_MAX_SPENDS = 16;
export const RECEIPT_MAX_TXS = 96;

/** Where an opened note came from. */
export type ReceiptOrigin =
  | { kind: "deposit"; settleTx: string; depositTx: string }
  /** change from an earlier spend of this account; `spend` is that spend, opened (absent: the owner stopped here) */
  | { kind: "change"; spendTx: string; spend?: ReceiptSpend }
  /** received privately inside the pool from someone else: the trail stops here */
  | { kind: "received"; spendTx: string };

/** One input note, opened: everything is a decimal or a 64-hex string. */
export type ReceiptNote = { index: number; amount: string; inner: string; sig: string; origin: ReceiptOrigin };

export type ReceiptSpend = {
  /** the transact transaction */
  tx: string;
  inputs: ReceiptNote[];
  /** both outputs, in order, when opened */
  outputs?: [{ amount: string; inner: string }, { amount: string; inner: string }];
};

export type Receipt = {
  kind: typeof RECEIPT_KIND;
  version: number;
  network: string;
  programId: string;
  createdAt: string;
  payment: ReceiptSpend & {
    /** a payment to an outside address: the one-time address's transfer to the recipient */
    delivery?: { tx: string; hop: string; to: string };
  };
  /**
   * Optional: a verifier's challenge text signed by an address the receipt names (a depositing wallet,
   * the payment's recipient or the delivery's recipient), as "Prove I control this address" signs it:
   * "VisionSwap ownership proof:", a new line, then the text, ed25519. Shows the presenter controls that end.
   */
  binding?: { address: string; message: string; signature: string }[];
};

/** What an ownership proof signs: this, then the challenge text (see web/src/lib/ownership.ts). */
export const OWNERSHIP_PROOF_PREFIX = "VisionSwap ownership proof:\n";

// ─── building (in the app, with the owner's keys) ───

/** A note this account owns, as the app found it (spent ones included). */
export type OwnNote = { index: number; leaf: bigint; amount: bigint; blinding: bigint };

/** What the app knows of the pool's public history (from the full /api/pool/txs download). */
export type ReceiptHistory = {
  /** the transaction that made leaf `index`, and for a deposit's leaf the one that queued it */
  leafTx(index: number): { tx: string; depositTx: string | null } | null;
  /** a spend: the nullifiers it revealed, and its two output leaves' indexes; null when `tx` isn't one */
  spend(tx: string): { nullifiers: bigint[]; outputs: number[] } | null;
};

export type BuildOptions = {
  network: string;
  programId: string;
  /** the payment to prove (a transact transaction this account sent) */
  paymentTx: string;
  delivery?: { tx: string; hop: string; to: string };
  /** ownership proofs to carry (see Receipt.binding) */
  binding?: { address: string; message: string; signature: string }[];
  /** open both outputs of each spend (proves conservation) */
  openOutputs?: boolean;
  /** how many earlier spends of this account to open, from the payment back (default: all, up to RECEIPT_MAX_SPENDS) */
  depth?: number;
  now?: Date;
};

const nf = (k: Keys, n: OwnNote) => H3(n.leaf, BigInt(n.index), H3(k.privKey, n.leaf, BigInt(n.index)));
const h64 = (x: bigint) => hex(toBE(x));

/**
 * Builds a receipt for one payment from the notes this account owns (`notes`, spent ones included)
 * and the pool's public history. Throws a plain reason when it can't.
 */
export function buildReceipt(keys: Keys, notes: OwnNote[], history: ReceiptHistory, o: BuildOptions): Receipt {
  const byNullifier = new Map<bigint, OwnNote>();
  const byIndex = new Map<number, OwnNote>();
  for (const n of notes) {
    byNullifier.set(nf(keys, n), n);
    byIndex.set(n.index, n);
  }
  let spends = 0;
  const maxDepth = Math.max(0, Math.min(o.depth ?? RECEIPT_MAX_SPENDS, RECEIPT_MAX_SPENDS));
  const openSpend = (tx: string, level: number): ReceiptSpend => {
    if (++spends > RECEIPT_MAX_SPENDS) throw new Error("This payment's history is too long for one receipt. Choose fewer earlier payments to include.");
    const s = history.spend(tx);
    if (!s) throw new Error("That transaction isn't a payment from the pool, or the pool's history doesn't show it yet.");
    const mine = s.nullifiers.map((x) => byNullifier.get(x)).filter((n): n is OwnNote => !!n && n.amount > 0n);
    if (!mine.length) throw new Error("That payment didn't spend notes of this account.");
    const inputs = mine.map((n): ReceiptNote => {
      const sig = H3(keys.privKey, n.leaf, BigInt(n.index));
      const inner = H2(keys.pubKey, n.blinding);
      const at = history.leafTx(n.index);
      if (!at) throw new Error("The pool's history doesn't say where one of these notes came from yet. Try again later.");
      let origin: ReceiptOrigin;
      if (at.depositTx) origin = { kind: "deposit", settleTx: at.tx, depositTx: at.depositTx };
      else {
        const earlier = history.spend(at.tx);
        const own = !!earlier && earlier.nullifiers.some((x) => byNullifier.has(x));
        origin = own
          ? { kind: "change", spendTx: at.tx, ...(level < maxDepth ? { spend: openSpend(at.tx, level + 1) } : {}) }
          : { kind: "received", spendTx: at.tx };
      }
      return { index: n.index, amount: n.amount.toString(), inner: h64(inner), sig: h64(sig), origin };
    });
    const spend: ReceiptSpend = { tx, inputs };
    if (o.openOutputs) {
      const outs = s.outputs.map((i) => byIndex.get(i));
      if (outs.length === 2 && outs.every((x) => !!x)) {
        spend.outputs = outs.map((x) => ({ amount: x!.amount.toString(), inner: h64(H2(keys.pubKey, x!.blinding)) })) as ReceiptSpend["outputs"];
      }
    }
    return spend;
  };
  const payment = openSpend(o.paymentTx, 0);
  return {
    kind: RECEIPT_KIND,
    version: RECEIPT_VERSION,
    network: o.network,
    programId: o.programId,
    createdAt: (o.now ?? new Date()).toISOString(),
    payment: { ...payment, ...(o.delivery ? { delivery: o.delivery } : {}) },
    ...(o.binding?.length ? { binding: o.binding } : {}),
  };
}

// ─── checking (anyone, against the chain) ───

/** One transaction as a check reads it: whether it failed, its logs, and its instructions with accounts as addresses. */
export type ReceiptTx = {
  err: unknown;
  slot: number;
  logs: string[];
  /** top-level instructions, in order */
  instructions: { programId: string; accounts: string[]; data: Uint8Array }[];
  /** inner instructions, flattened */
  inner: { programId: string; accounts: string[]; data: Uint8Array }[];
};

/** A web3.js getTransaction answer (maxSupportedTransactionVersion: 1) as a ReceiptTx; null when there is none. */
export function receiptTxFrom(tx: VersionedTransactionResponse | null): ReceiptTx | null {
  if (!tx) return null;
  const m = tx.transaction.message;
  const la = tx.meta?.loadedAddresses;
  const keys = [...m.staticAccountKeys, ...(la?.writable ?? []), ...(la?.readonly ?? [])].map((k) => k.toBase58());
  const instructions = m.compiledInstructions.map((ix) => ({ programId: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((k) => keys[k]), data: ix.data }));
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((g) =>
    g.instructions.map((c) => ({ programId: keys[c.programIdIndex], accounts: c.accounts.map((k) => keys[k]), data: bs58.decode(c.data) })),
  );
  return { err: tx.meta?.err ?? null, slot: tx.slot, logs: tx.meta?.logMessages ?? [], instructions, inner };
}

export type ReceiptSource =
  | {
      kind: "deposit";
      depositor: string;
      /** the note's value (for a v2 deposit, the deposit plus its waiting-room rent) */
      amount: bigint;
      depositTx: string;
      settleTx: string;
      /** the screening pass right before the deposit: who signed it, and whether that is the pool's screening key (null: not asked) */
      pass: { guard: string; current: boolean | null } | null;
    }
  | { kind: "received"; amount: bigint; tx: string }
  | { kind: "unopened"; amount: bigint; tx: string };

export type ReceiptCheck = {
  ok: boolean;
  problems: string[];
  payment: { tx: string; withdraw: bigint; recipient: string; complete: boolean; delivery: { tx: string; to: string; lamports: bigint } | null } | null;
  sources: ReceiptSource[];
  /** how many of the owner's earlier spends the receipt opens */
  links: number;
  /** addresses the receipt names whose ownership proofs check out */
  bound: string[];
};

const te = new TextEncoder();
const disc = (name: string) => sha256(te.encode(`global:${name}`)).slice(0, 8);
const IX = {
  deposit: disc("deposit"),
  depositV2: disc("deposit_v2"),
  settle: disc("settle"),
  settleV2: disc("settle_v2"),
  transact: disc("transact"),
  transactV2: disc("transact_v2"),
};
const is = (data: Uint8Array, d: Uint8Array) => data.length >= 8 && d.every((v, i) => data[i] === v);
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const HEX64 = /^[0-9a-f]{64}$/;
const DEC = /^\d{1,20}$/;

function indexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** The single message an Ed25519 program instruction checks, when its offsets all point into itself. */
function ed25519Message(data: Uint8Array): { pubkey: Uint8Array; message: Uint8Array; signature: Uint8Array } | null {
  if (data.length < 16 || data[0] !== 1) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rd = (o: number) => v.getUint16(o, true);
  const [sigOff, sigIx, pkOff, pkIx, msgOff, msgLen, msgIx] = [rd(2), rd(4), rd(6), rd(8), rd(10), rd(12), rd(14)];
  if (sigIx !== 0xffff || pkIx !== 0xffff || msgIx !== 0xffff) return null;
  if (sigOff + 64 > data.length || pkOff + 32 > data.length || msgOff + msgLen > data.length) return null;
  return { pubkey: data.slice(pkOff, pkOff + 32), message: data.slice(msgOff, msgOff + msgLen), signature: data.slice(sigOff, sigOff + 64) };
}

/** Whether `msg` is a screening pass (VSA1, or the v2 program's VSA2) for `depositor` (and `inner`, for VSA2) from `programId`. */
function passFor(msg: Uint8Array, depositor: PublicKey, inner: bigint, programId: PublicKey): boolean {
  const tag = new TextDecoder().decode(msg.slice(0, 4));
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (tag === "VSA1") return msg.length === 44 && same(msg.slice(4, 36), depositor.toBytes());
  if (tag === "VSA2") {
    return msg.length === 116 && same(msg.slice(4, 36), programId.toBytes()) && same(msg.slice(36, 68), depositor.toBytes()) && fromBE(msg.slice(68, 100)) === inner;
  }
  return false;
}

export type VerifyOptions = {
  /** the pool program the receipt must be for (the published mainnet one, normally) */
  programId: string;
  /** the pool's screening key now, to say whether a deposit's pass came from it */
  guard?: string;
};

/**
 * Checks a receipt against the chain. `fetchTx` reads one transaction (from any RPC the verifier
 * trusts); only the pool program's own logs count, and every transaction must have succeeded.
 */
export async function verifyReceipt(receipt: unknown, fetchTx: (sig: string) => Promise<ReceiptTx | null>, o: VerifyOptions): Promise<ReceiptCheck> {
  const problems: string[] = [];
  const sources: ReceiptSource[] = [];
  const out: ReceiptCheck = { ok: false, problems, payment: null, sources, links: 0, bound: [] };
  const r = receipt as Receipt;
  if (!r || typeof r !== "object" || r.kind !== RECEIPT_KIND || r.version !== RECEIPT_VERSION || !r.payment) {
    problems.push("This isn't a VisionSwap payment receipt.");
    return out;
  }
  if (r.programId !== o.programId) {
    problems.push(`The receipt is for program ${String(r.programId).slice(0, 44)}, not the pool ${o.programId}.`);
    return out;
  }
  const program = new PublicKey(o.programId);
  const pda = (seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, program)[0].toBase58();
  let reads = 0;
  const cache = new Map<string, Promise<ReceiptTx | null>>();
  const tx = async (sig: string): Promise<ReceiptTx> => {
    if (typeof sig !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new Error("A transaction signature in the receipt is malformed.");
    if (!cache.has(sig)) {
      if (++reads > RECEIPT_MAX_TXS) throw new Error("The receipt names too many transactions to check.");
      cache.set(sig, fetchTx(sig));
    }
    const t = await cache.get(sig)!;
    if (!t) throw new Error(`Transaction ${sig.slice(0, 8)}… wasn't found on this network.`);
    if (t.err) throw new Error(`Transaction ${sig.slice(0, 8)}… failed on-chain, so it proves nothing.`);
    return t;
  };
  const events = (t: ReceiptTx): PoolEvent[] => eventsFromLogs(t.logs, o.programId);
  const all = (t: ReceiptTx) => [...t.instructions, ...t.inner].filter((i) => i.programId === o.programId);
  const used = new Set<string>();
  let spends = 0;

  /** Checks one opened spend; returns its slot and its withdraw, recipient and outputs' commitments. */
  const checkSpend = async (s: ReceiptSpend, where: string): Promise<{ slot: number; withdraw: bigint; recipient: string; complete: boolean; commitments: [bigint, bigint]; firstIndex: number }> => {
    if (++spends > RECEIPT_MAX_SPENDS) throw new Error("The receipt opens too many spends to check.");
    if (!Array.isArray(s.inputs) || !s.inputs.length || s.inputs.length > 2) throw new Error(`${where}: a spend has one or two opened notes.`);
    const t = await tx(s.tx);
    const notes = s.inputs.map((n) => {
      if (!Number.isInteger(n.index) || n.index < 0 || !DEC.test(n.amount) || !HEX64.test(n.inner) || !HEX64.test(n.sig)) throw new Error(`${where}: a note in the receipt is malformed.`);
      const amount = BigInt(n.amount);
      if (amount >= 1n << 64n) throw new Error(`${where}: a note's amount is out of range.`);
      const leaf = H2(amount, fromBE(unhex(n.inner)));
      const nullifier = H3(leaf, BigInt(n.index), fromBE(unhex(n.sig)));
      return { n, amount, leaf, nullifier };
    });
    if (new Set(notes.map((x) => x.n.index)).size !== notes.length) throw new Error(`${where}: the same note is listed twice.`);
    const ev = events(t).find((e): e is Extract<PoolEvent, { kind: "spent" }> => e.kind === "spent" && notes.every((x) => e.nullifiers.includes(x.nullifier)));
    if (!ev) throw new Error(`${where}: the opened notes' spend IDs aren't in that transaction's pool event. The receipt doesn't match the chain.`);
    // the spend instruction that carries these nullifiers: its second account is where the payout went
    const needle = new Uint8Array([...toBE(ev.nullifiers[0]), ...toBE(ev.nullifiers[1])]);
    const ix = all(t).find((i) => (is(i.data, IX.transact) || is(i.data, IX.transactV2)) && indexOfBytes(i.data, needle) >= 0);
    if (!ix) throw new Error(`${where}: that transaction has no pool payment carrying those spend IDs.`);
    const recipient = ix.accounts[1];
    let complete = false;
    if (s.outputs) {
      if (!Array.isArray(s.outputs) || s.outputs.length !== 2) throw new Error(`${where}: both outputs must be opened together.`);
      const outs = s.outputs.map((x, k) => {
        if (!DEC.test(x.amount) || !HEX64.test(x.inner)) throw new Error(`${where}: an opened output is malformed.`);
        const a = BigInt(x.amount);
        if (a >= 1n << 64n) throw new Error(`${where}: an output's amount is out of range.`);
        if (H2(a, fromBE(unhex(x.inner))) !== ev.commitments[k]) throw new Error(`${where}: an opened output doesn't match the pool event.`);
        return a;
      });
      const ins = notes.reduce((sum, x) => sum + x.amount, 0n);
      // the circuit: inputs = outputs + withdraw, with 64-bit amounts: if the opened inputs balance, any other input is zero-value padding
      if (ins === outs[0] + outs[1] + ev.withdraw) complete = true;
      else problems.push(`${where}: the opened notes don't add up to what the payment paid out and kept, so other notes paid for part of it.`);
    }
    // where each opened note came from
    for (const x of notes) {
      const key = `${x.n.index}`;
      if (used.has(key)) throw new Error(`${where}: the same note appears twice in the receipt.`);
      used.add(key);
      const og = x.n.origin;
      if (!og || typeof og !== "object") throw new Error(`${where}: a note doesn't say where it came from.`);
      if (og.kind === "deposit") {
        const st = await tx(og.settleTx);
        const settled = events(st).find((e) => e.kind === "settled" && e.index === x.n.index && e.leaf === x.leaf && e.amount === x.amount);
        if (!settled) throw new Error(`${where}: note ${x.n.index} isn't the one that transaction added to the pool.`);
        const dt = await tx(og.depositTx);
        const inner = fromBE(unhex(x.n.inner));
        const queued = events(dt).find((e): e is Extract<PoolEvent, { kind: "queued" }> => e.kind === "queued" && e.inner === inner);
        if (!queued) throw new Error(`${where}: note ${x.n.index}'s deposit isn't in that transaction.`);
        if (dt.slot > st.slot) throw new Error(`${where}: note ${x.n.index}'s deposit came after it was added to the pool.`);
        const depositor = new PublicKey(queued.depositor);
        // the deposit instruction for this note, at the top level, and the one right before it
        const di = dt.instructions.findIndex(
          (i) => i.programId === o.programId && (is(i.data, IX.deposit) || is(i.data, IX.depositV2)) && i.accounts[0] === queued.depositor && i.data.length >= 48 && fromBE(i.data.slice(16, 48)) === inner,
        );
        if (di < 0) throw new Error(`${where}: note ${x.n.index}'s deposit instruction isn't in that transaction.`);
        const v2 = is(dt.instructions[di].data, IX.depositV2);
        if (v2 ? queued.amount > x.amount : queued.amount !== x.amount) throw new Error(`${where}: note ${x.n.index}'s amount doesn't match its deposit.`);
        // the settle that added it closed this deposit's own waiting-room account, naming the same depositor
        const pending = v2 ? pda([te.encode("pending2"), depositor.toBytes(), toBE(inner)]) : pda([te.encode("pending"), toBE(inner)]);
        if (dt.instructions[di].accounts[4] !== pending) throw new Error(`${where}: note ${x.n.index}'s deposit used an unexpected waiting-room account.`);
        const settleIx = all(st).some((i) =>
          v2 ? is(i.data, IX.settleV2) && i.accounts[3] === pending : is(i.data, IX.settle) && i.accounts[2] === pending && i.accounts[3] === queued.depositor,
        );
        if (!settleIx) throw new Error(`${where}: the transaction that added note ${x.n.index} didn't settle that deposit.`);
        let pass: { guard: string; current: boolean | null } | null = null;
        const before = di > 0 ? dt.instructions[di - 1] : null;
        if (before && before.programId === ED25519) {
          const m = ed25519Message(before.data);
          if (m && passFor(m.message, depositor, inner, program)) {
            let good = false;
            try {
              good = ed25519.verify(m.signature, m.message, m.pubkey);
            } catch {
              good = false;
            }
            if (good) {
              const g = new PublicKey(m.pubkey).toBase58();
              pass = { guard: g, current: o.guard ? g === o.guard : null };
            }
          }
        }
        sources.push({ kind: "deposit", depositor: queued.depositor, amount: x.amount, depositTx: og.depositTx, settleTx: og.settleTx, pass });
      } else if (og.kind === "change" || og.kind === "received") {
        const ct = await tx(og.spendTx);
        const made = events(ct).find(
          (e) => e.kind === "spent" && ((e.index === x.n.index && e.commitments[0] === x.leaf) || (e.index + 1 === x.n.index && e.commitments[1] === x.leaf)),
        );
        if (!made) throw new Error(`${where}: note ${x.n.index} isn't one that transaction created.`);
        if (ct.slot > t.slot) throw new Error(`${where}: note ${x.n.index} was created after the payment that spent it.`);
        if (og.kind === "change" && og.spend) {
          if (og.spend.tx !== og.spendTx) throw new Error(`${where}: an earlier spend in the receipt doesn't match.`);
          out.links++;
          await checkSpend(og.spend, `Earlier payment ${og.spendTx.slice(0, 8)}…`);
        } else if (og.kind === "change") {
          sources.push({ kind: "unopened", amount: x.amount, tx: og.spendTx });
        } else {
          sources.push({ kind: "received", amount: x.amount, tx: og.spendTx });
        }
      } else {
        throw new Error(`${where}: a note says it came from somewhere this check doesn't know.`);
      }
    }
    return { slot: t.slot, withdraw: ev.withdraw, recipient, complete, commitments: ev.commitments, firstIndex: ev.index };
  };

  try {
    const pay = await checkSpend(r.payment, "The payment");
    let delivery: { tx: string; to: string; lamports: bigint } | null = null;
    const d = r.payment.delivery;
    if (d) {
      const dt = await tx(d.tx);
      if (d.hop !== pay.recipient) throw new Error("The delivery isn't from the address the payment paid.");
      const transfer = [...dt.instructions, ...dt.inner].find(
        (i) => i.programId === SYSTEM && i.data.length === 12 && fromLE(i.data.slice(0, 4)) === 2n && i.accounts[0] === d.hop && i.accounts[1] === d.to,
      );
      if (!transfer) throw new Error("The delivery transaction has no transfer from the payment's one-time address to the recipient.");
      if (dt.slot < pay.slot) throw new Error("The delivery came before the payment.");
      delivery = { tx: d.tx, to: d.to, lamports: fromLE(transfer.data.slice(4, 12)) };
    }
    out.payment = { tx: r.payment.tx, withdraw: pay.withdraw, recipient: pay.recipient, complete: pay.complete, delivery };
    // ownership proofs: each must be by an address the receipt names, over the prefixed text
    if (r.binding !== undefined) {
      if (!Array.isArray(r.binding) || r.binding.length > 4) throw new Error("The receipt's ownership proofs are malformed.");
      const named = new Set<string>([pay.recipient, ...(delivery ? [delivery.to] : []), ...sources.flatMap((s) => (s.kind === "deposit" ? [s.depositor] : []))]);
      for (const b of r.binding) {
        if (!b || typeof b.address !== "string" || typeof b.message !== "string" || typeof b.signature !== "string") throw new Error("An ownership proof in the receipt is malformed.");
        if (!named.has(b.address)) throw new Error(`An ownership proof is by ${b.address.slice(0, 8)}…, an address this receipt doesn't name.`);
        if (!b.message.startsWith(OWNERSHIP_PROOF_PREFIX)) throw new Error("An ownership proof doesn't sign a VisionSwap ownership message.");
        let good = false;
        try {
          const sig = bs58.decode(b.signature);
          good = sig.length === 64 && ed25519.verify(sig, te.encode(b.message), new PublicKey(b.address).toBytes());
        } catch {
          good = false;
        }
        if (!good) throw new Error(`The ownership proof for ${b.address.slice(0, 8)}… doesn't check out.`);
        out.bound.push(b.address);
      }
    }
  } catch (e) {
    problems.push((e as Error).message);
  }
  out.ok = problems.length === 0;
  return out;
}
