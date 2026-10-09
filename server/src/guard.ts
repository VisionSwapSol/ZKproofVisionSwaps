import { PublicKey, Transaction, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { attestationMessage, computeBudget, eventsFromLogs, refundRequestMessage } from "@visionswap/sdk";
import { config } from "./config.ts";
import { conn, pool, poolConfig, confirm, payerUnfunded } from "./chain.ts";
import { ofacLoaded, screen, type ScreenResult } from "./screening.ts";
import { store } from "./indexer.ts";
import { log } from "./log.ts";
import { parseKey } from "./keys.ts";
import { fundingWalk, notFunders, type FundingTx } from "./funding.ts";

/**
 * The guard signs short-lived "this wallet passed screening" attestations
 * that the program requires before a deposit, and sends waiting-room
 * deposits back to their owners if a later check flags them.
 */

export type Attestation = { guard: string; expiry: string; signature: string };

/** Signatures read per page, and pages read at most, while looking for where the address was last empty. */
const FUNDER_TXS = 10;
const FUNDER_PAGES = 2;
const funderCache = new Map<string, { at: number; funders: string[]; latest: string | null; balance: number }>();
/** the same address read twice at once is read once */
const funderReads = new Map<string, Promise<string[]>>();

/**
 * Who paid the SOL that `address` holds now: every account whose balance went
 * down in a transaction that credited it since it was last empty (fundingSince).
 * A deposit address (sent to by QR code or a payment link, from any wallet or
 * exchange) is brand new, so screening only the address itself would say
 * nothing; screening its senders does. Pool withdrawals, exchange pools paying
 * for a sale and similar plumbing don't count as senders (notFunders). A busy
 * wallet's history is read FUNDER_PAGES pages back and its payers there are screened.
 */
export async function fundersOf(address: string, maxAgeMs = 0, now?: { latest: string | null; balance: number }): Promise<string[]> {
  const hit = funderCache.get(address);
  // `now` is the address's newest transaction and balance as just read: a cached answer only counts
  // while neither has changed, so a payment that arrived since is always screened
  if (hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs && (!now || (now.latest === hit.latest && now.balance === hit.balance))) return hit.funders;
  let p = funderReads.get(address);
  if (!p) {
    p = readFunders(address, now?.balance).finally(() => funderReads.delete(address));
    funderReads.set(address, p);
  }
  return p;
}

async function readFunders(address: string, knownBalance?: number): Promise<string[]> {
  const pk = new PublicKey(address);
  const program = config.programId.toBase58();
  const ctx = {
    programId: program,
    vault: pool.vault.toBase58(),
    own: [config.relayer, config.guard].flatMap((k) => (k ? [k.publicKey.toBase58()] : [])),
  };
  const balance = knownBalance ?? (await conn.getBalance(pk, "confirmed"));
  let latest: string | null | undefined;
  // the balance right after the address's newest transaction that was read
  let newestPost: number | undefined;
  const found = await fundingWalk(async (before) => {
    const sigs = await conn.getSignaturesForAddress(pk, { limit: FUNDER_TXS, before }, "confirmed");
    if (latest === undefined) latest = sigs[0]?.signature ?? null;
    const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
    // read one by one, four at a time (as the index does): an RPC may answer a batch in any order,
    // and the public fallback often turns away part of one, which would fail the whole read
    const parsed: (ParsedTransactionWithMeta | null)[] = [];
    for (let k = 0; k < ok.length; k += 4) {
      parsed.push(...(await Promise.all(ok.slice(k, k + 4).map((s) => conn.getParsedTransaction(s, { maxSupportedTransactionVersion: 1, commitment: "confirmed" })))));
    }
    const txs: FundingTx[] = [];
    for (const tx of parsed) {
      const meta = tx?.meta;
      if (!tx || !meta) continue;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const me = keys.indexOf(address);
      if (me < 0) continue;
      const skip = notFunders(tx, address, ctx);
      const events = eventsFromLogs(meta.logMessages ?? [], program);
      txs.push({
        gain: meta.postBalances[me] - meta.preBalances[me],
        post: meta.postBalances[me],
        payers: keys.filter((k, i) => i !== me && meta.postBalances[i] < meta.preBalances[i] && !skip.has(k)),
        refunded: events.flatMap((e) => (e.kind === "refunded" && e.depositor === address ? [e.inner.toString()] : [])),
        queued: events.flatMap((e) => (e.kind === "queued" && e.depositor === address ? [e.inner.toString()] : [])),
      });
    }
    if (before === undefined) newestPost = txs[0]?.post;
    return { txs, next: sigs.at(-1)?.signature, ended: sigs.length < FUNDER_TXS };
  }, FUNDER_PAGES);
  // A whole history (back to an empty point or the first transaction) must explain every lamport
  // the address holds. If it doesn't, the node hasn't indexed the latest payment yet: worth asking
  // again soon. A longer history was only read in part, so it can't be held to that.
  // For a busy wallet read only in part, a balance above what its newest transaction left means
  // a payment the node hasn't indexed yet: its sender would go unscreened, so ask again soon.
  if (found.complete ? balance > found.received : newestPost !== undefined && balance > newestPost) {
    throw Object.assign(new Error("funding not indexed yet"), { soon: true, retry: true });
  }
  const funders = found.payers;
  funderCache.set(address, { at: Date.now(), funders, latest: latest ?? null, balance });
  if (funderCache.size > 5000) funderCache.delete(funderCache.keys().next().value!);
  return funders;
}

/** The depositor and everyone who recently funded it must pass screening. */
export async function screenDepositor(address: string, maxAgeMs = 0, now?: { latest: string | null; balance: number }): Promise<ScreenResult & { soon?: boolean }> {
  const own = await screen(address);
  if (!own.ok) return own;
  let funders: string[];
  try {
    funders = await fundersOf(address, maxAgeMs, now);
  } catch (e) {
    // `soon`: a payment that just landed and isn't indexed yet, not a real outage
    return { ok: false, reason: "unavailable", soon: (e as { soon?: boolean }).soon === true };
  }
  for (const f of funders) {
    const r = await screen(f);
    if (!r.ok) return r;
  }
  return own;
}

export async function attest(depositor: string): Promise<Attestation> {
  if (!config.guard) throw Object.assign(new Error("Screening is not configured on this server."), { status: 503 });
  const pk = parseKey(depositor);
  // always check the latest funding (a deposit address may have been paid a moment ago), but two
  // cheap reads tell whether anything changed since the last full read a minute ago
  const latest = await Promise.all([conn.getSignaturesForAddress(pk, { limit: 1 }, "confirmed"), conn.getBalance(pk, "confirmed")])
    .then(([s, balance]) => ({ latest: s[0]?.signature ?? null, balance }))
    .catch(() => undefined);
  const res = await screenDepositor(pk.toBase58(), latest ? 60_000 : 0, latest);
  if (!res.ok) {
    const msg =
      res.reason !== "unavailable"
        ? "This wallet can't use VisionSwap."
        : res.soon
          ? "Your latest payment is still arriving. Try again in a few seconds."
          : "Screening is briefly unavailable. Try again in a minute.";
    // tells the client when to ask again (Retry-After)
    const retryAfter = res.reason !== "unavailable" ? undefined : res.soon ? 10 : 60;
    throw Object.assign(new Error(msg), { status: res.reason === "unavailable" ? 503 : 403, retryAfter });
  }
  // passed screening: a network hiccup from here on is worth a quick retry, not a refusal
  const brief = () => Object.assign(new Error("The network is busy right now. Try again in a few seconds."), { status: 503, retryAfter: 5 });
  const cfg = await poolConfig().catch(() => {
    throw brief();
  });
  if (!cfg.guard.equals(config.guard.publicKey)) {
    throw Object.assign(new Error("Server guard key does not match the pool."), { status: 503 });
  }
  const slot = BigInt(
    await conn.getSlot("confirmed").catch(() => {
      throw brief();
    }),
  );
  const expiry = slot + config.attestationTtlSlots;
  const sig = ed25519.sign(attestationMessage(pk, expiry), config.guard.secretKey.slice(0, 32));
  return { guard: config.guard.publicKey.toBase58(), expiry: expiry.toString(), signature: Buffer.from(sig).toString("base64") };
}

/**
 * Hands a waiting deposit back for a depositor who can't pay the network fee
 * (a deposit address or Vision wallet that put everything in). The depositor
 * signs the request; the program pays the refund only to the depositor.
 */
export async function refundFor(inner: string, signatureB64: string): Promise<string> {
  if (!config.guard) throw Object.assign(new Error("Refunds by request aren't available on this server."), { status: 503 });
  if (!/^[0-9a-f]{64}$/i.test(inner)) throw Object.assign(new Error("Bad deposit id."), { status: 400 });
  const key = inner.toLowerCase();
  const p = store.pending.get(key);
  if (!p) throw Object.assign(new Error("That deposit has already left the waiting room."), { status: 404 });
  const sig = Buffer.from(String(signatureB64 ?? ""), "base64");
  const depositor = new PublicKey(p.depositor);
  if (sig.length !== 64 || !ed25519.verify(sig, refundRequestMessage(config.programId, key), depositor.toBytes())) {
    throw Object.assign(new Error("Only the address that made this deposit can take it back."), { status: 403 });
  }
  // the guard pays only for depositors that can't: anyone with SOL for the fee (above what keeps the address open) takes a deposit back themselves
  if ((await conn.getBalance(depositor, "confirmed")) >= (await conn.getMinimumBalanceForRentExemption(0)) + 10_000) {
    throw Object.assign(new Error("This address can pay the network fee itself: take the deposit back from the app."), { status: 409 });
  }
  const tx = new Transaction().add(
    ...computeBudget(60_000, config.priorityMicroLamports),
    pool.refund(config.guard.publicKey, pool.pending(BigInt("0x" + key)), depositor),
  );
  tx.feePayer = config.guard.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(config.guard);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    if (payerUnfunded(sim.value.err, sim.value.logs)) {
      log("guard: can't pay for a take-back: it needs SOL");
      throw Object.assign(
        new Error("Free take-backs are paused for a moment. Your deposit is safe and joins your private balance when the wait ends, or try again later."),
        { status: 503 },
      );
    }
    throw Object.assign(new Error("That deposit has already left the waiting room."), { status: 409 });
  }
  const sent = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  if ((await confirm(sent)) !== "confirmed") throw Object.assign(new Error("The network is slow right now. Try again in a minute."), { status: 503 });
  return sent;
}

/** Waiting deposits that failed a re-screen but couldn't be sent back yet: the crank leaves them alone. */
const flagged = new Set<string>();
export function isFlagged(inner: string): boolean {
  return flagged.has(inner);
}

/**
 * The chain slot this server started at (plus a margin), once read; until then every deposit
 * counts as one from before the start. `flagged` lives in memory only, so a deposit that was
 * already waiting at the start may have been flagged by the copy before this one: our relayer
 * adds it to the pool only after a clear re-screen here. A deposit queued after the start was
 * screened for its deposit moments before and can't be flagged anywhere yet; the regular
 * re-screen covers it like any other waiting deposit.
 */
let startSlot: bigint | null = null;
/** Slots added to the start, so a node a little behind the chain can't make an older deposit look new. */
const START_MARGIN = 150n;
/** Waiting deposits with a clear answer from a re-screen since this server started. */
const rescreened = new Set<string>();
export function screenedSinceStart(inner: string, start = startSlot): boolean {
  if (!config.guard || rescreened.has(inner)) return true;
  const slot = store.pending.get(inner)?.slot;
  return start !== null && slot !== undefined && /^\d+$/.test(slot) && BigInt(slot) > start;
}

let rescreening = false;
/** When the last full re-screen started. */
let lastPass = 0;
const PASS_EVERY = 2 * 60_000;
/** When a deposit still waiting for its first clear answer here was last asked about: an unclear answer is asked again this often. */
const askedAt = new Map<string, number>();
const ASK_AGAIN = 30_000;

/**
 * Re-screens every waiting deposit, or with `firstOnly` just those still waiting for their first
 * clear answer since this server started; flagged ones go straight back to their depositor.
 */
export async function rescreenWaitingRoom(firstOnly = false) {
  if (!config.guard || rescreening) return;
  rescreening = true;
  try {
    for (const inner of flagged) if (!store.pending.has(inner)) flagged.delete(inner);
    for (const inner of rescreened) if (!store.pending.has(inner)) rescreened.delete(inner);
    for (const inner of askedAt.keys()) if (!store.pending.has(inner)) askedAt.delete(inner);
    if (!firstOnly) lastPass = Date.now();
    for (const p of [...store.pending.values()]) {
      if (firstOnly && !firstLookDue(p.inner)) continue;
      if (!screenedSinceStart(p.inner)) askedAt.set(p.inner, Date.now());
      const r = await screenDepositor(p.depositor, 30 * 60_000).catch(() => ({ ok: false as const, reason: "unavailable" as const }));
      if (r.ok || r.reason !== "unavailable") rescreened.add(p.inner);
      if (r.ok) flagged.delete(p.inner);
      if (r.ok || r.reason === "unavailable") continue;
      flagged.add(p.inner);
      try {
        const inner = BigInt("0x" + p.inner);
        const tx = new Transaction().add(
          ...computeBudget(60_000, config.priorityMicroLamports),
          pool.refund(config.guard.publicKey, pool.pending(inner), new PublicKey(p.depositor)),
        );
        tx.feePayer = config.guard.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
        tx.sign(config.guard);
        const sig = await conn.sendRawTransaction(tx.serialize());
        const st = await confirm(sig);
        log("guard: returned a flagged waiting-room deposit:", st);
      } catch (e) {
        const lamports = await conn.getBalance(config.guard.publicKey, "confirmed").catch(() => null);
        log(
          `guard: could not return a flagged waiting-room deposit (guard holds ${lamports === null ? "?" : (lamports / 1e9).toFixed(4)} SOL); it stays out of the pool and is retried:`,
          (e as Error).message.slice(0, 200),
        );
      }
    }
  } finally {
    rescreening = false;
  }
}

/** A deposit still waiting for its first clear answer here, and not asked about in the last little while. */
const firstLookDue = (inner: string) => !screenedSinceStart(inner) && Date.now() - (askedAt.get(inner) ?? 0) >= ASK_AGAIN;

/** A full re-screen every two minutes; in between, deposits still waiting for their first look here get it within seconds. */
function tick() {
  if (Date.now() - lastPass >= PASS_EVERY) void rescreenWaitingRoom();
  else if ([...store.pending.keys()].some(firstLookDue)) void rescreenWaitingRoom(true);
}

async function readStartSlot() {
  for (;;) {
    try {
      // "processed" is the newest slot the node knows, so every deposit made before the start sits below it
      startSlot = BigInt(await conn.getSlot("processed")) + START_MARGIN;
      return;
    } catch {
      // until it's read, every waiting deposit is re-screened before it's added
      await new Promise((r) => setTimeout(r, 5_000).unref());
    }
  }
}

export function startGuard() {
  if (!config.guard) return;
  void readStartSlot();
  // the first full look as soon as the sanctions list is fresh (the crank waits for it), then often
  // enough that a new flag (a list update, say) is acted on well inside the waiting time; deposits
  // the index finds later (catching up after a restart) are looked at within seconds, not minutes
  void ofacLoaded().then(() => {
    tick();
    setInterval(tick, 5_000).unref();
  });
}
