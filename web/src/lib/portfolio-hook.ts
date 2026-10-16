import { engine, type State } from "./engine";
import { tokensAnswered, useTokenMeta } from "./tokenmeta";
import { portfolioCache, pricesKey, tokenPrices, type Portfolio, type PortfolioIn } from "./portfolio";

/**
 * Accounts whose notes have been read once this session. Until then the total shows as loading (never
 * a bare 0 while the pool is still being read); after that, a later sync shows the last figures known.
 * Not `synced < total`: a sync sets `synced = total` before the account's notes are read, which would
 * flash 0 on every unlock. Locking starts over, so the next unlock waits for its notes again.
 */
const ready = new Set<string>();
engine.subscribe(() => {
  if (!engine.get().unlocked) ready.clear();
});

function loadingOf(st: State): boolean {
  const fp = st.fingerprint;
  if (!fp) return true;
  if (!ready.has(fp) && st.unlocked && st.pool && engine.notesReady()) ready.add(fp);
  return !ready.has(fp);
}

/** The mints of the tokens the Vision wallets hold (amount above zero), the same list Home asks the token search about. */
export const heldMints = (st: State) => [...new Set(st.vision.flatMap((v) => v.tokens.filter((t) => t.amount > 0n).map((t) => t.mint)))];

type Meta = Record<string, { symbol?: string | null; icon?: string | null; price?: number | null }>;

/** What the total is worked out from: the engine's state, the price of SOL, and the token prices known. */
export function portfolioIn(st: State, meta: Meta, loading: boolean, asked = true): PortfolioIn {
  // what each wallet or deposit address moved into the pool and still shows, not read since (see portfolio.ts)
  const moved = engine.movedIn();
  return {
    loading,
    balance: st.balance,
    arriving: st.arriving,
    locked: st.locked,
    waiting: st.waiting,
    slot: st.slot,
    delaySlots: Number(st.pool?.depositDelaySlots ?? 0),
    msPerSlot: st.msPerSlot,
    deposits: st.deposits.map((d) => ({ lamports: d.lamports, held: d.held, index: d.index, moved: moved.deposit.get(d.index) })),
    minReceive: engine.minReceive(),
    returned: st.hops.filter((h) => h.kind === "returned").reduce((s, h) => s + h.lamports, 0n),
    vision: st.vision.map((v) => ({ ...v, moved: moved.vision.get(v.index) })),
    jobs: engine.jobsInFlight(),
    // test SOL has no dollar value: a total on localnet or devnet is in SOL only
    solUsd: st.pool?.network === "mainnet" ? st.solUsd : null,
    tokens: tokenPrices(meta, st.pool?.network === "mainnet"),
    asked,
  };
}

/** The last result, shared by every screen that asks with the same state and prices (see usePortfolio). */
const shared = portfolioCache<State>();

/**
 * The account's total, asset list and every dollar figure as shown (see portfolio.ts), worked out once
 * per state: Home, Wallets and the website's balance line all take the same result, so the same thing
 * never shows two different figures. From what this device already holds: the engine's state, the price
 * of SOL, and token prices from the token search. `fetch: false` only reads token prices another screen
 * already asked for (the website: nothing is looked up on unlock).
 */
export function usePortfolio(st: State, o: { fetch: boolean }): Portfolio {
  const mints = heldMints(st);
  const meta = useTokenMeta(mints, { fetch: o.fetch });
  const loading = loadingOf(st);
  // (whether every token held has been looked up: a token with no price may otherwise just not have been asked about)
  const asked = tokensAnswered(mints);
  return shared(st, `${pricesKey(meta)}#${asked ? 1 : 0}`, loading, () => portfolioIn(st, meta, loading, asked));
}
