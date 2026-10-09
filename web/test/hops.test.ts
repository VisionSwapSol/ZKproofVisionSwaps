import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DELIVERY_FEE, l1Message, n2Message, predictCredit, verifyDelivery, hopLookupMessage, NONCE_SPACE } from "@visionswap/sdk";
import {
  APP_VERSION,
  newerVersion,
  payQuote,
  finishAmount,
  l1Sig,
  n2Sig,
  nonceOk,
  finishTransaction,
  lookupBody,
  signText,
  refusalText,
  recipientProblem,
  offCurve,
  poisoned,
  pruneLegs,
  hasDeliveryLine,
  fillDeliveryLine,
  keptFound,
  lookupWait,
  LOOKUP_BURST,
  LOOKUP_GAP_MS,
  worthShowing,
  checkedText,
  notesRead,
  upsertLeg,
  patchLeg,
  recentRecipients,
  sortOpen,
  autoFinishable,
  AUTO_FINISH_SLACK,
  finishGate,
  afterFailedFinish,
  moveOutVerdict,
  HISTORY_UNREAD,
  EMPTIED_UNREAD,
  MaybeSent,
  NEEDS_LOOK,
  trustedRecipient,
  feeChanged,
  readDelivery,
  newHopHistory,
  HISTORY_PAGE,
  HISTORY_PAGES,
  HISTORY_READS,
  type HistoryRpc,
  type HopLeg,
} from "../src/lib/hops.ts";

const BH = bs58.encode(new Uint8Array(32).fill(7));
const leg = (hop: string, status: HopLeg["status"], extra: Partial<HopLeg> = {}): HopLeg => ({ hop, out0: "00", to: "T", amount: "1000000", status, at: 1000, ...extra });

test("version gate: a server asking for a newer page waits for a refresh", () => {
  assert.equal(APP_VERSION, "1.6.0");
  assert.equal(newerVersion("1.6.0", APP_VERSION), false);
  assert.equal(newerVersion("1.6.1", APP_VERSION), true);
  assert.equal(newerVersion("1.10.0", "1.9.9"), true);
  assert.equal(newerVersion("1.5.9", APP_VERSION), false);
  assert.equal(newerVersion("2", "1.99.99"), true);
  assert.equal(newerVersion("garbage", APP_VERSION), false);
});

test("a payment's quote makes the recipient get exactly the amount, the hop paying its own fee", () => {
  for (const [amount, fee, bps] of [
    [1_000_000_000n, 1_600_000n, 80],
    [878_880n, 1_545_760n, 80],
    [123_456_789n, 2_000_000n, 0],
    [5_000_000_000n, 1_500_000n, 500],
  ] as [bigint, bigint, number][]) {
    const q = payQuote(amount, fee, bps);
    assert.equal(q.toRecipient, amount);
    assert.equal(q.deliveryFee, DELIVERY_FEE);
    assert.equal(predictCredit(q.withdraw, fee, bps), amount + DELIVERY_FEE, "the hop is credited the amount plus its fee");
    assert.equal(q.relayerFee + q.protocolFee + amount + DELIVERY_FEE, q.withdraw, "every lamport accounted for");
  }
  // a treasury that can't take a fee: none is charged, and the withdrawal is smaller to match
  const empty = { lamports: 0n, rentMin: 890_880n };
  const q = payQuote(1_000_000n, 1_500_000n, 80, empty);
  assert.equal(q.protocolFee, 0n);
  assert.equal(q.withdraw, 1_000_000n + DELIVERY_FEE + 1_500_000n);
});

test("finishing a hop sends everything less the fee, which must be at least the rent minimum for any recipient", () => {
  assert.deepEqual(finishAmount(1_012_000n, 890_880n), { lamports: 1_000_000n });
  assert.deepEqual(finishAmount(12_000n, 890_880n), { problem: "empty" });
  assert.deepEqual(finishAmount(0n, 890_880n), { problem: "empty" });
  assert.deepEqual(finishAmount(500_000n, 890_880n), { problem: "too-small" });
  // the hop pays its own fee: one left holding less than the rent minimum afterwards is refused by the network
  assert.deepEqual(finishAmount(902_879n, 890_880n), { problem: "too-small" });
  assert.deepEqual(finishAmount(902_880n, 890_880n), { lamports: 890_880n });
});

test("a recipient the relayer remembers for a hop is trusted only when the hop's own signature covers it", () => {
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const l1 = { blockhash: BH, sig: l1Sig(hop, to, 5_000_000n, BH) };
  assert.equal(trustedRecipient(hop.publicKey, { status: "waiting", to: to.toBase58(), amount: "5000000", l1 }), to.toBase58());
  const n = { account: Keypair.generate().publicKey.toBase58(), value: BH, authority: Keypair.generate().publicKey.toBase58() };
  const n2 = { ...n, sig: n2Sig(hop, to, 5_000_000n, n) };
  assert.equal(trustedRecipient(hop.publicKey, { status: "waiting", to: to.toBase58(), amount: "5000000", n2 }), to.toBase58());
  // another address, another amount, no signature, or junk: not trusted
  const thief = Keypair.generate().publicKey.toBase58();
  assert.equal(trustedRecipient(hop.publicKey, { status: "waiting", to: thief, amount: "5000000", l1, n2 }), null);
  assert.equal(trustedRecipient(hop.publicKey, { status: "waiting", to: to.toBase58(), amount: "5000001", l1 }), null);
  assert.equal(trustedRecipient(hop.publicKey, { status: "waiting", to: to.toBase58(), amount: "5000000" }), null);
  assert.equal(trustedRecipient(hop.publicKey, { status: "waiting", to: "nope", amount: "x", l1 }), null);
  const other = Keypair.generate();
  assert.equal(trustedRecipient(other.publicKey, { status: "waiting", to: to.toBase58(), amount: "5000000", l1 }), null, "signed by another hop");
});

test("the hop's signatures are over exactly the transfer the relayer rebuilds", () => {
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const s1 = bs58.decode(l1Sig(hop, to, 5_000_000n, BH));
  assert.ok(verifyDelivery(l1Message({ hop: hop.publicKey, to, lamports: 5_000_000n, blockhash: BH }), s1, hop.publicKey));
  assert.ok(!verifyDelivery(l1Message({ hop: hop.publicKey, to, lamports: 5_000_001n, blockhash: BH }), s1, hop.publicKey), "another amount isn't covered");
  const other = Keypair.generate().publicKey;
  assert.ok(!verifyDelivery(l1Message({ hop: hop.publicKey, to: other, lamports: 5_000_000n, blockhash: BH }), s1, hop.publicKey), "another recipient isn't covered");
  const n = { account: Keypair.generate().publicKey.toBase58(), value: BH, authority: Keypair.generate().publicKey.toBase58() };
  const s2 = bs58.decode(n2Sig(hop, to, 5_000_000n, n));
  const m2 = n2Message({ hop: hop.publicKey, to, lamports: 5_000_000n, nonceAccount: new PublicKey(n.account), authority: new PublicKey(n.authority), nonce: n.value });
  assert.ok(verifyDelivery(m2, s2, hop.publicKey));
});

test("a finishing transfer is a standard one: the hop pays and sends, one System transfer, legacy", () => {
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const raw = finishTransaction(hop, to, 777_000n, BH);
  const tx = VersionedTransaction.deserialize(raw);
  assert.equal(tx.version, "legacy");
  assert.equal(raw.length, 1 + 64 + l1Message({ hop: hop.publicKey, to, lamports: 777_000n, blockhash: BH }).length);
  const keys = tx.message.staticAccountKeys;
  assert.ok(keys[0].equals(hop.publicKey), "the hop pays the fee");
  assert.equal(tx.message.header.numRequiredSignatures, 1);
  const transfers = tx.message.compiledInstructions.filter((ix) => keys[ix.programIdIndex].equals(SystemProgram.programId));
  assert.equal(transfers.length, 1);
  assert.ok(keys[transfers[0].accountKeyIndexes[1]].equals(to));
  assert.ok(verifyDelivery(tx.message.serialize(), tx.signatures[0], hop.publicKey));
});

test("a durable nonce is used only when it is on the chain as the relayer said", () => {
  const authority = Keypair.generate().publicKey;
  const data = new Uint8Array(NONCE_SPACE);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 1, true);
  data.set(authority.toBytes(), 8);
  data.set(bs58.decode(BH), 40);
  const lease = { account: Keypair.generate().publicKey.toBase58(), value: BH, authority: authority.toBase58() };
  const sys = "11111111111111111111111111111111";
  assert.ok(nonceOk({ owner: sys, data }, lease, authority.toBase58()));
  assert.ok(!nonceOk(null, lease, authority.toBase58()), "not there");
  assert.ok(!nonceOk({ owner: sys, data }, lease, Keypair.generate().publicKey.toBase58()), "not the published authority");
  assert.ok(!nonceOk({ owner: sys, data }, { ...lease, value: bs58.encode(new Uint8Array(32).fill(9)) }, authority.toBase58()), "another value");
  assert.ok(!nonceOk({ owner: Keypair.generate().publicKey, data }, lease, authority.toBase58()), "not a System account");
  assert.ok(!nonceOk({ owner: sys, data: data.slice(0, 79) }, lease, authority.toBase58()), "not a nonce account");
  assert.ok(!nonceOk({ owner: sys, data }, lease, null), "no authority published");
});

test("lookups and messages are signed by the sending address itself", () => {
  const hop = Keypair.generate();
  const b = lookupBody(hop, 1_700_000_000_000);
  assert.equal(b.hop, hop.publicKey.toBase58());
  assert.ok(verifyDelivery(hopLookupMessage(hop.publicKey, b.ts), bs58.decode(b.sig), hop.publicKey));
  const sig = signText(hop, "Verify wallet ownership: 123");
  assert.ok(verifyDelivery(new TextEncoder().encode("Verify wallet ownership: 123"), bs58.decode(sig), hop.publicKey));
});

test("recipients that can never be paid are named before anything moves", () => {
  const ok = Keypair.generate().publicKey.toBase58();
  const hop = Keypair.generate().publicKey.toBase58();
  const pool = Keypair.generate().publicKey.toBase58();
  assert.equal(recipientProblem(ok, new Set([pool]), new Set([hop])), null);
  assert.match(recipientProblem("not an address", new Set(), new Set())!, /doesn't look like/);
  assert.match(recipientProblem(pool, new Set([pool]), new Set())!, /belongs to VisionSwap/);
  assert.match(recipientProblem("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", new Set(), new Set())!, /belongs to VisionSwap or to a program/);
  assert.match(recipientProblem(hop, new Set(), new Set([hop]))!, /one-time sending address/);
  assert.match(refusalText("token-account"), /token account/);
  assert.match(refusalText("program"), /belongs to a program/);
  assert.match(refusalText("nonce-account"), /durable nonce/);
  const pda = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault")], SystemProgram.programId)[0].toBase58();
  assert.equal(offCurve(pda), true);
  assert.equal(offCurve(ok), false);
});

test("a pasted address that only looks like an earlier recipient is caught", () => {
  const real = "HtrDenXq9WbVqQh5kQ2y8jW4YgYQ6rTqwM3cZ1u7s2FE";
  const fake = "HtrDzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzs2FE";
  assert.equal(poisoned(fake, [real]), real);
  assert.equal(poisoned(real, [real]), null, "the same address is fine");
  assert.equal(poisoned(Keypair.generate().publicKey.toBase58(), [real]), null);
  const recent = recentRecipients([leg("h1", "delivered", { to: "A", at: 5 }), leg("h2", "sent", { to: "B", at: 9 })], [{ to: "C", created: 7 }, { to: "A", created: 1 }]);
  assert.deepEqual(recent, ["B", "C", "A"], "newest first, once each");
});

test("the ledger keeps one record per hop, and a delivery never goes back to an earlier step", () => {
  let legs = upsertLeg([], leg("h1", "proved"));
  legs = upsertLeg(legs, leg("h2", "proved"));
  legs = upsertLeg(legs, leg("h1", "sent", { tx1: "t1" }));
  assert.deepEqual(
    legs.map((l) => [l.hop, l.status]),
    [
      ["h1", "sent"],
      ["h2", "proved"],
    ],
  );
  legs = patchLeg(legs, "h1", { status: "delivered", tx2: "d1" });
  legs = patchLeg(legs, "h1", { status: "sent", tx1: "t1b" });
  assert.equal(legs[0].status, "delivered", "a late 'sent' can't undo a delivery");
  assert.equal(legs[0].tx1, "t1b", "its other news still lands");
  legs = patchLeg(legs, "h1", { status: "returned" });
  assert.equal(legs[0].status, "returned");
});

test("old records go: unsent proofs after two weeks, open ones after a month, finished after two", () => {
  const day = 86_400_000;
  const now = 100 * day;
  const kept = pruneLegs(
    [
      leg("p-new", "proved", { at: now - day }),
      leg("p-old", "proved", { at: now - 15 * day }),
      leg("w", "waiting", { at: now - 20 * day }),
      leg("w-old", "waiting", { at: now - 31 * day }),
      leg("d", "delivered", { at: now - 50 * day, done: now - 50 * day }),
      leg("d-old", "delivered", { at: now - 61 * day, done: now - 61 * day }),
    ],
    now,
  ).map((l) => l.hop);
  assert.deepEqual(kept, ["p-new", "w", "d"]);
});

test("open sending addresses: undelivered ones are finished, delivered ones that hold SOL again came back", () => {
  const legs = [leg("a", "sent", { to: "X" }), leg("b", "delivered", { to: "Y" }), leg("c", "returned", { to: "Z" })];
  const out = sortOpen(
    [
      { hop: "a", lamports: 1_012_000n },
      { hop: "b", lamports: 50_000_000n },
      { hop: "c", lamports: 1_600_000n },
      { hop: "d", lamports: 9_000_000n },
      { hop: "e", lamports: 3_000_000n },
      { hop: "f", lamports: 0n },
    ],
    legs,
    new Map([
      ["d", { delivered: false, to: "W" }],
      ["e", { delivered: true, to: null }],
    ]),
    1_600_000n,
  );
  assert.deepEqual(
    out.map((h) => [h.hop, h.kind, h.to]),
    [
      ["a", "finish", "X"],
      ["b", "returned", "Y"],
      ["d", "finish", "W"],
      ["e", "returned", null],
    ],
    "c only holds the waiting room's rent coming home; f is empty",
  );
  // dust (too little to send on) is nobody's payment: never a delivery to finish, nor SOL that came back
  const dust = sortOpen(
    [
      { hop: "a", lamports: 7n },
      { hop: "b", lamports: 902_879n },
      { hop: "d", lamports: 902_880n },
    ],
    legs,
    new Map([["d", { delivered: true, to: null }]]),
    0n,
    890_880n,
  );
  assert.deepEqual(
    dust.map((h) => h.hop),
    ["d"],
  );
});

test("a sending address whose history can't be told is offered for a look, never left with only Finish now", () => {
  const legs = [leg("a", "sent", { to: "X" }), leg("b", "waiting", { to: "Y" }), leg("c", "delivered", { to: "Z" })];
  const open = [
    { hop: "a", lamports: 1_012_000n },
    { hop: "b", lamports: 1_012_000n },
    { hop: "c", lamports: 5_000_000n },
    { hop: "d", lamports: 9_000_000n },
  ];
  const known = new Map([["d", { delivered: false, to: "W" }]]);
  // a refused manual finish (dust flooded its history; another device, no leg): no longer a dead end
  const out = sortOpen(open, legs, known, 0n, 0n, new Set(["a", "c", "d"]));
  assert.deepEqual(
    out.map((h) => [h.hop, h.kind]),
    [
      ["a", "look"],
      ["b", "finish"],
      ["c", "returned"],
      ["d", "look"],
    ],
  );
  // the refusal says the way out, and never that trying again is the only one
  assert.match(HISTORY_UNREAD, /nothing was sent/i);
  assert.match(HISTORY_UNREAD, /private balance|somewhere else/);
});

test("a refusal because the pool fee changed makes the app read the pool again; other refusals don't", () => {
  assert.equal(feeChanged("stale", "This payment needs a fresh signature. Open VisionSwap and it is made for you. Nothing was spent."), true);
  // the schedule's own check answers without a code
  assert.equal(feeChanged(undefined, "The pool fee changed. Please review the new fee and try again."), true);
  assert.equal(feeChanged("expired", "This payment's signature ran out of time before it was sent. Nothing was spent. Please try again."), false);
  assert.equal(feeChanged("recipient", "This is a token account."), false);
  assert.equal(feeChanged(undefined, "The pool moved on while your proof was being made. Please try again."), false);
});

test("a delivery is finished by itself only when its address holds what an undelivered payment does", () => {
  const amount = 200_000_000n;
  assert.equal(autoFinishable(amount + DELIVERY_FEE, amount), true);
  assert.equal(autoFinishable(amount + DELIVERY_FEE + 5_000n, amount), true, "a little dust rides along");
  assert.equal(autoFinishable(amount + DELIVERY_FEE + AUTO_FINISH_SLACK + 1n, amount), false, "more than that is the owner's to decide");
  assert.equal(autoFinishable(amount - 1_000_000n, amount), false, "an exchange's refund less its fee is never sent back by itself");
  assert.equal(autoFinishable(amount, amount), false);
});

test("finishing a delivery never sends when its sending address's history can't be read, however it was started", () => {
  const amount = 200_000_000n;
  const undelivered = amount + DELIVERY_FEE;
  const refund = amount - 12_000n;
  // the owner's Finish now after an exchange refund, while the history read hits a 429: nothing is sent
  assert.deepEqual(finishGate(undefined, "manual", refund, amount), { refuse: HISTORY_UNREAD });
  assert.deepEqual(finishGate(undefined, "manual", undelivered), { refuse: HISTORY_UNREAD }, "even with no record of the leg");
  assert.deepEqual(finishGate(undefined, "auto", undelivered, amount), { refuse: HISTORY_UNREAD });
  // delivered already: that is the answer, whatever is there now
  assert.deepEqual(finishGate("SIG", "manual", refund, amount), { delivered: "SIG" });
  assert.deepEqual(finishGate("SIG", "auto", undelivered, amount), { delivered: "SIG" });
  // no delivery in its history: the owner may send what is there; by itself only what an undelivered payment holds
  assert.deepEqual(finishGate(null, "manual", refund, amount), { send: true });
  assert.deepEqual(finishGate(null, "auto", undelivered, amount), { send: true });
  assert.deepEqual(finishGate(null, "auto", refund, amount), { refuse: NEEDS_LOOK });
  assert.deepEqual(finishGate(null, "auto", refund), { send: true }, "no leg on this device: its amount isn't known");
  // a plain send (not finishing a delivery) has nothing to check
  assert.deepEqual(finishGate(null, false, refund, amount), { send: true });
  assert.deepEqual(finishGate(undefined, false, refund, amount), { send: true });
});

test("a failed finishing transfer answers with the delivery, says it may have gone when the history can't be read, else keeps its error", () => {
  const err = new Error("Blockhash not found");
  assert.equal(afterFailedFinish("SIG", err), "SIG");
  // the address was emptied (perhaps by this very transfer) and the history can't say by what: never "nothing was sent"
  assert.throws(
    () => afterFailedFinish(undefined, err),
    (e: unknown) => e instanceof MaybeSent && e.message === EMPTIED_UNREAD && !/nothing was sent/i.test(e.message),
  );
  assert.throws(() => afterFailedFinish(null, err), (e: unknown) => e === err);
  // a slow Finish now that may still land keeps its own "may still go through"
  class StillPending extends Error {
    readonly pending = true;
  }
  const slow = new StillPending("The delivery is taking longer than usual. It may still go through: check your activity in a minute before trying again.");
  assert.throws(() => afterFailedFinish(undefined, slow), (e: unknown) => e === slow);
  const maybe = new MaybeSent("may still go through");
  assert.throws(() => afterFailedFinish(undefined, maybe), (e: unknown) => e === maybe);
});

/**
 * A sending address's history as the RPC gives it: `chain` oldest first, each signature with who paid
 * for it ("hop" or a stranger) and whom it paid. Listing follows getSignaturesForAddress (newest first,
 * HISTORY_PAGE at most, older than `before`, newer than `until`); every list and read is counted.
 */
function fakeHistory(chain: { sig: string; by: "hop" | "other"; to?: string; err?: boolean }[]) {
  const calls = { list: 0, read: 0, reads: [] as string[] };
  const rpc: HistoryRpc = {
    async list({ before, until }) {
      calls.list++;
      const newest = [...chain].reverse();
      let from = before ? newest.findIndex((x) => x.sig === before) + 1 : 0;
      const out: { signature: string; err: unknown }[] = [];
      for (; from < newest.length && out.length < HISTORY_PAGE; from++) {
        if (until && newest[from].sig === until) break;
        out.push({ signature: newest[from].sig, err: newest[from].err ? { x: 1 } : null });
      }
      return out;
    },
    async read(sig) {
      calls.read++;
      calls.reads.push(sig);
      const t = chain.find((x) => x.sig === sig)!;
      return t.by === "hop" && !t.err ? { byHop: true, pays: (to: string) => to === t.to } : { byHop: false };
    },
  };
  return { rpc, calls };
}

test("a sending address's history: the first transfer it paid for itself is its delivery, whatever came in before or after", async () => {
  const chain = [
    { sig: "tx1", by: "other" as const },
    { sig: "d1", by: "other" as const },
    { sig: "tx2", by: "hop" as const, to: "R" },
    { sig: "d2", by: "other" as const },
    { sig: "back", by: "hop" as const, to: "X" },
  ];
  const { rpc } = fakeHistory(chain);
  assert.equal(await readDelivery(newHopHistory(), "tx1", "R", rpc), "tx2");
  // paid for something else first (a move into the pool): no delivery
  assert.equal(await readDelivery(newHopHistory(), "tx1", "Z", rpc), null);
  // nothing it paid for: none
  const none = fakeHistory([
    { sig: "tx1", by: "other" },
    { sig: "d1", by: "other" },
  ]);
  assert.equal(await readDelivery(newHopHistory(), "tx1", "R", none.rpc), null);
  // the network couldn't say: undefined
  assert.equal(await readDelivery(newHopHistory(), "tx1", "R", { list: async () => null, read: rpc.read }), undefined);
  assert.equal(await readDelivery(newHopHistory(), "tx1", "R", { list: rpc.list, read: async () => undefined }), undefined);
});

test("dust a stranger keeps sending a sending address is read once each, and one look never reads more than its share", async () => {
  // 100 one-lamport transfers to a hop whose delivery never landed
  const chain: { sig: string; by: "hop" | "other"; to?: string }[] = [{ sig: "tx1", by: "other" }];
  for (let i = 0; i < 100; i++) chain.push({ sig: `dust${i}`, by: "other" });
  const { rpc, calls } = fakeHistory(chain);
  const h = newHopHistory();
  const looks: (string | null | undefined)[] = [];
  let maxList = 0;
  let maxRead = 0;
  for (let i = 0; i < 40 && looks.at(-1) !== null; i++) {
    const before = { ...calls };
    looks.push(await readDelivery(h, "tx1", "R", rpc));
    maxList = Math.max(maxList, calls.list - before.list);
    maxRead = Math.max(maxRead, calls.read - before.read);
  }
  // every look stays within its share of pages and reads, never one read per dust transfer
  assert.ok(maxList <= HISTORY_PAGES, `listed ${maxList} pages in one look`);
  assert.ok(maxRead <= HISTORY_READS, `read ${maxRead} transactions in one look`);
  // until it has read through, it can't be told (the owner gets a look); then the answer is sure
  assert.equal(looks[0], undefined);
  assert.equal(looks.at(-1), null);
  // every transaction was fetched once, however many looks it took
  assert.equal(calls.read, 100);
  assert.equal(new Set(calls.reads).size, 100);
  // once read through, a look lists only what is new: one page, no reads
  const settled = { ...calls };
  assert.equal(await readDelivery(h, "tx1", "R", rpc), null);
  assert.equal(calls.list - settled.list, 1);
  assert.equal(calls.read - settled.read, 0);
  // more dust later costs a read each; then the delivery lands and is found
  chain.push({ sig: "late1", by: "other" }, { sig: "late2", by: "other" }, { sig: "tx2", by: "hop", to: "R" });
  const later = { ...calls };
  assert.equal(await readDelivery(h, "tx1", "R", rpc), "tx2");
  assert.equal(calls.read - later.read, 3);
  // found once, it is the answer from then on with nothing listed or read, whatever comes in after
  chain.push({ sig: "after", by: "other" });
  const found = { ...calls };
  assert.equal(await readDelivery(h, "tx1", "R", rpc), "tx2");
  assert.equal(await readDelivery(h, "tx1", "Z", rpc), null, "a delivery to someone else isn't this one");
  assert.equal(calls.list - found.list, 0);
  assert.equal(calls.read - found.read, 0);
});

test("dust before the delivery is read through over a few looks, and the delivery is still found", async () => {
  const chain: { sig: string; by: "hop" | "other"; to?: string; err?: boolean }[] = [{ sig: "tx1", by: "other" }];
  for (let i = 0; i < 30; i++) chain.push({ sig: `pre${i}`, by: "other" });
  chain.push({ sig: "failed", by: "hop", to: "R", err: true });
  chain.push({ sig: "tx2", by: "hop", to: "R" });
  for (let i = 0; i < 150; i++) chain.push({ sig: `post${i}`, by: "other" });
  const { rpc, calls } = fakeHistory(chain);
  const h = newHopHistory();
  let got: string | null | undefined;
  let n = 0;
  while (got === undefined && n < 30) {
    got = await readDelivery(h, "tx1", "R", rpc);
    n++;
  }
  assert.equal(got, "tx2");
  // more than a look's pages past the pool spend: listed over several looks, and nothing after the delivery is read
  assert.ok(n > 1);
  // (reads go a few at a time, so at most the rest of the delivery's batch comes after it)
  assert.ok(calls.reads.length - calls.reads.indexOf("tx2") - 1 < 4, `only what came before the delivery is read: ${calls.reads.join(",")}`);
  assert.equal(new Set(calls.reads).size, calls.reads.length, "each read once");
  // with no pool spend known, its history is read back to the start
  const fromStart = fakeHistory([
    { sig: "a", by: "other" },
    { sig: "b", by: "hop", to: "R" },
  ]);
  assert.equal(await readDelivery(newHopHistory(), undefined, "R", fromStart.rpc), "b");
  // one share across tries (finishLeg's wait): reads stop when it runs out
  const big = fakeHistory([{ sig: "tx1", by: "other" }, ...Array.from({ length: 30 }, (_, i) => ({ sig: `x${i}`, by: "other" as const }))]);
  const budget = { pages: HISTORY_PAGES + 5, reads: HISTORY_READS };
  const hh = newHopHistory();
  for (let i = 0; i < 6; i++) assert.equal(await readDelivery(hh, "tx1", "R", big.rpc, budget), undefined);
  assert.equal(big.calls.read, HISTORY_READS);
  // a look with nothing left of its share keeps what was read, and the next look carries on from there
  assert.equal(await readDelivery(hh, "tx1", "R", big.rpc, { pages: 0, reads: 0 }), undefined);
  assert.equal(hh.cands.length, 30);
  const lists = big.calls.list;
  let next: string | null | undefined;
  for (let i = 0; i < 5 && next === undefined; i++) next = await readDelivery(hh, "tx1", "R", big.rpc);
  assert.equal(next, null);
  assert.equal(big.calls.read, 30, "each read once");
  assert.ok(big.calls.list - lists <= 3, "only what is new is listed again");
});

test("more coming in than one look lists: it reads on down from what it listed, never everything again", async () => {
  const chain: { sig: string; by: "hop" | "other"; to?: string }[] = [
    { sig: "tx1", by: "other" },
    { sig: "a", by: "other" },
  ];
  const { rpc, calls } = fakeHistory(chain);
  const h = newHopHistory();
  assert.equal(await readDelivery(h, "tx1", "R", rpc), null);
  // a burst of 200 dust transfers between two looks
  for (let i = 0; i < 200; i++) chain.push({ sig: `burst${i}`, by: "other" });
  let got: string | null | undefined;
  for (let i = 0; i < 40 && got !== null; i++) {
    const before = calls.list;
    got = await readDelivery(h, "tx1", "R", rpc);
    assert.ok(calls.list - before <= HISTORY_PAGES);
  }
  assert.equal(got, null);
  assert.equal(new Set(calls.reads).size, calls.reads.length, "each read once");
  assert.equal(calls.read, 201);
});

test("after a move out of a sending address, a delivery is 'not delivered' only when its history shows it paid elsewhere first", () => {
  const to = "Recipient1111111111111111111111111111111111";
  // the history shows the delivery: that is the answer, whatever was moved after it
  assert.deepEqual(moveOutVerdict({ by: "tx2", move: { sig: "mv", to: "Other" }, recipient: to, elsewhere: false }), { delivered: "tx2" });
  // sent on to the delivery's own recipient, read before the history lists the move: delivered by the move
  assert.deepEqual(moveOutVerdict({ by: null, move: { sig: "mv", to }, recipient: to, elsewhere: false }), { delivered: "mv" });
  assert.deepEqual(moveOutVerdict({ by: undefined, move: { sig: "mv", to }, recipient: to, elsewhere: false }), { delivered: "mv" });
  // moved elsewhere, and the history shows the address paying for something else first: not delivered
  assert.deepEqual(moveOutVerdict({ by: null, move: { sig: "mv", to: "Other" }, recipient: to, elsewhere: true }), { notDelivered: true });
  assert.deepEqual(moveOutVerdict({ by: null, recipient: to, elsewhere: true }), { notDelivered: true });
  // a history that doesn't list the move yet (or can't be read) leaves it for a later look
  assert.equal(moveOutVerdict({ by: null, move: { sig: "mv", to: "Other" }, recipient: to, elsewhere: false }), null);
  assert.equal(moveOutVerdict({ by: null, recipient: to, elsewhere: false }), null);
  assert.equal(moveOutVerdict({ by: undefined, recipient: to, elsewhere: true }), null);
  // no recipient known: a move is never taken as the delivery
  assert.equal(moveOutVerdict({ by: null, move: { sig: "mv", to }, recipient: undefined, elsewhere: false }), null);
});

test("a proof the relayer may have delivered after the page closed is kept two weeks, so the next open still finds and writes it down", () => {
  const day = 86_400_000;
  const now = 100 * day;
  const kept = pruneLegs([leg("p", "proved", { at: now - 10 * day })], now).map((l) => l.hop);
  assert.deepEqual(kept, ["p"]);
});

test("a delivery whose sending address still holds a payment is kept for as long as it does, and never pushed out by count", () => {
  const day = 86_400_000;
  const now = 400 * day;
  const kept = pruneLegs(
    [
      leg("held", "waiting", { at: now - 200 * day, held: now - 2 * day }),
      leg("held-proof", "proved", { at: now - 100 * day, held: now - day }),
      leg("held-long-ago", "waiting", { at: now - 200 * day, held: now - 40 * day }),
      leg("done-held", "delivered", { at: now - 90 * day, done: now - 90 * day, held: now - day }),
    ],
    now,
  ).map((l) => l.hop);
  assert.deepEqual(kept, ["held", "held-proof"]);
  // past the cap, finished ones go first: every open one stays
  const many = [
    ...Array.from({ length: 450 }, (_, i) => leg(`d${i}`, "delivered", { at: now - day, done: now - day })),
    leg("old-open", "waiting", { at: now - 10 * day }),
    leg("old-held", "sent", { at: now - 300 * day, held: now - day }),
  ];
  const out = pruneLegs(many, now);
  assert.equal(out.length, 400, "the cap holds while open ones fit under it");
  assert.ok(out.some((l) => l.hop === "old-open") && out.some((l) => l.hop === "old-held"));
  assert.equal(out.filter((l) => l.status === "delivered").length, 398);
  assert.equal(out[0].hop, "d0", "newest finished ones are the ones kept");
});

test("a delivery seen landed later fills its activity line, or says there is none (then a line is added); a send's own line never doubles one", () => {
  const act = [
    { t: 3, text: "Sent 1 SOL to A", delivery: { hop: "h1", to: "A" } },
    { t: 2, text: "Sent on", sig: "onward", delivery: { hop: "h1", to: "B", onward: true } },
    { t: 1, text: "Sent 2 SOL to C", sig: "tx2c", delivery: { hop: "h2", to: "C" } },
  ];
  assert.equal(hasDeliveryLine(act, "h1"), true);
  assert.equal(hasDeliveryLine(act, "h3"), false, "a payment the relayer delivered after the page closed has no line yet");
  assert.equal(fillDeliveryLine(act, "h3", "x"), null);
  const filled = fillDeliveryLine(act, "h1", "tx2a")!;
  assert.equal(filled[0].sig, "tx2a");
  assert.equal(filled[1].sig, "onward", "SOL sent on after it came back keeps its own ID");
  assert.equal(fillDeliveryLine(act, "h2", "other")![2].sig, "tx2c", "an ID already there stays");
  assert.equal(hasDeliveryLine([{ delivery: { hop: "h4", onward: true } }], "h4"), false);
});

test("what a check of every sending address found stays on the later looks until it holds nothing", () => {
  const mine = new Set(["a", "b", "c"]);
  assert.deepEqual(keptFound(["a", "z"], mine, true, ["b", "c"], new Set()), ["b", "c", "z"], "a check replaces what it read; one not worked out yet stays");
  assert.deepEqual(keptFound(["b", "c", "z"], mine, false, ["b"], new Set(["c"])), ["b", "z"], "a look drops only one it read at zero");
  assert.deepEqual(keptFound(["b"], new Set(), false, [], new Set()), ["b"], "notes not read yet never drop one");
});

test("a check of every sending address looks up only ones worth showing, paced under the relayer's limit, and never says none when some couldn't be read", () => {
  const rentMin = 890_880n;
  assert.equal(worthShowing(0n, rentMin), false);
  assert.equal(worthShowing(5_000n, rentMin), false, "dust a stranger sent is never looked up");
  assert.equal(worthShowing(rentMin + DELIVERY_FEE - 1n, rentMin), false);
  assert.equal(worthShowing(rentMin + DELIVERY_FEE, rentMin), true);
  assert.equal(worthShowing(DELIVERY_FEE, 0n), true, "rent not known yet: only the fee is asked for");
  // 40 lookups stay under 30 a minute, a few at once and then one at a time
  const waits = Array.from({ length: 40 }, (_, k) => lookupWait(k));
  assert.equal(waits.filter((w) => w === 0).length, LOOKUP_BURST);
  let t = 0;
  const at = waits.map((w) => (t += w));
  assert.ok(at.filter((x) => x < 60_000).length < 30, "the first minute asks fewer than the limit");
  assert.ok(LOOKUP_GAP_MS >= 2_000);
  assert.equal(checkedText({ found: 0, unread: 0 }), "None of your sending addresses holds SOL.");
  assert.equal(checkedText({ found: 2, unread: 0 }), "Found 2 sending addresses holding SOL: see Deliveries.");
  assert.match(checkedText({ found: 0, unread: 3 }), /^3 sending addresses holding SOL couldn't be checked just now/);
  assert.doesNotMatch(checkedText({ found: 0, unread: 1 }), /None/);
  assert.match(checkedText({ found: 1, unread: 1 }), /^Found 1 sending address holding SOL: see Deliveries\. 1 more holding SOL couldn't be checked/);
});

test("a check of every sending address waits until every note has been read", () => {
  const keys = {};
  const done = { scannedFor: keys, keys, scannedTo: 500, leafCount: 500, total: 500 };
  assert.equal(notesRead(done), true);
  assert.equal(notesRead({ ...done, scannedFor: null }), false, "nothing read yet for this account (just unlocked)");
  assert.equal(notesRead({ ...done, scannedTo: 120 }), false, "still opening the leaves");
  assert.equal(notesRead({ ...done, leafCount: 300, scannedTo: 300 }), false, "the leaves aren't all downloaded");
  assert.equal(notesRead({ ...done, scannedFor: {} }), false, "another account's look");
});
