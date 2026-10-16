import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SystemProgram, TransactionMessage } from "@solana/web3.js";
import { l1Message } from "@visionswap/sdk";
import { FALLBACK_MS_PER_SLOT, SlotClock, bestMsPerSlot, msPerSlotFromSamples, slotMinutes } from "../src/lib/slottime.ts";
import { drawGoAt, goAtOf, needsProof, pollGroups, RIPE_DUE_MS, type JobStatus } from "../src/lib/jobs.ts";
import { refundIsOurs } from "../src/lib/walletpay.ts";
import { isTxMessage, signText, signTextProblem } from "../src/lib/hops.ts";
import { chainError, setPoolProgram } from "../src/lib/chainerr.ts";
import { randInt, secureRandom } from "../src/lib/poll.ts";

// ─── slot time (VS-27) ───

test("the slot time comes from the network's samples, sanely bounded", () => {
  assert.equal(msPerSlotFromSamples([{ numSlots: 300, samplePeriodSecs: 60 }]), 200);
  assert.equal(msPerSlotFromSamples([{ numSlots: 290, samplePeriodSecs: 60 }, { numSlots: 310, samplePeriodSecs: 60 }]), 200);
  // empty, zero or absurd samples say nothing
  assert.equal(msPerSlotFromSamples([]), null);
  assert.equal(msPerSlotFromSamples([{ numSlots: 0, samplePeriodSecs: 60 }]), null);
  assert.equal(msPerSlotFromSamples([{ numSlots: 1, samplePeriodSecs: 60 }]), null);
  assert.equal(msPerSlotFromSamples(null), null);
});

test("the page's own readings of the slot measure it once they span a minute", () => {
  const c = new SlotClock();
  assert.equal(c.observe(1000, 0), null);
  assert.equal(c.observe(1100, 20_000), null, "too short a span");
  assert.equal(c.observe(1300, 63_000), 210);
  // a reading that goes backwards starts over
  assert.equal(c.observe(900, 70_000), null);
  assert.equal(c.observe(1200, 130_000), 200);
});

test("waiting-room minutes follow the measured slot time, never a fixed 400 ms", () => {
  // 450 slots: about 3 minutes at 400 ms, but about a minute and a half at 206 ms
  assert.equal(slotMinutes(450, 400), 3);
  assert.equal(slotMinutes(450, 206), 2);
  assert.equal(slotMinutes(840, 214), 3);
  // time left rounds up, and never says less than a minute
  assert.equal(slotMinutes(100, 206, true), 1);
  assert.equal(slotMinutes(301, 206, true), 2);
  assert.equal(slotMinutes(0, 206), 1);
  // the server's figure first, then a measured one, then a cached one, then 400 ms
  assert.equal(bestMsPerSlot(205, 230, 240), 205);
  assert.equal(bestMsPerSlot(undefined, 230, 240), 230);
  assert.equal(bestMsPerSlot(null, null, 240), 240);
  assert.equal(bestMsPerSlot(null, null, null), FALLBACK_MS_PER_SLOT);
  assert.equal(bestMsPerSlot(5, 7000, null), FALLBACK_MS_PER_SLOT, "absurd figures are ignored");
});

// ─── scheduled payments still waiting for their notes (VS-06) ───

test("a payment still waiting here for its notes isn't asked about at the relayer", () => {
  type J = { id: string; status: JobStatus; latest: number; ripening?: boolean; cancelPending?: boolean };
  const list: J[] = [
    { id: "a", status: "scheduled", latest: 3 },
    { id: "b", status: "stale", latest: 1, ripening: true },
    { id: "c", status: "stale", latest: 2 },
    // once handed over it is asked about like any other
    { id: "d", status: "scheduled", latest: 0, ripening: true },
    { id: "e", status: "cancelled", latest: 5, ripening: true, cancelPending: true },
  ];
  assert.deepEqual(pollGroups(list), [["d", "c", "a", "e"]]);
});

test("a payment waiting for its notes is proved for later until it falls due, then sent like one sent now", () => {
  const j = { id: "r", status: "stale" as JobStatus, created: 0, latest: 900_000, ripening: true, window: "15m" };
  // proved for later (held, its own lag) once its notes are old enough: asked for as "stale"
  assert.equal(needsProof(j, 100_000), "stale");
  // due: the newest root, as a payment that goes out now
  assert.equal(needsProof(j, 900_000 - RIPE_DUE_MS), "timing");
  assert.equal(needsProof(j, 2_000_000), "timing");
  // a try that wasn't ready waits its minute either way
  assert.equal(needsProof({ ...j, nextTry: 950_000 }, 900_000), null);
  // one waiting for its owner to accept a fee change isn't touched
  assert.equal(needsProof({ ...j, confirm: { amount: "1" } }, 2_000_000), null);
  // an ordinary stale job never counts as due
  assert.equal(needsProof({ ...j, ripening: undefined }, 2_000_000), "stale");
});

// ─── "Later" goes at a random moment within the window, never a fixed time after its notes (VS-04, VS-05) ───

test("a payment waiting for its notes goes at its own random moment, not just before its deadline", () => {
  const j = { id: "r", status: "stale" as JobStatus, created: 0, latest: 900_000, ripening: true, window: "15m", goAt: 300_000 };
  assert.equal(needsProof(j, 299_999), "stale");
  assert.equal(needsProof(j, 300_000), "timing");
  assert.equal(goAtOf(j), 300_000);
  // one made before moments were drawn keeps its deadline
  assert.equal(goAtOf({ latest: 900_000 }), 900_000 - RIPE_DUE_MS);
});

test("the moment is drawn over the whole window: never in its first tenth, always early enough for the deadline", () => {
  for (const [created, span] of [
    [1_000_000, 15 * 60_000],
    [5_000, 3_600_000],
    [0, 24 * 3_600_000],
    [42, 2 * 60_000],
  ] as const) {
    const latest = created + span;
    const lo = drawGoAt(created, latest, () => 0);
    const hi = drawGoAt(created, latest, () => 0.999_999_999);
    assert.equal(lo, created + Math.round(span * 0.1));
    assert.ok(hi <= latest - RIPE_DUE_MS && hi > latest - RIPE_DUE_MS - 1_000, `${span}: ${hi}`);
    // the secure source lands anywhere in between
    for (let i = 0; i < 200; i++) {
      const t = drawGoAt(created, latest);
      assert.ok(t >= lo && t <= latest - RIPE_DUE_MS, `${span}: ${t}`);
    }
  }
  // spread out, not bunched at one end: a 1-hour window's draws cover its quarters
  const quarters = new Set<number>();
  for (let i = 0; i < 400; i++) quarters.add(Math.floor((drawGoAt(0, 3_600_000) / 3_600_000) * 4));
  assert.deepEqual([...quarters].sort(), [0, 1, 2, 3]);
  // a window too short for the margins: its first moment
  assert.equal(drawGoAt(0, 30_000, () => 0.5), 3_000);
});

// ─── refunds by inner (VS-29) ───

test("a refund counts for a payment only when it is that deposit's own", () => {
  const p = { depositor: "Dep1", D: "500000000", inner: "0abc", created: 1_000_000_000 };
  const e = { depositor: "Dep1", amount: 500_000_000n, inner: 0xabcn };
  assert.equal(refundIsOurs(e, p, 1_000_100), true);
  assert.equal(refundIsOurs(e, p, null), true);
  // someone else's deposit with the same inner, taken back
  assert.equal(refundIsOurs({ ...e, depositor: "Other" }, p, 1_000_100), false);
  assert.equal(refundIsOurs({ ...e, amount: 1_000_000n }, p, 1_000_100), false);
  // one from before the payment was made
  assert.equal(refundIsOurs(e, p, 990_000), false);
  assert.equal(refundIsOurs({ ...e, inner: 0xabdn }, p, 1_000_100), false);
});

test("a deposit beaten to its waiting-room place says so plainly", () => {
  const POOL = "VisNPoo1111111111111111111111111111111111111";
  setPoolProgram(POOL);
  const e = chainError({
    message: "Simulation failed",
    logs: [
      `Program ${POOL} invoke [1]`,
      "Program log: Instruction: Deposit",
      "Program 11111111111111111111111111111111 invoke [2]",
      "Allocate: account Address { address: 9xyz, base: None } already in use",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
      `Program ${POOL} failed: custom program error: 0x0`,
    ],
  });
  assert.match(e.message, /took this one's place in the waiting room/);
  assert.match(e.message, /place in the waiting room/, "an automatic move treats it as passing and tries again with a new note");
  // a payment whose note was already spent fails with the same words (its nullifier's account): not about the waiting room
  const spent = chainError({
    message: "Simulation failed",
    logs: [
      `Program ${POOL} invoke [1]`,
      "Program log: Instruction: Transact",
      "Program 11111111111111111111111111111111 invoke [2]",
      "Allocate: account Address { address: 9nf1, base: None } already in use",
      "Program 11111111111111111111111111111111 failed: custom program error: 0x0",
      `Program ${POOL} failed: custom program error: 0x0`,
    ],
  });
  assert.doesNotMatch(spent.message, /waiting room/);
  // the same words from another program aren't about the waiting room
  const other = chainError({ message: "Simulation failed", logs: ["Program Other1111111111111111111111111111111111111 failed: account already in use"] });
  assert.doesNotMatch(other.message, /waiting room/);
});

// ─── hop text signing (VS-55) ───

test("a sending address signs a plain text, but never one of the app's own messages or a transaction", () => {
  const hop = Keypair.generate();
  assert.ok(signText(hop, "Verify ownership of 7x...: 4815162342").length > 40);
  assert.equal(signTextProblem("Please sign: exchange deposit 123"), null);
  assert.match(signTextProblem("vs:hop-lookup:v1 anything") ?? "", /VisionSwap's own/);
  assert.match(signTextProblem("ÿsolana offchain hello") ?? "", /off-chain/);
  assert.throws(() => signText(hop, "vs:own:..."), /VisionSwap's own/);
  // the bytes of a real delivery transfer read as a transaction
  const to = Keypair.generate().publicKey;
  const l1 = l1Message({ hop: hop.publicKey, to, lamports: 5_000_000n, blockhash: PublicKey.default.toBase58() });
  assert.equal(isTxMessage(l1), true);
  const v0 = new TransactionMessage({
    payerKey: hop.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: hop.publicKey, toPubkey: to, lamports: 1 })],
  })
    .compileToV0Message()
    .serialize();
  assert.equal(isTxMessage(v0), true);
  assert.equal(isTxMessage(new TextEncoder().encode("Sign this to prove you own the address")), false);
});

// ─── randomness (VS-06, VS-14) ───

test("randInt covers both ends evenly and secureRandom stays in [0, 1)", () => {
  const counts = [0, 0, 0];
  for (let i = 0; i < 30_000; i++) counts[randInt(0, 2)]++;
  for (const c of counts) assert.ok(c > 9_400 && c < 10_600, `${counts}`);
  for (let i = 0; i < 10_000; i++) {
    const x = secureRandom();
    assert.ok(x >= 0 && x < 1);
  }
  assert.equal(randInt(5, 5), 5);
  assert.equal(randInt(7, 3), 7);
});

// ─── what the server says is checked against what the page knows (VS-10, VS-37) ───

test("the extension ID built into the page wins over the server's", async () => {
  const { extensionIdFrom } = await import("../src/lib/extid.ts");
  const a = "a".repeat(32);
  const b = "b".repeat(32);
  assert.equal(extensionIdFrom(a, ""), a);
  assert.equal(extensionIdFrom("not-an-id", ""), null);
  assert.equal(extensionIdFrom(a, a), a);
  assert.equal(extensionIdFrom(b, a), null, "a server naming another extension is not followed");
  assert.equal(extensionIdFrom(null, a), null, "switched off on the server: nothing is offered");
});

test("probe and tax quotes carry a rounded amount, never the exact holding", async () => {
  const { bucketAmount } = await import("../src/lib/tokenfacts.ts");
  assert.equal(bucketAmount(7_654_321n), 7_000_000n);
  assert.equal(bucketAmount(10n), 10n);
  assert.equal(bucketAmount(9n), 9n);
  assert.equal(bucketAmount(199_999n), 100_000n);
  assert.equal(bucketAmount(0n), 0n);
});

test("only VisionSwap's own site counts as the official server, whatever a page or build names", async () => {
  const { officialServer } = await import("../src/lib/official.ts");
  // the website talks to the site it came from; the published extension names it
  assert.equal(officialServer("", "https://visionswap.net"), true);
  assert.equal(officialServer("https://visionswap.net", "chrome-extension://abc"), true);
  assert.equal(officialServer("", "https://www.visionswap.net"), true);
  // local and test copies, and look-alikes, aren't
  assert.equal(officialServer("", "http://localhost:5196"), false);
  assert.equal(officialServer("http://127.0.0.1:8787", "chrome-extension://abc"), false);
  assert.equal(officialServer("", "https://visionswap.net.example.com"), false);
  assert.equal(officialServer("", "http://visionswap.net"), false);
  assert.equal(officialServer("", ""), false);
});

test("a payment from the wallet keeps its note out of other spends until it goes or ends", async () => {
  const { holdsItsNote } = await import("../src/lib/walletpay.ts");
  for (const status of ["paying", "waiting", "sending", "needs-you"] as const) assert.equal(holdsItsNote({ status }), true, status);
  for (const status of ["sent", "scheduled", "returned", "cancelled"] as const) assert.equal(holdsItsNote({ status }), false, status);
});
