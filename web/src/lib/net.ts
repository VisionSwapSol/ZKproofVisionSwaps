import { Connection, VersionedTransaction, type SignatureStatus, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { API } from "./config";
import { sleep } from "./poll";
import { normAmount } from "./amount";
import { chainError } from "./chainerr";

/**
 * Every network call goes to the VisionSwap server: RPC, Jupiter, token
 * icons. The browser never contacts a third party, so none of them learn the
 * visitor's IP address. The RPC provider still sees which addresses are looked
 * up, so the engine asks about as few as it can, one role at a time.
 */
const rpcUrl = () => `${API || location.origin}/api/rpc`;

let _conn: Connection | null = null;
export function conn(): Connection {
  if (!_conn) _conn = new Connection(rpcUrl(), { commitment: "confirmed", disableRetryOnRateLimit: false });
  return _conn;
}

export class ApiError extends Error {
  status: number;
  /** seconds the server asked us to wait before trying again (Retry-After), if it said */
  retryAfter: number | null;
  /** the rest of the server's answer (a `code`, say), when it sent one */
  data: Record<string, unknown> | null;
  constructor(message: string, status: number, retryAfter: number | null = null, data: Record<string, unknown> | null = null) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.data = data;
  }
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    ...init,
    method: init?.json !== undefined ? "POST" : (init?.method ?? "GET"),
    headers: init?.json !== undefined ? { "content-type": "application/json" } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await r.text();
  let j: unknown = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!r.ok) {
    const msg = (j as { error?: string } | null)?.error ?? `Request failed (${r.status})`;
    // a missing or odd header (a date, garbage) means "not said", never "retry now"
    const wait = Number(r.headers.get("retry-after"));
    const data = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
    throw new ApiError(msg, r.status, Number.isFinite(wait) && wait > 0 ? wait : null, data);
  }
  return j as T;
}

export async function apiBinary(path: string): Promise<{ data: Uint8Array; total: number }> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new ApiError(`Request failed (${r.status})`, r.status);
  const total = Number(r.headers.get("X-Total") ?? "0");
  return { data: new Uint8Array(await r.arrayBuffer()), total };
}

export { chainError, failedProgram, setPoolProgram } from "./chainerr";

/**
 * A transaction whose fate is still unknown: it may yet land. Callers must not send a
 * replacement (a second buy, a second sale) until it is known not to have landed.
 */
export class StillPending extends Error {
  readonly pending = true;
  constructor(
    message: string,
    readonly signature: string,
  ) {
    super(message);
  }
}

/** The first signature of a signed transaction: its id on-chain, known before it is sent. */
export function signatureOf(tx: Transaction | VersionedTransaction): string {
  const s = tx instanceof VersionedTransaction ? tx.signatures[0] : tx.signature;
  if (!s) throw new Error("The transaction isn't signed.");
  return bs58.encode(s);
}

/** True when the network certainly refused the transaction before it could run (it was never sent on). */
function refusedForSure(e: unknown): boolean {
  const err = e as { message?: string; logs?: string[] };
  const m = err?.message ?? "";
  return (
    (Array.isArray(err?.logs) && err.logs.length > 0) ||
    /simulation failed|custom program error|insufficient (funds|lamports)|blockhash not found|no record of a prior credit|invalid (account|transaction)|signature verification/i.test(m)
  );
}

/**
 * When a transaction can no longer land: the last block height its blockhash is good for, and the
 * slot it was fetched at (a node that hasn't reached that slot can't answer for it).
 */
export type Expiry = { lastValidBlockHeight: number; minContextSlot?: number };

/**
 * Sends a signed transaction and waits until it has certainly landed or certainly not. A
 * reply that goes missing (a timeout, a dropped connection) is never taken as a failure:
 * the transaction may already be on its way, so its status is checked, and it is sent
 * again while its blockhash is still valid, until the network either confirms it or
 * lets the blockhash expire. Pass `expiry` when it is known (a swap's build says it).
 */
export async function sendAndConfirm(tx: Transaction | VersionedTransaction, label = "transaction", expiry?: Expiry): Promise<string> {
  const raw = tx.serialize();
  const sig = signatureOf(tx);
  const blockhash = tx instanceof VersionedTransaction ? tx.message.recentBlockhash : tx.recentBlockhash!;
  try {
    await conn().sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } catch (e) {
    if (/already been processed|AlreadyProcessed/i.test((e as Error)?.message ?? "")) {
      // it landed already (an earlier send got through)
    } else if (refusedForSure(e)) {
      throw chainError(e);
    }
    // otherwise the reply was lost: find out what happened before anyone tries again
  }
  await landing(sig, raw, blockhash, label, expiry);
  return sig;
}

// Each transaction is looked up on its own: two of them in one request would tie their addresses together.
const statusNow = (sig: string): Promise<SignatureStatus | null> => conn().getSignatureStatuses([sig]).then((r) => r.value[0]);
const statusEver = (sig: string): Promise<SignatureStatus | null> =>
  conn().getSignatureStatuses([sig], { searchTransactionHistory: true }).then((r) => r.value[0]);

/** Quick looks while a transaction normally lands, then slower ones. */
const pollGap = (age: number) => (age < 10_000 ? 800 : age < 40_000 ? 1500 : 2500);

/** A blockhash is good for 150 blocks, which never pass in less than about a minute. */
const BLOCKHASH_MIN_LIFE_MS = 60_000;

/**
 * Whether the blockhash has certainly expired. With the exact expiry, only a node at least as far
 * along as the build may answer, and a node that is behind reports a lower height, never a higher
 * one. Without it, "not valid" from a node that may be behind means little until the blockhash is
 * at least a minute old.
 */
async function blockhashExpired(blockhash: string, expiry: Expiry | undefined, sentAt: number): Promise<boolean> {
  if (expiry) {
    const h = await conn()
      .getBlockHeight({ commitment: "confirmed", minContextSlot: expiry.minContextSlot })
      .catch(() => null);
    return h != null && h > expiry.lastValidBlockHeight;
  }
  if (Date.now() - sentAt < BLOCKHASH_MIN_LIFE_MS) return false;
  return conn()
    .isBlockhashValid(blockhash, { commitment: "confirmed" })
    .then((r) => !r.value)
    .catch(() => false);
}

/**
 * Follows the blockhash's expiry: it counts as expired only after two readings a few seconds apart
 * agree, and even then the transaction gets one last look (history included) before anyone is told
 * it didn't go through. Returns the final status when it found one, null when it is certainly gone,
 * undefined while that isn't certain yet.
 */
function expiryWatch(sig: string, blockhash: string, expiry: Expiry | undefined, sentAt: number) {
  let lastCheck = Date.now();
  let seen = 0;
  return async (): Promise<SignatureStatus | null | undefined> => {
    if (Date.now() - lastCheck < 4000) return undefined;
    lastCheck = Date.now();
    if (!(await blockhashExpired(blockhash, expiry, sentAt))) {
      seen = 0;
      return undefined;
    }
    if (++seen < 2) return undefined;
    await sleep(2500);
    // a failed lookup stays undefined so it can't be mistaken for "not found" (null)
    return statusEver(sig).catch(() => undefined);
  };
}

const dropped = (label: string) => new Error(`The ${label} didn't go through: the network dropped it before it ran. Nothing was spent. Please try again.`);

async function landing(sig: string, raw: Uint8Array, blockhash: string, label: string, expiry?: Expiry): Promise<void> {
  const started = Date.now();
  let lastSend = Date.now();
  const expired = expiryWatch(sig, blockhash, expiry, started);
  for (;;) {
    const st = await statusNow(sig).catch(() => null);
    if (st?.err) throw await onChainFailure(sig, label);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
    // send it again now and then: a busy network can drop it on the way to the leader
    if (!st && Date.now() - lastSend > (Date.now() - started < 15_000 ? 3000 : 6000)) {
      lastSend = Date.now();
      void conn()
        .sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })
        .catch(() => {});
    }
    if (!st) {
      const last = await expired();
      if (last?.err) throw await onChainFailure(sig, label);
      if (last?.confirmationStatus) return;
      // only a lookup that answered "not found" is certain; a failed lookup is asked again
      if (last === null) throw dropped(label);
    }
    if (Date.now() - started > 150_000) {
      throw new StillPending(`The ${label} is taking longer than usual. It may still go through: check your activity in a minute before trying again.`, sig);
    }
    await sleep(pollGap(Date.now() - started));
  }
}

/**
 * What became of a transaction sent earlier: "landed", "failed" (it ran and was refused), "dropped"
 * (its blockhash has expired and it is nowhere), or "unknown" while that can't be said for sure.
 */
export async function signatureState(sig: string, lastValidBlockHeight?: number): Promise<"landed" | "failed" | "dropped" | "unknown"> {
  // the height first: if a node has passed the expiry, a status lookup made after it can be trusted to be final
  const h = lastValidBlockHeight == null ? null : await conn().getBlockHeight("confirmed").catch(() => null);
  const st = await statusEver(sig).catch(() => undefined);
  if (st === undefined) return "unknown";
  if (st?.err) return "failed";
  if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return "landed";
  if (st || h == null || lastValidBlockHeight == null) return "unknown";
  return h > lastValidBlockHeight ? "dropped" : "unknown";
}

async function onChainFailure(sig: string, label: string): Promise<Error> {
  // say why, from the transaction's own logs, when the network still has them
  const tx = await conn()
    .getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 1 })
    .catch(() => null);
  const logs = tx?.meta?.logMessages ?? [];
  const why = logs.length ? chainError({ message: "", logs }) : null;
  return Object.assign(new Error(why && !/^The network refused/.test(why.message) ? why.message : `The ${label} failed on-chain. Nothing moved.`), { logs });
}

/**
 * Waits for a transaction someone else sent (a wallet's own send). A poll that fails is not
 * a failure: only an on-chain error, or a blockhash that has expired with the transaction
 * nowhere to be found, says it didn't go through. Anything less certain is StillPending.
 */
export async function confirmSig(sig: string, label = "transaction", timeoutMs = 90_000, blockhash?: string, expiry?: Expiry): Promise<void> {
  const started = Date.now();
  const expired = blockhash || expiry ? expiryWatch(sig, blockhash ?? "", expiry, started) : null;
  while (Date.now() - started < timeoutMs) {
    // a failed look is not an answer: keep looking until the time is up
    const st = await statusNow(sig).catch(() => null);
    if (st?.err) throw await onChainFailure(sig, label);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return;
    if (expired && !st) {
      const last = await expired();
      if (last?.err) throw await onChainFailure(sig, label);
      if (last?.confirmationStatus) return;
      if (last === null) throw dropped(label);
    }
    await sleep(pollGap(Date.now() - started));
  }
  throw new StillPending(`The ${label} is taking longer than usual. It may still go through: check again in a minute before trying again.`, sig);
}

const cluster = (network: string) =>
  network === "mainnet" ? "" : network === "devnet" ? "?cluster=devnet" : "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899";

export function explorer(sig: string, network: string): string {
  return `https://solscan.io/tx/${sig}${cluster(network)}`;
}

export function explorerAccount(address: string, network: string): string {
  return `https://solscan.io/account/${address}${cluster(network)}`;
}

export function short(a: string, n = 4): string {
  return a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-n)}` : a;
}

export function sol(lamports: bigint | number, digits = 4): string {
  const n = typeof lamports === "bigint" ? Number(lamports) / 1e9 : lamports / 1e9;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** "1.25" (or "1,25") -> 1250000000n; null when the text is not a valid SOL amount. */
export function parseSol(s: string): bigint | null {
  return parseUnits(s, 9);
}

export function parseUnits(s: string, decimals: number): bigint | null {
  const t = normAmount(s);
  const re = new RegExp(`^\\d*(\\.\\d{0,${decimals}})?$`);
  if (t == null || !re.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function formatUnits(v: bigint, decimals: number, digits = 6): string {
  const neg = v < 0n;
  const x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = (x % base).toString().padStart(decimals, "0").slice(0, Math.min(digits, decimals)).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}
