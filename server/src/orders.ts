import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { config, lamportsSetting } from "./config.ts";
import { conn } from "./chain.ts";
import { keeperSwap, keeperQuote, ataFor, tokenState, WSOL } from "./swap.ts";
import { prices as bookPrices, getPrice, setWatch, clearWatch, onUpdate, type PriceOpts } from "./pricebook.ts";
import { WAIT, limiter } from "./jupiter.ts";
import { fundsStatus } from "./funds.ts";
import { log } from "./log.ts";
import { loadState, saveState, saveStateNow, stateRestoring } from "./durable.ts";
import { Keeper, checkOrder, fastCheckMs, keeperError, isB58, UNPRICED_MS, MAX_DAYS, MAX_LEGS, MAX_SLIPPAGE_BPS, type Book, type Exec, type Limits, type Order, type OrderKind, type PriceEntry } from "./keeper.ts";

/**
 * Private orders, kept by the server: take-profit (in up to 4 steps), stop-loss and trailing stop on
 * a Vision wallet's tokens, limit buys, and DCA (recurring buys). Each order gets its own key. The
 * Vision wallet approves that key, on-chain, for exactly the tokens (or wrapped SOL) set aside for
 * the order, and nothing else: the token program refuses it anything more. When the order triggers,
 * the keeper (keeper.ts) signs a Jupiter swap as that key, spending the approved tokens and sending
 * the output back to the same Vision wallet. The relayer pays the network fee. Cancelling revokes
 * the approval on-chain.
 */

export type { OrderKind, OrderStatus } from "./keeper.ts";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// ─── settings ───

const env = (k: string) => {
  const v = process.env[k]?.trim();
  return v ? v : undefined;
};
const numSetting = (k: string, d: number) => {
  const n = Number(env(k));
  return env(k) && Number.isFinite(n) && n > 0 ? n : d;
};
/** the smallest orders the server takes (new orders; the app shows the same floors) */
export const LIMITS: Limits = {
  minSellUsd: numSetting("ORDER_MIN_SELL_USD", 2),
  minBuyLamports: lamportsSetting(env("ORDER_MIN_BUY_LAMPORTS"), 20_000_000n, "ORDER_MIN_BUY_LAMPORTS"),
  // 0.005 SOL: the app funds a DCA before describing it, so this must never be above what the app allows
  minDcaBuyLamports: lamportsSetting(env("ORDER_MIN_DCA_BUY_LAMPORTS"), 5_000_000n, "ORDER_MIN_DCA_BUY_LAMPORTS"),
  minDcaEverySec: numSetting("ORDER_MIN_DCA_EVERY", 3600),
};
/** orders described but not started yet: per visitor and in all (the wallet address in a request proves nothing, so it isn't counted) */
const PENDING_PER_IP = numSetting("ORDERS_PENDING_PER_IP", 5);
const PENDING_MAX = numSetting("ORDERS_PENDING_MAX", 2000);
/** orders handed back after the server lost them, per visitor per 10 minutes */
const RESUMES_PER_IP = numSetting("ORDERS_RESUMES_PER_IP", 20);
/** for this long after the orders start loading, an order the server doesn't know yet may still be on its way back from storage */
const RESTORE_GRACE_MS = 10 * 60_000;
/** when the orders last started loading (set again by startKeeper, which may wait for the copy before this one) */
let loadedAt = Date.now();
/** The floors and caps, for the app to check before it moves any funds (GET /api/orders/limits). */
export function orderLimits() {
  return {
    minSellUsd: LIMITS.minSellUsd,
    minBuyLamports: LIMITS.minBuyLamports.toString(),
    minDcaBuyLamports: LIMITS.minDcaBuyLamports.toString(),
    minDcaEverySec: LIMITS.minDcaEverySec,
    maxDcaEverySec: 30 * 86_400,
    dcaCount: [2, 100],
    maxSlippageBps: MAX_SLIPPAGE_BPS,
    trailPct: [1, 50],
    maxLegs: MAX_LEGS,
    maxDays: MAX_DAYS,
  };
}
/** priority fee for order trades (micro-lamports per compute unit); stop-losses pay a few times more, never past the cap */
const PRIORITY = numSetting("KEEPER_PRIORITY_MICROLAMPORTS", config.priorityMicroLamports);
const STOP_PRIORITY_X = numSetting("KEEPER_STOP_PRIORITY_X", 4);
const MAX_PRIORITY = numSetting("KEEPER_MAX_PRIORITY_MICROLAMPORTS", 200_000);
/** below this the relayer keeps its SOL for payments, and order trades wait (by default where /api/health starts warning) */
const RELAYER_FLOOR = lamportsSetting(env("KEEPER_RELAYER_FLOOR_LAMPORTS"), config.relayerLowLamports, "KEEPER_RELAYER_FLOOR_LAMPORTS");

const priorityFor = (urgent: boolean) => Math.min(MAX_PRIORITY, Math.round(PRIORITY * (urgent ? STOP_PRIORITY_X : 1)));
/** trades built at once: from the swap lane's share of the Jupiter plan (about 3 on a free key), 1 to 8 */
const workers = () => Math.max(1, Math.min(8, Math.floor(numSetting("KEEPER_WORKERS", (limiter.usable() * 0.4) / 6))));
/** the quickest a token near its trigger is checked: worked out each time from the plan's size, which Jupiter's replies can show is bigger */
const fastMs = () => fastCheckMs(limiter.baseCapacity());

// ─── accounts ───

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bad = (m: string, status = 400) => Object.assign(new Error(m), { status });
const keyOf = (o: Order) => Keypair.fromSecretKey(bs58.decode(o.secret!));
/** The account the order spends from: the owner's token account (sells) or wrapped-SOL account (buys). */
const inputAccount = (o: Pick<Order, "kind" | "owner" | "mint" | "program">) =>
  o.kind === "sell" ? ataFor(new PublicKey(o.owner!), new PublicKey(o.mint!), new PublicKey(o.program!)) : ataFor(new PublicKey(o.owner!), new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM));
/** The input account as a string, worked out once per order (it never changes, and the keeper asks often). */
const inputKeys = new WeakMap<Order, string>();
const inputKeyOf = (o: Order) => {
  let k = inputKeys.get(o);
  if (k === undefined) inputKeys.set(o, (k = inputAccount(o).toBase58()));
  return k;
};
/** Where the output lands: the owner's wrapped-SOL account (sells) or token account (buys). */
const outputAccount = (o: Order) =>
  o.kind === "sell" ? ataFor(new PublicKey(o.owner!), new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM)) : ataFor(new PublicKey(o.owner!), new PublicKey(o.mint!), new PublicKey(o.program!));

/**
 * The order's key: the owner's app may supply it (derived from their account, so the app can hand it
 * back if this server ever loses its orders); otherwise a fresh one is made.
 */
function orderSecret(given: unknown): string {
  if (typeof given === "string" && given) {
    // a 64-byte key is at most 88 characters: anything longer is refused before it is decoded
    if (!isB58(given, 64, 88)) throw bad("Bad order key.");
    try {
      return bs58.encode(Keypair.fromSecretKey(bs58.decode(given)).secretKey);
    } catch {
      throw bad("Bad order key.");
    }
  }
  return bs58.encode(Keypair.generate().secretKey);
}

// ─── prices ───

/**
 * On a local test chain (only there), ORDER_TEST_PRICES may name a JSON file of { mint: usdPrice }
 * that stands in for Jupiter, whose prices only exist for mainnet tokens.
 */
const testPrices = config.network === "localnet" ? env("ORDER_TEST_PRICES") : undefined;
function readTestPrices(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(testPrices!, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The test file as a price book: every watched token is read again every 2 seconds. */
function testBook(): Book {
  const watched = new Set<string>();
  const last = new Map<string, PriceEntry>();
  let block = 0;
  setInterval(() => {
    const all = readTestPrices();
    const at = Date.now();
    block++;
    for (const m of [...watched, WSOL]) {
      const usd = all[m];
      const e = typeof usd === "number" && usd > 0 ? { usd, at, blockId: block } : null;
      if (e) last.set(m, e);
      keeper.onPrice(m, e);
    }
  }, 2_000).unref();
  return { getPrice: (m) => last.get(m) ?? null, setWatch: (m) => void watched.add(m), clearWatch: (m) => void watched.delete(m) };
}

/** A price for a new order or an edit: a visitor's request, on the visitors' lane; a couple of minutes old is fine. */
async function priceNow(mint: string, ip?: string): Promise<number | null> {
  if (testPrices) return readTestPrices()[mint] ?? null;
  const o: PriceOpts = { maxAgeMs: 120_000, lane: "interactive", maxWaitMs: WAIT.quote, ip };
  const got = await bookPrices([mint], o).catch(() => ({}) as Record<string, PriceEntry | null>);
  // left out means the price check couldn't run just now, not that the token has no price
  if (!Object.hasOwn(got, mint)) throw Object.assign(new Error("Prices are busy right now. Try again in a few seconds."), { status: 503, retryAfter: 5 });
  return got[mint]?.usd ?? null;
}

// ─── the chain, for the keeper ───

const exec: Exec = {
  async build(o, plan) {
    const relayer = config.relayer;
    if (!relayer) throw keeperError("Orders aren't available right now.", "relayer");
    if (!o.secret) throw keeperError("cancelled", "cancelled");
    const key = keyOf(o);
    const sell = o.kind === "sell";
    const b = await keeperSwap({
      inputMint: sell ? o.mint! : WSOL,
      outputMint: sell ? WSOL : o.mint!,
      amount: plan.amount.toString(),
      slippageBps: plan.slippageBps,
      authority: key.publicKey,
      payer: relayer.publicKey,
      inputAccount: inputAccount(o),
      inputProgram: new PublicKey(sell ? o.program! : TOKEN_PROGRAM),
      destination: outputAccount(o),
      gate: plan.gate,
      priorityMicroLamports: priorityFor(plan.urgent),
    });
    b.tx.sign([relayer, key]);
    const raw = b.tx.serialize();
    return { sig: bs58.encode(b.tx.signatures[0]), lastValid: b.lastValidBlockHeight, out: b.outAmount, send: () => conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }) };
  },
  async statuses(sigs, history) {
    const r = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: history });
    return r.value.map((v) => (v?.err ? "failed" : v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") ? "landed" : null));
  },
  height: () => conn.getBlockHeight("confirmed"),
  async approval(o) {
    const a = await conn.getAccountInfo(inputAccount(o), "confirmed");
    const s = tokenState(a?.data);
    return s ? { delegate: s.delegate, delegated: s.delegated, balance: s.amount } : null;
  },
  async history(o) {
    if (!o.delegate) return [];
    const list = await conn.getSignaturesForAddress(new PublicKey(o.delegate), { limit: 25 }, "confirmed");
    return list.filter((s) => !s.err).map((s) => ({ sig: s.signature, t: s.blockTime == null ? null : s.blockTime * 1000 }));
  },
  async landed(o, sig) {
    // null unless it is a trade the order's own key signed (its address also shows up in the owner's approval)
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
    if (!tx || tx.meta?.err || !o.delegate) return null;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
    const signers = tx.transaction.message.header.numRequiredSignatures;
    let signed = false;
    for (let i = 0; i < signers; i++) if (keys.get(i)?.toBase58() === o.delegate) signed = true;
    if (!signed) return null;
    if (!o.owner) return {};
    const at = (acct: PublicKey) => {
      for (let i = 0; i < keys.length; i++) if (keys.get(i)?.equals(acct)) return i;
      return -1;
    };
    const bal = (list: { accountIndex: number; uiTokenAmount: { amount: string } }[] | null | undefined, i: number) => BigInt(list?.find((x) => x.accountIndex === i)?.uiTokenAmount.amount ?? "0");
    const inI = at(inputAccount(o));
    const outI = at(outputAccount(o));
    const m = tx.meta!;
    return {
      ...(inI >= 0 ? { spent: (bal(m.preTokenBalances, inI) - bal(m.postTokenBalances, inI)).toString() } : {}),
      ...(outI >= 0 ? { got: (bal(m.postTokenBalances, outI) - bal(m.preTokenBalances, outI)).toString() } : {}),
    };
  },
  probe: (o, amount) => keeperQuote({ inputMint: o.mint!, outputMint: WSOL, amount: amount.toString() }),
  async relayerOk() {
    const f = await fundsStatus().catch(() => null);
    const l = f?.relayer?.lamports;
    return l == null || BigInt(l) >= RELAYER_FLOOR;
  },
  async decimals(o) {
    const a = await conn.getParsedAccountInfo(new PublicKey(o.mint!), "confirmed");
    const d = (a.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals;
    if (d == null) throw keeperError("keeper: unknown mint", "fatal");
    return d;
  },
  async solUsd(o) {
    if (testPrices) return readTestPrices()[WSOL] ?? null;
    if (o?.cachedOnly) {
      // a stop-loss: what the book holds, if recent enough to judge a recovery by
      const e = getPrice(WSOL);
      return e && Date.now() - e.at <= 120_000 ? e.usd : null;
    }
    // a price gate's fresh price goes on the trades' own lane, so a busy price lane can't hold it back
    const fresh = o?.maxAgeMs != null && o.maxAgeMs <= 15_000;
    const got = await bookPrices([WSOL], { maxAgeMs: o?.maxAgeMs ?? 120_000, lane: fresh ? "exec" : "keeper", maxWaitMs: fresh ? WAIT.quote : WAIT.keeper });
    return got[WSOL]?.usd ?? null;
  },
};

const book: Book = testPrices ? testBook() : { getPrice, setWatch, clearWatch };
const keeper = new Keeper(book, exec, {
  workers,
  fastMs,
  save,
  saveNow: (): Promise<void> => saveStateNow("orders", () => keeper.serialize()),
  limits: LIMITS,
  solMint: WSOL,
  // about a third of the keeper's Jupiter share (a quarter of the plan) goes to quotes for unpriced tokens
  probeBudget: () => Math.max(1, Math.floor(limiter.capacity() * 0.25 * 0.3)),
  inputKey: inputKeyOf,
});
const orders = keeper.orders;
/** who described each order not started yet (memory only), for the per-visitor cap */
const pendingIp = new Map<string, string>();
const activating = new Set<string>();
/** orders handed back per visitor (memory only): when, for the per-visitor cap */
const resumes = new Map<string, number[]>();

/** Still within the start's grace while App Storage hasn't answered: an unknown order may be on its way back. */
function restoring() {
  return Date.now() - loadedAt < RESTORE_GRACE_MS && stateRestoring("orders");
}

// ─── storage ───
// orders live in durable state (sealed, and kept in App Storage on Replit), so a republish loses none

/** Adds the saved orders this server doesn't hold yet (the ones it holds are newer). */
function adopt(text: string): number {
  try {
    const list = JSON.parse(text) as Order[];
    for (const o of list) {
      // orders saved before the key's public half was kept
      if (o?.secret && !o.delegate) o.delegate = Keypair.fromSecretKey(bs58.decode(o.secret)).publicKey.toBase58();
    }
    return keeper.adopt(list);
  } catch (e) {
    log(`orders: couldn't read the saved orders: ${(e as Error).message}`);
    return 0;
  }
}
async function load() {
  // App Storage may only answer after the start: what it holds is added back then
  const text = await loadState("orders", (late) => {
    log(`orders: ${adopt(late)} order(s) added back from storage`);
    void fillDecimals();
    save();
  });
  if (text) adopt(text);
  void fillDecimals();
}
/** Returns at once: the list is written a moment later, once, however many changes came in. */
function save() {
  saveState("orders", () => keeper.serialize());
}

/** Orders saved before decimals were kept get them (the price gate needs them). */
async function fillDecimals() {
  const need = [...orders.values()].filter((o) => o.status === "active" && o.mint && o.decimals == null);
  const mints = [...new Set(need.map((o) => o.mint!))];
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const infos = await conn.getMultipleParsedAccounts(chunk.map((m) => new PublicKey(m)), { commitment: "confirmed" }).catch(() => null);
    infos?.value.forEach((a, j) => {
      const d = (a?.data as { parsed?: { info?: { decimals?: number } } } | undefined)?.parsed?.info?.decimals;
      if (d != null) for (const o of need) if (o.mint === chunk[j]) o.decimals = d;
    });
  }
}

// ─── the API ───

/** What a token's mint says about whether the keeper can move it (Token-2022 extensions it can't follow). */
function unmovable(exts: { extension: string; state?: Record<string, unknown> }[] | undefined): boolean {
  for (const e of exts ?? []) {
    if (e.extension === "transferHook" && e.state?.programId) return true;
    if (e.extension === "nonTransferable" || e.extension === "nonTransferableAccount") return true;
    if (e.extension === "defaultAccountState" && e.state?.accountState === "frozen") return true;
    if (e.extension === "permanentDelegate" && e.state?.delegate) return true;
  }
  return false;
}

/** Half the new-order floors, on what a handed-back order really holds (no price: most of its tokens must still be there). */
export function tooSmallToResume(kind: OrderKind, held: bigint, amount: bigint, price: number | null, decimals: number): boolean {
  if (kind !== "sell") return held < (kind === "dca" ? LIMITS.minDcaBuyLamports : LIMITS.minBuyLamports) / 2n;
  return price ? (Number(held) / 10 ** decimals) * price < LIMITS.minSellUsd / 2 : held * 2n < amount;
}

/** Step 1: the order is described and gets its own key; the Vision wallet then approves that key on-chain. */
export async function prepareOrder(b: Record<string, unknown>, ip?: string) {
  const kind = b.kind as OrderKind;
  if (!["sell", "buy", "dca"].includes(kind)) throw bad("Unknown order type.");
  let owner: PublicKey, mint: PublicKey;
  // checked for length before decoding: a long string would hold up the whole server
  if (!isB58(b.owner, 32, 44) || !isB58(b.mint, 32, 44)) throw bad("Bad address.");
  try {
    owner = new PublicKey(b.owner);
    mint = new PublicKey(b.mint);
  } catch {
    throw bad("Bad address.");
  }
  if (mint.toBase58() === WSOL) throw bad("Pick a token other than SOL.");
  if (!/^\d{1,20}$/.test(String(b.amount)) || BigInt(String(b.amount)) <= 0n) throw bad("Bad amount.");
  const info = await conn.getParsedAccountInfo(mint, "confirmed");
  const program = info.value?.owner.toBase58();
  if (program !== TOKEN_PROGRAM && program !== TOKEN_2022) throw bad("That isn't a token Jupiter can trade.");
  const parsed = (info.value?.data as { parsed?: { info?: { decimals?: number; extensions?: { extension: string; state?: Record<string, unknown> }[] } } } | undefined)?.parsed?.info;
  if (parsed?.decimals == null) throw bad("That isn't a token Jupiter can trade.");
  if (unmovable(parsed.extensions)) throw bad("This token has transfer rules the order service can't follow. Trade it straight from the app instead.");
  const secret = orderSecret(b.secret);
  const key = Keypair.fromSecretKey(bs58.decode(secret));
  const base = { kind, owner: owner.toBase58(), mint: mint.toBase58(), program };
  // an order the app hands back after this server lost it: its approval is on-chain already
  let resume = false;
  let held = 0n;
  if (typeof b.secret === "string" && b.secret) {
    const a = tokenState((await conn.getAccountInfo(inputAccount(base), "confirmed").catch(() => null))?.data);
    resume = !!a && a.delegate === key.publicKey.toBase58() && a.delegated >= BigInt(String(b.amount));
    // what the order can really trade: approved, and actually in the account
    if (a) held = [a.amount, a.delegated, BigInt(String(b.amount))].reduce((x, y) => (y < x ? y : x));
  }
  if (resume) {
    // the stored orders may still be on their way back: handing this one back now would run it twice
    if (restoring()) throw Object.assign(new Error("Orders are still loading. Try again in a moment."), { status: 503, retryAfter: 15 });
    const t = Date.now();
    const recent = (ip ? (resumes.get(ip) ?? []) : []).filter((x) => t - x < 10 * 60_000);
    if (ip && recent.length >= RESUMES_PER_IP) throw Object.assign(new Error("Too many orders handed back at once. Try again in a few minutes."), { status: 429, retryAfter: 60 });
    if (ip) resumes.set(ip, [...recent, t]);
  }
  let price: number | null = null;
  if (kind !== "dca") {
    price = await priceNow(mint.toBase58(), ip);
    if (!price && !resume) throw bad("This token has no market price yet, so a price order can't watch it. Try again once it trades more.");
  } else price = getPrice(mint.toBase58())?.usd ?? null;
  const c = checkOrder(kind, b, { price, decimals: parsed.decimals, resume, limits: LIMITS });
  // a handed-back order skips the new-order floors, but not by much: half of them, on what it really holds
  if (resume && tooSmallToResume(kind, held, BigInt(c.amount), price, parsed.decimals)) throw bad("What's left of this order is too small to run. Cancel it to remove its permission.");
  const now = Date.now();
  if (!resume) {
    // a new description for the same tokens, from the same visitor, replaces the older one not started yet
    const input = inputAccount(base).toBase58();
    for (const x of [...orders.values()]) {
      if (x.status === "pending" && ip && pendingIp.get(x.id) === ip && x.owner === base.owner && x.kind === kind && inputKeyOf(x) === input) {
        orders.delete(x.id);
        pendingIp.delete(x.id);
      }
    }
    const waiting = [...orders.values()].filter((x) => x.status === "pending");
    if (waiting.length >= PENDING_MAX) throw Object.assign(new Error("Orders are busy right now. Try again in a few minutes."), { status: 503, retryAfter: 60 });
    const mine = ip ? [...pendingIp.values()].filter((x) => x === ip).length : 0;
    if (mine >= PENDING_PER_IP) throw Object.assign(new Error("A few orders are already waiting to start. Finish those or wait a few minutes, then try again."), { status: 429, retryAfter: 60 });
  }
  const token = randomBytes(16).toString("hex");
  const o: Order = {
    id: randomBytes(12).toString("hex"),
    tokenHash: sha(token),
    secret,
    delegate: key.publicKey.toBase58(),
    ...base,
    decimals: parsed.decimals,
    amount: c.amount,
    spent: "0",
    slippageBps: c.slippageBps,
    created: now,
    expires: now + (c.days ?? 30) * 86_400_000,
    status: "pending",
    tries: 0,
    fills: [],
    lastPrice: price,
  };
  if (kind === "sell") Object.assign(o, { tpUsd: c.tpUsd, slUsd: c.slUsd, trailPct: c.trailPct, legs: c.legs, slSlippageBps: c.slSlippageBps });
  if (kind === "buy") o.buyBelowUsd = c.buyBelowUsd;
  if (kind === "dca" && c.dca) {
    const firstIn = Number(b.firstIn);
    const next = now + (firstIn >= 0 && firstIn <= c.dca.every ? firstIn * 1000 : 60_000);
    o.dca = { per: c.dca.per, every: c.dca.every, count: c.dca.count, next, done: 0, ...(c.dca.exact ? { exact: true } : {}) };
    o.expires = now + (c.dca.count * c.dca.every + 7 * 86_400) * 1000;
  }
  orders.set(o.id, o);
  if (resume) {
    try {
      goLive(o);
    } catch (e) {
      orders.delete(o.id);
      throw e;
    }
  } else if (ip) pendingIp.set(o.id, ip);
  save();
  return {
    id: o.id,
    token,
    delegate: o.delegate,
    price,
    status: o.status,
    amount: o.amount,
    slippageBps: o.slippageBps,
    ...(o.slSlippageBps != null ? { slSlippageBps: o.slSlippageBps } : {}),
    expires: o.expires,
  };
}

/** Starts an order: an older one on the same account is replaced (one approval per account). */
function goLive(o: Order) {
  const input = inputKeyOf(o);
  for (const other of orders.values()) {
    if (other.id === o.id || other.status !== "active" || !other.owner || other.owner !== o.owner) continue;
    if (inputKeyOf(other) !== input) continue;
    if (keeper.inFlight(other)) throw bad("Another order on these tokens is trading right now. Try again in a minute.", 409);
    keeper.finish(other, "cancelled", "Replaced by a newer order on the same tokens.");
  }
  o.status = "active";
  o.liveAt = Date.now();
  pendingIp.delete(o.id);
  keeper.live(o);
}

function authorized(id: string, token: string): Order {
  const o = orders.get(id);
  if (!o || o.tokenHash !== sha(String(token ?? ""))) throw bad("Unknown order.", 404);
  return o;
}

/** Step 2: once the approval is on-chain, the order goes live. Checked against the chain, not taken on trust. */
export async function activateOrder(id: string, token: string) {
  const o = authorized(id, token);
  if (o.status !== "pending") return { status: o.status };
  // the app may ask twice at once: one check is enough
  if (activating.has(id)) throw bad("The approval for this order isn't on-chain yet. Try again in a moment.", 409);
  // worked out while the order is surely pending: a cancel meanwhile drops the owner and token it needs
  const acc = inputAccount(o);
  activating.add(id);
  try {
    for (let i = 0; i < 8; i++) {
      if (o.status !== "pending") return { status: o.status };
      const a = await conn.getParsedAccountInfo(acc, "confirmed").catch(() => null);
      const info = (a?.value?.data as { parsed?: { info?: { owner?: string; delegate?: string; delegatedAmount?: { amount: string }; tokenAmount?: { amount: string } } } } | undefined)?.parsed?.info;
      if (o.status !== "pending") return { status: o.status };
      if (info && o.owner && info.owner === o.owner && info.delegate === o.delegate && BigInt(info.delegatedAmount?.amount ?? "0") >= BigInt(o.amount)) {
        // an approval needs no tokens behind it: the order's amount must really be in the account
        if (BigInt(info.tokenAmount?.amount ?? "0") < BigInt(o.amount))
          throw bad(o.kind === "sell" ? "The Vision wallet holds fewer tokens than this order. Cancel it and place it again." : "The Vision wallet holds less SOL than this order. Cancel it and place it again.", 409);
        goLive(o);
        return { status: o.status };
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    activating.delete(id);
  }
  throw bad("The approval for this order isn't on-chain yet. Try again in a moment.", 409);
}

/** Cancels the order. `settling` means a trade was already on its way: if it lands, the order shows as filled. */
export function cancelOrder(id: string, token: string) {
  const o = authorized(id, token);
  pendingIp.delete(id);
  return keeper.cancel(o);
}

/**
 * Changes a running order's terms without a new approval: prices, steps, trailing stop, price room,
 * end date, a lower amount, or pausing a DCA. Checked exactly like a new order.
 */
export async function updateOrder(id: string, token: string, b: Record<string, unknown>, ip?: string) {
  const o = authorized(id, token);
  if (o.status !== "active") throw bad("Only a running order can be changed.", 409);
  if (keeper.inFlight(o)) throw bad("A trade for this order is going through right now. Try again in a minute.", 409);
  const given = (k: string) => Object.hasOwn(b, k) && b[k] !== undefined;
  const priced = ["tpUsd", "slUsd", "legs", "buyBelowUsd", "amount", "trailPct"].some(given);
  const price = priced && o.kind !== "dca" ? await priceNow(o.mint!, ip) : (o.lastPrice ?? null);
  if (o.decimals == null) await fillDecimals();
  const c = checkOrder(o.kind, b, { price, decimals: o.decimals ?? 0, limits: LIMITS, prev: o });
  // the trade may have started while the price was checked
  if (keeper.inFlight(o) || o.status !== "active") throw bad("A trade for this order is going through right now. Try again in a minute.", 409);
  // a trade waiting its turn was for the old terms: the new ones are looked at on the next price
  keeper.dequeue(o);
  o.amount = c.amount;
  o.slippageBps = c.slippageBps;
  if (o.kind === "sell") {
    const hadTrail = o.trailPct;
    Object.assign(o, { tpUsd: c.tpUsd, slUsd: c.slUsd, trailPct: c.trailPct, legs: c.legs, slSlippageBps: c.slSlippageBps });
    // a new or changed trailing stop follows the price from now (an old peak could put it above today's price)
    if (c.trailPct && c.trailPct !== hadTrail) o.peak = price ?? o.lastPrice ?? undefined;
    if (!c.trailPct) delete o.peak;
  }
  if (o.kind === "buy") o.buyBelowUsd = c.buyBelowUsd;
  if (o.kind === "dca" && o.dca && c.dca) {
    o.dca.exact = c.dca.exact || undefined;
    if (given("paused")) {
      const pause = b.paused === true;
      const now = Date.now();
      if (pause && !o.dca.paused) o.dca.pausedAt = now;
      if (!pause && o.dca.paused) {
        // the time paused is added to the end date, so the buys still to come keep their time
        o.expires += now - (o.dca.pausedAt ?? now);
        o.dca.next = Math.max(o.dca.next, now + 60_000);
        delete o.dca.pausedAt;
      }
      o.dca.paused = pause || undefined;
    }
  } else if (c.days != null && given("days")) o.expires = Date.now() + Math.min(MAX_DAYS, c.days) * 86_400_000;
  // new terms start fresh: a waiting take-profit or an armed stop is looked at again on the next price
  keeper.freshTerms(o);
  o.error = null;
  keeper.live(o);
  return orderStatuses([o.id])[0];
}

/** How each order is doing (up to 200 per call). */
export function orderStatuses(ids: string[]) {
  const now = Date.now();
  // an order the server doesn't know may still come back from storage: "unknown" would get it handed back twice
  if (restoring() && ids.slice(0, 200).some((id) => !orders.has(id))) throw Object.assign(new Error("Orders are still loading. Try again in a moment."), { status: 503, retryAfter: 15 });
  return ids.slice(0, 200).map((id) => {
    const o = orders.get(id);
    if (!o) return { id, status: "unknown" as const };
    const live = o.status === "active";
    const priceOrder = live && o.kind !== "dca";
    const since = o.priceAt ?? o.liveAt ?? o.created;
    return {
      id,
      status: o.status,
      stage: live ? keeper.stageOf(o) : null,
      error: o.error ?? null,
      fills: o.fills,
      spent: o.spent ?? "0",
      amount: o.amount,
      lastPrice: o.lastPrice ?? null,
      priceAt: o.priceAt ?? null,
      // no fresh price for a while (the token may have stopped trading): shown as "price unavailable since"
      noPriceSince: priceOrder && now - since > UNPRICED_MS ? since : null,
      armed: !!o.armed,
      peak: o.peak ?? null,
      stop: live ? (keeper.stopOf(o) ?? null) : null,
      legs: o.legs?.map((l) => ({ tpUsd: l.tpUsd ?? null, amount: l.amount, filled: !!l.filled })) ?? null,
      dca: o.dca ? { done: o.dca.done, count: o.dca.count, next: o.dca.next, every: o.dca.every, paused: !!o.dca.paused } : null,
      slippageBps: o.slippageBps,
      // the stop-loss's price room: the order's own price room unless set apart
      slSlippageBps: o.kind === "sell" ? (o.slSlippageBps ?? o.slippageBps) : null,
      expires: o.expires,
      nextCheckAt: keeper.nextCheckAt(o),
      settling: !!o.pending,
    };
  });
}

/** For /api/health: totals only, never which tokens or wallets. */
export function ordersHealth() {
  return { ...keeper.stats(), workers: workers(), fastestCheckSec: Math.round(fastMs() / 1000), limits: orderLimits() };
}

// ─── the loop ───

let timer: NodeJS.Timeout | undefined;
let sweeper: NodeJS.Timeout | undefined;
let listening = false;
/** Loads the orders and runs them. Also after stopKeeper (another copy of the site ran them meanwhile): the stored list replaces what was held here. */
export async function startKeeper() {
  loadedAt = Date.now();
  keeper.reset();
  await load();
  if (!testPrices && !listening) {
    listening = true;
    onUpdate((mint, e) => keeper.onPrice(mint, e));
  }
  clearInterval(timer);
  clearInterval(sweeper);
  timer = setInterval(() => keeper.tick(), 1_000);
  timer.unref?.();
  sweeper = setInterval(() => {
    keeper.sweep();
    for (const id of pendingIp.keys()) if (orders.get(id)?.status !== "pending") pendingIp.delete(id);
    for (const [ip, ts] of resumes) if (ts.every((t) => Date.now() - t > 10 * 60_000)) resumes.delete(ip);
  }, 60_000);
  sweeper.unref?.();
  const active = [...orders.values()].filter((o) => o.status === "active");
  log(`orders: ${active.length} active order(s)${active.some((o) => o.pending) ? `, ${active.filter((o) => o.pending).length} trade(s) being settled first` : ""}`);
}

/**
 * For shutdown (or another copy of the site taking the orders over): starts no new trade, stops
 * watching prices, and waits for the trades being built and checked. Then saves what it holds,
 * unless `keep` is false (a start that failed half way: what it holds may be only part of the list).
 */
export async function stopKeeper(keep = true) {
  keeper.stop();
  clearInterval(timer);
  clearInterval(sweeper);
  await keeper.idle();
  if (keep) save();
}
