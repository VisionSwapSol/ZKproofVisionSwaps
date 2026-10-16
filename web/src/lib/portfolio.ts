// Everything the account holds, counted once, as one total and one list: the private balance, SOL
// joining it or on its way, the Vision wallets' SOL and their tokens at the prices already known.
// Pure (no React, no engine), so the tests can pin every figure down.
//
// Where each lamport is counted:
// - `balance` already includes `arriving` (change from this device's spends) and `locked` (held for
//   scheduled payments): neither is added again.
// - The waiting room, SOL at a deposit address (moving in, a small leftover, or held for its owner),
//   SOL that came back to a sending address, and the Vision wallets' SOL are each added once.
// - A payment to one of this account's Vision wallets (scheduled, or sent now) is counted inside
//   `balance` while its notes are unspent (`held`); once they're spent and before its wallet is read
//   again, its amount is added on its own (`landing`). A payment to anyone else is never added: held,
//   it is in `balance`; gone, it is theirs.
// - A Vision wallet (or a deposit address) that moved SOL into the pool is read again only once the
//   waiting room shows the deposit (read first, the total would dip by it, to 0 for an account with
//   nothing else, while the server's index catches up). Until that read the wallet still shows the SOL,
//   so its deposit (the same source and amount, see `moved`) is left out of the waiting room meanwhile:
//   the SOL is counted once where it was, then once in the waiting room, never in both.
// - Not counted: a sending address with a delivery still to finish (owed to its recipient) or one
//   whose history can't be told, tokens sent to a deposit address by mistake (never looked up), and
//   repeated deposits (never used by the app).
//
// One short overlap is known and accepted, never patched over with guesses: for the length of one
// waiting-room read after a sync, a deposit that just joined can be counted in both the waiting room and
// the balance. Nothing can show 0 while money is on its way.
import { slotMinutes } from "./slottime";
import { walletsName } from "./vwallets";
import { fmtUsd, solStr } from "./money";

export type PortfolioIn = {
  /** the first read of the pool hasn't finished (see portfolio-hook.ts) */
  loading: boolean;
  balance: bigint;
  arriving: bigint;
  locked: bigint;
  /** `vision` / `deposit`: the Vision wallet or deposit address that made the deposit (see `moved`) */
  waiting: { amount: bigint; readyAt: bigint | null; vision?: number | null; deposit?: number | null }[];
  slot: number;
  delaySlots: number;
  msPerSlot: number;
  /** `moved`: what the address moved into the pool since it was last read (it still shows it), each deposit's amount */
  deposits: { lamports: bigint; held: string | null; index?: number; moved?: bigint[] }[];
  minReceive: bigint | null;
  /** the SOL that came back to this account's sending addresses (hops of kind "returned") */
  returned: bigint;
  /** `moved`: what the wallet moved into the pool since it was last read (it still shows it), each deposit's amount */
  vision: { index: number; lamports: bigint; tokens: { mint: string; amount: bigint; decimals: number }[]; moved?: bigint[] }[];
  jobs: { index: number | null; amount: bigint; latest: number; held: boolean; landing: boolean }[];
  /** null on any network other than mainnet: test SOL has no dollar value */
  solUsd: number | null;
  /**
   * Names and prices known for the tokens held. A mint missing here, or with price null, has no price
   * yet: the token search can't tell "not asked yet" from "doesn't know it", so neither does this.
   */
  tokens: Record<string, { symbol: string | null; icon: string | null; price: number | null }>;
  /**
   * Whether the token search has answered for every token held, on this page (prices are looked up only where
   * tokens are shown, never on opening the page): only then is a token with no price one that has none yet, rather
   * than one not asked about. Taken as answered when left out.
   */
  asked?: boolean;
};

/** Money on its way, for the lines under the total. */
export type Flight =
  /** into the private balance through the waiting room; `minutes` null: any moment now */
  | { kind: "joining"; sol: bigint; minutes: number | null; count: number; progress: number }
  /** scheduled to this account's own Vision wallets (still in the balance) */
  | { kind: "own"; sol: bigint; indexes: number[]; by: number }
  /** went out to them, and their wallets haven't been read yet */
  | { kind: "landing"; sol: bigint; indexes: number[] }
  /** scheduled to someone else (still in the balance) */
  | { kind: "out"; sol: bigint; count: number; by: number }
  /** at a deposit address, moving into the pool by itself */
  | { kind: "address"; sol: bigint };

export type Asset =
  | { key: "private"; sol: bigint; available: bigint; goingOut: bigint; arriving: bigint; incoming: boolean; usd: number | null }
  | { key: "joining"; sol: bigint; minutes: number | null; count: number; progress: number; usd: number | null }
  | { key: "address"; sol: bigint; small: boolean; usd: number | null }
  | { key: "landing"; sol: bigint; usd: number | null }
  /** `each`: every wallet holding SOL, by number (what the row's figure is made of) */
  | { key: "vision"; sol: bigint; wallets: number; usd: number | null; each: { index: number; sol: bigint; usd: number | null }[] }
  | {
      key: "token";
      mint: string;
      symbol: string | null;
      icon: string | null;
      amount: bigint;
      decimals: number;
      price: number | null;
      usd: number | null;
      wallets: { index: number; amount: bigint; usd: number | null }[];
    }
  /** SOL waiting for its owner: held at a deposit address, or come back to a sending address */
  | { key: "held"; sol: bigint; deposit: bigint; returned: bigint; usd: number | null };

export type Portfolio = {
  loading: boolean;
  /** every SOL counted, in lamports */
  sol: bigint;
  /** `sol` plus the priced tokens converted at solUsd (the "≈ x SOL" line); null without solUsd */
  solEq: number | null;
  /** sol × solUsd plus the priced tokens; null without solUsd */
  usd: number | null;
  /** kinds of token held with no price yet */
  unpriced: number;
  /** a fresh account: nothing held, nothing on its way, and the pool read */
  empty: boolean;
  /** in order: joining, landing, own, address, out */
  flights: Flight[];
  /** in order: private, joining, address, landing, vision, tokens (see tokenOrder), held */
  assets: Asset[];
  /** every dollar figure as shown, rounded once for this state (see portfolioCents) */
  cents: Cents;
  /** the token search has answered for every token held (see PortfolioIn.asked) */
  asked: boolean;
};

/**
 * The dollar figures as shown, in cents, worked out once per state so every screen shows the same
 * figure for the same thing. The rows add up to the total (while it shows cents: from $10,000 it shows
 * whole dollars, and each row is simply rounded); a row's parts add up to the row: each Vision wallet's
 * SOL to the "Vision wallets" row, each wallet's share of a token to that token's row. A wallet's own
 * figure is the sum of its parts (see walletValue). Null: no price, or a test network.
 */
export type Cents = {
  /** the total; null without dollar values */
  total: number | null;
  /** each row of `assets`, in its order */
  rows: (number | null)[];
  /** each Vision wallet's SOL, by wallet number */
  sol: Map<number, number | null>;
  /** each token in each Vision wallet, by `${wallet number}:${mint}` */
  held: Map<string, number | null>;
};

const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const tokenUsd = (amount: bigint, decimals: number, price: number | null) => (price == null ? null : (Number(amount) / 10 ** decimals) * price);

/**
 * The waiting-room deposits that a Vision wallet or deposit address still shows as its own SOL: it moved
 * them into the pool and hasn't been read since. Matched by source and amount, each amount moved to one
 * deposit at most; returns their positions in `waiting`.
 */
export function stillAtSource(waiting: PortfolioIn["waiting"], vision: PortfolioIn["vision"], deposits: PortfolioIn["deposits"]): Set<number> {
  const out = new Set<number>();
  const take = (src: "vision" | "deposit", index: number, moved: bigint[] | undefined) => {
    for (const amount of moved ?? []) {
      const k = waiting.findIndex((w, i) => !out.has(i) && w[src] === index && w.amount === amount);
      if (k >= 0) out.add(k);
    }
  };
  for (const v of vision) take("vision", v.index, v.moved);
  for (const d of deposits) if (d.index != null) take("deposit", d.index, d.moved);
  return out;
}

type Ordered = { symbol: string | null; usd: number | null; amount: bigint; decimals: number; mint: string };

/**
 * The order of tokens in a list: by value, highest first; then the ones with a name but no price yet, by
 * name; then the ones whose name isn't known yet, by amount, largest first (so never ahead of a named one).
 */
export function tokenOrder(a: Ordered, b: Ordered): number {
  const rank = (t: Ordered) => (t.symbol == null ? 2 : t.usd == null ? 1 : 0);
  const r = rank(a) - rank(b);
  if (r) return r;
  if (rank(a) === 0) return b.usd! - a.usd! || a.symbol!.localeCompare(b.symbol!);
  if (rank(a) === 1) return a.symbol!.localeCompare(b.symbol!) || a.mint.localeCompare(b.mint);
  return Number(b.amount) / 10 ** b.decimals - Number(a.amount) / 10 ** a.decimals || a.mint.localeCompare(b.mint);
}

export function portfolio(p: PortfolioIn): Portfolio {
  const usdOf = (l: bigint) => (p.solUsd == null ? null : (Number(l) / 1e9) * p.solUsd);

  // joining: the waiting room, whatever paid in (a deposit its wallet or address still shows is counted there, not here)
  const stale = stillAtSource(p.waiting, p.vision, p.deposits);
  const counted = p.waiting.filter((_, i) => !stale.has(i));
  const joining = sum(counted.map((w) => w.amount));
  let minutes: number | null = null;
  let weighted = 0;
  for (const w of counted) {
    const left = w.readyAt == null ? 0 : Number(w.readyAt) - p.slot;
    if (left > 0) minutes = Math.max(minutes ?? 0, slotMinutes(left, p.msPerSlot, true));
    const done = p.delaySlots > 0 ? Math.min(1, Math.max(0, 1 - left / p.delaySlots)) : 1;
    weighted += done * Number(w.amount);
  }
  const progress = joining > 0n ? Math.min(1, Math.max(0, weighted / Number(joining))) : 1;

  // deposit addresses: moving in by itself, a leftover too small to, or held for its owner
  const free = p.deposits.filter((d) => !d.held && d.lamports > 0n);
  const moving = sum(free.filter((d) => p.minReceive != null && d.lamports >= p.minReceive).map((d) => d.lamports));
  const atAddress = sum(free.map((d) => d.lamports));
  const heldDeposit = sum(p.deposits.filter((d) => !!d.held && d.lamports > 0n).map((d) => d.lamports));
  const held = heldDeposit + p.returned;

  // scheduled payments: only what went out to a Vision wallet not read yet is added (held ones are in the balance)
  const landing = p.jobs.filter((j) => !j.held && j.index != null);
  const landingSol = sum(landing.map((j) => j.amount));
  const own = p.jobs.filter((j) => j.held && j.index != null);
  const out = p.jobs.filter((j) => j.held && j.index == null);

  const visionSol = sum(p.vision.map((v) => v.lamports));

  // tokens: one row per mint across every Vision wallet
  const byMint = new Map<string, { decimals: number; wallets: { index: number; amount: bigint }[] }>();
  for (const v of p.vision)
    for (const t of v.tokens) {
      if (t.amount <= 0n) continue;
      const h = byMint.get(t.mint) ?? { decimals: t.decimals, wallets: [] };
      h.wallets.push({ index: v.index, amount: t.amount });
      byMint.set(t.mint, h);
    }
  const tokens: Extract<Asset, { key: "token" }>[] = [...byMint.entries()].map(([mint, h]) => {
    const info = p.tokens[mint];
    const price = info?.price ?? null;
    const amount = sum(h.wallets.map((w) => w.amount));
    return {
      key: "token",
      mint,
      symbol: info?.symbol ?? null,
      icon: info?.icon ?? null,
      amount,
      decimals: h.decimals,
      price,
      usd: tokenUsd(amount, h.decimals, price),
      wallets: h.wallets
        .map((w) => ({ index: w.index, amount: w.amount, usd: tokenUsd(w.amount, h.decimals, price) }))
        .sort((a, b) => (a.amount === b.amount ? a.index - b.index : a.amount > b.amount ? -1 : 1)),
    };
  });
  tokens.sort(tokenOrder);
  const unpriced = tokens.filter((t) => t.usd == null).length;
  const tokensUsd = tokens.reduce((s, t) => s + (t.usd ?? 0), 0);

  const sol = p.balance + joining + atAddress + held + landingSol + visionSol;
  const usd = p.solUsd == null ? null : (Number(sol) / 1e9) * p.solUsd + tokensUsd;
  const solEq = p.solUsd == null || p.solUsd <= 0 ? null : Number(sol) / 1e9 + tokensUsd / p.solUsd;

  const flights: Flight[] = [];
  if (joining > 0n) flights.push({ kind: "joining", sol: joining, minutes, count: counted.length, progress });
  if (landingSol > 0n) flights.push({ kind: "landing", sol: landingSol, indexes: [...new Set(landing.map((j) => j.index!))] });
  if (own.length) flights.push({ kind: "own", sol: sum(own.map((j) => j.amount)), indexes: [...new Set(own.map((j) => j.index!))], by: Math.max(...own.map((j) => j.latest)) });
  if (moving > 0n) flights.push({ kind: "address", sol: moving });
  if (out.length) flights.push({ kind: "out", sol: sum(out.map((j) => j.amount)), count: out.length, by: Math.max(...out.map((j) => j.latest)) });

  const assets: Asset[] = [];
  if (!p.loading)
    assets.push({
      key: "private",
      sol: p.balance,
      available: p.balance - p.arriving - p.locked,
      goingOut: p.locked,
      arriving: p.arriving,
      incoming: joining > 0n || moving > 0n || landingSol > 0n,
      usd: usdOf(p.balance),
    });
  if (joining > 0n) assets.push({ key: "joining", sol: joining, minutes, count: counted.length, progress, usd: usdOf(joining) });
  if (atAddress > 0n) assets.push({ key: "address", sol: atAddress, small: moving === 0n, usd: usdOf(atAddress) });
  if (landingSol > 0n) assets.push({ key: "landing", sol: landingSol, usd: usdOf(landingSol) });
  if (p.vision.some((v) => v.lamports > 0n)) {
    const wallets = p.vision.filter((v) => v.lamports > 0n || v.tokens.some((t) => t.amount > 0n)).length;
    const each = p.vision.filter((v) => v.lamports > 0n).map((v) => ({ index: v.index, sol: v.lamports, usd: usdOf(v.lamports) }));
    assets.push({ key: "vision", sol: visionSol, wallets, usd: usdOf(visionSol), each: each.sort((a, b) => a.index - b.index) });
  }
  assets.push(...tokens);
  if (held > 0n) assets.push({ key: "held", sol: held, deposit: heldDeposit, returned: p.returned, usd: usdOf(held) });

  return {
    loading: p.loading,
    sol,
    solEq,
    usd,
    unpriced,
    empty: !p.loading && sol === 0n && !tokens.length && !flights.length,
    flights,
    assets,
    cents: portfolioCents(assets, usd),
    asked: p.asked ?? true,
  };
}

/**
 * The cents of every figure (see Cents): the rows rounded to add up to the total, then each row's parts
 * rounded to add up to the row. While the first read of the pool hasn't finished, the private balance has
 * no row yet: the rows then add up to what they hold (the total isn't shown meanwhile).
 */
export function portfolioCents(assets: Asset[], usd: number | null): Cents {
  const values = assets.map((a) => a.usd);
  const listed = values.reduce<number>((s, v) => s + (v ?? 0), 0);
  const all = usd == null ? null : assets.some((a) => a.key === "private") ? usd : listed;
  const rows = centsAddingUp(values, all != null && all < 10_000 ? all : null);
  const sol = new Map<number, number | null>();
  const held = new Map<string, number | null>();
  const parts = <T extends { usd: number | null }>(row: number | null, xs: T[]) =>
    centsAddingUp(
      xs.map((x) => x.usd),
      row == null ? null : row / 100,
    );
  assets.forEach((a, k) => {
    if (a.key === "vision") parts(rows[k], a.each).forEach((c, i) => sol.set(a.each[i].index, c));
    else if (a.key === "token") parts(rows[k], a.wallets).forEach((c, i) => held.set(`${a.wallets[i].index}:${a.mint}`, c));
  });
  return { total: usd == null ? null : Math.round(usd * 100), rows, sol, held };
}

export type WalletValue = {
  /** its figure: its SOL and every token with a price (null: nothing in it has a price, or a test network) */
  cents: number | null;
  /** the same, unrounded */
  value: number | null;
  /** its SOL's part, and the same unrounded */
  sol: number | null;
  solValue: number | null;
  /** each token's part, by mint (null: no price yet) */
  tokens: Map<string, number | null>;
  /** each token's value, unrounded, by mint (null: no price yet) */
  values: Map<string, number | null>;
  /** its tokens with no price yet, left out of the figure (said beside it, see unpricedNote) */
  unpriced: number;
};

/** One Vision wallet's dollar figure as shown, from the shared cents: the sum of its parts, so its sheet adds up to it. */
export function walletValue(p: Portfolio, w: { index: number; tokens: { mint: string; amount: bigint }[] }): WalletValue {
  const vision = p.assets.find((a): a is Extract<Asset, { key: "vision" }> => a.key === "vision");
  const sol = p.cents.sol.get(w.index) ?? null;
  let cents: number | null = sol;
  const solValue = vision?.each.find((e) => e.index === w.index)?.usd ?? null;
  let value: number | null = solValue;
  let unpriced = 0;
  const tokens = new Map<string, number | null>();
  const values = new Map<string, number | null>();
  for (const t of w.tokens) {
    if (t.amount <= 0n) continue;
    const row = p.assets.find((a): a is Extract<Asset, { key: "token" }> => a.key === "token" && a.mint === t.mint);
    const c = p.cents.held.get(`${w.index}:${t.mint}`) ?? null;
    const usd = row?.wallets.find((x) => x.index === w.index)?.usd ?? null;
    tokens.set(t.mint, usd == null ? null : c);
    values.set(t.mint, usd);
    if (c == null || usd == null) {
      // (a test network has no dollar values at all: nothing to leave out)
      if (p.cents.total != null) unpriced++;
      continue;
    }
    cents = (cents ?? 0) + c;
    value = (value ?? 0) + usd;
  }
  return { cents, value, sol, solValue, tokens, values, unpriced };
}

/** A dollar figure from its cents as shown ("<$0.01" for a value under a cent that a list shows as none). */
export function centsText(cents: number | null, value: number | null): string | null {
  if (cents == null || value == null) return null;
  return cents === 0 && value > 0 ? fmtUsd(value) : fmtUsd(cents / 100);
}

/** "+ 2 without a price": said beside a dollar figure that leaves out tokens with no price yet. */
export const unpricedNote = (n: number) => (n > 0 ? `+ ${n} without a price` : "");

/**
 * Whether a dollar figure leaving out `unpriced` tokens can be shown, with "+ N without a price" beside it: only once
 * the token search has answered for every token held. Before that (a page that hasn't asked about them, or the
 * moment it's asking) a token with no price here may well have one, so no dollar figure stands for them.
 */
export const pricedEnough = (p: Pick<Portfolio, "asked">, unpriced: number) => unpriced === 0 || p.asked;

/**
 * The website's balance line, its part on the Vision wallets: "Total with Vision wallets ≈ $148.14" (with "+ 1 without
 * a price" beside it when a token has none), or in SOL and tokens while there are no dollar figures for all of it
 * ("Total with Vision wallets: 0.7708 SOL + 3 tokens"). `sol`: the SOL counted, as written.
 */
export function totalWithWallets(p: Portfolio, sol: string): string {
  const kinds = p.assets.filter((a) => a.key === "token").length;
  const usd = pricedEnough(p, p.unpriced) ? centsText(p.cents.total, p.usd) : null;
  return usd != null
    ? `Total with Vision wallets ≈ ${usd}${p.unpriced ? ` ${unpricedNote(p.unpriced)}` : ""}`
    : `Total with Vision wallets: ${sol} SOL${kinds ? ` + ${kinds} token${kinds === 1 ? "" : "s"}` : ""}`;
}

/**
 * The lines the website's balance line keeps on a screen wider than a phone (a phone always keeps two, since it often
 * takes two there): one while it says one thing (what's moving, or the line for a quiet balance), which fits; two once
 * the account's line can also carry the Vision wallets' total beside what's moving (something in a Vision wallet, or
 * a payment on its way to one), and from then on for the rest of the visit (`had`), so nothing under it ever moves as
 * money moves.
 */
export function balanceLineRows(p: Portfolio, had: boolean): 1 | 2 {
  if (had) return 2;
  const wallets = p.assets.some((a) => a.key === "vision" || a.key === "token");
  return wallets || p.flights.some((f) => f.kind === "own" || f.kind === "landing") ? 2 : 1;
}

/** The prices a screen knows, as one key (in any order): screens showing the same state with the same prices share one result. */
export function pricesKey(meta: Record<string, { symbol?: string | null; icon?: string | null; price?: number | null }>): string {
  return Object.keys(meta)
    .sort()
    .map((m) => `${m}:${meta[m].symbol ?? ""}:${meta[m].icon ?? ""}:${meta[m].price ?? ""}`)
    .join("|");
}

/**
 * The portfolio worked out once per state: every screen asking with the same state (the same object), the same
 * prices and the same loading flag gets the very same result, its dollar figures rounded once (see Cents). The
 * state's other inputs (`make`) are read only when it is worked out again.
 */
export function portfolioCache<S extends object>(): (st: S, prices: string, loading: boolean, make: () => PortfolioIn) => Portfolio {
  let last: { st: S; prices: string; loading: boolean; p: Portfolio } | null = null;
  return (st, prices, loading, make) => {
    if (last && last.st === st && last.prices === prices && last.loading === loading) return last.p;
    const p = portfolio(make());
    last = { st, prices, loading, p };
    return p;
  };
}

/**
 * The names and prices the total uses, from what the token search said. Off mainnet no token has a price:
 * test tokens have no dollar value, as test SOL has none (so a test network's total reads in SOL only).
 */
export function tokenPrices(meta: Record<string, { symbol?: string | null; icon?: string | null; price?: number | null }>, mainnet: boolean): PortfolioIn["tokens"] {
  const out: PortfolioIn["tokens"] = {};
  for (const [mint, t] of Object.entries(meta)) out[mint] = { symbol: t.symbol ?? null, icon: t.icon ?? null, price: mainnet ? (t.price ?? null) : null };
  return out;
}

/**
 * Dollar figures for a list whose total is shown above it, in cents, rounded so the figures shown add up
 * to the total shown: each is rounded down, then the cents still missing go to the ones with the most
 * cut off (largest remainder). None is ever more than a cent from its own value. A null (no price) stays
 * null and is not part of the total. Without a total, each is simply rounded.
 */
export function centsAddingUp(values: (number | null)[], total: number | null): (number | null)[] {
  if (total == null || !Number.isFinite(total)) return values.map((v) => (v == null ? null : Math.round(v * 100)));
  const raw = values.map((v) => (v == null ? null : Math.max(0, v * 100)));
  // (a hair over a whole cent counts as that cent: floating point turns 4.25 into 424.99999...)
  const out = raw.map((c) => (c == null ? null : Math.floor(c + 1e-6)));
  const want = Math.round(total * 100);
  let missing = want - out.reduce<number>((s, c) => s + (c ?? 0), 0);
  const order = raw
    .map((c, i) => ({ i, rem: c == null ? -1 : c - out[i]! }))
    .filter((x) => x.rem >= 0)
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; missing > 0 && k < order.length; k++, missing--) {
    const j = order[k].i;
    out[j] = (out[j] ?? 0) + 1;
  }
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line about money on its way, for under the total. `clock` writes a time ("1:47 PM"). */
export function flightText(f: Flight, clock: (t: number) => string): string {
  const x = `${solStr(f.sol)} SOL`;
  switch (f.kind) {
    case "joining":
      return `${x} joining your private balance · ${f.minutes == null ? "any moment now" : `about ${f.minutes} min`}`;
    case "own":
      return `${x} going to ${walletsName(f.indexes)} · by ${clock(f.by)}`;
    case "landing":
      return `${x} landing in ${walletsName(f.indexes)}`;
    case "out":
      return f.count > 1 ? `${x} in ${f.count} scheduled payments · by ${clock(f.by)}` : `${x} scheduled to send · by ${clock(f.by)}`;
    case "address":
      return `${x} moving in from your deposit address`;
  }
}

/** An asset row's name. `symbol` stands in for a token whose name isn't known yet. */
export function assetTitle(a: Asset): string {
  switch (a.key) {
    case "private":
      return "Private balance";
    case "joining":
      return "Joining private balance";
    case "address":
      return "At your deposit address";
    case "landing":
      return "On its way to Vision wallets";
    case "vision":
      return "Vision wallets";
    case "token":
      return a.symbol ?? `${a.mint.slice(0, 4)}…`;
    case "held":
      return "Waiting for you";
  }
}

/** An asset row's second line: where it is, or what is happening to it. */
export function assetSub(a: Asset): string {
  switch (a.key) {
    case "private":
      if (a.sol === 0n) return a.incoming ? "Ready to spend once SOL joins" : "Add SOL with Receive";
      if (a.available === a.sol) return "Ready to spend";
      return [
        `${solStr(a.available)} available`,
        ...(a.goingOut > 0n ? [`${solStr(a.goingOut)} scheduled`] : []),
        ...(a.arriving > 0n ? [`${solStr(a.arriving)} arriving`] : []),
      ].join(" · ");
    case "joining":
      return `${a.minutes == null ? "Any moment now" : `About ${a.minutes} min`} · ${plural(a.count, "deposit", "deposits")}`;
    case "address":
      return a.small ? "Too small to move in on its own" : "Moving in by itself";
    case "landing":
      return "On its way to Vision wallets · lands in a moment";
    case "vision":
      return a.wallets === 1 ? "1 wallet · only you control it" : `${a.wallets} wallets · only you control them`;
    case "token":
      return a.wallets.length === 1 ? "In a Vision wallet" : `In ${a.wallets.length} Vision wallets`;
    case "held":
      return a.returned > 0n && a.deposit === 0n
        ? "Came back to a sending address"
        : a.returned > 0n
          ? "At a deposit address and a sending address"
          : "Waiting for you at a deposit address";
  }
}
