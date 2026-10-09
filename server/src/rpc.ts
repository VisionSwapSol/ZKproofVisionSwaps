import { VersionedTransaction } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { config } from "./config.ts";

/**
 * A narrow JSON-RPC gateway. Browsers can't use Solana's public endpoint
 * directly (it refuses web origins), and routing through here keeps users'
 * IP addresses away from RPC providers. Only the calls the app needs pass.
 *
 * The calls the app makes, and what each costs against the limits below: reading a wallet's
 * history or token accounts costs the RPC plan more than reading a balance.
 */
const COST: Record<string, number> = {
  getAccountInfo: 1,
  getMultipleAccounts: 1,
  getBalance: 1,
  getLatestBlockhash: 1,
  isBlockhashValid: 1,
  getSlot: 1,
  getBlockHeight: 1,
  getEpochInfo: 1,
  getVersion: 1,
  getGenesisHash: 1,
  getHealth: 1,
  getMinimumBalanceForRentExemption: 1,
  getFeeForMessage: 1,
  getSignatureStatuses: 1,
  getTokenAccountsByOwner: 3,
  getTokenAccountBalance: 1,
  getTransaction: 5,
  getSignaturesForAddress: 5,
  sendTransaction: 2,
  simulateTransaction: 3,
};
/** What one call costs: "was this address ever used" (its latest one or two transactions) is a light read. */
export function costOf(r: RpcReq): number {
  if (r.method === "getSignaturesForAddress") {
    const limit = (Array.isArray(r.params) ? (r.params[1] as { limit?: unknown } | undefined)?.limit : undefined) ?? 1000;
    if (typeof limit === "number" && limit <= 2) return 2;
  }
  return COST[r.method!] ?? 1;
}

/** the app never batches; a few calls in one request are allowed for other well-behaved clients */
const MAX_BATCH = 5;

/** sending a payment and watching it land: these may also draw on the share held back below */
const URGENT = new Set(["sendTransaction", "getSignatureStatuses", "getLatestBlockhash", "isBlockhashValid", "getBlockHeight"]);
/** part of everyone's allowance kept for URGENT calls, so idle tabs' polling can't crowd out a payment */
const RESERVE = 0.3;

/**
 * Each visitor has their own allowance too: a fair share of everyone's (the site's rate split
 * between the visitors active in the last few seconds), never more than 10 a second, and however
 * many are active never less than 4 (the app at its busiest uses about 3.3) unless the plan is that
 * small. It holds BURST seconds' worth. A few visitors, or scripts, can then never take everyone's.
 * That floor holds only while there is room to spare: once half of everyone's allowance is used,
 * each visitor gets just the even split, so many visitors at the floor can't empty it either.
 */
const KEY_MAX = 10;
const KEY_MIN = 4;
const BURST = 3;
/** a visitor counts as active this long after their last call */
const ACTIVE_MS = 10_000;
const MAX_KEYS = 50_000;

type RpcReq = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

/** visitors by rate key, in the order of their last call (oldest first) */
const keys = new Map<string, { at: number; tokens: number; reserve: number }>();
let bucket = { at: Date.now(), tokens: config.rpcProxyPerSecond * 2 };

/** How many visitors the gateway is keeping count of (for tests). */
export const keyCount = () => keys.size;

/**
 * Spends `cost` from the visitor's own allowance and from everyone's; false when either is out.
 * A call is let in while there is at least one unit left and may take the balance a little below
 * zero (refilled over the next moments), so a costly read is never starved by a stream of cheap ones.
 * Below the reserve only URGENT calls pass, each visitor taking at most a small part of it.
 */
export function admit(ip: string, cost: number, now = Date.now(), urgent = false): boolean {
  const rate = config.rpcProxyPerSecond;
  const floor = rate * 2 * RESERVE;
  bucket = { at: now, tokens: Math.min(rate * 2, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate) };
  // visitors quiet for a while are forgotten (their own allowance would be full again by then);
  // in last-call order this stops at the first one still active, so each call costs next to nothing
  for (const [k, v] of keys) {
    if (now - v.at < ACTIVE_MS && keys.size < MAX_KEYS) break;
    keys.delete(k);
  }
  const hi = Math.min(KEY_MAX, Math.max(1, rate * 0.4));
  const even = Math.min(hi, rate / (keys.size + (keys.has(ip) ? 0 : 1)));
  const share = bucket.tokens < rate ? even : Math.max(Math.min(hi, KEY_MIN), even);
  // never below one call's worth, so a visitor always gets a turn
  const most = Math.max(1, share * BURST);
  const reserveMax = Math.max(2, floor / 3);
  const prev = keys.get(ip);
  const dt = prev ? Math.max(0, now - prev.at) / 1000 : 0;
  const mine = prev
    ? { at: now, tokens: Math.min(most, prev.tokens + dt * share), reserve: Math.min(reserveMax, prev.reserve + (dt * reserveMax) / 4) }
    : { at: now, tokens: most, reserve: reserveMax };
  // re-inserted at the end: the map stays in last-call order
  keys.delete(ip);
  keys.set(ip, mine);
  if (mine.tokens < 1 || bucket.tokens < 1) return false;
  if (bucket.tokens - 1 < floor) {
    if (!urgent || mine.reserve < cost) return false;
    mine.reserve -= cost;
  }
  mine.tokens -= cost;
  bucket.tokens -= cost;
  return true;
}

const TRANSACT = sha256(new TextEncoder().encode("global:transact")).slice(0, 8);
export const UPDATE_REQUIRED = "VisionSwap was updated. Refresh the page to send this. Nothing was spent.";

/**
 * Set by the delivery ledger: told each pool payment the app sent itself through here (its signature,
 * its co-signing recipients, and the sender's rate key). Its recipients are watched only once it lands.
 */
export const rpcHooks: { selfSent?: (signature: string, recipients: string[], key: string) => void } = {};

/**
 * A payment sent through here by the app itself ("send it yourself"): every pool spend in it must
 * name a recipient that signs the transaction too. The app's own payments always do (the one-time
 * hop of a delivery co-signs, a join pays its own fee payer), while a page from before deliveries
 * (or one changed to skip them) would pay an exchange straight from the pool, a payment its scanner
 * can't see: those are told to refresh. `cosigners` are the recipients that sign without paying the
 * fee: a delivery's hop (or one of the sender's own wallets).
 */
export function inspectSend(r: RpcReq): { refusal: string | null; cosigners: string[] } {
  const out = { refusal: null as string | null, cosigners: [] as string[] };
  if (r.method !== "sendTransaction") return out;
  const unreadable = { refusal: "sendTransaction: not a transaction this gateway can read", cosigners: [] };
  const p = Array.isArray(r.params) ? r.params : [];
  const text = p[0];
  const encoding = (p[1] as { encoding?: unknown } | undefined)?.encoding ?? "base58";
  if (typeof text !== "string" || text.length > 8000 || (encoding !== "base58" && encoding !== "base64")) return unreadable;
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(encoding === "base64" ? Buffer.from(text, "base64") : bs58.decode(text));
  } catch {
    return unreadable;
  }
  const m = tx.message;
  const keys = m.staticAccountKeys;
  const signers = m.header.numRequiredSignatures;
  for (const ix of m.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program || !program.equals(config.programId) || ix.data.length < 8 || TRANSACT.some((b, i) => ix.data[i] !== b)) continue;
    // the recipient is the instruction's second account; a signer is among the first `signers` keys (never from a lookup table)
    const recipient = ix.accountKeyIndexes[1];
    if (recipient === undefined || recipient >= signers) return { refusal: UPDATE_REQUIRED, cosigners: [] };
    if (recipient > 0) out.cosigners.push(keys[recipient].toBase58());
  }
  return out;
}

/** Why a payment sent through here is refused (see inspectSend), or null when it may go. */
export const sendRefusal = (r: RpcReq): string | null => inspectSend(r).refusal;

/** Why a call is refused, or null when it may go. */
function refuse(r: RpcReq): string | null {
  const testFaucet = r.method === "requestAirdrop" && config.network !== "mainnet";
  if (typeof r.method !== "string" || (!Object.hasOwn(COST, r.method) && !testFaucet)) return `method not available: ${String(r.method).slice(0, 40)}`;
  const p = Array.isArray(r.params) ? r.params : [];
  // the app asks for a wallet's latest one or two transactions, never its whole history
  if (r.method === "getSignaturesForAddress") {
    const limit = (p[1] as { limit?: unknown } | undefined)?.limit;
    if (typeof limit !== "number" || limit < 1 || limit > 10) return "getSignaturesForAddress: limit must be 1 to 10";
  }
  if (r.method === "getMultipleAccounts" && (!Array.isArray(p[0]) || p[0].length > 100)) return "getMultipleAccounts: at most 100 accounts";
  if (r.method === "getSignatureStatuses" && (!Array.isArray(p[0]) || p[0].length > 256)) return "getSignatureStatuses: at most 256 signatures";
  return sendRefusal(r);
}

export async function proxyRpc(body: unknown, ip = ""): Promise<{ status: number; json: unknown; retryAfter?: number; sends?: boolean }> {
  const batch = Array.isArray(body) ? (body as RpcReq[]) : [body as RpcReq];
  if (batch.length === 0 || batch.length > MAX_BATCH) return { status: 400, json: { error: "bad request" } };
  let cost = 0;
  for (const r of batch) {
    const why = r && typeof r === "object" ? refuse(r) : "bad request";
    // an old page's payment: refused the way a node refuses a transaction, so the page shows the reason
    if (why === UPDATE_REQUIRED) return { status: 200, json: { jsonrpc: "2.0", id: r?.id ?? null, error: { code: -32002, message: why } } };
    if (why) return { status: 403, json: { jsonrpc: "2.0", id: r?.id ?? null, error: { code: -32601, message: why } } };
    cost += costOf(r);
  }
  if (!admit(ip, cost, Date.now(), batch.every((r) => URGENT.has(r.method!)))) {
    return { status: 429, retryAfter: 2, json: { jsonrpc: "2.0", id: batch[0]?.id ?? null, error: { code: 429, message: "The network is busy right now. Try again in a moment." } } };
  }
  const upstreams = [config.rpcUrl, config.rpcFallbackUrl].filter(Boolean) as string[];
  let last: { status: number; json: unknown } = { status: 502, json: { error: "upstream unavailable" } };
  for (const url of upstreams) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status === 429 || r.status >= 500) {
        last = { status: r.status, json: { error: `upstream ${r.status}` } };
        continue;
      }
      const json = await r.json();
      // a pool payment the app sent itself went through: its one-time sending address is watched from here on
      if (r.ok && rpcHooks.selfSent) {
        const answers = Array.isArray(json) ? json : [json];
        batch.forEach((c, i) => {
          const a = answers.find((x: { id?: unknown }) => x && x.id === c.id) ?? answers[i];
          if (c.method !== "sendTransaction" || !a || typeof (a as { result?: unknown }).result !== "string") return;
          const hops = inspectSend(c).cosigners;
          if (hops.length) rpcHooks.selfSent!((a as { result: string }).result, hops, ip);
        });
      }
      return { status: r.status, json, sends: batch.some((c) => c.method === "sendTransaction") };
    } catch {
      last = { status: 502, json: { error: "upstream unavailable" } };
    }
  }
  return last;
}
