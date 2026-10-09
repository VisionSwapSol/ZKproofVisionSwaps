import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

/**
 * Sanctions screening for deposits, withdrawal recipients and swap wallets.
 *
 * Source 1 (always on): every Solana address on OFAC's SDN list. Refreshed
 * every 6 hours from the nightly 0xB10C mirror of OFAC's own files, cached to
 * disk, and seeded with the addresses listed on 2026-10-01 so screening works
 * even when the mirror is unreachable.
 *
 * Source 2 (optional): Range's Address Risk Score when RANGE_API_KEY is set.
 */

const SEED_OFAC_SOL = [
  "42RLPACwZPx3vYYmxSueqsogfynBDqXK298EDsNoyoHi",
  "6wjqWWra8ombzaw6VHrG5xpQ972jCYF6bbHiFCbWmr4U",
  "Fc1EwQUZyTEagaDvA1utHXCcZNyG1x2PLt2DfNu1cJdH",
  "FuCC7GoYwt5TsNTjWL23Xx9UKCvC18chjMEFPL3vJDCC",
];
const MIRROR =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_SOL.json";
const cacheFile = join(config.dataDir, "ofac_sol.json");

let ofac = new Set<string>(SEED_OFAC_SOL);
let ofacUpdated = 0;
/** Range's answers for an hour, oldest first (each answer is re-inserted), at most VENDOR_MAX of them */
const vendorCache = new Map<string, { at: number; flagged: boolean }>();
const VENDOR_TTL = 3600_000;
const VENDOR_MAX = 20_000;

/** Remembers one answer and drops expired ones from the front, and the oldest past the cap. */
export function rememberVendor(cache: Map<string, { at: number; flagged: boolean }>, address: string, flagged: boolean, now = Date.now()) {
  cache.delete(address);
  cache.set(address, { at: now, flagged });
  for (const [k, v] of cache) {
    if (cache.size <= VENDOR_MAX && now - v.at < VENDOR_TTL) break;
    cache.delete(k);
  }
}

function loadCache() {
  try {
    if (!existsSync(cacheFile)) return;
    const list = JSON.parse(readFileSync(cacheFile, "utf8")) as string[];
    if (Array.isArray(list)) for (const a of list) ofac.add(a);
  } catch {
    /* keep the seed list */
  }
}

export async function refreshOfac(): Promise<number> {
  try {
    const r = await fetch(MIRROR, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return ofac.size;
    const list = (await r.json()) as unknown;
    if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return ofac.size;
    ofac = new Set<string>([...SEED_OFAC_SOL, ...(list as string[])]);
    writeFileSync(cacheFile, JSON.stringify([...ofac]));
    ofacUpdated = Date.now();
  } catch {
    /* network trouble: keep the last good list */
  }
  return ofac.size;
}

let firstRefresh: Promise<number> = Promise.resolve(0);
/** Settles once the first sanctions list download after start has finished (or failed). */
export const ofacLoaded = () => firstRefresh;

export function startScreening() {
  loadCache();
  firstRefresh = refreshOfac();
  setInterval(() => void refreshOfac(), 6 * 3600_000).unref();
}

/**
 * Range Address Risk Score (1-10, sanctions and blacklists included). Range's
 * own guidance for privacy pools: reject at 7 and above. When a key is set
 * the check fails closed: if Range cannot answer, the deposit waits.
 */
async function rangeCheck(address: string): Promise<"clean" | "flagged" | "unknown"> {
  if (!config.rangeKey) return "clean";
  const hit = vendorCache.get(address);
  if (hit && Date.now() - hit.at < VENDOR_TTL) return hit.flagged ? "flagged" : "clean";
  try {
    const q = new URLSearchParams({ address, network: "solana" });
    const r = await fetch(`https://api.range.org/v1/risk/address?${q}`, {
      headers: { Authorization: `Bearer ${config.rangeKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return "unknown";
    const j = (await r.json()) as { riskScore?: number };
    if (typeof j.riskScore !== "number") return "unknown";
    const flagged = j.riskScore >= 7;
    rememberVendor(vendorCache, address, flagged);
    return flagged ? "flagged" : "clean";
  } catch {
    return "unknown";
  }
}

export type ScreenResult = { ok: true } | { ok: false; reason: "sanctions" | "risk" | "unavailable" };

const blockedByOperator = new Set(config.blockedAddresses);

export async function screen(address: string): Promise<ScreenResult> {
  if (ofac.has(address) || blockedByOperator.has(address)) return { ok: false, reason: "sanctions" };
  const v = await rangeCheck(address);
  if (v === "flagged") return { ok: false, reason: "risk" };
  if (v === "unknown") return { ok: false, reason: "unavailable" };
  return { ok: true };
}

/** The sanctions list and the operator's own list only: nothing leaves this server. */
export function screenLocal(address: string): ScreenResult {
  return ofac.has(address) || blockedByOperator.has(address) ? { ok: false, reason: "sanctions" } : { ok: true };
}

export function screeningStatus() {
  return { ofacAddresses: ofac.size, ofacUpdatedAt: ofacUpdated || null, vendor: config.rangeKey ? "range" : null };
}
