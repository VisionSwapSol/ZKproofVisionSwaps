import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns";
import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import { isIP, type LookupFunction } from "node:net";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountInfo,
  type RpcResponseAndContext,
  type SimulatedTransactionResponse,
} from "@solana/web3.js";
import { config } from "./config.ts";
import { conn, poolConfig } from "./chain.ts";
import { jget, jpost, WAIT } from "./jupiter.ts";
import { gate } from "./gate.ts";
import { checkSwapTx } from "@visionswap/sdk";
import { priorityPrice, speedOf, type Speed } from "./priority.ts";
import { log } from "./log.ts";
import { classify } from "./keeper.ts";
import { parseKey } from "./keys.ts";

export { WAIT };
export type { Speed };

/**
 * Jupiter, proxied. The browser never talks to Jupiter (or to token-icon
 * hosts) directly, so neither learns the user's IP or what they look at.
 */

export const WSOL = "So11111111111111111111111111111111111111112";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

// ─── fee account ───

let feeAccountCache: { at: number; address: string | null } | null = null;

export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}

/** The treasury's wSOL account, where sell fees land. Null if it does not exist yet. */
export async function sellFeeAccount(): Promise<string | null> {
  if (config.sellFeeAccount) return config.sellFeeAccount;
  if (feeAccountCache && Date.now() - feeAccountCache.at < 300_000) return feeAccountCache.address;
  let address: string | null = null;
  try {
    const cfg = await poolConfig();
    const a = ata(cfg.treasury, new PublicKey(WSOL));
    address = (await conn.getAccountInfo(a, "confirmed")) ? a.toBase58() : null;
    if (!address) log("swap: the treasury has no wSOL account yet, so sells are not charged a fee");
  } catch {
    address = null;
  }
  feeAccountCache = { at: Date.now(), address };
  return address;
}

// ─── quotes and builds ───

export type Side = "buy" | "sell";

type V1Quote = {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  platformFee?: { amount: string; feeBps: number } | null;
  routePlan: { swapInfo: { label: string } }[];
};

export type QuoteOut = {
  inAmount: string;
  outAmount: string;
  minOut: string;
  priceImpactPct: number;
  route: string[];
  feeBps: number;
  feeAmount: string | null;
  /** the token's own transfer tax (Token-2022 transfer fee), in bps; Jupiter's amounts already include it */
  transferFeeBps?: number;
};

const taxCache = new Map<string, { at: number; bps: number }>();

/** A Token-2022 mint's current transfer fee in bps (0 for none). Cached for 10 minutes. */
export async function transferFeeBps(mint: string): Promise<number> {
  if (mint === WSOL) return 0;
  const hit = taxCache.get(mint);
  if (hit && Date.now() - hit.at < 600_000) return hit.bps;
  let bps = 0;
  try {
    const info = await conn.getParsedAccountInfo(new PublicKey(mint), "confirmed");
    const data = info.value?.data as { parsed?: { info?: { extensions?: { extension: string; state?: Record<string, unknown> }[] } } } | undefined;
    const ext = data?.parsed?.info?.extensions?.find((e) => e.extension === "transferFeeConfig")?.state as
      | { newerTransferFee?: { epoch: number; transferFeeBasisPoints: number }; olderTransferFee?: { epoch: number; transferFeeBasisPoints: number } }
      | undefined;
    if (ext) {
      const epoch = (await conn.getEpochInfo("confirmed")).epoch;
      const fee = ext.newerTransferFee && epoch >= ext.newerTransferFee.epoch ? ext.newerTransferFee : (ext.olderTransferFee ?? ext.newerTransferFee);
      bps = Math.max(0, Math.min(10_000, Number(fee?.transferFeeBasisPoints ?? 0)));
    }
  } catch {
    return hit?.bps ?? 0;
  }
  taxCache.set(mint, { at: Date.now(), bps });
  if (taxCache.size > 2000) taxCache.delete(taxCache.keys().next().value!);
  return bps;
}

const quoteCache = new Map<string, { at: number; q: V1Quote }>();
/** the same quote asked for twice at once is fetched once */
const quoteInflight = new Map<string, Promise<V1Quote>>();

function checkMint(m: unknown) {
  try {
    return parseKey(m).toBase58();
  } catch {
    throw Object.assign(new Error("Bad token address."), { status: 400 });
  }
}

async function v1Quote(inputMint: string, outputMint: string, amount: string, slippageBps: number, feeBps: number, forSwap = false, ip?: string, maxAccounts = 54) {
  const key = `${inputMint}|${outputMint}|${amount}|${slippageBps}|${feeBps}|${maxAccounts}`;
  const hit = quoteCache.get(key);
  if (hit && Date.now() - hit.at < (forSwap ? 4_000 : 10_000)) return hit.q;
  const flight = `${forSwap ? "x" : "q"}|${key}`;
  let p = quoteInflight.get(flight);
  if (!p) {
    p = fetchQuote(inputMint, outputMint, amount, slippageBps, feeBps, forSwap, ip, maxAccounts).finally(() => quoteInflight.delete(flight));
    quoteInflight.set(flight, p);
  }
  const q = await p;
  quoteCache.set(key, { at: Date.now(), q });
  if (quoteCache.size > 500) quoteCache.delete(quoteCache.keys().next().value!);
  return q;
}

async function fetchQuote(inputMint: string, outputMint: string, amount: string, slippageBps: number, feeBps: number, forSwap: boolean, ip?: string, maxAccounts = 54) {
  // a swap someone is making goes ahead of previews (the visitor still counts, so one can't hold the swap lane)
  const lane = forSwap ? ({ lane: "exec", maxWaitMs: WAIT.swap, ip } as const) : ({ lane: "interactive", maxWaitMs: WAIT.quote, ip } as const);
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: "true",
    maxAccounts: String(maxAccounts),
  });
  if (feeBps > 0) qs.set("platformFeeBps", String(feeBps));
  try {
    return await jget<V1Quote>(`/swap/v1/quote?${qs}`, lane);
  } catch (e) {
    // tokens paired only with an unusual asset (a tokenized stock, another launch) can need a wider search;
    // Jupiter only allows that with an API key
    if (!config.jupiterKey || !/no route/i.test((e as Error).message)) throw e;
    qs.set("restrictIntermediateTokens", "false");
    // the visitor already had their turn for this quote: the wider search isn't refused by their own cap
    return await jget<V1Quote>(`/swap/v1/quote?${qs}`, { ...lane, retry: true });
  }
}

function shapeQuote(q: V1Quote, feeBps: number): QuoteOut {
  return {
    inAmount: q.inAmount,
    outAmount: q.outAmount,
    minOut: q.otherAmountThreshold,
    priceImpactPct: Number(q.priceImpactPct) * 100,
    route: [...new Set(q.routePlan.map((r) => r.swapInfo.label))],
    feeBps,
    feeAmount: q.platformFee?.amount ?? null,
  };
}

async function feeFor(side: Side): Promise<{ bps: number; account: string | null }> {
  if (side !== "sell" || config.sellFeeBps <= 0) return { bps: 0, account: null };
  const account = await sellFeeAccount();
  return account ? { bps: config.sellFeeBps, account } : { bps: 0, account: null };
}

export async function quote(p: { inputMint: string; outputMint: string; amount: string; slippageBps: number; side: Side; ip?: string }) {
  const inputMint = checkMint(p.inputMint);
  const outputMint = checkMint(p.outputMint);
  if (!/^\d{1,20}$/.test(p.amount) || BigInt(p.amount) <= 0n) throw Object.assign(new Error("Bad amount."), { status: 400 });
  const fee = await feeFor(p.side);
  const [q, tax] = await Promise.all([
    v1Quote(inputMint, outputMint, p.amount, clampSlippage(p.slippageBps), fee.bps, false, p.ip),
    transferFeeBps(p.side === "buy" ? outputMint : inputMint),
  ]);
  return { ...shapeQuote(q, fee.bps), transferFeeBps: tax };
}

/** Price tolerance: 0.1% to 25% (thin, fast-moving launch tokens can need a lot of room). */
const clampSlippage = (s: number) => Math.max(10, Math.min(2500, Math.round(Number.isFinite(s) ? s : 100)));

type ApiIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
const toIx = (i: ApiIx) =>
  new TransactionInstruction({
    programId: new PublicKey(i.programId),
    keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
    data: Buffer.from(i.data, "base64"),
  });

async function loadLookupTables(addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return [];
  const infos = await conn.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)), "confirmed");
  return infos
    .map((info, i) =>
      info ? new AddressLookupTableAccount({ key: new PublicKey(addresses[i]), state: AddressLookupTableAccount.deserialize(info.data) }) : null,
    )
    .filter((x): x is AddressLookupTableAccount => !!x);
}

/** Route sizes to try, largest first: fewer accounts make a smaller transaction (and sometimes a slightly worse price). */
const ROUTE_ACCOUNTS = [54, 40, 30];

/** A transaction's size in bytes, or Infinity when it doesn't fit in one at all. */
function txSize(tx: VersionedTransaction): number {
  try {
    return tx.serialize().length;
  } catch {
    return Infinity;
  }
}

/**
 * Builds an unsigned v0 swap transaction for a Vision wallet (`taker`). The
 * browser checks it and signs it with the Vision wallet's key.
 */
export async function buildSwap(p: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  side: Side;
  taker: string;
  /** how hard to push the swap through a busy network */
  speed?: Speed;
  /** which try this is (0 for the first): each retry pays a higher priority fee, within the speed's cap */
  attempt?: number;
  /** who asked (the rate-limit key), so one visitor's builds can't take every swap turn */
  ip?: string;
}): Promise<{
  tx: string;
  lastValidBlockHeight: number;
  minContextSlot: number;
  quote: QuoteOut;
  shortfall: string;
  speed: Speed;
  priorityLamports: string;
}> {
  const inputMint = checkMint(p.inputMint);
  const outputMint = checkMint(p.outputMint);
  const taker = new PublicKey(checkMint(p.taker));
  const slippageBps = clampSlippage(p.slippageBps);
  const speed = speedOf(p.speed);
  const fee = await feeFor(p.side);

  for (const maxAccounts of ROUTE_ACCOUNTS) {
    const r = await swapRoute({ inputMint, outputMint, amount: p.amount, slippageBps, taker, fee, maxAccounts, ip: p.ip });
    const bh = await conn.getLatestBlockhashAndContext("confirmed");
    const compile = (units: number, microLamports: number) =>
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: taker,
          recentBlockhash: bh.value.blockhash,
          instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...r.ixs],
        }).compileToV0Message(r.tables),
      );
    // too big for one transaction: ask Jupiter for a route through fewer accounts
    if (txSize(compile(1_400_000, 1_000_000)) > 1232) {
      if (maxAccounts !== ROUTE_ACCOUNTS[ROUTE_ACCOUNTS.length - 1]) continue;
      break;
    }

    const simulate = async (units: number, microLamports: number): Promise<Sim | null> => {
      try {
        return (await conn.simulateTransaction(compile(units, microLamports), { sigVerify: false, replaceRecentBlockhash: true })).value;
      } catch {
        return null;
      }
    };
    // size the compute budget from a simulation without a priority fee
    const first = await simulate(1_400_000, 0);
    const units = first?.unitsConsumed ? Math.min(1_400_000, Math.ceil(first.unitsConsumed * 1.25) + 5_000) : 400_000;
    const prio = priorityPrice({ speed, attempt: p.attempt ?? 0, recent: await recentFees(r.ixs), units, base: config.priorityMicroLamports });
    const shortfall = await routeShortfall(first, prio.lamports, () => simulate(units, prio.microLamports), (s, fee) => lamportShortfall(taker, s.err, s.logs ?? [], fee));
    const tx = compile(units, prio.microLamports);
    // Jupiter's reply is checked the way the browser checks it: nothing may leave the taker but through the swap
    checkRoute(tx, taker, r.tables, outputMint);
    return {
      tx: Buffer.from(tx.serialize()).toString("base64"),
      lastValidBlockHeight: bh.value.lastValidBlockHeight,
      minContextSlot: bh.context.slot,
      quote: r.shaped,
      // SOL the taker lacks for this route (token accounts it has to open, fees): 0 when it has enough
      shortfall: shortfall.toString(),
      speed,
      priorityLamports: String(prio.lamports),
    };
  }
  throw Object.assign(new Error("This route is too large for one transaction. Try a smaller amount."), { status: 422 });
}

/** One route from Jupiter for `taker`: its instructions, lookup tables and quote. */
async function swapRoute(p: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  taker: PublicKey;
  fee: { bps: number; account: string | null };
  maxAccounts: number;
  ip?: string;
}): Promise<{ ixs: TransactionInstruction[]; tables: AddressLookupTableAccount[]; shaped: QuoteOut }> {
  const { inputMint, outputMint, slippageBps, taker, fee, ip } = p;
  const useV2 = config.jupiterSwapApi ? config.jupiterSwapApi === "v2" : !!config.jupiterKey;
  if (useV2) {
    const qs = new URLSearchParams({ inputMint, outputMint, amount: p.amount, taker: taker.toBase58(), slippageBps: String(slippageBps), maxAccounts: String(p.maxAccounts) });
    if (fee.bps > 0 && fee.account) {
      qs.set("platformFeeBps", String(fee.bps));
      qs.set("feeAccount", fee.account);
    }
    type Build = {
      inAmount: string;
      outAmount: string;
      otherAmountThreshold: string;
      priceImpactPct?: string;
      routePlan: { swapInfo: { label: string } }[];
      computeBudgetInstructions: ApiIx[];
      setupInstructions: ApiIx[];
      swapInstruction: ApiIx;
      cleanupInstruction: ApiIx | null;
      otherInstructions: ApiIx[];
      addressesByLookupTableAddress: Record<string, string[]> | null;
    };
    const b = await jget<Build>(`/swap/v2/build?${qs}`, { lane: "exec", maxWaitMs: WAIT.swap, timeoutMs: 15_000, ip });
    return {
      ixs: [...b.setupInstructions.map(toIx), toIx(b.swapInstruction), ...(b.cleanupInstruction ? [toIx(b.cleanupInstruction)] : []), ...b.otherInstructions.map(toIx)],
      tables: Object.entries(b.addressesByLookupTableAddress ?? {}).map(
        ([k, addrs]) =>
          new AddressLookupTableAccount({
            key: new PublicKey(k),
            state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs.map((a) => new PublicKey(a)) },
          }),
      ),
      // the build carries everything the receipt needs, so no second call to Jupiter
      shaped: {
        inAmount: b.inAmount,
        outAmount: b.outAmount,
        minOut: b.otherAmountThreshold,
        priceImpactPct: Number(b.priceImpactPct ?? 0) * 100,
        route: [...new Set(b.routePlan.map((r) => r.swapInfo.label))],
        feeBps: fee.bps,
        feeAmount: null,
      },
    };
  }
  const q = await v1Quote(inputMint, outputMint, p.amount, slippageBps, fee.bps, true, ip, p.maxAccounts);
  type SwapIxs = {
    setupInstructions: ApiIx[];
    swapInstruction: ApiIx;
    cleanupInstruction: ApiIx | null;
    otherInstructions: ApiIx[];
    addressLookupTableAddresses: string[];
  };
  const body: Record<string, unknown> = {
    quoteResponse: q,
    userPublicKey: taker.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: false,
  };
  if (fee.bps > 0 && fee.account) body.feeAccount = fee.account;
  const s = await jpost<SwapIxs>(`/swap/v1/swap-instructions`, body, { lane: "exec", maxWaitMs: WAIT.swap, ip });
  return {
    ixs: [...s.setupInstructions.map(toIx), toIx(s.swapInstruction), ...(s.cleanupInstruction ? [toIx(s.cleanupInstruction)] : []), ...s.otherInstructions.map(toIx)],
    tables: await loadLookupTables(s.addressLookupTableAddresses),
    shaped: shapeQuote(q, fee.bps),
  };
}

/** What the route's accounts paid per compute unit in recent blocks (nothing when the network can't say). */
async function recentFees(ixs: TransactionInstruction[]): Promise<number[]> {
  const writable = [...new Set(ixs.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())))].slice(0, 128);
  try {
    const r = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable.map((a) => new PublicKey(a)) });
    return r.map((x) => x.prioritizationFee);
  } catch {
    return [];
  }
}

/**
 * Refuses a route that could send the taker's funds anywhere but through the swap (the same check
 * the browser runs), or whose output wouldn't land in the taker's own token account.
 */
function checkRoute(tx: VersionedTransaction, taker: PublicKey, tables: AddressLookupTableAccount[], outputMint: string) {
  const bad = (why: string) => Object.assign(new Error(`The route Jupiter returned didn't pass the safety check (${why}). Please try again.`), { status: 422 });
  try {
    checkSwapTx(tx, taker);
  } catch (e) {
    throw bad((e as Error).message.replace(/\.$/, "").toLowerCase());
  }
  if (!routeLandsWith(tx, tables, taker, outputMint)) throw bad("the tokens would land somewhere else");
}

/** True when a Jupiter instruction in `tx` writes to `owner`'s own token account for `mint` (under either token program). */
export function routeLandsWith(tx: VersionedTransaction, tables: AddressLookupTableAccount[], owner: PublicKey, mint: string): boolean {
  const m = new PublicKey(mint);
  const mine = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((prog) => ataFor(owner, m, prog).toBase58());
  const msg = tx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
  return msg.compiledInstructions.some(
    (ix) => keys.get(ix.programIdIndex)?.toBase58() === JUPITER_PROGRAM && ix.accountKeyIndexes.some((k) => msg.isAccountWritable(k) && mine.includes(keys.get(k)?.toBase58() ?? "")),
  );
}

/**
 * How many lamports a failed simulation says the taker is missing. Routes through
 * other tokens open temporary token accounts (rent comes back when they close), and
 * Token-2022 accounts cost a little more, so the same sale can need more SOL than the
 * buy did.
 */
async function lamportShortfall(taker: PublicKey, err: unknown, logs: string[], fee: bigint): Promise<bigint> {
  const text = `${JSON.stringify(err)} ${logs.join(" ")}`;
  const m = /insufficient lamports (\d+), need (\d+)/i.exec(text);
  if (m) return BigInt(m[2]) - BigInt(m[1]);
  if (/InsufficientFundsForRent|insufficient funds for rent/i.test(text)) return BigInt(await conn.getMinimumBalanceForRentExemption(0));
  if (/InsufficientFundsForFee|AccountNotFound|no record of a prior credit/i.test(text)) {
    // it can't even pay the fee, so the network can't say what the route needs: ask for the fee and a safe amount, then measure again
    const have = BigInt(await conn.getBalance(taker, "confirmed"));
    const want = 5_000_000n + fee;
    return have < want ? want - have : 1_000_000n;
  }
  return 0n;
}

type Sim = { err: unknown; logs?: string[] | null; unitsConsumed?: number };

/**
 * SOL the taker lacks for a route, from its simulations (0 when it has enough). The first one runs
 * without a priority fee, but the network takes the whole fee, priority included, before the route
 * runs: so a route that fits only without it is simulated again at the real price.
 */
export async function routeShortfall(
  first: Sim | null,
  priorityLamports: number,
  again: () => Promise<Sim | null>,
  measure: (sim: Sim, fee: bigint) => Promise<bigint>,
): Promise<bigint> {
  const prio = BigInt(priorityLamports);
  const fee = 5_000n + prio;
  if (!first) return 0n;
  if (first.err) {
    // measured without the priority fee, which comes on top
    const short = await measure(first, 5_000n);
    if (short > 0n) return short + prio;
  }
  if (prio === 0n) return 0n;
  const sim = await again();
  return sim?.err ? measure(sim, fee) : 0n;
}

// ─── the order keeper's trades ───

const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const KEEPER_PROGRAMS = new Set([COMPUTE_BUDGET, SYSTEM_PROGRAM, TOKEN_PROGRAM.toBase58(), TOKEN_2022_PROGRAM.toBase58(), ATA_PROGRAM.toBase58(), JUPITER_PROGRAM]);

/** The associated token account of `owner` for `mint` under the given token program. */
export function ataFor(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), program.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}

/** An error the order keeper sorts by `code` (see keeper.ts): busy, price, slippage, route, account, fatal, transient, relayer. */
const keeperErr = (message: string, code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { code, ...extra });

type Facts = { decimals: number; feeBps: number; maxFee: bigint };
const factsCache = new Map<string, { at: number; f: Facts }>();

/** A mint's decimals and current transfer tax (bps and cap), for exact keeper amounts. Cached for 10 minutes. */
async function mintFacts(mint: PublicKey): Promise<Facts> {
  const hit = factsCache.get(mint.toBase58());
  if (hit && Date.now() - hit.at < 600_000) return hit.f;
  const info = await conn.getParsedAccountInfo(mint, "confirmed");
  const parsed = (info.value?.data as { parsed?: { info?: { decimals?: number; extensions?: { extension: string; state?: Record<string, unknown> }[] } } } | undefined)?.parsed?.info;
  if (parsed?.decimals == null) throw keeperErr("keeper: unknown mint", "fatal");
  type Fee = { epoch: number; transferFeeBasisPoints: number; maximumFee: number | string };
  const cfg = parsed.extensions?.find((e) => e.extension === "transferFeeConfig")?.state as { newerTransferFee?: Fee; olderTransferFee?: Fee } | undefined;
  let f: Facts = { decimals: parsed.decimals, feeBps: 0, maxFee: 0n };
  if (cfg) {
    const epoch = (await conn.getEpochInfo("confirmed")).epoch;
    const fee = cfg.newerTransferFee && epoch >= cfg.newerTransferFee.epoch ? cfg.newerTransferFee : (cfg.olderTransferFee ?? cfg.newerTransferFee);
    f = { decimals: parsed.decimals, feeBps: Number(fee?.transferFeeBasisPoints ?? 0), maxFee: BigInt(fee?.maximumFee ?? 0) };
  }
  factsCache.set(mint.toBase58(), { at: Date.now(), f });
  if (factsCache.size > 2000) factsCache.delete(factsCache.keys().next().value!);
  return f;
}

/** Token-2022's transfer fee on `amount`: ceil(amount × bps / 10000), at most the cap. */
const transferFee = (amount: bigint, bps: number, max: bigint) => {
  if (!bps) return 0n;
  const f = (amount * BigInt(bps) + 9999n) / 10000n;
  return f > max ? max : f;
};

const tokenIx = (program: PublicKey, keys: [PublicKey, boolean, boolean][], data: Buffer) =>
  new TransactionInstruction({ programId: program, keys: keys.map(([pubkey, isSigner, isWritable]) => ({ pubkey, isSigner, isWritable })), data });

/** A token account's balance and approval, from its raw data (Token and Token-2022 share this layout). */
export function tokenState(data: Buffer | null | undefined): { amount: bigint; delegate: string | null; delegated: bigint } | null {
  if (!data || data.length < 165) return null;
  return {
    amount: data.readBigUInt64LE(64),
    delegate: data.readUInt32LE(72) === 1 ? new PublicKey(data.subarray(76, 108)).toBase58() : null,
    delegated: data.readBigUInt64LE(121),
  };
}

/** What the price gate sees of a route: what would arrive, the least the chain allows, the input the route gets, and the output's transfer tax. */
export type KeeperQuote = { out: bigint; threshold: bigint; arrives: bigint; outFeeBps?: number };

type KeeperParams = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  authority: PublicKey;
  payer: PublicKey;
  inputAccount: PublicKey;
  inputProgram: PublicKey;
  destination: PublicKey;
  /** tests only: steps that run before the trade in the check-run (never part of the real trade) */
  simulateAfter?: TransactionInstruction[];
  /** how many accounts the route may use (fewer makes a smaller transaction) */
  maxAccounts?: number;
  /** the order's price gate: throws to refuse a route, or names the least output the chain must then guarantee */
  gate?: (q: KeeperQuote) => bigint | undefined;
  /** the priority fee (a stop-loss pays more to land sooner) */
  priorityMicroLamports?: number;
};
type KeeperBuilt = { tx: VersionedTransaction; outAmount: string; minOut: string; route: string[]; taxed: string; arrives: string; lastValidBlockHeight: number };

/** Until then, order trades use the two-call build (the one-call build gave a route an order can't use). */
let keeperV2Off = 0;

/**
 * One trade for an order, signed by the order's key, in a single transaction that either happens
 * whole or not at all:
 *   1. the order key, as the *approved delegate* of the Vision wallet's account, moves exactly the
 *      order's amount into a temporary account of its own (the token program allows nothing more);
 *   2. Jupiter swaps it from there, the output landing in the Vision wallet's own account;
 *   3. the temporary account (and any other account the route opened for the order key) is emptied
 *      of any transfer tax it holds and closed.
 * Between orders the tokens never leave the Vision wallet, so revoking the approval cancels for
 * good. Jupiter's part may only use known programs and no top-level token or SOL moves. Nothing is
 * signed until a simulation shows exactly the order's amount leaving, the output arriving in the
 * Vision wallet, and the relayer paying only the network fee.
 */
export async function keeperSwap(p: KeeperParams): Promise<KeeperBuilt> {
  const v2 = (config.jupiterSwapApi ? config.jupiterSwapApi === "v2" : !!config.jupiterKey) && Date.now() >= keeperV2Off;
  if (!v2) return keeperTrade(p, "v1");
  try {
    return await keeperTrade(p, "v2");
  } catch (e) {
    // a route problem may be the one-call build's own (including the build refusing what it was asked): the two-call build gets one try at it
    if (classify(e as Error & { status?: number }) !== "route") throw e;
    try {
      const r = await keeperTrade(p, "v1");
      keeperV2Off = Date.now() + 3600_000;
      log("swap: an order trade only worked with the two-call build; orders use it for the next hour");
      return r;
    } catch (e1) {
      // busy or a hiccup on the second try is that, not a missing route
      if (classify(e1 as Error & { status?: number }) !== "route") throw e1;
      throw e;
    }
  }
}

type Ixs = { setup: ApiIx[]; swap: ApiIx; cleanup: ApiIx | null; other: ApiIx[]; tables: () => Promise<AddressLookupTableAccount[]> };
type Route = { out: bigint; threshold: bigint; labels: string[]; ixs?: Ixs; quote?: V1Quote };

async function keeperTrade(p: KeeperParams, api: "v1" | "v2"): Promise<KeeperBuilt> {
  const mint = new PublicKey(p.inputMint);
  const facts = await mintFacts(mint);
  const amount = BigInt(p.amount);
  const tax = transferFee(amount, facts.feeBps, facts.maxFee);
  const arrives = amount - tax;
  if (arrives <= 0n) throw keeperErr("keeper: nothing left after the token's transfer tax", "fatal");
  // order sells pay the same optional sell fee as a sell from the app
  const fee = p.outputMint === WSOL ? await feeFor("sell") : { bps: 0, account: null };
  const maxAccounts = String(p.maxAccounts ?? 30);
  const lane = { lane: "exec", maxWaitMs: WAIT.keeper } as const;

  const fetchRoute = async (bps: number): Promise<Route> => {
    if (api === "v2") {
      const qs = new URLSearchParams({
        inputMint: p.inputMint,
        outputMint: p.outputMint,
        amount: arrives.toString(),
        taker: p.authority.toBase58(),
        payer: p.payer.toBase58(),
        slippageBps: String(bps),
        maxAccounts,
        wrapAndUnwrapSol: "false",
        destinationTokenAccount: p.destination.toBase58(),
      });
      if (fee.bps > 0 && fee.account) {
        qs.set("platformFeeBps", String(fee.bps));
        qs.set("feeAccount", fee.account);
      }
      type Build = {
        outAmount: string;
        otherAmountThreshold: string;
        routePlan: { swapInfo: { label: string } }[];
        setupInstructions: ApiIx[];
        swapInstruction: ApiIx;
        cleanupInstruction: ApiIx | null;
        otherInstructions: ApiIx[];
        addressesByLookupTableAddress: Record<string, string[]> | null;
      };
      const b = await jget<Build>(`/swap/v2/build?${qs}`, { ...lane, timeoutMs: 15_000 });
      const tables = Object.entries(b.addressesByLookupTableAddress ?? {}).map(
        ([k, addrs]) =>
          new AddressLookupTableAccount({
            key: new PublicKey(k),
            state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs.map((a) => new PublicKey(a)) },
          }),
      );
      return {
        out: BigInt(b.outAmount),
        threshold: BigInt(b.otherAmountThreshold),
        labels: [...new Set(b.routePlan.map((r) => r.swapInfo.label))],
        ixs: { setup: b.setupInstructions ?? [], swap: b.swapInstruction, cleanup: b.cleanupInstruction, other: b.otherInstructions ?? [], tables: async () => tables },
      };
    }
    const qs = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: arrives.toString(),
      slippageBps: String(bps),
      restrictIntermediateTokens: "true",
      maxAccounts,
    });
    if (fee.bps > 0 && fee.account) qs.set("platformFeeBps", String(fee.bps));
    const q = await jget<V1Quote>(`/swap/v1/quote?${qs}`, lane);
    return { out: BigInt(q.outAmount), threshold: BigInt(q.otherAmountThreshold), labels: [...new Set(q.routePlan.map((r) => r.swapInfo.label))], quote: q };
  };

  // a taxed output token arrives short by its tax: the price gate and the check-run both count it
  const outTax = await transferFeeBps(p.outputMint);
  // the price gate looks at the quote before anything else is spent on it
  let route = await fetchRoute(clampSlippage(p.slippageBps));
  const floor = p.gate?.({ out: route.out, threshold: route.threshold, arrives, outFeeBps: outTax });
  if (floor != null && route.threshold < floor) {
    // the price room would let it land below the order's price: narrow the room so the chain can't
    const tight = route.out > floor ? Number(((route.out - floor) * 10_000n) / route.out) : 0;
    if (tight < 10) throw keeperErr("Waiting for a better price: the route is right at the order's price.", "price");
    route = await fetchRoute(tight);
    p.gate?.({ out: route.out, threshold: route.threshold, arrives, outFeeBps: outTax });
    if (route.threshold < floor) throw keeperErr("Waiting for a better price: the route moved away from the order's price.", "price");
  }
  if (!route.ixs) {
    type SwapIxs = { setupInstructions: ApiIx[]; swapInstruction: ApiIx; cleanupInstruction: ApiIx | null; otherInstructions: ApiIx[]; addressLookupTableAddresses: string[] };
    const body: Record<string, unknown> = {
      quoteResponse: route.quote,
      userPublicKey: p.authority.toBase58(),
      payer: p.payer.toBase58(),
      wrapAndUnwrapSol: false,
      destinationTokenAccount: p.destination.toBase58(),
      dynamicComputeUnitLimit: false,
    };
    if (fee.bps > 0 && fee.account) body.feeAccount = fee.account;
    const s = await jpost<SwapIxs>(`/swap/v1/swap-instructions`, body, lane);
    route.ixs = { setup: s.setupInstructions, swap: s.swapInstruction, cleanup: s.cleanupInstruction, other: s.otherInstructions, tables: () => loadLookupTables(s.addressLookupTableAddresses) };
  }
  const r = route.ixs;
  const temp = ataFor(p.authority, mint, p.inputProgram);
  // our own opening of the temporary account comes first; Jupiter's duplicate is dropped
  const setup = r.setup.filter((i) => !(i.programId === ATA_PROGRAM.toBase58() && i.accounts.some((a) => a.pubkey === temp.toBase58())));
  const steps = [...setup, r.swap, ...(r.cleanup ? [r.cleanup] : []), ...r.other];
  for (const i of steps) {
    if (!KEEPER_PROGRAMS.has(i.programId)) throw keeperErr(`keeper: unexpected program ${i.programId}`, "route");
    if (i.programId === TOKEN_PROGRAM.toBase58() || i.programId === TOKEN_2022_PROGRAM.toBase58()) {
      // syncing a native account (17) is all a route may do with the token programs directly
      if (Buffer.from(i.data, "base64")[0] !== 17) throw keeperErr("keeper: a top-level token instruction in the route", "route");
    }
    if (i.programId === SYSTEM_PROGRAM) throw keeperErr("keeper: a top-level SOL transfer in the route", "route");
  }
  const SYS = new PublicKey(SYSTEM_PROGRAM);
  const amt = Buffer.alloc(8);
  amt.writeBigUInt64LE(amount);
  const before: TransactionInstruction[] = [
    // open the temporary account (the relayer pays the rent and gets it back below)
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: p.payer, isSigner: true, isWritable: true },
        { pubkey: temp, isSigner: false, isWritable: true },
        { pubkey: p.authority, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SYS, isSigner: false, isWritable: false },
        { pubkey: p.inputProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    }),
    // TransferChecked (12) as the approved delegate: exactly the order's amount, nothing more is allowed
    tokenIx(
      p.inputProgram,
      [
        [p.inputAccount, false, true],
        [mint, false, false],
        [temp, false, true],
        [p.authority, true, false],
      ],
      Buffer.concat([Buffer.from([12]), amt, Buffer.from([facts.decimals])]),
    ),
  ];
  const after: TransactionInstruction[] = [];
  // other accounts the route opens for the order key (in-between tokens) are closed again, so their
  // rent goes back to the relayer; one left holding anything makes the whole trade fail safely
  for (const i of setup) {
    if (i.programId !== ATA_PROGRAM.toBase58() || i.accounts.length < 6) continue;
    const [, account, owner, , , program] = i.accounts.map((a) => a.pubkey);
    if (owner !== p.authority.toBase58() || account === temp.toBase58()) continue;
    after.push(
      tokenIx(
        new PublicKey(program),
        [
          [new PublicKey(account), false, true],
          [p.payer, false, true],
          [p.authority, true, false],
        ],
        Buffer.from([9]),
      ),
    );
  }
  // a taxed token leaves its tax withheld in the temporary account, which can't close holding it:
  // hand it to the mint first (TransferFeeExtension 26 -> HarvestWithheldTokensToMint 4)
  if (tax > 0n) {
    after.push(
      tokenIx(
        p.inputProgram,
        [
          [mint, false, true],
          [temp, false, true],
        ],
        Buffer.from([26, 4]),
      ),
    );
  }
  // CloseAccount (9): the rent goes back to the relayer
  after.push(
    tokenIx(
      p.inputProgram,
      [
        [temp, false, true],
        [p.payer, false, true],
        [p.authority, true, false],
      ],
      Buffer.from([9]),
    ),
  );
  const ixs = [...before, ...steps.map(toIx), ...after];
  const tables = await r.tables();
  const bh = await conn.getLatestBlockhash("confirmed");
  const priority = Math.max(0, Math.round(p.priorityMicroLamports ?? config.priorityMicroLamports));
  const compile = (units: number, pre: TransactionInstruction[] = []) =>
    new VersionedTransaction(
      new TransactionMessage({
        payerKey: p.payer,
        recentBlockhash: bh.blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }), ...pre, ...ixs],
      }).compileToV0Message(tables),
    );

  // too big for one transaction: ask for a simpler route, once (measured first: the check-run can't take it either)
  let size = Infinity;
  try {
    size = compile(1_400_000).serialize().length;
  } catch {
    // web3 refuses to build a transaction over the limit
  }
  if (size > 1232) {
    if ((p.maxAccounts ?? 30) > 20) return keeperTrade({ ...p, maxAccounts: 20 }, api);
    throw keeperErr("keeper: route too large", "route");
  }

  // the check-run is required: no simulation, no trade
  const watch = [p.inputAccount, p.destination, p.payer];
  // the transfer out of the Vision wallet: after the two compute-budget steps, any test steps and the temporary account's opening
  const ownStep = 3 + (p.simulateAfter?.length ?? 0);
  let sim!: RpcResponseAndContext<SimulatedTransactionResponse>;
  for (let look = 1; ; look++) {
    const pre = p.simulateAfter
      ? null
      : await conn.getMultipleAccountsInfo(watch, "confirmed").catch((e) => {
          throw keeperErr(`keeper: couldn't read the accounts (${(e as Error).message.slice(0, 80)})`, "transient");
        });
    // the order's own wallet not ready for it (its tokens moved, its approval changed, an account closed): that
    // wallet's problem, never the token's, so it can't pause other people's orders on the token
    const own = pre && ownerProblem(pre, amount, p.authority.toBase58());
    if (own) throw keeperErr(own, "account");
    sim = await conn
      .simulateTransaction(compile(1_400_000, p.simulateAfter), { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: watch.map((a) => a.toBase58()) } })
      .catch((e) => {
        const msg = (e as Error).message;
        throw keeperErr(`keeper: couldn't check the trade (${msg.slice(0, 80)})`, /too large/i.test(msg) ? "route" : "transient");
      });
    if (sim.value.err) {
      // the wallet's own transfer failed although it was ready a moment before: look once more, in case it changed in
      // between (then it's that wallet's problem); failing again with the wallet still ready is the token's doing
      const at = (sim.value.err as { InstructionError?: [number, unknown] } | null)?.InstructionError?.[0];
      if (pre && at === ownStep && look < 2) continue;
      break;
    }
    const wrong = pre ? checkRun(pre, sim.value, amount, route.threshold, outTax, priority) : null;
    if (!wrong) break;
    // another trade or payment touched one of these accounts between the two reads: look once more before refusing
    if (look >= 2) throw keeperErr(wrong, "route");
  }
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const text = `${JSON.stringify(sim.value.err)} ${logs.join(" ")}`;
    const code = /"Custom":6001\b|0x1771|SlippageToleranceExceeded/i.test(text)
      ? "slippage"
      : /InsufficientFundsForFee|InsufficientFundsForRent|insufficient lamports/i.test(text)
        ? "relayer"
        : /AccountFrozen|account is frozen/i.test(text)
          ? "fatal"
          : "route";
    throw keeperErr(
      code === "relayer" ? "The order service is topping up its fees. Your order will run shortly." : `keeper: the trade wouldn't go through (${JSON.stringify(sim.value.err)})`,
      code,
      { logs },
    );
  }
  const units = sim.value.unitsConsumed ? Math.min(1_400_000, Math.ceil(sim.value.unitsConsumed * 1.25) + 5_000) : 400_000;
  const tx = compile(units);
  return {
    tx,
    outAmount: route.out.toString(),
    minOut: route.threshold.toString(),
    route: route.labels,
    taxed: tax.toString(),
    arrives: arrives.toString(),
    lastValidBlockHeight: bh.lastValidBlockHeight,
  };
}

/** Token-2022's "incoming transfers need a memo" setting on an account, which its owner can turn on (MemoTransfer, extension 8). */
function memoRequired(data: Buffer): boolean {
  // the account's own 165 bytes, its type byte, then the extensions: type (u16), length (u16), value
  for (let at = 166; at + 4 <= data.length; ) {
    const type = data.readUInt16LE(at);
    const len = data.readUInt16LE(at + 2);
    if (type === 8) return len >= 1 && data[at + 4] === 1;
    if (type === 0) break;
    at += 4 + len;
  }
  return false;
}

/**
 * What in the order's own Vision wallet stops its trade, from the accounts read just before the
 * check-run (input, output, relayer): the input account gone, holding or approving less than the
 * trade or approving another key, or the output account missing or turned to refuse transfers
 * without a memo. All of these are up to that wallet, never the token. Null when it's ready.
 */
export function ownerProblem(pre: (AccountInfo<Buffer> | null)[], amount: bigint, authority: string): string | null {
  const input = tokenState(pre[0]?.data);
  if (!input) return "keeper: the Vision wallet's account for this trade is gone";
  if (input.amount < amount) return "keeper: the Vision wallet holds less than this trade";
  if (input.delegate !== authority || input.delegated < amount) return "keeper: the Vision wallet's approval doesn't cover this trade";
  const out = pre[1]?.data;
  if (!out || !tokenState(out)) return "keeper: the Vision wallet's account for the output is missing";
  if (memoRequired(out)) return "keeper: the Vision wallet's account for the output only takes transfers with a memo";
  return null;
}

/**
 * What the check-run did, account by account, before anything is signed: exactly the order's amount
 * leaves the Vision wallet's account (and its approval), the output lands in the Vision wallet, and
 * the relayer pays the network fee and nothing else. Returns what's wrong, or null.
 */
function checkRun(pre: (AccountInfo<Buffer> | null)[], sim: SimulatedTransactionResponse, amount: bigint, threshold: bigint, outTax: number, priority: number): string | null {
  const post = sim.accounts ?? [];
  const was = tokenState(pre[0]?.data);
  const now = tokenState(post[0] ? Buffer.from(post[0].data[0], "base64") : null);
  if (!was || !now || was.amount - now.amount !== amount || was.delegated - now.delegated !== amount) return "keeper: the trade would move a different amount than the order's";
  const outBefore = tokenState(pre[1]?.data)?.amount ?? 0n;
  const outAfter = tokenState(post[1] ? Buffer.from(post[1].data[0], "base64") : null)?.amount;
  const least = threshold - (threshold * BigInt(outTax)) / 10_000n;
  if (outAfter == null || outAfter - outBefore < least || outAfter - outBefore <= 0n) return "keeper: the output wouldn't land in the Vision wallet";
  // some slack for the relayer's other payments meanwhile
  const spend = BigInt(pre[2]?.lamports ?? 0) - BigInt(post[2]?.lamports ?? 0);
  if (spend > 10_000n + BigInt(Math.ceil((1_400_000 * priority) / 1e6)) + 200_000n) return "keeper: the route would cost the relayer more than the fee";
  return null;
}

/** An executable quote for an order's whole amount, on the keeper's lane (for a token Jupiter stopped pricing). */
export async function keeperQuote(p: { inputMint: string; outputMint: string; amount: string }): Promise<KeeperQuote> {
  const facts = await mintFacts(new PublicKey(p.inputMint));
  const amount = BigInt(p.amount);
  const arrives = amount - transferFee(amount, facts.feeBps, facts.maxFee);
  if (arrives <= 0n) throw keeperErr("keeper: nothing left after the token's transfer tax", "fatal");
  const qs = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: arrives.toString(), slippageBps: "1500", restrictIntermediateTokens: "true", maxAccounts: "30" });
  const q = await jget<V1Quote>(`/swap/v1/quote?${qs}`, { lane: "keeper", maxWaitMs: WAIT.keeper });
  return { out: BigInt(q.outAmount), threshold: BigInt(q.otherAmountThreshold), arrives };
}

// ─── tokens, prices, icons ───

type TokenInfo = {
  id: string;
  name: string;
  symbol: string;
  icon?: string;
  decimals: number;
  usdPrice?: number;
  isVerified?: boolean;
  tokenProgram?: string;
  organicScoreLabel?: string;
  liquidity?: number;
  mcap?: number;
};

const tokCache = new Map<string, { at: number; v: TokenInfo[] }>();
/** the same search asked for twice at once is fetched once */
const tokInflight = new Map<string, Promise<TokenInfo[]>>();

function slim(t: TokenInfo) {
  return {
    mint: t.id,
    name: t.name,
    symbol: t.symbol,
    decimals: t.decimals,
    icon: t.icon ? iconLink(t.icon) : null,
    price: t.usdPrice ?? null,
    verified: !!t.isVerified,
    program: t.tokenProgram ?? null,
    organic: t.organicScoreLabel ?? null,
    liquidity: t.liquidity ?? null,
    mcap: t.mcap ?? null,
  };
}

export async function searchTokens(q: string, ip?: string) {
  const query = q.trim().slice(0, 600);
  if (!query) return [];
  const hit = tokCache.get("s:" + query);
  if (hit && Date.now() - hit.at < 300_000) return hit.v.map(slim);
  let p = tokInflight.get("s:" + query);
  if (!p) {
    p = jget<TokenInfo[]>(`/tokens/v2/search?query=${encodeURIComponent(query)}`, { lane: "interactive", maxWaitMs: WAIT.search, ip }).finally(() =>
      tokInflight.delete("s:" + query),
    );
    tokInflight.set("s:" + query, p);
  }
  const v = await p;
  tokCache.set("s:" + query, { at: Date.now(), v });
  if (tokCache.size > 2000) tokCache.delete(tokCache.keys().next().value!);
  return v.map(slim);
}

export async function topTokens() {
  const hit = tokCache.get("top");
  if (hit && Date.now() - hit.at < 600_000) return hit.v.map(slim);
  let p = tokInflight.get("top");
  if (!p) {
    p = jget<TokenInfo[]>(`/tokens/v2/toptrending/24h?limit=40`, { lane: "background", maxWaitMs: WAIT.search }).finally(() => tokInflight.delete("top"));
    tokInflight.set("top", p);
  }
  let v: TokenInfo[];
  try {
    v = await p;
  } catch (e) {
    // Jupiter busy: the last list beats none
    if (hit) return hit.v.map(slim);
    throw e;
  }
  const safe = v.filter((t) => t.isVerified || (t.organicScoreLabel && t.organicScoreLabel !== "low"));
  tokCache.set("top", { at: Date.now(), v: safe });
  return safe.map(slim);
}

// ─── icons ───
// Token icons come from wherever their creators host them. The server fetches them for the
// browser, which never contacts those hosts. Only links the server itself handed out are
// fetched, only from public addresses, only up to ICON_MAX bytes, and only real raster images
// are passed on: anything else (an SVG with a script in it, a web page) is refused.

const ICON_MAX = 2_000_000;
const ICON_CACHE_BYTES = 48 * 1024 * 1024;
const ICON_TTL = 24 * 3600_000;
const iconCache = new Map<string, { at: number; type: string; body: Buffer }>();
let iconCacheBytes = 0;
/** links that gave no icon, so they aren't fetched again for a while */
const iconMisses = new Map<string, number>();
const iconInflight = new Map<string, Promise<{ type: string; body: Buffer } | null>>();
const iconFetches = gate(6, 40, 8_000, "Icons are busy. Try again in a moment.");

/** Signs icon links, so /api/icon isn't an open proxy for any address someone makes up. */
const iconKey = createHash("sha256")
  .update("visionswap icon links\0")
  .update(config.relayer?.secretKey ?? config.guard?.secretKey ?? randomBytes(32))
  .digest();
const iconSig = (url: string) => createHmac("sha256", iconKey).update(url).digest("base64url").slice(0, 22);
const iconLink = (url: string) => `/api/icon?u=${encodeURIComponent(url)}&s=${iconSig(url)}`;

export function iconSigned(url: string, sig: string): boolean {
  const want = Buffer.from(iconSig(url));
  const got = Buffer.from(String(sig));
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Addresses no icon may point at: loopback, private networks, link-local and cloud metadata. */
function privateAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:");
}

/** A public-looking https address, or null. Checked again for every redirect. */
function safeIconUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || (u.port && u.port !== "443") || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return null;
  return u;
}

/**
 * The DNS lookup for icon hosts: refuses a host with any private address, and the addresses it
 * checked are the ones the connection uses, so a host can't switch addresses in between.
 */
const publicLookup = ((hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
  lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return cb(Object.assign(new Error("not a public address"), { code: "ENOTFOUND" }));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}) as unknown as LookupFunction;

/** What the bytes really are; only these image types are served. */
export function sniffImage(b: Buffer): string | null {
  const ascii = (from: number, to: number) => b.subarray(from, to).toString("latin1");
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return "image/gif";
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  return null;
}

/** An SVG logo. It is only ever served as a picture, never as a page (see the icon route). */
export function sniffSvg(b: Buffer): boolean {
  const head = b.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (!/^<(\?xml|svg|!--|!doctype svg)/.test(head)) return false;
  return head.includes("<svg") && !head.includes("<html");
}

/**
 * IPFS gateways that still hand out files directly: the protocol's own gateways (ipfs.io,
 * dweb.link and the like) now answer with a page asking for a service worker instead.
 */
const IPFS_GATEWAYS = ["https://gateway.pinata.cloud", "https://ipfs.filebase.io", "https://4everland.io"];

/** The /ipfs/<cid>/… path of an IPFS link, in either the path or the subdomain style; null for anything else. */
export function ipfsPath(url: string): string | null {
  try {
    const u = new URL(url);
    const p = u.pathname.match(/^\/ipfs\/([a-z0-9]{40,}(?:\/[^?#]*)?)$/i);
    if (p) return `/ipfs/${p[1]}`;
    const sub = u.hostname.match(/^([a-z0-9]{40,})\.ipfs\./i);
    if (sub) return `/ipfs/${sub[1]}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    /* not a link */
  }
  return null;
}

export async function icon(url: string): Promise<{ type: string; body: Buffer } | null> {
  const now = Date.now();
  const hit = iconCache.get(url);
  if (hit && now - hit.at < ICON_TTL) {
    iconCache.delete(url);
    iconCache.set(url, hit);
    return hit;
  }
  const miss = iconMisses.get(url);
  if (miss && now - miss < 10 * 60_000) return null;
  let p = iconInflight.get(url);
  if (!p) {
    p = iconFetches(async () => {
      // an IPFS file is the same on every gateway: ask ones that still serve files, the original last
      const path = ipfsPath(url);
      for (const u of path ? [...IPFS_GATEWAYS.map((g) => g + path), url] : [url]) {
        const got = await fetchIcon(u);
        if (got) return got;
      }
      return null;
    }).finally(() => iconInflight.delete(url));
    iconInflight.set(url, p);
  }
  const got = await p;
  if (!got) {
    iconMisses.delete(url);
    iconMisses.set(url, Date.now());
    if (iconMisses.size > 5000) iconMisses.delete(iconMisses.keys().next().value!);
    return null;
  }
  return remember(url, got);
}

function remember(url: string, v: { type: string; body: Buffer }) {
  const old = iconCache.get(url);
  if (old) {
    iconCache.delete(url);
    iconCacheBytes -= old.body.length;
  }
  const e = { at: Date.now(), ...v };
  iconCache.set(url, e);
  iconCacheBytes += e.body.length;
  // least recently used first, until the cache fits its byte budget again
  for (const [k, c] of iconCache) {
    if (iconCacheBytes <= ICON_CACHE_BYTES) break;
    iconCache.delete(k);
    iconCacheBytes -= c.body.length;
  }
  return e;
}

function get(u: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      { method: "GET", lookup: publicLookup, signal, headers: { accept: "image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml", "accept-encoding": "identity" } },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchIcon(url: string): Promise<{ type: string; body: Buffer } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    // IPFS and Arweave gateways answer with a redirect to a per-file address
    let next = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = safeIconUrl(next);
      if (!u) return null;
      const r = await get(u, ctl.signal);
      const status = r.statusCode ?? 0;
      const location = r.headers.location;
      if (status >= 300 && status < 400 && location) {
        r.destroy();
        next = new URL(location, u).href;
        continue;
      }
      const encoding = String(r.headers["content-encoding"] ?? "identity").toLowerCase();
      if (status !== 200 || encoding !== "identity" || Number(r.headers["content-length"] ?? 0) > ICON_MAX) {
        r.destroy();
        return null;
      }
      // count what actually arrives: the declared length can lie
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of r as AsyncIterable<Buffer>) {
        size += c.length;
        if (size > ICON_MAX) {
          r.destroy();
          return null;
        }
        chunks.push(c);
      }
      const body = Buffer.concat(chunks);
      const type = sniffImage(body) ?? (sniffSvg(body) ? "image/svg+xml" : null);
      return type ? { type, body } : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}
