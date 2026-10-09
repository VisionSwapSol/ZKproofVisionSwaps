import { test } from "node:test";
import assert from "node:assert/strict";
import { Keeper, checkOrder, fastCheckMs, isB58, keeperError, left, UNPRICED_MS, UNPRICED_ERROR, type Book, type Exec, type Limits, type Order, type Plan, type PriceEntry, type SigState } from "../src/keeper.ts";

// A fake clock, a fake price book and a fake chain + Jupiter, so the keeper runs deterministically.

const SOL = "SOL";
const LIMITS: Limits = { minSellUsd: 2, minBuyLamports: 20_000_000n, minDcaBuyLamports: 10_000_000n, minDcaEverySec: 3600 };
let harnesses = 0;
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

type Hooks = {
  /** executable USD price per token at build time (defaults to the book's price) */
  px: Map<string, number>;
  /** throws instead of building, per order id (called each attempt) */
  fail?: (o: Order, plan: Plan) => Error | null;
  /** holds builds until released */
  hold?: Promise<void>;
  /** marks each sent trade as landed straight away */
  autoLand: boolean;
  /** the output token's transfer tax, as the route reports it */
  outFeeBps?: number;
  /** what a sent trade ends as (with autoLand) */
  landAs?: SigState;
  /** what the chain says a landed trade spent and delivered, per signature */
  landedAs?: Map<string, { spent?: string; got?: string }>;
};

function harness(o: { workers?: number; random?: () => number; saveNow?: () => Promise<void>; limits?: Limits } = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const prices = new Map<string, PriceEntry>();
  const watches = new Map<string, number>();
  const book: Book = { getPrice: (m) => prices.get(m) ?? null, setWatch: (m, ms) => void watches.set(m, ms), clearWatch: (m) => void watches.delete(m) };
  const chain = {
    height: 1_000,
    sigs: new Map<string, SigState>(),
    /** what statuses() says only when asked to search history */
    historyOnly: new Map<string, SigState>(),
    approvals: new Map<string, { delegate: string | null; delegated: bigint; balance: bigint }>(),
    keyHistory: new Map<string, { sig: string; t: number | null }[]>(),
    statusCalls: [] as { sigs: string[]; history: boolean }[],
  };
  const hooks: Hooks = { px: new Map(), autoLand: true };
  const log = { builds: [] as { id: string; trigger: string; amount: bigint; leg?: number; round?: number }[], sent: [] as string[], gates: [] as (bigint | undefined)[], solAsks: [] as unknown[], keyCalls: 0, probes: 0 };
  let inBuild = 0;
  let maxInBuild = 0;
  let n = 0;
  const name = `h${++harnesses}-`;
  const sol = { usd: 100 };
  const exec: Exec = {
    async build(ord, plan) {
      inBuild++;
      maxInBuild = Math.max(maxInBuild, inBuild);
      try {
        if (hooks.hold) await hooks.hold;
        const err = hooks.fail?.(ord, plan);
        if (err) throw err;
        log.builds.push({ id: ord.id, trigger: plan.trigger, amount: plan.amount, leg: plan.leg, round: plan.round });
        // an executable quote at the token's current price
        const px = hooks.px.get(ord.mint!) ?? prices.get(ord.mint!)?.usd ?? 1;
        const dec = ord.decimals ?? 6;
        const gross = ord.kind === "sell" ? BigInt(Math.floor(((Number(plan.amount) / 10 ** dec) * px * 1e9) / sol.usd)) : BigInt(Math.floor((((Number(plan.amount) / 1e9) * sol.usd) / px) * 10 ** dec));
        // like Jupiter: a taxed output token's amounts are what arrives, after its transfer tax
        const out = gross - (gross * BigInt(hooks.outFeeBps ?? 0)) / 10_000n;
        const threshold = (out * BigInt(10_000 - plan.slippageBps)) / 10_000n;
        log.gates.push(plan.gate?.({ out, threshold, arrives: plan.amount, outFeeBps: hooks.outFeeBps }));
        const sig = `${name}sig${++n}`;
        return {
          sig,
          lastValid: chain.height + 150,
          out: out.toString(),
          send: async () => {
            log.sent.push(sig);
            if (hooks.autoLand) chain.sigs.set(sig, hooks.landAs ?? "landed");
          },
        };
      } finally {
        inBuild--;
      }
    },
    async statuses(sigs, history) {
      chain.statusCalls.push({ sigs, history });
      return sigs.map((s) => chain.sigs.get(s) ?? (history ? (chain.historyOnly.get(s) ?? null) : null));
    },
    height: async () => chain.height,
    approval: async (ord) => chain.approvals.get(ord.id) ?? { delegate: ord.delegate!, delegated: left(ord), balance: left(ord) },
    history: async (ord) => chain.keyHistory.get(ord.id) ?? [],
    // like the real one: only trades the order key signed (this fake's own signatures) count
    landed: async (_ord, sig) => hooks.landedAs?.get(sig) ?? (sig.includes("sig") ? {} : null),
    async probe(ord, amount) {
      log.probes++;
      const px = hooks.px.get(ord.mint!) ?? 1;
      return { out: BigInt(Math.floor(((Number(amount) / 1e6) * px * 1e9) / sol.usd)), threshold: 0n, arrives: amount };
    },
    relayerOk: async () => true,
    solUsd: async (a) => {
      log.solAsks.push(a);
      return sol.usd;
    },
    decimals: async () => 6,
  };
  const saves = { n: 0 };
  const keeper = new Keeper(book, exec, {
    now: clock.now,
    random: o.random ?? (() => 0.5),
    workers: () => o.workers ?? 3,
    fastMs: () => 5_000,
    save: () => void saves.n++,
    saveNow: o.saveNow,
    limits: o.limits,
    solMint: SOL,
    inputKey: (x) => {
      log.keyCalls++;
      return `${x.owner}:${x.kind === "sell" ? x.mint : SOL}`;
    },
  });
  let ids = 0;
  const add = (p: Partial<Order> & { kind: Order["kind"] }) => {
    const id = (++ids).toString(16).padStart(24, "0");
    const ord: Order = {
      id,
      tokenHash: "",
      secret: "secret",
      delegate: `D${id}`,
      owner: `W${id}`,
      mint: "T0",
      program: "P",
      decimals: 6,
      amount: "1000000000",
      spent: "0",
      slippageBps: 300,
      created: clock.now(),
      expires: clock.now() + 30 * 86_400_000,
      status: "active",
      tries: 0,
      fills: [],
      ...p,
    };
    keeper.orders.set(id, ord);
    keeper.live(ord);
    return ord;
  };
  let block = 0;
  const push = (mint: string, usd: number, blockId = ++block) => {
    const e = { usd, at: clock.now(), blockId };
    prices.set(mint, e);
    keeper.onPrice(mint, e);
  };
  /** runs the loop for `ms`, a second at a time, letting every trade settle */
  const run = async (ms: number, step = 1_000) => {
    for (let x = 0; x < ms; x += step) {
      clock.advance(step);
      keeper.tick();
      await settle();
      await keeper.idle();
    }
  };
  return { keeper, clock, prices, watches, chain, hooks, log, add, push, run, sol, exec, saves, maxInBuild: () => maxInBuild };
}

test("1,000 orders over 300 tokens: a crash sells the 300 stop-losses first, and the loop never stalls", async () => {
  const h = harness({ workers: 3 });
  const tokens = Array.from({ length: 300 }, (_, i) => `T${i}`);
  for (const m of tokens) h.push(m, 1);
  const sls: Order[] = [];
  const others: Order[] = [];
  for (let i = 0; i < 1000; i++) {
    const mint = tokens[i % 300];
    if (i < 300) sls.push(h.add({ kind: "sell", mint, slUsd: 0.9, slSlippageBps: 1500, legs: [{ tpUsd: 2, amount: "1000000000" }] }));
    else if (i < 700) others.push(h.add({ kind: "sell", mint, legs: [{ tpUsd: 1.5, amount: "1000000000" }] }));
    else if (i < 900) others.push(h.add({ kind: "buy", mint, buyBelowUsd: 0.5, amount: "50000000" }));
    else others.push(h.add({ kind: "dca", mint, amount: "100000000", dca: { per: "20000000", every: 3600, count: 5, next: h.clock.now() + 5_000, done: 0 } }));
  }
  h.keeper.tick();
  assert.equal(h.keeper.stats().watchedTokens, 301, "every token plus SOL");
  // the crash: every token drops below its stop, then a newer price confirms it
  for (const m of tokens) h.push(m, 0.8);
  assert.equal(h.keeper.stats().armed, 300);
  // trades hang while they are built: the loop must keep going
  let release!: () => void;
  h.hooks.hold = new Promise<void>((r) => (release = r));
  h.clock.advance(6_000);
  for (const m of tokens) h.push(m, 0.79);
  const t0 = performance.now();
  h.keeper.tick(); // DCAs are due now too
  const tickMs = performance.now() - t0;
  await settle();
  assert.ok(tickMs < 200, `a tick over 1,000 orders took ${tickMs.toFixed(1)} ms`);
  assert.equal(h.keeper.stats().trading, 3, "three workers");
  // while trades hang, prices are still checked: a limit buy crossing is queued at once
  const before = h.keeper.stats().queue;
  h.push(tokens[1], 0.4);
  h.keeper.tick();
  assert.ok(h.keeper.stats().queue >= before, "the loop isn't blocked by trades");
  release();
  h.hooks.hold = undefined;
  await h.run(120_000);
  const order = h.log.builds.map((b) => b.trigger);
  const lastSl = order.lastIndexOf("sl");
  const firstOther = order.findIndex((x) => x !== "sl");
  assert.equal(order.filter((x) => x === "sl").length, 300);
  assert.ok(firstOther > lastSl, "every stop-loss is built before any other trade");
  assert.ok(sls.every((o) => o.status === "filled"), "every stop-loss sold");
  assert.ok(h.maxInBuild() <= 3, "never more than three trades built at once");
  assert.ok(others.filter((o) => o.kind === "dca").every((o) => o.fills.length >= 1), "DCAs ran after");
});

test("Jupiter or our own limiter being busy never fails an order", async () => {
  const h = harness();
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9 });
  let busy = 40;
  h.hooks.fail = () => (busy-- > 0 ? Object.assign(new Error("Jupiter is busy right now."), { status: 429 }) : null);
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(10 * 60_000);
  assert.equal(o.status, "filled");
  assert.equal(o.tries, 0, "busy is never counted as a failed try");
  assert.equal(h.log.builds.length, 1);
});

test("a trade whose confirmation timed out but landed ends filled, never cancelled", async () => {
  const h = harness();
  h.hooks.autoLand = false;
  h.push("T0", 1);
  // (a) only a search of the history finds it
  const a = h.add({ kind: "sell", slUsd: 0.9, owner: "A" });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(3_000);
  const sigA = a.pending!.sig;
  h.chain.historyOnly.set(sigA, "landed");
  // the approval is used up, as after a fill
  h.chain.approvals.set(a.id, { delegate: null, delegated: 0n, balance: 0n });
  h.chain.height = a.pending!.lastValid + 1;
  await h.run(10_000);
  assert.equal(a.status, "filled");
  assert.equal(a.fills[0].sig, sigA);
  assert.equal(h.log.builds.length, 1, "never sold twice");

  // (b) no status at all, but the order key's own history shows it landed
  const b = h.add({ kind: "sell", slUsd: 0.9, owner: "B", mint: "T1" });
  h.push("T1", 1);
  h.push("T1", 0.8);
  h.clock.advance(6_000);
  h.push("T1", 0.79);
  await h.run(3_000);
  const sigB = b.pending!.sig;
  h.chain.keyHistory.set(b.id, [{ sig: "approve-tx", t: b.created }, { sig: sigB, t: h.clock.now() }]);
  h.chain.approvals.set(b.id, { delegate: null, delegated: 0n, balance: 0n });
  h.chain.height = b.pending!.lastValid + 1;
  await h.run(10_000);
  assert.equal(b.status, "filled");
  assert.deepEqual(
    b.fills.map((f) => f.sig),
    [sigB],
    "the owner's approval isn't a fill",
  );
});

test("after a restart, a trade still on its way is settled before anything is retried", async () => {
  const h = harness();
  h.hooks.autoLand = false;
  h.push("T0", 1);
  const o = h.add({ kind: "dca", amount: "100000000", dca: { per: "20000000", every: 3600, count: 5, next: h.clock.now() + 1_000, done: 0 } });
  await h.run(3_000);
  assert.ok(o.pending, "a buy is on its way");
  const saved = h.keeper.serialize();
  // the server restarts: a new keeper reads the saved list
  const h2 = harness();
  h2.hooks.autoLand = false;
  h2.keeper.adopt(JSON.parse(saved));
  const o2 = h2.keeper.orders.get(o.id)!;
  assert.ok(o2.pending?.history, "settled from the chain's history");
  h2.chain.height = o2.pending!.lastValid + 1; // expired, never landed
  await h2.run(5_000);
  const first = h2.chain.statusCalls.findIndex((c) => c.history && c.sigs.includes(o.pending!.sig));
  assert.ok(first >= 0, "its signature was looked up first");
  assert.ok(!o2.pending || o2.pending.sig !== o.pending!.sig, "it never landed, so it was dropped");
  await h2.run(5_000);
  assert.equal(h2.log.builds.length, 1, "then the same round was tried again, once");
  assert.equal(h2.log.builds[0].round, 0, "the same round, not the next");

  // the same restart where it had landed: filled, nothing built again
  const h3 = harness();
  h3.keeper.adopt(JSON.parse(saved));
  const o3 = h3.keeper.orders.get(o.id)!;
  h3.chain.historyOnly.set(o3.pending!.sig, "landed");
  await h3.run(3_000);
  assert.equal(o3.dca!.done, 1);
  assert.equal(o3.fills.length, 1);
  assert.equal(h3.log.builds.length, 0, "never bought twice");
});

test("cancel during a trade: filled if it lands, cancelled if it doesn't", async () => {
  // (a) cancelled while the trade is built: it never goes out
  const h = harness();
  h.push("T0", 1);
  const a = h.add({ kind: "sell", slUsd: 0.9 });
  let release!: () => void;
  h.hooks.hold = new Promise<void>((r) => (release = r));
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await settle();
  assert.equal(h.keeper.stageOf(a), "trading");
  assert.deepEqual(h.keeper.cancel(a), { status: "cancelled", settling: true });
  release();
  await settle();
  await h.keeper.idle();
  assert.equal(a.status, "cancelled");
  assert.equal(h.log.sent.length, 0, "nothing was sent");
  assert.equal(a.secret, undefined, "the key is gone");
  assert.equal(a.owner, undefined, "and the wallet");

  // (b) cancelled after it was sent, and it lands: filled
  const h2 = harness();
  h2.hooks.autoLand = false;
  h2.push("T0", 1);
  const b = h2.add({ kind: "sell", slUsd: 0.9 });
  h2.push("T0", 0.8);
  h2.clock.advance(6_000);
  h2.push("T0", 0.79);
  await h2.run(2_000);
  assert.ok(b.pending);
  assert.deepEqual(h2.keeper.cancel(b), { status: "cancelled", settling: true });
  assert.equal(b.secret, undefined);
  h2.chain.sigs.set(b.pending!.sig, "landed");
  await h2.run(3_000);
  assert.equal(b.status, "filled");
  assert.equal(b.fills.length, 1);
  assert.match(b.error ?? "", /before the cancel/);
  assert.equal(b.owner, undefined, "settled: the wallet is dropped too");

  // (c) cancelled after it was sent, and it never lands: cancelled
  const h3 = harness();
  h3.hooks.autoLand = false;
  h3.push("T0", 1);
  const c = h3.add({ kind: "sell", slUsd: 0.9 });
  h3.push("T0", 0.8);
  h3.clock.advance(6_000);
  h3.push("T0", 0.79);
  await h3.run(2_000);
  h3.keeper.cancel(c);
  h3.chain.height = c.pending!.lastValid + 1;
  await h3.run(12_000);
  assert.equal(c.status, "cancelled");
  assert.equal(c.pending, undefined);
  assert.equal(c.fills.length, 0);
  assert.equal(h3.log.builds.length, 1, "not tried again");
});

test("trailing stop: follows the peak; with a fixed stop too, the higher one applies", async () => {
  const h = harness();
  h.push("T0", 1);
  const o = h.add({ kind: "sell", trailPct: 10, slUsd: 0.95 });
  assert.equal(o.peak, 1);
  assert.equal(h.keeper.stopOf(o), 0.95, "the fixed stop is higher than 1 x 0.9");
  h.push("T0", 1.5);
  assert.equal(o.peak, 1.5);
  assert.ok(Math.abs(h.keeper.stopOf(o)! - 1.35) < 1e-9);
  h.push("T0", 1.4);
  assert.equal(o.armed, undefined);
  h.push("T0", 1.34);
  assert.ok(o.armed, "armed below 1.35");
  h.push("T0", 1.36);
  assert.equal(o.armed, undefined, "the price came back: disarmed");
  h.push("T0", 1.3);
  h.clock.advance(6_000);
  h.push("T0", 1.29);
  await h.run(3_000);
  assert.equal(o.status, "filled");
  assert.equal(h.log.builds[0].trigger, "sl");
});

test("take-profit steps fill one by one; the stop sells whatever is left", async () => {
  const h = harness();
  h.push("T0", 1);
  const o = h.add({
    kind: "sell",
    amount: "1000",
    slUsd: 0.5,
    legs: [
      { tpUsd: 2, amount: "300" },
      { tpUsd: 3, amount: "300" },
      { tpUsd: 4, amount: "100" },
    ],
  });
  h.push("T0", 2.1);
  await h.run(3_000);
  assert.deepEqual(
    h.log.builds.map((b) => [b.leg, b.amount]),
    [[0, 300n]],
  );
  // the price jumps past two steps: they fill one after the other
  h.push("T0", 4.5);
  await h.run(5_000);
  assert.deepEqual(
    h.log.builds.map((b) => [b.leg, b.amount]),
    [
      [0, 300n],
      [1, 300n],
      [2, 100n],
    ],
  );
  assert.equal(o.status, "active", "300 tokens are still protected by the stop");
  assert.equal(left(o), 300n);
  h.push("T0", 0.4);
  h.clock.advance(6_000);
  h.push("T0", 0.39);
  await h.run(3_000);
  assert.equal(h.log.builds.at(-1)!.amount, 300n);
  assert.equal(o.status, "filled");
  assert.equal(o.fills.length, 4);
  assert.deepEqual(
    o.legs!.map((l) => l.filled),
    [true, true, true],
  );
});

test("the price gate: a limit buy or take-profit never fills worse than its price", async () => {
  const h = harness();
  h.push("T0", 1.1);
  const buy = h.add({ kind: "buy", buyBelowUsd: 1, amount: "100000000" });
  // the market's last trade says 0.99, but the route would really cost 1.20 a token
  h.hooks.px.set("T0", 1.2);
  h.push("T0", 0.99);
  await h.run(2_000);
  assert.equal(h.log.sent.length, 0, "nothing sent");
  assert.equal(buy.status, "active");
  assert.equal(buy.tries, 0);
  assert.match(buy.error!, /about \$1\.20/);
  // the route comes down: the next crossing after the pause fills, and the chain must guarantee the limit
  h.hooks.px.set("T0", 0.98);
  await h.run(61_000);
  h.push("T0", 0.97);
  await h.run(3_000);
  assert.equal(buy.status, "filled");
  // 0.1 SOL at $100 = $10, at most $1 a token = at least 10 tokens (6 decimals)
  assert.equal(h.log.gates.at(-1), 10_000_000n);

  const tp = h.add({ kind: "sell", legs: [{ tpUsd: 2, amount: "1000000000" }], mint: "T1", owner: "S" });
  h.push("T1", 1.5);
  h.hooks.px.set("T1", 1.8);
  h.push("T1", 2.05);
  await h.run(2_000);
  assert.equal(tp.status, "active", "a take-profit isn't sold at 1.80");
  assert.match(tp.error!, /selling now would get about \$1\.80/);
});

test("a stop-loss whose route shows the price came back is disarmed, not sold", async () => {
  const h = harness();
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9 });
  h.hooks.px.set("T0", 0.95); // the route pays 0.95, more than 2% above the stop
  h.push("T0", 0.85);
  h.clock.advance(6_000);
  h.push("T0", 0.84);
  await h.run(2_000);
  assert.equal(h.log.sent.length, 0);
  assert.equal(o.armed, undefined);
  assert.equal(o.status, "active");
});

test("DCA rounds land within ±10% of the interval, at most 30 minutes off; exact ones on time", async () => {
  for (const r of [0, 1]) {
    const h = harness({ random: () => r });
    const hour = h.add({ kind: "dca", amount: "100000000", dca: { per: "10000000", every: 3600, count: 10, next: 0, done: 0 } });
    const week = h.add({ kind: "dca", amount: "100000000", dca: { per: "10000000", every: 7 * 86_400, count: 10, next: 0, done: 0 } });
    const exact = h.add({ kind: "dca", amount: "100000000", dca: { per: "10000000", every: 3600, count: 10, next: 0, done: 0, exact: true } });
    const now = h.clock.now();
    const sign = r === 0 ? -1 : 1;
    assert.equal(h.keeper.nextRound(hour) - now, 3600_000 + sign * 360_000);
    assert.equal(h.keeper.nextRound(week) - now, 7 * 86_400_000 + sign * 30 * 60_000);
    assert.equal(h.keeper.nextRound(exact) - now, 3600_000);
  }
  // through the keeper: a round fills once, then waits for the next one
  const h = harness({ random: () => 0.75 });
  const d = h.add({ kind: "dca", amount: "30000000", dca: { per: "10000000", every: 3600, count: 3, next: 0, done: 0 } });
  await h.run(3_000);
  assert.equal(d.dca!.done, 1);
  const gap = d.dca!.next - h.clock.now();
  assert.ok(gap > 3600_000 && gap <= 3600_000 + 360_000);
  await h.run(10_000);
  assert.equal(d.dca!.done, 1, "no extra round");
  // the last round takes what's left
  h.clock.advance(2 * 3600_000 + 720_000);
  await h.run(3_000);
  h.clock.advance(3600_000 + 360_000);
  await h.run(3_000);
  assert.equal(d.status, "filled");
  assert.equal(d.fills.length, 3);
});

test("a token with no price: its stop-loss checks a real quote and sells at or below the stop", async () => {
  const h = harness();
  const o = h.add({ kind: "sell", slUsd: 0.5, amount: "1000000", mint: "RUG" });
  const p = h.add({ kind: "sell", slUsd: 0.1, amount: "1000000", mint: "RUG", owner: "P" });
  await h.run(UNPRICED_MS - 5_000);
  assert.equal(h.log.builds.length, 0, "not before a few minutes without a price");
  h.hooks.px.set("RUG", 0.3);
  await h.run(10_000);
  assert.equal(o.status, "filled", "the quote says 0.30, under the 0.50 stop");
  assert.equal(p.status, "active", "but over the 0.10 stop");
});

test("a token whose trades keep failing pauses, then the order gives up after 30 minutes", async () => {
  const h = harness({ workers: 1 });
  h.push("T0", 1);
  const orders = [0, 1, 2, 3].map((i) => h.add({ kind: "sell", slUsd: 0.9, owner: `O${i}` }));
  h.hooks.fail = () => Object.assign(new Error("No route for this pair right now."), { status: 400 });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(3_000);
  assert.equal(h.keeper.stats().pausedTokens, 1, "route failures for three wallets pause the token");
  assert.equal(orders.filter((o) => o.routeFails).length, 4, "stop-losses still try, each on its own backoff");
  assert.equal(h.keeper.stageOf(orders[3]), "retrying");
  await h.run(70 * 60_000, 5_000);
  assert.ok(orders.every((o) => o.status === "failed"), "no market for 30 minutes: failed, with a plain reason");
  assert.match(orders[0].error!, /No market/);
});

test("a paused token holds back take-profits, but one wallet alone can't pause it", async () => {
  const h = harness({ workers: 1 });
  h.push("T0", 1);
  // one wallet's take-profits keep failing (say its own account is broken)
  const bad = [0, 1, 2].map(() => h.add({ kind: "sell", legs: [{ tpUsd: 1.05, amount: "1000000000" }], owner: "BAD" }));
  h.hooks.fail = (o) => (o.owner === "BAD" ? Object.assign(new Error("No route for this pair right now."), { status: 400 }) : null);
  h.push("T0", 1.06);
  await h.run(3_000);
  assert.ok(bad.every((o) => o.routeFails === 1));
  assert.equal(h.keeper.stats().pausedTokens, 0, "one wallet's failures don't pause the token for everyone");
  const good = h.add({ kind: "sell", slUsd: 0.9, owner: "GOOD" });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(3_000);
  assert.equal(good.status, "filled");

  // failures for three wallets do pause it; a take-profit waits, a stop-loss doesn't
  const h2 = harness({ workers: 1 });
  h2.push("T0", 1);
  [0, 1, 2].forEach((i) => h2.add({ kind: "sell", legs: [{ tpUsd: 1.05, amount: "1000000000" }], owner: `B${i}` }));
  h2.hooks.fail = (o) => (o.owner!.startsWith("B") ? Object.assign(new Error("No route for this pair right now."), { status: 400 }) : null);
  h2.push("T0", 1.06);
  await h2.run(3_000);
  assert.equal(h2.keeper.stats().pausedTokens, 1);
  const tp = h2.add({ kind: "sell", legs: [{ tpUsd: 1.1, amount: "1000000000" }], owner: "TP" });
  const sl = h2.add({ kind: "sell", slUsd: 0.9, owner: "SL" });
  h2.push("T0", 1.12);
  await h2.run(3_000);
  assert.equal(tp.status, "active", "the take-profit waits out the pause");
  assert.equal(h2.keeper.stageOf(tp), "waiting");
  h2.push("T0", 0.8);
  h2.clock.advance(6_000);
  h2.push("T0", 0.79);
  await h2.run(3_000);
  assert.equal(sl.status, "filled", "a stop-loss is never held back by the pause");
});

test("failures in the orders' own wallets never pause the token for everyone", async () => {
  const h = harness({ workers: 1 });
  h.push("T0", 1);
  // three wallets whose trades can't go through because of something in the wallet itself (say, an account they closed)
  const bad = [0, 1, 2].map((i) => h.add({ kind: "sell", legs: [{ tpUsd: 1.05, amount: "1000000000" }], owner: `B${i}` }));
  h.hooks.fail = (o) => (o.owner!.startsWith("B") ? keeperError("keeper: the Vision wallet's account for the output is missing", "account") : null);
  h.push("T0", 1.06);
  await h.run(3_000);
  assert.ok(bad.every((o) => o.tries === 1 && !o.routeFails), "each one backs off on its own");
  assert.equal(h.keeper.stats().pausedTokens, 0, "the token's breaker never counts them");
  assert.match(bad[0].error!, /Vision wallet/);
  assert.equal(h.keeper.stageOf(bad[0]), "retrying");
  const tp = h.add({ kind: "sell", legs: [{ tpUsd: 1.1, amount: "1000000000" }], owner: "TP" });
  h.push("T0", 1.12);
  await h.run(3_000);
  assert.equal(tp.status, "filled", "another wallet's take-profit goes ahead");
  assert.ok(bad.every((o) => o.status === "active"), "and theirs keep trying");
});

test("the quickest check follows the Jupiter plan: 5 s on a free plan, between 2 s and 15 s", () => {
  assert.equal(fastCheckMs(60), 5_000);
  assert.equal(fastCheckMs(600), 2_000);
  assert.equal(fastCheckMs(10), 15_000);
  assert.equal(fastCheckMs(0), 15_000);
  assert.equal(fastCheckMs(100), 3_000);
});

test("a stop-loss that misses its price room tries again on the next price", async () => {
  const h = harness();
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9 });
  let slips = 1;
  h.hooks.fail = () => (slips-- > 0 ? Object.assign(new Error("slippage"), { code: "slippage" }) : null);
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(5_000);
  assert.equal(o.status, "active", "waits for a newer price");
  assert.equal(h.keeper.stageOf(o), "retrying");
  h.push("T0", 0.75);
  await h.run(2_000);
  assert.equal(o.status, "filled");
});

test("admission: prices on the wrong side, too small, too often, and the limits", () => {
  const sell = (b: Record<string, unknown>, price = 1, resume = false) => checkOrder("sell", { amount: "10000000", ...b }, { price, decimals: 6, resume, limits: LIMITS });
  // 10 tokens at $1 = $10
  assert.throws(() => sell({ tpUsd: 1 }), /take-profit at or below today's price \(\$1\.00\)/);
  assert.throws(() => sell({ slUsd: 1.2 }), /stop-loss at or above today's price/);
  assert.throws(() => sell({ tpUsd: 2, slUsd: 2.5 }, 3), /below the take-profit/);
  assert.throws(() => sell({ tpUsd: 2 }, 0.1), /about \$2 worth/);
  assert.throws(() => sell({}), /take-profit price, a stop-loss price, or both/);
  assert.throws(() => sell({ trailPct: 0.5 }), /1% to 50%/);
  assert.throws(() => sell({ trailPct: 51 }), /1% to 50%/);
  assert.throws(() => sell({ legs: [1, 2, 3, 4, 5].map((i) => ({ tpUsd: 1 + i, amount: "1000000" })) }), /at most 4/);
  assert.throws(() => sell({ legs: [{ tpUsd: 2, amount: "6000000" }, { tpUsd: 3, amount: "6000000" }] }), /add up to more/);
  const ok = sell({ tpUsd: 2, slUsd: 0.5, slippageBps: 9000 });
  assert.equal(ok.slippageBps, 2500, "price room is capped at 25%, as the keeper trades");
  assert.equal(ok.slSlippageBps, undefined, "a stop-loss uses the order's price room unless given its own");
  assert.equal(sell({ slUsd: 0.5, slSlippageBps: 1500 }).slSlippageBps, 1500);
  assert.deepEqual(ok.legs, [{ tpUsd: 2, amount: "10000000" }]);
  assert.equal(sell({ trailPct: 10, slSlippageBps: 4000 }).slSlippageBps, 2500);
  // an order handed back after the server lost it may already be past its price
  assert.doesNotThrow(() => sell({ tpUsd: 0.8 }, 1, true));
  assert.doesNotThrow(() => sell({ slUsd: 0.5 }, 0.01, true), "and worth little now");

  const buy = (b: Record<string, unknown>, price = 1) => checkOrder("buy", b, { price, decimals: 6, limits: LIMITS });
  assert.throws(() => buy({ amount: "50000000", buyBelowUsd: 1 }), /limit buy at or above today's price/);
  assert.throws(() => buy({ amount: "10000000", buyBelowUsd: 0.5 }), /start at 0\.02 SOL/);
  assert.doesNotThrow(() => buy({ amount: "20000000", buyBelowUsd: 0.5 }));

  const dca = (b: Record<string, unknown>, resume = false) => checkOrder("dca", b, { price: null, decimals: 6, resume, limits: LIMITS });
  assert.throws(() => dca({ amount: "100000000", count: 20, every: 3600 }), /at least 0\.01 SOL/);
  assert.throws(() => dca({ amount: "100000000", count: 5, every: 600 }), /every hour/);
  assert.throws(() => dca({ amount: "100000000", count: 1, every: 3600 }), /2 to 100 buys/);
  assert.equal(dca({ amount: "10000000", count: 1, every: 3600 }, true).dca!.count, 1, "one buy left, handed back");
  // every interval the app offers is accepted
  for (const every of [3600, 4 * 3600, 86_400, 7 * 86_400]) assert.doesNotThrow(() => dca({ amount: "40000000", count: 4, every }));
  assert.equal(dca({ amount: "40000000", count: 4, every: 3600 }).dca!.exact, false, "spread a little by default");

  // edits: the amount only goes down, and a single step follows it
  const prev = { kind: "sell", amount: "10000000", spent: "0", slippageBps: 300, legs: [{ tpUsd: 2, amount: "10000000" }], slUsd: 0.5 } as Order;
  assert.throws(() => checkOrder("sell", { amount: "20000000" }, { price: 1, decimals: 6, limits: LIMITS, prev }), /can only go down/);
  const lower = checkOrder("sell", { amount: "5000000" }, { price: 1, decimals: 6, limits: LIMITS, prev });
  assert.deepEqual(lower.legs, [{ tpUsd: 2, amount: "5000000" }]);
  assert.equal(lower.slUsd, 0.5, "fields not given stay as they were");
  assert.throws(() => checkOrder("sell", { slUsd: 1.5 }, { price: 1, decimals: 6, limits: LIMITS, prev }), /at or above today's price/);
  assert.equal(checkOrder("sell", { slUsd: null }, { price: 1, decimals: 6, limits: LIMITS, prev }).slUsd, undefined, "a stop can be removed");
});

test("watching: near a trigger every few seconds, far from it every few minutes, never watched once done", async () => {
  const h = harness();
  h.push("NEAR", 1);
  h.push("MID", 1);
  h.push("FAR", 1);
  h.push("STOP", 1);
  h.add({ kind: "sell", mint: "NEAR", legs: [{ tpUsd: 1.02, amount: "1" }], owner: "a" });
  h.add({ kind: "sell", mint: "MID", legs: [{ tpUsd: 1.2, amount: "1" }], owner: "b" });
  const far = h.add({ kind: "buy", mint: "FAR", buyBelowUsd: 0.5, owner: "c" });
  h.add({ kind: "sell", mint: "STOP", slUsd: 0.4, owner: "d" });
  h.keeper.tick();
  assert.equal(h.watches.get("NEAR"), 5_000);
  assert.equal(h.watches.get("MID"), 120_000);
  assert.equal(h.watches.get("FAR"), 300_000);
  assert.equal(h.watches.get("STOP"), 120_000, "a stop-loss is never checked less often than every 2 minutes");
  assert.equal(h.watches.get(SOL), 60_000);
  h.keeper.cancel(far);
  h.keeper.tick();
  assert.ok(!h.watches.has("FAR"));
});

test("terms changed while a trade waited its turn: the old trade never runs", async () => {
  const h = harness({ workers: 1 });
  h.push("T0", 1);
  const a = h.add({ kind: "sell", slUsd: 0.9, owner: "A" });
  const b = h.add({ kind: "sell", slUsd: 0.9, owner: "B" });
  const c = h.add({ kind: "sell", legs: [{ tpUsd: 0.5, amount: "1000000000" }], owner: "C" });
  const d = h.add({ kind: "dca", amount: "100000000", owner: "D", dca: { per: "20000000", every: 3600, count: 5, next: h.clock.now() + 1_000, done: 0 } });
  let release!: () => void;
  h.hooks.hold = new Promise<void>((r) => (release = r));
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  h.keeper.tick();
  await settle();
  assert.equal(h.keeper.stageOf(a), "trading");
  assert.equal(h.keeper.stageOf(b), "queued");
  assert.equal(h.keeper.stats().queue, 3, "b's stop-loss, c's take-profit and d's buy wait");
  // meanwhile the owners change their orders: no stop, the step already sold, the DCA paused
  delete b.slUsd;
  c.legs![0].filled = true;
  d.dca!.paused = true;
  release();
  h.hooks.hold = undefined;
  await h.run(10_000);
  assert.deepEqual(
    h.log.builds.map((x) => x.id),
    [a.id],
    "only a's stop-loss ran",
  );
  assert.equal(b.status, "active");
  assert.equal(d.fills.length, 0);
  // a stop-loss trade whose stop is gone refuses its quote too
  const gate = h.keeper.gateFor(b, "sl", undefined, 100, () => {})!;
  assert.throws(() => gate({ out: 1n, threshold: 1n, arrives: 1n }), (e: Error & { code?: string }) => e.code === "recovered");
});

test("a trade is written to disk before it is sent; cancelled meanwhile, it never goes out", async () => {
  const atSave: number[] = [];
  let hold: Promise<void> | null = null;
  const h = harness({
    saveNow: async () => {
      atSave.push(h.log.sent.length);
      if (hold) await hold;
    },
  });
  h.push("T0", 1);
  const a = h.add({ kind: "sell", slUsd: 0.9, owner: "A" });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(3_000);
  assert.equal(a.status, "filled");
  assert.deepEqual(atSave, [0], "saved once, before anything was sent");

  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  h.hooks.autoLand = false;
  h.push("T1", 1);
  const b = h.add({ kind: "sell", slUsd: 0.9, owner: "B", mint: "T1" });
  h.push("T1", 0.8);
  h.clock.advance(6_000);
  h.push("T1", 0.79);
  await settle();
  assert.ok(b.pending, "written down");
  assert.deepEqual(h.keeper.cancel(b), { status: "cancelled", settling: true });
  release();
  await settle();
  await h.keeper.idle();
  assert.equal(h.log.sent.length, 1, "b's trade never went out");
  h.chain.height = b.pending!.lastValid + 1;
  await h.run(12_000);
  assert.equal(b.status, "cancelled");
  assert.equal(b.pending, undefined);
  assert.equal(b.fills.length, 0);
});

test("after a restart, a sell nobody wrote down is matched to its take-profit step", async () => {
  const h = harness();
  const t = h.clock.now();
  const saved = {
    id: "a".repeat(24),
    tokenHash: "",
    secret: "secret",
    delegate: "DA",
    kind: "sell",
    owner: "WA",
    mint: "T0",
    program: "P",
    decimals: 6,
    amount: "1000",
    spent: "0",
    slUsd: 0.5,
    legs: [
      { tpUsd: 2, amount: "300" },
      { tpUsd: 3, amount: "300" },
    ],
    slippageBps: 300,
    created: t - 60_000,
    expires: t + 86_400_000,
    status: "active",
    tries: 0,
    fills: [],
  } as Order;
  h.keeper.adopt([saved]);
  const o = h.keeper.orders.get(saved.id)!;
  // the first step sold just before the restart, but the server never wrote it down
  h.chain.keyHistory.set(o.id, [{ sig: "lost-sig", t: t - 1_000 }]);
  h.hooks.landedAs = new Map([["lost-sig", { spent: "300", got: "5" }]]);
  h.chain.approvals.set(o.id, { delegate: "DA", delegated: 700n, balance: 700n });
  h.push("T0", 2.1);
  await h.run(5_000);
  assert.deepEqual(
    o.legs!.map((l) => !!l.filled),
    [true, false],
  );
  assert.equal(o.fills[0].leg, 0);
  assert.equal(left(o), 700n);
  assert.equal(h.log.builds.length, 0, "the step isn't sold a second time");
});

test("a landed trade with no block time yet still counts as filled", async () => {
  const h = harness();
  h.hooks.autoLand = false;
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9 });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(3_000);
  const sig = o.pending!.sig;
  h.chain.keyHistory.set(o.id, [{ sig, t: null }]);
  h.chain.approvals.set(o.id, { delegate: null, delegated: 0n, balance: 0n });
  h.chain.height = o.pending!.lastValid + 1;
  await h.run(10_000);
  assert.equal(o.status, "filled");
  assert.equal(o.fills[0].sig, sig);
});

test("trades that keep failing on-chain back off (one wallet's failures don't pause the token)", async () => {
  const h = harness({ workers: 1 });
  h.hooks.landAs = "failed";
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9 });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  for (let i = 0; i < 12; i++) {
    h.push("T0", 0.79 - i * 0.001);
    await h.run(3_000);
  }
  assert.equal(h.log.builds.length, 3, "three tries, then a wait");
  assert.equal(h.keeper.stats().pausedTokens, 0);
  assert.equal(o.chainFails, 3);
  assert.equal(o.status, "active", "still protected, just slower");
  assert.ok(o.retryAt! > h.clock.now(), "backing off");
});

test("most of the tokens moved away: the dust left is not traded", async () => {
  const h = harness({ limits: LIMITS });
  h.push("T0", 1);
  const a = h.add({ kind: "sell", slUsd: 0.9, owner: "A" });
  h.chain.approvals.set(a.id, { delegate: a.delegate!, delegated: 1_000_000_000n, balance: 100n });
  // a real crash: the tokens are all there, just worth little now; it still sells
  const b = h.add({ kind: "sell", slUsd: 0.9, owner: "B", amount: "1000000" });
  h.push("T0", 0.02);
  h.clock.advance(6_000);
  h.push("T0", 0.019);
  await h.run(3_000);
  assert.equal(a.status, "cancelled");
  assert.match(a.error!, /moved out/);
  assert.equal(b.status, "filled");
  assert.deepEqual(
    h.log.builds.map((x) => x.id),
    [b.id],
  );
});

test("a saved order whose key is already running here (handed back meanwhile) doesn't run twice", () => {
  const h = harness();
  const x = h.add({ kind: "sell", slUsd: 0.5, delegate: "DK" });
  const y = { ...x, id: "b".repeat(24), fills: [] } as Order;
  h.keeper.adopt([y]);
  assert.equal(h.keeper.orders.get(y.id)!.status, "cancelled");
  assert.equal(h.keeper.orders.get(y.id)!.secret, undefined);
  assert.equal(x.status, "active");
});

test("a limit buy on a taxed token counts the tokens that actually arrive", async () => {
  const h = harness();
  h.hooks.outFeeBps = 1000; // 10% transfer tax
  h.push("T0", 1.1);
  const buy = h.add({ kind: "buy", buyBelowUsd: 1, amount: "100000000" });
  h.hooks.px.set("T0", 0.95); // 0.95 a token before the tax, 1.06 for each that arrives
  h.push("T0", 0.99);
  await h.run(2_000);
  assert.equal(h.log.sent.length, 0);
  assert.match(buy.error!, /about \$1\.06/);
  h.hooks.px.set("T0", 0.88); // 0.98 for each that arrives: under the limit, so it fills
  await h.run(61_000);
  h.push("T0", 0.97);
  await h.run(3_000);
  assert.equal(buy.status, "filled");
  // $10 at most $1 a token = 10 tokens arriving (Jupiter's amounts are already after the tax: it isn't taken twice)
  assert.equal(h.log.gates.at(-1), 10_000_000n);
});

test("the no-price note goes away once the token has a price again", async () => {
  const h = harness();
  const o = h.add({ kind: "sell", slUsd: 0.5, mint: "RUG" });
  h.exec.probe = async () => {
    throw new Error("no route");
  };
  await h.run(UNPRICED_MS + 5_000);
  assert.equal(o.error, UNPRICED_ERROR);
  h.push("RUG", 1);
  assert.equal(o.error, null);
});

test("a paused DCA doesn't run out while paused; after 90 days paused it ends", async () => {
  const h = harness();
  const now = h.clock.now();
  const d = h.add({ kind: "dca", amount: "100000000", expires: now + 3600_000, dca: { per: "20000000", every: 3600, count: 5, next: now + 1_000, done: 0, paused: true, pausedAt: now } });
  await h.run(2 * 3600_000, 60_000);
  assert.equal(d.status, "active");
  assert.equal(d.fills.length, 0, "and buys nothing while paused");
  h.clock.advance(91 * 86_400_000);
  h.keeper.tick();
  assert.equal(d.status, "expired");
  assert.match(d.error!, /paused for 90 days/);
});

test("after a restart, DCA buys wait until a buy sent just before it could have settled", () => {
  const h = harness();
  const now = h.clock.now();
  const saved = { id: "c".repeat(24), tokenHash: "", secret: "s", delegate: "DC", kind: "dca", owner: "WC", mint: "T0", program: "P", decimals: 6, amount: "100000000", spent: "0", slippageBps: 300, created: now - 7200_000, expires: now + 86_400_000, status: "active", tries: 0, fills: [], dca: { per: "20000000", every: 3600, count: 5, next: now - 60_000, done: 1 } } as Order;
  h.keeper.adopt([saved]);
  assert.ok(saved.dca!.next - now >= 90_000);
});

test("a stop-loss on a token Jupiter stopped pricing tries again after a miss, without waiting for a price", async () => {
  // a miss at build time
  const h = harness();
  const o = h.add({ kind: "sell", slUsd: 0.5, amount: "1000000", mint: "RUG" });
  h.hooks.px.set("RUG", 0.3);
  let slips = 1;
  h.hooks.fail = () => (slips-- > 0 ? Object.assign(new Error("slippage"), { code: "slippage" }) : null);
  await h.run(UNPRICED_MS + 2_000);
  assert.equal(h.log.builds.length, 0);
  assert.match(o.error!, /moved too fast/);
  await h.run(15_000);
  assert.equal(o.status, "filled", "sold within seconds, not after a price that never comes");

  // a trade that failed on-chain
  const h2 = harness();
  const p = h2.add({ kind: "sell", slUsd: 0.5, amount: "1000000", mint: "RUG" });
  h2.hooks.px.set("RUG", 0.3);
  h2.hooks.landAs = "failed";
  await h2.run(UNPRICED_MS + 3_000);
  assert.equal(p.chainFails, 1);
  h2.hooks.landAs = "landed";
  await h2.run(15_000);
  assert.equal(p.status, "filled");

  // an order saved while waiting for a newer price that never came is not stuck
  const h3 = harness();
  const q = h3.add({ kind: "sell", slUsd: 0.5, amount: "1000000", mint: "RUG", afterPrice: h3.clock.now() });
  h3.hooks.px.set("RUG", 0.3);
  await h3.run(UNPRICED_MS + 5_000);
  assert.equal(q.status, "filled");
});

test("route failures count only a recent streak: a blip weeks ago doesn't end a stop-loss in a crash", async () => {
  const h = harness();
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9, legs: [{ tpUsd: 2, amount: "1000000000" }] });
  let fails = 1;
  const route = () => Object.assign(new Error("No route for this pair right now."), { status: 400 });
  h.hooks.fail = () => (fails-- > 0 ? route() : null);
  // day 1: one route failure, then the price comes back
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(3_000);
  assert.equal(h.log.builds.length, 0);
  h.push("T0", 1);
  assert.equal(o.routeFails, undefined, "the moment passed: the count starts over");
  // day 15: the crash, two route failures a minute or so apart, then a route
  h.clock.advance(14 * 86_400_000);
  h.push("T0", 1);
  fails = 2;
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  for (let i = 0; i < 6; i++) {
    await h.run(30_000, 2_000);
    h.push("T0", 0.78 - i * 0.01);
  }
  assert.equal(o.status, "filled", "never failed for an old blip");

  // even without the price coming back, an hour without a failure starts the count over
  const h2 = harness();
  h2.push("T0", 1);
  const p = h2.add({ kind: "sell", slUsd: 0.9, routeFails: 2, routeSince: h2.clock.now() - 14 * 86_400_000, failAt: h2.clock.now() - 2 * 3_600_000 });
  h2.hooks.fail = () => route();
  h2.push("T0", 0.8);
  h2.clock.advance(6_000);
  h2.push("T0", 0.79);
  await h2.run(3_000);
  assert.equal(p.status, "active");
  assert.equal(p.routeFails, 1);
});

test("old hiccups and take-profit refusals never slow a stop-loss down", async () => {
  // stale hiccup counts: the stop-loss still retries within seconds
  const h = harness();
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9, tries: 8, failAt: h.clock.now() - 2 * 3_600_000 });
  let hiccups = 1;
  h.hooks.fail = () => (hiccups-- > 0 ? new Error("fetch failed") : null);
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(8_000);
  assert.equal(o.status, "filled");

  // a take-profit's refusals don't lengthen the stop-loss's quiet time
  const h2 = harness();
  h2.push("T0", 1);
  const p = h2.add({ kind: "sell", slUsd: 0.9, legs: [{ tpUsd: 2, amount: "1000000000" }], cools: 10, failAt: h2.clock.now() });
  h2.hooks.px.set("T0", 0.95); // the route shows the price came back
  h2.push("T0", 0.85);
  h2.clock.advance(6_000);
  h2.push("T0", 0.84);
  await h2.run(1_000);
  assert.equal(p.slCools, 1);
  assert.ok(p.slQuietUntil! - h2.clock.now() <= 30_000, "quiet for 30 s, not 5 minutes");

  // a take-profit backing off: a stop-loss that fires meanwhile goes straight away
  const h3 = harness();
  h3.push("T0", 1);
  const q = h3.add({ kind: "sell", slUsd: 0.5, legs: [{ tpUsd: 1.5, amount: "1000000000" }], tries: 6, failAt: h3.clock.now() });
  let tpHiccup = 1;
  h3.hooks.fail = (_o, plan) => (plan.trigger === "tp" && tpHiccup-- > 0 ? new Error("fetch failed") : null);
  h3.push("T0", 1.6);
  await h3.run(2_000);
  assert.equal(q.retryFor, "tp");
  assert.ok(q.retryAt! - h3.clock.now() > 60_000, "the take-profit waits minutes");
  h3.push("T0", 0.4);
  h3.clock.advance(6_000);
  h3.push("T0", 0.39);
  await h3.run(2_000);
  assert.equal(q.status, "filled");
  assert.equal(h3.log.builds.at(-1)!.trigger, "sl");
});

test("handing out trades works out input accounts only for the trades it hands out", async () => {
  const h = harness({ workers: 3 });
  h.push("T0", 1);
  const tokens = Array.from({ length: 200 }, (_, i) => `M${i}`);
  for (const m of tokens) h.push(m, 1);
  for (const m of tokens) h.add({ kind: "sell", mint: m, slUsd: 0.9 });
  h.hooks.hold = new Promise<void>(() => {});
  for (const m of tokens) h.push(m, 0.8);
  h.clock.advance(6_000);
  const before = h.log.keyCalls;
  for (const m of tokens) h.push(m, 0.79);
  await settle();
  assert.equal(h.keeper.stats().trading, 3);
  assert.ok(h.log.keyCalls - before <= 6, `${h.log.keyCalls - before} lookups for 200 queued trades`);
  const again = h.log.keyCalls;
  h.keeper.dispatch();
  assert.equal(h.log.keyCalls, again, "with every worker busy, none at all");
});

test("unpriced tokens are asked a couple at a time; a busy refusal leaves no false note", async () => {
  const h = harness();
  for (let i = 0; i < 30; i++) h.add({ kind: "sell", slUsd: 0.5, amount: "1000000", mint: `U${i}`, owner: `W${i}` });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const probe = h.exec.probe;
  h.exec.probe = async (o, a) => {
    await gate;
    return probe(o, a);
  };
  h.clock.advance(UNPRICED_MS + 1_000);
  h.keeper.tick();
  h.keeper.tick();
  await settle();
  h.hooks.px.set("U0", 1);
  release();
  await h.keeper.idle();
  assert.ok(h.log.probes <= 2, `${h.log.probes} probes at once`);

  const h2 = harness();
  const o = h2.add({ kind: "sell", slUsd: 0.5, amount: "1000000", mint: "RUG" });
  let busy = 1;
  const real = h2.exec.probe;
  h2.exec.probe = async (x, a) => {
    if (busy-- > 0) throw Object.assign(new Error("Jupiter is busy right now."), { status: 429 });
    return real(x, a);
  };
  h2.hooks.px.set("RUG", 0.3);
  await h2.run(UNPRICED_MS + 1_000);
  assert.equal(o.error ?? null, null, "busy isn't 'no route'");
  await h2.run(35_000);
  assert.equal(o.status, "filled", "asked again within half a minute");
});

test("SOL's price: a stop-loss never waits on it, the price gates ask for a fresh one", async () => {
  const h = harness();
  h.push("T0", 1);
  h.add({ kind: "sell", slUsd: 0.9 });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(2_000);
  assert.deepEqual(h.log.solAsks.at(-1), { cachedOnly: true });
  h.add({ kind: "sell", legs: [{ tpUsd: 1.5, amount: "1000000000" }], mint: "T1", owner: "S" });
  h.push("T1", 1.6);
  await h.run(2_000);
  assert.deepEqual(h.log.solAsks.at(-1), { maxAgeMs: 15_000 });
});

test("after a restart, a sell nobody wrote down fills the lowest-priced step of its size", async () => {
  const h = harness();
  const t = h.clock.now();
  const saved = {
    id: "c".repeat(24),
    tokenHash: "",
    secret: "secret",
    delegate: "DC",
    kind: "sell",
    owner: "WC",
    mint: "T0",
    program: "P",
    decimals: 6,
    amount: "1000",
    spent: "0",
    legs: [
      { tpUsd: 2, amount: "300" },
      { tpUsd: 1.5, amount: "300" },
    ],
    slippageBps: 300,
    created: t - 60_000,
    expires: t + 86_400_000,
    status: "active",
    tries: 0,
    fills: [],
  } as Order;
  h.keeper.adopt([saved]);
  const o = h.keeper.orders.get(saved.id)!;
  h.chain.keyHistory.set(o.id, [{ sig: "lost-sig", t: t - 1_000 }]);
  h.hooks.landedAs = new Map([["lost-sig", { spent: "300", got: "5" }]]);
  h.chain.approvals.set(o.id, { delegate: "DC", delegated: 700n, balance: 700n });
  h.push("T0", 1.6);
  await h.run(5_000);
  assert.deepEqual(
    o.legs!.map((l) => !!l.filled),
    [false, true],
  );
  assert.equal(h.log.builds.length, 0, "nothing more sold under $2");
});

test("after a restart, a stop-loss on an unpriced token still won't trade the dust left", async () => {
  const h = harness({ limits: LIMITS });
  const t = h.clock.now();
  const saved = { id: "d".repeat(24), tokenHash: "", secret: "secret", delegate: "DD", kind: "sell", owner: "WD", mint: "RUG", program: "P", decimals: 6, amount: "100000000", spent: "0", slUsd: 0.5, slippageBps: 300, created: t - 60_000, expires: t + 86_400_000, status: "active", tries: 0, fills: [] } as Order;
  h.keeper.adopt([saved]);
  const o = h.keeper.orders.get(saved.id)!;
  // 99% of the tokens moved out; what's left is worth cents
  h.chain.approvals.set(o.id, { delegate: "DD", delegated: 100_000_000n, balance: 1_000_000n });
  h.hooks.px.set("RUG", 0.3);
  await h.run(UNPRICED_MS + 5_000);
  assert.equal(h.log.builds.length, 0);
  assert.equal(o.status, "cancelled");
  assert.match(o.error!, /moved out/);
});

test("order keys and addresses: long strings are refused before decoding", () => {
  const t0 = performance.now();
  assert.equal(isB58("z".repeat(100_000), 64, 88), false);
  assert.ok(performance.now() - t0 < 50);
  assert.equal(isB58("So11111111111111111111111111111111111111112", 32, 44), true);
  assert.equal(isB58("0OIl".repeat(10), 32, 44), false, "not base58");
  assert.equal(isB58(123, 32, 44), false);
});

test("on-chain failures still count after a stop-loss disarms and fires again: it keeps trying, just slower", async () => {
  const h = harness({ workers: 1 });
  h.hooks.landAs = "failed";
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9 });
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  for (let i = 0; i < 12; i++) {
    h.push("T0", 0.79 - i * 0.001);
    await h.run(3_000);
  }
  assert.equal(o.chainFails, 3);
  // the price swings back above the stop and down again
  h.push("T0", 1);
  assert.equal(o.armed, undefined);
  assert.equal(o.chainFails, 3, "the fees those failures cost still count");
  const before = h.log.builds.length;
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  for (let i = 0; i < 10; i++) {
    h.push("T0", 0.79 - i * 0.001);
    await h.run(3_000);
  }
  assert.equal(h.log.builds.length, before + 1, "one try, then a wait");
  assert.equal(o.chainFails, 4);
  assert.equal(o.retryFor, "sl");
  assert.ok(o.retryAt! > h.clock.now(), "backing off");
  // ... and it never stops trying while the price stays under the stop
  for (let i = 0; i < 20; i++) {
    h.push("T0", 0.7 - i * 0.001);
    await h.run(3_000);
  }
  assert.equal(h.log.builds.length, before + 2);
  assert.equal(o.status, "active");
});

test("a backoff saved by 1.4.0 never holds a stop-loss back after the upgrade", async () => {
  const h = harness();
  h.push("T0", 1);
  const now = h.clock.now();
  const base = { tokenHash: "", secret: "s", mint: "T0", program: "P", decimals: 6, spent: "0", slippageBps: 300, created: now, expires: now + 86_400_000, status: "active", tries: 0, fills: [] };
  const sell = { ...base, id: "d".repeat(24), delegate: "DL", owner: "WL", kind: "sell", amount: "1000000000", slUsd: 0.9, retryAt: now + 10 * 60_000 } as Order;
  const buy = { ...base, id: "e".repeat(24), delegate: "DB", owner: "WB", kind: "buy", amount: "50000000", buyBelowUsd: 0.5, retryAt: now + 60_000 } as Order;
  h.keeper.adopt([sell, buy]);
  assert.equal(sell.retryAt, undefined, "a sell's old backoff could be a take-profit's: it goes");
  assert.equal(buy.retryFor, "buy", "a buy's is its own");
  h.push("T0", 0.8);
  h.clock.advance(6_000);
  h.push("T0", 0.79);
  await h.run(3_000);
  assert.equal(sell.status, "filled");
});

test("a stop-loss never takes on a take-profit's backoff, in its status or after it fails on-chain", async () => {
  const h = harness({ workers: 1 });
  h.push("T0", 1);
  h.push("T1", 1);
  const now = h.clock.now();
  const q = h.add({ kind: "sell", slUsd: 0.9, legs: [{ tpUsd: 2, amount: "1000000000" }], retryAt: now + 10 * 60_000, retryFor: "tp", chainFails: 2, failAt: now });
  // another order's trade holds the only worker, so the stop-loss waits in the queue
  let release!: () => void;
  h.hooks.hold = new Promise<void>((r) => (release = r));
  h.add({ kind: "sell", mint: "T1", slUsd: 0.9 });
  h.push("T1", 0.8);
  h.clock.advance(6_000);
  h.push("T1", 0.79);
  await settle();
  h.push("T0", 0.8);
  h.clock.advance(1_000);
  h.push("T0", 0.79);
  await settle();
  assert.equal(h.keeper.stageOf(q), "queued", "ready to go, not retrying");
  assert.ok(h.keeper.nextCheckAt(q)! < q.retryAt!, "not the take-profit's wait");
  // it goes out and fails on-chain: its own backoff starts from the 30 s step, not the take-profit's 10 minutes
  h.hooks.landAs = "failed";
  release();
  h.hooks.hold = undefined;
  await h.run(4_000);
  assert.equal(q.chainFails, 3);
  assert.equal(q.retryFor, "sl");
  assert.ok(q.retryAt! - h.clock.now() <= 30_000, `${q.retryAt! - h.clock.now()} ms`);
});

test("a token with no price keeps its last quoted price current for the dust guard", async () => {
  const h = harness();
  const o = h.add({ kind: "sell", slUsd: 0.5, mint: "RUG" });
  h.hooks.px.set("RUG", 0.8);
  await h.run(UNPRICED_MS + 25_000);
  assert.ok(Math.abs(o.lastPrice! - 0.8) < 1e-6, String(o.lastPrice));
  h.hooks.px.set("RUG", 0.6);
  await h.run(3 * 60_000);
  assert.ok(Math.abs(o.lastPrice! - 0.6) < 1e-6, String(o.lastPrice));
  assert.equal(o.status, "active");
});

test("stalled trades are only ready ones not handed out: a backoff or a paused token never reads as a stall", async () => {
  // one DCA whose token has no route at all: it backs off for minutes at a time, and that is "retrying"
  const a = harness();
  a.hooks.fail = () => keeperError("no route", "route");
  a.add({ kind: "dca", amount: "100000000", dca: { per: "20000000", every: 3600, count: 5, next: a.clock.now() + 1_000, done: 0 } });
  let worst = 0;
  for (let s = 0; s < 25 * 60; s++) {
    await a.run(1_000);
    worst = Math.max(worst, a.keeper.stats().oldestQueuedSec);
  }
  assert.ok(worst <= 300, `a DCA in its own backoff read as stalled for ${worst}s`);

  // three owners' DCAs on a token whose breaker pauses it again and again
  const b = harness();
  b.push("T0", 1);
  b.hooks.fail = () => keeperError("no route", "route");
  for (let i = 0; i < 3; i++) b.add({ kind: "dca", amount: "100000000", dca: { per: "20000000", every: 3600, count: 5, next: b.clock.now() + 1_000, done: 0 } });
  worst = 0;
  for (let s = 0; s < 20 * 60; s += 5) {
    await b.run(5_000, 5_000);
    worst = Math.max(worst, b.keeper.stats().oldestQueuedSec);
  }
  assert.ok(worst <= 300, `DCAs on a paused token read as stalled for ${worst}s`);

  // builds that never finish, with more ready trades than workers: that is a real stall
  const c = harness({ workers: 1 });
  c.push("T0", 1);
  c.hooks.hold = new Promise<void>(() => {});
  for (let i = 0; i < 3; i++) c.add({ kind: "dca", amount: "100000000", dca: { per: "20000000", every: 3600, count: 5, next: c.clock.now() + 1_000, done: 0 } });
  for (let s = 0; s < 6 * 60; s += 5) {
    c.clock.advance(5_000);
    c.keeper.tick();
    await settle();
  }
  assert.ok(c.keeper.stats().oldestQueuedSec > 300, "ready trades waiting on stuck workers are reported");
});

test("reset forgets every order and its watches, so the stored list can be read again", () => {
  const h = harness();
  h.push("T0", 1);
  h.add({ kind: "sell", legs: [{ tpUsd: 2, amount: "1000000000" }] });
  h.keeper.tick();
  assert.ok(h.watches.size > 0);
  h.keeper.stopping = true;
  h.keeper.reset();
  assert.equal(h.keeper.orders.size, 0);
  assert.equal(h.watches.size, 0);
  assert.equal(h.keeper.stopping, false);
  assert.equal(h.keeper.stats().queue, 0);
});

test("a stopped keeper acts on no price, saves nothing and polls no token, and starts again cleanly", () => {
  const h = harness();
  h.push("T0", 1);
  const o = h.add({ kind: "sell", slUsd: 0.9 });
  h.keeper.tick();
  assert.ok(h.watches.size > 0);
  h.keeper.stop();
  assert.equal(h.watches.size, 0, "no token is polled for a stopped keeper");
  const saved = h.saves.n;
  h.push("T0", 0.5);
  assert.equal(o.armed, undefined, "a price below the stop arms nothing");
  assert.equal(h.saves.n, saved, "and nothing is saved");
  assert.equal(h.watches.size, 0, "nor is the token watched again");
  h.keeper.tick();
  assert.equal(h.watches.size, 0);
  // read again (another copy ran the orders meanwhile) and running: prices count again
  h.keeper.reset();
  h.keeper.adopt([{ ...o, armed: undefined }]);
  h.push("T0", 0.5);
  assert.ok(h.keeper.orders.get(o.id)!.armed, "the restarted keeper arms the stop-loss");
  assert.ok(h.watches.size > 0);
});
