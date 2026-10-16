import { test } from "node:test";
import assert from "node:assert/strict";
import { walletName, walletNumbers, walletsName, ownPaidText, walletStatus, fundAmounts, FUND_MIN, VARY_BPS, bulkPlan, bulkCount, bulkWhyText, walletsLine, type BulkWallet } from "../src/lib/vwallets.ts";

test("wallet names and numbers", () => {
  assert.equal(walletName(3), "Vision wallet #4");
  assert.equal(walletNumbers([0]), "#1");
  assert.equal(walletNumbers([6, 0, 1, 2, 3, 4, 5]), "#1–#7");
  assert.equal(walletNumbers([0, 1]), "#1 and #2");
  assert.equal(walletNumbers([4, 1]), "#2 and #5");
  assert.equal(walletNumbers([0, 2, 3]), "#1, #3 and #4");
  assert.equal(walletNumbers([2, 2, 3, 4]), "#3–#5");
  assert.equal(walletsName([3]), "Vision wallet #4");
  assert.equal(walletsName([3, 3]), "Vision wallet #4");
  assert.equal(walletsName([0, 1, 2]), "Vision wallets #1–#3");
});

test("the message after paying the person's own wallets", () => {
  assert.equal(ownPaidText([3], true), "Your SOL is in Vision wallet #4. Use it, move it back, or export its key in the Wallets tab.");
  assert.equal(
    ownPaidText([0, 1, 2, 3, 4, 5, 6], false),
    "Your SOL is going to Vision wallets #1–#7. Find them in the Wallets tab: buy with them, move the SOL back, or export their keys.",
  );
  assert.match(ownPaidText([3], false), /^Your SOL is going to Vision wallet #4\. Find it in the Wallets tab/);
  assert.match(ownPaidText([0, 1], true), /^Your SOL is in Vision wallets #1 and #2\./);
});

test("a wallet row's status", () => {
  const base = { lamports: 0n, tokens: 0, finishable: false, arriving: false, sweepMin: 12_000_000n };
  assert.equal(walletStatus(base), "empty");
  assert.equal(walletStatus({ ...base, arriving: true }), "arriving");
  assert.equal(walletStatus({ ...base, lamports: 1_000_000_000n }), "ready");
  // SOL already there and more on its way: usable now
  assert.equal(walletStatus({ ...base, lamports: 1_000_000_000n, arriving: true }), "ready");
  assert.equal(walletStatus({ ...base, lamports: 5_000_000n }), "small");
  assert.equal(walletStatus({ ...base, lamports: 5_000_000n, sweepMin: null }), "ready");
  assert.equal(walletStatus({ ...base, lamports: 6_000_000n, tokens: 1 }), "tokens");
  assert.equal(walletStatus({ ...base, lamports: 0n, tokens: 1 }), "tokens");
  assert.equal(walletStatus({ ...base, lamports: 900_000_000n, finishable: true }), "finish");
});

test("fund amounts: exact, or each varied on its own by at most 3% (to the lamport), never below the floor", () => {
  assert.deepEqual(fundAmounts(500_000_000n, 3, false), [500_000_000n, 500_000_000n, 500_000_000n]);
  let k = 0;
  const seq = [0, 0.999999, 0.5, 0.25, 0.75];
  const rnd = () => seq[k++ % seq.length];
  const a = fundAmounts(1_000_000_000n, 5, true, rnd);
  assert.equal(a.length, 5);
  for (const x of a) {
    assert.ok(x >= 1_000_000_000n - (1_000_000_000n * BigInt(VARY_BPS)) / 10_000n - 100_000n, `${x} too low`);
    assert.ok(x <= 1_000_000_000n + (1_000_000_000n * BigInt(VARY_BPS)) / 10_000n, `${x} too high`);
  }
  assert.equal(a[0], 970_000_000n);
  assert.equal(a[2], 1_000_000_000n);
  // with real randomness, the amounts differ, and don't sit on a shared 0.0001 SOL grid
  const r = fundAmounts(1_000_000_000n, 10, true);
  assert.ok(new Set(r.map(String)).size > 1);
  assert.ok(r.filter((x) => x % 1_000n === 0n).length < 3);
  // and Math.random is never used for them
  const real = Math.random;
  Math.random = () => {
    throw new Error("Math.random used");
  };
  try {
    fundAmounts(1_000_000_000n, 3, true);
  } finally {
    Math.random = real;
  }
  // a floor holds
  assert.ok(fundAmounts(FUND_MIN, 20, true, Math.random, FUND_MIN).every((x) => x >= FUND_MIN));
});

test("wallet numbers fold runs of three or more inside a longer list", () => {
  assert.equal(walletNumbers([0, 1, 2, 3, 4, 5, 6, 7, 8, 10]), "#1–#9 and #11");
  assert.equal(walletNumbers([0, 2, 3, 4, 7]), "#1, #3–#5 and #8");
  assert.equal(walletNumbers([0, 1, 3, 4]), "#1, #2, #4 and #5");
  assert.equal(walletsName([0, 1, 2, 3, 4, 5, 6, 7, 8, 10]), "Vision wallets #1–#9 and #11");
});

const SWEEP_MIN = 12_000_000n;
const MIN_BUY = 10_000_000n + 6_000_000n;
// the owner's twelve wallets (#1, #2 and #9 hold tokens, #10 a leftover), as the Wallets tab builds them
const owner12 = (): BulkWallet[] =>
  [
    [0.05, 1],
    [0.0061, 1],
    [0.0412, 0],
    [0.0398, 0],
    [0.0405, 0],
    [0.0388, 0],
    [0.042, 0],
    [0.0391, 0],
    [0.006, 1],
    [0.0015, 0],
    [0.0402, 0],
    [0.0175, 0],
  ].map(([sol, tokens], index) => {
    const lamports = BigInt(Math.round(sol * 1e9));
    return { index, lamports, tokens, buyable: !tokens && lamports >= MIN_BUY, finish: false, busy: false };
  });

test("the selection bar: what each action does with the owner's twelve wallets", () => {
  const p = bulkPlan(owner12(), SWEEP_MIN);
  assert.deepEqual(p.buy.ok, [2, 3, 4, 5, 6, 7, 10, 11]);
  assert.deepEqual(p.move.ok, [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11]);
  assert.deepEqual(p.move.left, [{ index: 9, why: "small" }]);
  assert.deepEqual(p.move.now, [0, 1, 2, 3, 4, 5, 6, 7, 8, 10]);
  assert.deepEqual(p.move.later, [11]);
  assert.deepEqual(p.send.ok, [2, 3, 4, 5, 6, 7, 10, 11]);
  assert.deepEqual(
    p.send.left.map((l) => [l.index, l.why]),
    [
      [0, "tokens"],
      [1, "tokens"],
      [8, "tokens"],
      [9, "small"],
    ],
  );
  assert.deepEqual(
    p.buy.left.map((l) => [l.index, l.why]),
    [
      [0, "tokens"],
      [1, "tokens"],
      [8, "tokens"],
      [9, "low"],
    ],
  );
  // the owner's screenshot: #1-#9 ticked
  const nine = bulkPlan(owner12().slice(0, 9), SWEEP_MIN);
  assert.equal(bulkCount(nine.buy, 9), "6 of 9");
  assert.equal(bulkCount(nine.move, 9), "9 wallets");
  assert.equal(bulkCount(nine.send, 9), "6 of 9");
  // a sweep minimum not known yet: every wallet with SOL can move
  assert.deepEqual(bulkPlan(owner12(), null).move.ok.length, 12);
});

test("a wallet already at work sits out every action", () => {
  const ws = owner12().map((w) => (w.index === 3 ? { ...w, busy: true } : w));
  const p = bulkPlan(ws, SWEEP_MIN);
  for (const a of [p.buy, p.move, p.send]) {
    assert.ok(!a.ok.includes(3));
    assert.deepEqual(
      a.left.find((l) => l.index === 3),
      { index: 3, why: "busy" },
    );
  }
});

test("bar counts", () => {
  const part = (ok: number[]) => ({ ok, now: ok, later: [], left: [] });
  assert.equal(bulkCount(part([1, 2, 3, 4, 5, 6, 7, 8, 9]), 9), "9 wallets");
  assert.equal(bulkCount(part([4]), 1), "1 wallet");
  assert.equal(bulkCount(part([1, 2, 3, 4, 5, 6, 7]), 9), "7 of 9");
  assert.equal(bulkCount(part([]), 9), "None");
});

test("a wallet whose only token account is empty can move back, not buy or send all (as today)", () => {
  const w: BulkWallet = { index: 0, lamports: 40_000_000n, tokens: 1, buyable: false, finish: false, busy: false };
  const p = bulkPlan([w], SWEEP_MIN);
  assert.deepEqual(p.move.ok, [0]);
  assert.deepEqual(p.buy.left, [{ index: 0, why: "tokens" }]);
  assert.deepEqual(p.send.left, [{ index: 0, why: "tokens" }]);
});

test("why a wallet sits out, one sentence per reason", () => {
  assert.deepEqual(bulkWhyText("buy", [{ index: 1, why: "tokens" }]), ["Vision wallet #2 already holds a token."]);
  assert.deepEqual(
    bulkWhyText("buy", [
      { index: 0, why: "tokens" },
      { index: 1, why: "tokens" },
      { index: 9, why: "low" },
    ]),
    ["Vision wallets #1 and #2 already hold a token.", "Vision wallet #10 has too little SOL to buy with."],
  );
  assert.deepEqual(bulkWhyText("buy", [{ index: 4, why: "finish" }]), ["Vision wallet #5 has a buy to finish: open it to finish or move the SOL back."]);
  assert.deepEqual(
    bulkWhyText("buy", [
      { index: 4, why: "finish" },
      { index: 5, why: "finish" },
    ]),
    ["Vision wallets #5 and #6 have a buy to finish: open each one to finish or move the SOL back."],
  );
  assert.deepEqual(bulkWhyText("move", [{ index: 9, why: "small" }]), ["Vision wallet #10 holds less than the smallest deposit, so it stays as it is."]);
  assert.deepEqual(
    bulkWhyText("move", [
      { index: 9, why: "small" },
      { index: 10, why: "small" },
    ]),
    ["Vision wallets #10 and #11 hold less than the smallest deposit, so they stay as they are."],
  );
  assert.deepEqual(bulkWhyText("send", [{ index: 0, why: "tokens" }]), ["Vision wallet #1 holds tokens. Sending all is for wallets that hold only SOL."]);
  assert.deepEqual(
    bulkWhyText("send", [
      { index: 0, why: "tokens" },
      { index: 8, why: "tokens" },
    ]),
    ["Vision wallets #1 and #9 hold tokens. Sending all is for wallets that hold only SOL."],
  );
  assert.deepEqual(bulkWhyText("send", [{ index: 9, why: "small" }]), ["Vision wallet #10 holds only a small leftover. Open the wallet to send it on its own."]);
  assert.deepEqual(bulkWhyText("send", [{ index: 3, why: "busy" }]), ["Vision wallet #4 is busy with another action. It can go when that ends."]);
  assert.deepEqual(
    bulkWhyText("move", [
      { index: 3, why: "busy" },
      { index: 4, why: "busy" },
    ]),
    ["Vision wallets #4 and #5 are busy with another action. They can go when that ends."],
  );
});

test("the Wallets header's line names the tokens before a dollar figure that counts them, and says what it leaves out", () => {
  const o = { wallets: 12, sol: "0.3627", tokens: 3, usd: "$106.07", coming: 10, masked: false };
  assert.equal(walletsLine(o), "12 wallets · 0.3627 SOL + 3 tokens ≈ $106.07 · 10 arriving");
  // no dollar values (a test network, or nothing priced): no dollar figure
  assert.equal(walletsLine({ ...o, usd: null, coming: 0 }), "12 wallets · 0.3627 SOL + 3 tokens");
  // a token with no price yet: the figure says it leaves it out, never silently
  assert.equal(walletsLine({ ...o, usd: "$85.82", unpriced: 1, coming: 0 }), "12 wallets · 0.3627 SOL + 3 tokens ≈ $85.82 + 1 without a price");
  assert.equal(walletsLine({ ...o, usd: "$85.82", unpriced: 2, masked: true }), "12 wallets · •••• SOL · 10 arriving");
  // only SOL: the dollar figure is the SOL's
  assert.equal(walletsLine({ ...o, wallets: 1, sol: "0.05", tokens: 0, usd: "$5.16", coming: 0 }), "1 wallet · 0.05 SOL ≈ $5.16");
  assert.equal(walletsLine({ ...o, tokens: 1, usd: null, coming: 0 }), "12 wallets · 0.3627 SOL + 1 token");
  assert.equal(walletsLine({ ...o, masked: true }), "12 wallets · •••• SOL · 10 arriving");
  assert.equal(walletsLine({ ...o, wallets: 0, coming: 2 }), "None yet · 2 arriving");
});
