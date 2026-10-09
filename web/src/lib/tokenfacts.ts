// Token facts with no network or browser parts, shared by tokenmeta.ts and the Sell form (and loadable in tests).

/** The token search reads at most 600 characters: 12 addresses and their commas stay under it. */
export const PER_ASK = 12;

/** Mints in groups small enough for one search each. */
export function askGroups(mints: string[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i < mints.length; i += PER_ASK) groups.push(mints.slice(i, i + PER_ASK));
  return groups;
}

/**
 * Tokens that look unsellable (a spam airdrop, a rug): no route even for a small slice of the
 * holding, seen again at least NO_ROUTE_GAP_MS later. A passing Jupiter or market hiccup then never
 * offers to burn a token that would have sold a minute later. Kept in memory for this page only.
 */
export const NO_ROUTE_GAP_MS = 120_000;
const noRoute = new Map<string, { first: number; last: number }>();

export function sawNoRoute(mint: string, now = Date.now()) {
  noRoute.set(mint, { first: noRoute.get(mint)?.first ?? now, last: now });
}

/** Any route at all (for some amount) means it can sell. */
export const sawRoute = (mint: string) => void noRoute.delete(mint);

export function stuckToken(mint: string): boolean {
  const r = noRoute.get(mint);
  return !!r && r.last - r.first >= NO_ROUTE_GAP_MS;
}

/** One probe quote per token at most this often, however often the sell form asks (typing can, per keystroke). */
export const PROBE_GAP_MS = 30_000;
const probed = new Map<string, number>();

/** How long since this token's last probe quote (ms), or null when one may go now (it then counts as sent). */
export function probeTooSoon(mint: string, now = Date.now()): number | null {
  const t = probed.get(mint);
  if (t != null && now - t < PROBE_GAP_MS) return Math.max(0, now - t);
  probed.set(mint, now);
  return null;
}
