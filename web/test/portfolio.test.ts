import { test } from "node:test";
import assert from "node:assert/strict";
import {
  portfolio,
  flightText,
  assetSub,
  assetTitle,
  centsAddingUp,
  centsText,
  tokenPrices,
  tokenOrder,
  walletValue,
  unpricedNote,
  stillAtSource,
  pricesKey,
  pricedEnough,
  totalWithWallets,
  balanceLineRows,
  portfolioCache,
  type PortfolioIn,
  type Asset,
  type Portfolio,
} from "../src/lib/portfolio.ts";
import { holdPayingRead, payingLands, PAYING_MS, type Paying } from "../src/lib/jobs.ts";

const L = (sol: number) => BigInt(Math.round(sol * 1e9));
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const WIF = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const PRICES: PortfolioIn["tokens"] = {
  [BONK]: { symbol: "BONK", icon: null, price: 0.000022096 },
  [JUP]: { symbol: "JUP", icon: null, price: 0.52 },
  [WIF]: { symbol: "WIF", icon: null, price: 0.81 },
};
const SLOT = 300_000_000;
const clock = (t: number) => `@${t}`;

const tok = (mint: string, amount: bigint, decimals: number) => ({ mint, amount, decimals });
const vw = (index: number, sol: number, tokens: { mint: string; amount: bigint; decimals: number }[] = []) => ({ index, lamports: L(sol), tokens });
// the owner's twelve wallets, as staged by the UI audit
const OWNER12 = [
  vw(0, 0.05, [tok(BONK, 125_000_000_000n, 5)]),
  vw(1, 0.0061, [tok(JUP, 40_000_000n, 6)]),
  vw(2, 0.0412),
  vw(3, 0.0398),
  vw(4, 0.0405),
  vw(5, 0.0388),
  vw(6, 0.042),
  vw(7, 0.0391),
  vw(8, 0.006, [tok(WIF, 25_000_000n, 6)]),
  vw(9, 0.0015),
  vw(10, 0.0402),
  vw(11, 0.0175),
];

const base = (p: Partial<PortfolioIn> = {}): PortfolioIn => ({
  loading: false,
  balance: 0n,
  arriving: 0n,
  locked: 0n,
  waiting: [],
  slot: SLOT,
  delaySlots: 1500,
  msPerSlot: 400,
  deposits: [],
  minReceive: L(0.012),
  returned: 0n,
  vision: [],
  jobs: [],
  solUsd: 103.1,
  tokens: PRICES,
  ...p,
});
const near = (a: number | null, b: number, d = 0.02) => assert.ok(a != null && Math.abs(a - b) <= d, `${a} is not about ${b}`);
const find = <K extends Asset["key"]>(as: Asset[], key: K) => as.find((a) => a.key === key) as Extract<Asset, { key: K }> | undefined;

test("the owner's state: one total, the scheduled payments counted once", () => {
  const jobs = Array.from({ length: 10 }, (_, k) => ({ index: 12 + k, amount: L(0.035), latest: 1000 + k, held: true, landing: false }));
  const p = portfolio(base({ balance: L(0.4081), locked: L(0.35), vision: OWNER12, jobs }));
  assert.equal(p.sol, L(0.7708));
  near(p.usd, 148.14);
  near(p.solEq, 148.14 / 103.1, 0.0005);
  assert.equal(p.unpriced, 0);
  assert.equal(p.empty, false);
  assert.deepEqual(p.flights, [{ kind: "own", sol: L(0.35), indexes: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21], by: 1009 }]);
  assert.equal(flightText(p.flights[0], clock), "0.35 SOL going to Vision wallets #13–#22 · by @1009");
  const priv = find(p.assets, "private")!;
  assert.equal(priv.available, L(0.0581));
  assert.equal(priv.goingOut, L(0.35));
  assert.equal(assetSub(priv), "0.0581 available · 0.35 scheduled");
  // the list: private, the Vision wallets' SOL, then the tokens by value
  assert.deepEqual(
    p.assets.map((a) => assetTitle(a)),
    ["Private balance", "Vision wallets", "BONK", "JUP", "WIF"],
  );
  const vision = find(p.assets, "vision")!;
  assert.equal(vision.sol, L(0.3627));
  assert.equal(vision.wallets, 12);
  assert.equal(assetSub(vision), "12 wallets · only you control them");
});

test("after moving SOL back: never 0, the joining SOL is in the total", () => {
  const moved = [0.0393, 0.0379, 0.0386, 0.0369, 0.0401, 0.0372, 0.0383, 0.0156];
  const waiting = moved.map((sol, k) => ({ amount: L(sol), readyAt: BigInt(SLOT - (40 + k * 30) + 1500) }));
  const vision = [vw(0, 0.006, [tok(BONK, 125_000_000_000n, 5)]), vw(1, 0.0061, [tok(JUP, 40_000_000n, 6)]), vw(8, 0.006, [tok(WIF, 25_000_000n, 6)]), vw(9, 0.0015)];
  const p = portfolio(base({ waiting, vision }));
  assert.equal(p.sol, L(0.3035));
  near(p.usd, 99.96);
  assert.equal(p.empty, false);
  const f = p.flights[0];
  assert.equal(f.kind, "joining");
  assert.equal(f.kind === "joining" && f.count, 8);
  assert.match(flightText(f, clock), /^0\.2839 SOL joining your private balance · about \d+ min$/);
  const j = find(p.assets, "joining")!;
  assert.ok(j.progress > 0 && j.progress < 1);
  assert.match(assetSub(j), /^About \d+ min · 8 deposits$/);
  const priv = find(p.assets, "private")!;
  assert.equal(priv.sol, 0n);
  assert.equal(assetSub(priv), "Ready to spend once SOL joins");
  assert.equal(assetSub(find(p.assets, "vision")!), "4 wallets · only you control them");
});

test("in flight: change arriving is in the balance already, the waiting room is added once", () => {
  const p = portfolio(
    base({
      balance: L(0.0581 + 0.0123),
      arriving: L(0.0123),
      waiting: [
        { amount: L(0.0393), readyAt: BigInt(SLOT + 1300) },
        { amount: L(0.0379), readyAt: BigInt(SLOT + 1380) },
        { amount: L(0.25), readyAt: BigInt(SLOT + 900) },
      ],
      vision: OWNER12.map((v) => ([2, 3].includes(v.index) ? { ...v, lamports: 0n } : v)),
    }),
  );
  assert.equal(p.sol, L(0.6793));
  assert.equal(assetSub(find(p.assets, "private")!), "0.0581 available · 0.0123 arriving");
});

test("a payment that went out to a Vision wallet not read yet is added; one still held is not", () => {
  const job = { index: 14, amount: L(0.035), latest: 5, held: false, landing: true };
  const p = portfolio(base({ balance: L(0.1), jobs: [job] }));
  assert.equal(p.sol, L(0.135));
  assert.deepEqual(p.flights, [{ kind: "landing", sol: L(0.035), indexes: [14] }]);
  assert.equal(flightText(p.flights[0], clock), "0.035 SOL landing in Vision wallet #15");
  assert.ok(find(p.assets, "landing"));
  const q = portfolio(base({ balance: L(0.1), jobs: [{ ...job, held: true }] }));
  assert.equal(q.sol, L(0.1));
  assert.equal(q.flights[0].kind, "own");
});

test("a payment to someone else: in the balance while held, gone once spent", () => {
  const spent = portfolio(base({ balance: L(0.1), jobs: [{ index: null, amount: L(0.05), latest: 9, held: false, landing: false }] }));
  assert.equal(spent.sol, L(0.1));
  assert.deepEqual(spent.flights, []);
  const held = portfolio(base({ balance: L(0.1), locked: L(0.05), jobs: [{ index: null, amount: L(0.05), latest: 9, held: true, landing: false }] }));
  assert.equal(held.sol, L(0.1));
  assert.equal(flightText(held.flights[0], clock), "0.05 SOL scheduled to send · by @9");
  const two = portfolio(
    base({
      balance: L(0.1),
      jobs: [
        { index: null, amount: L(0.02), latest: 9, held: true, landing: false },
        { index: null, amount: L(0.03), latest: 12, held: true, landing: false },
      ],
    }),
  );
  assert.equal(flightText(two.flights[0], clock), "0.05 SOL in 2 scheduled payments · by @12");
});

test("deposit addresses: moving in, a small leftover, and held for its owner all count", () => {
  const p = portfolio(
    base({
      deposits: [
        { lamports: L(0.25), held: null },
        { lamports: L(0.001), held: null },
        { lamports: L(0.1), held: "returned" },
      ],
    }),
  );
  assert.equal(p.sol, L(0.351));
  const addr = find(p.assets, "address")!;
  assert.equal(addr.sol, L(0.251));
  assert.equal(addr.small, false);
  assert.equal(assetSub(addr), "Moving in by itself");
  assert.deepEqual(p.flights, [{ kind: "address", sol: L(0.25) }]);
  assert.equal(flightText(p.flights[0], clock), "0.25 SOL moving in from your deposit address");
  assert.equal(find(p.assets, "held")!.sol, L(0.1));
  assert.equal(assetSub(find(p.assets, "held")!), "Waiting for you at a deposit address");
  // only a leftover: no flight, and it says why it stays
  const small = portfolio(base({ deposits: [{ lamports: L(0.001), held: null }] }));
  assert.equal(find(small.assets, "address")!.small, true);
  assert.equal(assetSub(find(small.assets, "address")!), "Too small to move in on its own");
  assert.deepEqual(small.flights, []);
});

test("prices: none known, one missing, and a test network", () => {
  const noUsd = portfolio(base({ balance: L(0.2), vision: OWNER12, solUsd: null }));
  assert.equal(noUsd.usd, null);
  assert.equal(noUsd.solEq, null);
  assert.equal(noUsd.sol, L(0.5627));
  assert.ok(noUsd.assets.every((a) => a.key === "token" || a.usd === null));
  const tokens = { ...PRICES, [JUP]: { symbol: "JUP", icon: null, price: null } };
  delete (tokens as Record<string, unknown>)[WIF];
  const p = portfolio(base({ vision: OWNER12, tokens }));
  assert.equal(p.unpriced, 2);
  const list = p.assets.filter((a): a is Extract<Asset, { key: "token" }> => a.key === "token");
  assert.equal(list[0].symbol, "BONK");
  assert.equal(list[1].usd, null);
  assert.equal(list[2].usd, null);
  // unpriced after the priced ones: named first, by name; one not known yet (no name) last, never ahead of a named one
  assert.deepEqual(
    list.map((t) => t.symbol ?? t.mint),
    ["BONK", "JUP", WIF],
  );
  // the total still counts the priced ones
  near(p.usd, (Number(L(0.3627)) / 1e9) * 103.1 + 27.62);
});

test("a token held in several wallets is one row, largest holding first", () => {
  const p = portfolio(base({ vision: [vw(0, 0.01, [tok(BONK, 125_000_000_000n, 5)]), vw(12, 0.006, [tok(BONK, 98_000_000_000n, 5)])] }));
  const bonk = find(p.assets, "token")!;
  assert.equal(bonk.amount, 223_000_000_000n);
  assert.deepEqual(
    bonk.wallets.map((w) => w.index),
    [0, 12],
  );
  near(bonk.usd, 2_230_000 * 0.000022096, 0.001);
  near(bonk.wallets[1].usd, 980_000 * 0.000022096, 0.001);
  assert.equal(assetSub(bonk), "In 2 Vision wallets");
});

test("left out of the total: repeated deposits, deliveries to finish; SOL that came back is in", () => {
  // (unexpected notes and finish/look hops never reach PortfolioIn; the hook passes only the returned hops)
  const p = portfolio(base({ balance: L(0.1), returned: L(0.02) }));
  assert.equal(p.sol, L(0.12));
  const held = find(p.assets, "held")!;
  assert.equal(held.returned, L(0.02));
  assert.equal(assetSub(held), "Came back to a sending address");
});

test("loading and empty", () => {
  const loading = portfolio(base({ loading: true }));
  assert.equal(loading.empty, false);
  assert.equal(find(loading.assets, "private"), undefined);
  const fresh = portfolio(base());
  assert.equal(fresh.empty, true);
  assert.deepEqual(
    fresh.assets.map((a) => a.key),
    ["private"],
  );
  assert.equal(assetSub(fresh.assets[0]), "Add SOL with Receive");
  assert.equal(fresh.usd, 0);
});

test("joining: past its time, any moment now", () => {
  const p = portfolio(base({ waiting: [{ amount: L(0.05), readyAt: BigInt(SLOT - 10) }, { amount: L(0.02), readyAt: null }] }));
  const f = p.flights[0];
  assert.equal(f.kind === "joining" && f.minutes, null);
  assert.equal(flightText(f, clock), "0.07 SOL joining your private balance · any moment now");
  const j = find(p.assets, "joining")!;
  assert.ok(j.progress >= 0 && j.progress <= 1);
  assert.equal(assetSub(j), "Any moment now · 2 deposits");
  const none = portfolio(base({ delaySlots: 0, waiting: [{ amount: L(0.05), readyAt: BigInt(SLOT + 100) }] }));
  assert.equal(find(none.assets, "joining")!.progress, 1);
});

test("the rows' dollar figures add up to the total shown, each within a cent of its own", () => {
  const usdText = (c: number) => (c / 100).toFixed(2);
  // the audit's states, as the extension's Home shows them (prices from the mock: BONK 0.0000221)
  const tokens = { ...PRICES, [BONK]: { symbol: "BONK", icon: null, price: 0.0000221 } };
  const moved = portfolio(
    base({
      tokens,
      waiting: [0.0393, 0.0379, 0.0386, 0.0369, 0.0401, 0.0372, 0.0383, 0.0156].map((sol) => ({ amount: L(sol), readyAt: BigInt(SLOT + 900) })),
      vision: [
        vw(0, 0.006, [tok(BONK, 125_000_000_000n, 5)]),
        vw(1, 0.0061, [tok(JUP, 40_000_000n, 6)]),
        vw(8, 0.006, [tok(WIF, 25_000_000n, 6)]),
        vw(9, 0.0015),
      ],
    }),
  );
  for (const p of [moved, portfolio(base({ tokens, balance: L(0.3620), vision: [...OWNER12, vw(12, 0.006, [tok(BONK, 98_000_000_000n, 5)])] }))]) {
    const values = p.assets.map((a) => a.usd);
    const cents = centsAddingUp(values, p.usd);
    assert.equal(
      cents.reduce<number>((s, c) => s + (c ?? 0), 0),
      Math.round(p.usd! * 100),
      `${cents.map((c) => usdText(c!)).join(" + ")} vs ${p.usd}`,
    );
    cents.forEach((c, k) => assert.ok(Math.abs(c! - values[k]! * 100) < 1, `${c} vs ${values[k]}`));
  }
  // rounded each on its own, these would show $0.00 + $29.27 + $2.02 + $27.62 + $20.80 + $20.25 = $99.96 under $99.97
  assert.deepEqual(centsAddingUp([0, 29.2703, 2.0208, 27.625, 20.8, 20.25], 99.9661), [0, 2927, 202, 2763, 2080, 2025]);
  // a row without a price is not part of the total and stays without one; no total: each simply rounded
  assert.deepEqual(centsAddingUp([1.005, null, 2.994], 4), [101, null, 299]);
  assert.deepEqual(centsAddingUp([1.006, null], null), [101, null]);
  assert.deepEqual(centsAddingUp([], 0), []);
});

test("a test network: no token has a dollar value either, so nothing on Home reads in dollars", () => {
  const meta = { [BONK]: { symbol: "BONK", icon: null, price: 0.0000221 }, [JUP]: { symbol: "JUP", price: 0.52 } };
  assert.deepEqual(tokenPrices(meta, true)[JUP], { symbol: "JUP", icon: null, price: 0.52 });
  const test = tokenPrices(meta, false);
  assert.deepEqual(test[BONK], { symbol: "BONK", icon: null, price: null });
  const p = portfolio(base({ solUsd: null, balance: L(0.4), vision: OWNER12, tokens: test }));
  assert.equal(p.usd, null);
  assert.ok(p.assets.every((a) => a.usd === null));
  assert.equal(p.unpriced, 3);
});

// ─── one rounding for every screen (Home, its token sheet, the Wallets rows and sheets, the website's balance line) ───

const MOCK_PRICES: PortfolioIn["tokens"] = { ...PRICES, [BONK]: { symbol: "BONK", icon: null, price: 0.0000221 } };
const tokenRow = (p: Portfolio, mint: string) => p.assets.findIndex((a) => a.key === "token" && a.mint === mint);
const sumOf = (xs: (number | null)[]) => xs.reduce<number>((s, c) => s + (c ?? 0), 0);

test("a token shows the same cents on every screen: Home's row, its wallet's row and the wallet's sheet", () => {
  // the QA's case: 1,250,000 BONK at $0.0000221 is $27.625. Home rounded it to $27.63 with the other rows, while the
  // wallet's sheet, rounding on its own against the wallet's figure, showed $27.62
  const p = portfolio(base({ tokens: MOCK_PRICES, balance: L(0.0581), vision: OWNER12 }));
  const k = tokenRow(p, BONK);
  assert.equal(p.cents.rows[k], 2763);
  const sol = 0.05 * 103.1;
  const bonk = 1_250_000 * 0.0000221;
  assert.deepEqual(centsAddingUp([sol, bonk], Math.round((sol + bonk) * 100) / 100), [516, 2762], "the old, separate rounding");
  const w = walletValue(p, OWNER12[0]);
  assert.equal(w.tokens.get(BONK), 2763, "the wallet's sheet shows Home's figure");
  assert.equal(centsText(w.tokens.get(BONK)!, w.values.get(BONK)!), "$27.63");
  // the wallet's row is the sum of its sheet's parts
  assert.equal(w.cents, w.sol! + w.tokens.get(BONK)!);
  assert.equal(w.unpriced, 0);
});

test("every figure adds up: rows to the total, wallets' SOL to the Vision row, wallets' shares to each token, wallets to the header", () => {
  const states = [
    base({ tokens: MOCK_PRICES, balance: L(0.0581), vision: OWNER12 }),
    base({ tokens: MOCK_PRICES, balance: L(0.4081), locked: L(0.35), vision: OWNER12 }),
    base({ tokens: MOCK_PRICES, balance: L(0.362), vision: [...OWNER12, vw(12, 0.006, [tok(BONK, 98_000_000_000n, 5)])] }),
    base({ tokens: MOCK_PRICES, waiting: [{ amount: L(0.2839), readyAt: BigInt(SLOT + 900) }], vision: OWNER12.slice(0, 2) }),
  ];
  for (const s of states) {
    const p = portfolio(s);
    const c = p.cents;
    assert.equal(sumOf(c.rows), c.total, "the rows add up to the total");
    p.assets.forEach((a, k) => assert.ok(a.usd == null || Math.abs(c.rows[k]! - a.usd * 100) < 1, `${a.key}: ${c.rows[k]} vs ${a.usd}`));
    const v = p.assets.findIndex((a) => a.key === "vision");
    assert.equal(sumOf([...c.sol.values()]), c.rows[v], "each wallet's SOL adds up to the Vision wallets row");
    let wallets = 0;
    for (const a of p.assets) {
      if (a.key !== "token") continue;
      const parts = a.wallets.map((x) => c.held.get(`${x.index}:${a.mint}`)!);
      assert.equal(sumOf(parts), c.rows[p.assets.indexOf(a)], `${a.symbol}: its wallets add up to its row`);
      a.wallets.forEach((x, i) => assert.ok(Math.abs(parts[i] - x.usd! * 100) < 1, `${a.symbol} in #${x.index + 1}: ${parts[i]} vs ${x.usd}`));
    }
    for (const w of s.vision) {
      const x = walletValue(p, w);
      wallets += x.cents ?? 0;
      assert.equal(x.cents, (x.sol ?? 0) + sumOf([...x.tokens.values()]), `wallet #${w.index + 1}: its sheet adds up to its row`);
    }
    const tokenRows = p.assets.map((a, k) => (a.key === "token" ? c.rows[k]! : 0));
    assert.equal(wallets, c.rows[v]! + sumOf(tokenRows), "the wallets add up to the Wallets header (the Vision row and the token rows)");
  }
});

test("from $10,000 the total shows whole dollars: each row simply rounded, and its parts still add up to it", () => {
  const p = portfolio(base({ tokens: MOCK_PRICES, balance: L(120), vision: OWNER12 }));
  assert.ok(p.usd! > 10_000);
  p.assets.forEach((a, k) => assert.equal(p.cents.rows[k], Math.round(a.usd! * 100)));
  const v = p.assets.findIndex((a) => a.key === "vision");
  assert.equal(sumOf([...p.cents.sol.values()]), p.cents.rows[v]);
});

test("one result per state: every screen asking with the same state and prices gets the same figures", () => {
  const shared = portfolioCache<object>();
  const st = {};
  let made = 0;
  const make = () => {
    made++;
    return base({ tokens: MOCK_PRICES, balance: L(0.0581), vision: OWNER12 });
  };
  // (the same prices, known to two screens in a different order)
  const a = { [BONK]: { symbol: "BONK", price: 0.0000221 }, [JUP]: { symbol: "JUP", price: 0.52 } };
  const b = { [JUP]: { symbol: "JUP", price: 0.52 }, [BONK]: { symbol: "BONK", price: 0.0000221 } };
  assert.equal(pricesKey(a), pricesKey(b));
  const home = shared(st, pricesKey(a), false, make);
  const wallets = shared(st, pricesKey(b), false, make);
  assert.equal(home, wallets);
  assert.equal(made, 1);
  // a new state, new prices or the first read finishing: worked out again
  assert.notEqual(shared({}, pricesKey(a), false, make), home);
  assert.notEqual(shared(st, pricesKey({ ...a, [BONK]: { symbol: "BONK", price: 0.00003 } }), false, make), home);
  assert.notEqual(shared(st, pricesKey(a), true, make), home);
  assert.equal(made, 4);
});

// ─── tokens with no price yet are said, never silently left out; tokens with no name never come first ───

test("a wallet with a token that has no price: its figure is its SOL, with '+ 1 without a price' beside it", () => {
  const tokens = { ...MOCK_PRICES, [WIF]: { symbol: "WIF", icon: null, price: null } };
  const p = portfolio(base({ tokens, vision: OWNER12 }));
  const w = walletValue(p, OWNER12[8]);
  assert.equal(w.unpriced, 1);
  assert.equal(w.tokens.get(WIF), null);
  assert.equal(w.cents, w.sol);
  assert.equal(centsText(w.cents, w.value), "$0.62");
  assert.equal(unpricedNote(w.unpriced), "+ 1 without a price");
  assert.equal(unpricedNote(0), "");
  // a token missing from what the search said counts too
  const q = portfolio(base({ tokens: { [BONK]: MOCK_PRICES[BONK] }, vision: OWNER12 }));
  assert.equal(walletValue(q, OWNER12[1]).unpriced, 1);
  assert.equal(q.unpriced, 2);
  // a test network has no dollar values at all: nothing is left out, so nothing to say
  const t = portfolio(base({ tokens: tokenPrices(MOCK_PRICES, false), solUsd: null, vision: OWNER12 }));
  const x = walletValue(t, OWNER12[8]);
  assert.equal(x.cents, null);
  assert.equal(x.unpriced, 0);
});

test("tokens without a name come after the named ones, by amount, never first", () => {
  // mints that sort before every name ("1…", "2…"): by mint they'd come first
  const ONE = "1".repeat(43) + "2";
  const TWO = "2".repeat(44);
  const tokens: PortfolioIn["tokens"] = { [BONK]: MOCK_PRICES[BONK], [JUP]: { symbol: "JUP", icon: null, price: null } };
  const p = portfolio(
    base({
      tokens,
      vision: [vw(0, 0.01, [tok(ONE, 5_000_000n, 6), tok(BONK, 1_000_000_000n, 5)]), vw(1, 0.01, [tok(TWO, 7_000n, 0), tok(JUP, 1_000_000n, 6)])],
    }),
  );
  // BONK (priced), JUP (named, no price), then the two with no name by amount: 7,000 before 5
  assert.deepEqual(
    p.assets.filter((a): a is Extract<Asset, { key: "token" }> => a.key === "token").map((t) => t.symbol ?? t.mint),
    ["BONK", "JUP", TWO, ONE],
  );
  const named = { symbol: "ZZZ", usd: null, amount: 1n, decimals: 0, mint: ONE };
  const unnamed = { symbol: null, usd: 5, amount: 10n ** 12n, decimals: 0, mint: TWO };
  assert.ok(tokenOrder(named, unnamed) < 0, "a named token without a price still comes before one with no name");
});

// ─── the moment after a move back: the moved SOL is counted once ───

test("moving back: the total neither dips nor counts the SOL twice, through the 0.1 s the wallet hasn't been read again", () => {
  const moved = L(0.1173);
  const deposit = { amount: moved, readyAt: BigInt(SLOT + 1500), vision: 0 };
  const before = portfolio(base({ balance: L(0.17), vision: [vw(0, 0.12)] }));
  assert.equal(before.sol, L(0.29));
  // the deposit landed; the waiting room doesn't show it yet, the wallet still shows its SOL (the engine reads it only later)
  const landed = portfolio(base({ balance: L(0.17), vision: [{ ...vw(0, 0.12), moved: [moved] }] }));
  assert.equal(landed.sol, before.sol);
  // the window the QA saw for 0.1 s (0.2895 -> 0.4069 SOL): the waiting room shows the deposit, the wallet isn't read again yet
  const window = base({ balance: L(0.17), waiting: [deposit], vision: [{ ...vw(0, 0.12), moved: [moved] }] });
  const both = portfolio(window);
  assert.equal(both.sol, before.sol, "counted once, in the wallet");
  assert.equal(portfolio({ ...window, vision: [vw(0, 0.12)] }).sol, before.sol + moved, "(without the dedupe: counted twice)");
  assert.equal(both.flights.length, 0);
  assert.equal(find(both.assets, "joining"), undefined);
  assert.equal(find(both.assets, "vision")!.sol, L(0.12));
  // the wallet read again (emptied): the deposit is in the waiting room, less the network fees
  const after = portfolio(base({ balance: L(0.17), waiting: [deposit], vision: [] }));
  assert.equal(after.sol, L(0.2873));
  assert.equal(after.flights[0].kind, "joining");
});

test("the same for a deposit address moving its SOL in (the Receive screen)", () => {
  const moved = L(0.2953);
  const deposits = [{ lamports: L(0.3), held: null, index: 4, moved: [moved] }];
  const p = portfolio(base({ deposits, waiting: [{ amount: moved, readyAt: BigInt(SLOT + 1500), deposit: 4 }] }));
  assert.equal(p.sol, L(0.3));
  assert.equal(find(p.assets, "address")!.sol, L(0.3));
  assert.equal(find(p.assets, "joining"), undefined);
  // read again: the address is empty, the deposit joins
  const q = portfolio(base({ deposits: [{ lamports: 0n, held: null, index: 4 }], waiting: [{ amount: moved, readyAt: BigInt(SLOT + 1500), deposit: 4 }] }));
  assert.equal(q.sol, moved);
});

test("a single payment now to a fresh Vision wallet: the total neither dips nor counts it twice, whenever the wallet is read", () => {
  // what the engine does (see sendMany, refreshVision and jobsInFlight): 0.25 SOL from a 0.2959 SOL balance (one note)
  const amount = L(0.25);
  const t0 = 1_000_000;
  const x: Paying = { amount, nfs: ["n1"], since: t0, at: Infinity, base: 0n };
  const inBalance = new Set(["n1"]);
  const spent = new Set<string>();
  // the engine's view of the wallet after a read that shows `read`, and the total from there
  const readInto = (shown: bigint, read: bigint, unspent: Set<string>, now: number) => (holdPayingRead(x, shown, read, unspent, now) ? shown : read);
  const total = (balance: bigint, shown: bigint, unspent: Set<string>, now: number) =>
    portfolio(base({ balance, vision: shown > 0n ? [{ index: 0, lamports: shown, tokens: [] }] : [], jobs: payingLands(x, shown, unspent, now) ? [{ index: 0, amount, latest: t0, held: false, landing: true }] : [] })).sol;
  const before = L(0.2959);
  const change = before - amount;
  // handed to the relayer: the note is still in the balance, the wallet shows nothing yet
  assert.equal(total(before, 0n, inBalance, t0 + 100), before);
  // it landed, the relayer hasn't answered yet: a read showing the 0.25 SOL in the wallet waits (the note is still counted)
  const held = readInto(0n, amount, inBalance, t0 + 600);
  assert.equal(held, 0n);
  assert.equal(total(before, held, inBalance, t0 + 600), before);
  assert.equal(total(before, amount, inBalance, t0 + 600), before + amount, "(taken then: counted twice)");
  // the relayer answered: the note leaves the balance; the wallet isn't read yet, so the payment counts as landing
  assert.equal(total(change, 0n, spent, t0 + 900), before);
  // a read made meanwhile (before the payment's own read) shows it in the wallet: it stops counting as landing at once
  const shown = readInto(0n, amount, spent, t0 + 1200);
  assert.equal(shown, amount);
  assert.equal(total(change, shown, spent, t0 + 1200), before);
  // a read from before it landed, answering late with the wallet still empty: landing again, never a dip
  assert.equal(total(change, readInto(shown, 0n, spent, t0 + 1300), spent, t0 + 1300), before);
  // after five minutes it's no longer followed: nothing held, nothing added
  assert.equal(holdPayingRead(x, 0n, amount, inBalance, t0 + PAYING_MS + 1), false);
  assert.equal(payingLands(x, 0n, spent, t0 + PAYING_MS + 1), false);
  // a wallet that held SOL before: it counts as landing until it shows more than that plus the payment
  const y: Paying = { ...x, base: L(0.01) };
  assert.equal(payingLands(y, L(0.01), spent, t0 + 900), true);
  assert.equal(payingLands(y, L(0.26), spent, t0 + 900), false);
  // a read showing less (or the same) is never held
  assert.equal(holdPayingRead(x, amount, 0n, inBalance, t0 + 600), false);
});

test("the website's total with the Vision wallets: no dollar figure stands for tokens nobody has looked up yet", () => {
  const jobs = Array.from({ length: 10 }, (_, k) => ({ index: 12 + k, amount: L(0.035), latest: 1000 + k, held: true, landing: false }));
  // the page hasn't asked about the tokens held (prices are looked up only where tokens are shown): SOL and tokens
  const fresh = portfolio(base({ balance: L(0.4081), locked: L(0.35), vision: OWNER12, jobs, tokens: {}, asked: false }));
  assert.equal(fresh.unpriced, 3);
  assert.equal(fresh.asked, false);
  assert.equal(pricedEnough(fresh, fresh.unpriced), false);
  assert.equal(totalWithWallets(fresh, "0.7708"), "Total with Vision wallets: 0.7708 SOL + 3 tokens");
  // answered: every figure in dollars
  const priced = portfolio(base({ balance: L(0.4081), locked: L(0.35), vision: OWNER12, jobs }));
  assert.equal(priced.asked, true);
  assert.equal(totalWithWallets(priced, "0.7708"), "Total with Vision wallets ≈ $148.14");
  // answered, and one token truly has no price: the dollar figure, saying so
  const odd = "NoPrice1111111111111111111111111111111111111";
  const vision = [...OWNER12.slice(0, 11), vw(11, 0.0175, [tok(odd, 300_000_000n, 6)])];
  const one = portfolio(base({ balance: L(0.4081), locked: L(0.35), vision, jobs, tokens: { ...PRICES, [odd]: { symbol: "NOPX", icon: null, price: null } }, asked: true }));
  assert.equal(one.unpriced, 1);
  assert.match(totalWithWallets(one, "0.7708"), /^Total with Vision wallets ≈ \$148\.14 \+ 1 without a price$/);
  // the same before the answer: no claim either way
  assert.equal(totalWithWallets({ ...one, asked: false }, "0.7708"), "Total with Vision wallets: 0.7708 SOL + 4 tokens");
  // only SOL in the wallets: dollars whatever was asked
  const sol = portfolio(base({ balance: L(0.1), vision: [vw(2, 0.0412)], tokens: {}, asked: false }));
  assert.equal(pricedEnough(sol, sol.unpriced), true);
  assert.match(totalWithWallets(sol, "0.1412"), /^Total with Vision wallets ≈ \$14\.56$/);
  // a test network: SOL only
  assert.equal(totalWithWallets(portfolio(base({ balance: L(0.1), vision: [vw(2, 0.0412)], solUsd: null })), "0.1412"), "Total with Vision wallets: 0.1412 SOL");
});

test("the website's balance line keeps one line on a wider screen until it can say two things, then two for the visit", () => {
  // nothing moving, nothing in Vision wallets: one line ("Only you can see this balance."), no empty line under it
  assert.equal(balanceLineRows(portfolio(base({ balance: L(0.3) })), false), 1);
  // one thing moving (the waiting room): it still fits one line
  assert.equal(balanceLineRows(portfolio(base({ balance: L(0.1), waiting: [{ amount: L(0.2), readyAt: BigInt(SLOT + 100) }] })), false), 1);
  // something in a Vision wallet (the total beside what's moving), or a payment on its way to one: two
  assert.equal(balanceLineRows(portfolio(base({ balance: L(0.1), vision: [vw(2, 0.0412)] })), false), 2);
  assert.equal(balanceLineRows(portfolio(base({ balance: L(0.1), vision: [vw(0, 0, [tok(BONK, 1n, 5)])] })), false), 2);
  const own = [{ index: 3, amount: L(0.035), latest: 1000, held: true, landing: false }];
  assert.equal(balanceLineRows(portfolio(base({ balance: L(0.1), jobs: own })), false), 2);
  assert.equal(balanceLineRows(portfolio(base({ balance: L(0.1), jobs: [{ ...own[0], held: false, landing: true }] })), false), 2);
  // once two, two for the rest of the visit: moving everything back never makes it shrink (and the page jump) later
  assert.equal(balanceLineRows(portfolio(base({ balance: L(0.3) })), true), 2);
});

test("only the deposits a wallet moved and still shows are left out: by source and amount, each once", () => {
  const a = L(0.05);
  const waiting = [
    { amount: a, readyAt: null, vision: 0 }, // moved just now, the wallet still shows it
    { amount: a, readyAt: null, vision: 0 }, // the same amount, moved earlier, already gone from the wallet
    { amount: L(0.07), readyAt: null, vision: 0 }, // another amount
    { amount: a, readyAt: null, vision: 1 }, // the same amount from another wallet
    { amount: a, readyAt: null, deposit: 0 }, // and from a deposit address
  ];
  assert.deepEqual([...stillAtSource(waiting, [{ index: 0, lamports: a, tokens: [], moved: [a] }], [])], [0]);
  assert.deepEqual([...stillAtSource(waiting, [{ index: 0, lamports: a, tokens: [], moved: [a, a, L(0.07)] }], [])].sort(), [0, 1, 2]);
  assert.deepEqual([...stillAtSource(waiting, [], [{ lamports: a, held: null, index: 0, moved: [a] }])], [4]);
  assert.equal(stillAtSource(waiting, [{ index: 2, lamports: a, tokens: [], moved: [a] }], []).size, 0);
  const p = portfolio(base({ waiting, vision: [{ index: 0, lamports: a, tokens: [], moved: [a] }] }));
  // the wallet's 0.05 once, the other four deposits each once
  assert.equal(p.sol, a + a * 3n + L(0.07));
  assert.equal(find(p.assets, "joining")!.count, 4);
});
