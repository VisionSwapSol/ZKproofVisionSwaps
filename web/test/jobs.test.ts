import { test } from "node:test";
import assert from "node:assert/strict";
import { patchJob, cancelledMeanwhile, mergeReplies, pollGroups, needsProof, backoff, splitSummary, rowsLeft, spentVerdict, definite, prepPlan, prepStep, isLive, isOpen, goneOut, finishDue, FEW_ROOTS, type JobStatus } from "../src/lib/jobs.ts";

type J = { id: string; status: JobStatus; created: number; latest: number; signature?: string | null; error?: string | null; note?: string | null; soon?: boolean; rootsLeft?: number | null };
const job = (id: string, status: JobStatus, extra: Partial<J> = {}): J => ({ id, status, created: 0, latest: 1000, ...extra });

test("a reply that arrives after a cancel can't bring the job back", () => {
  const list = [job("a", "cancelled"), job("b", "scheduled")];
  const m = mergeReplies(list, [
    { id: "a", status: "scheduled", signature: null, error: null },
    { id: "b", status: "stale", signature: null, error: "needs a fresh proof" },
  ]);
  assert.equal(m.list[0].status, "cancelled");
  assert.equal(m.list[1].status, "stale");
  assert.deepEqual(m.changed, ["b"]);
});

test("'sent' and 'unknown' are left for the caller to check, other news is merged", () => {
  const list = [job("a", "scheduled"), job("b", "sending"), job("c", "scheduled")];
  const m = mergeReplies(list, [
    { id: "a", status: "sent", signature: "sig", error: null },
    { id: "b", status: "unknown", signature: null, error: null },
    { id: "c", status: "scheduled", signature: null, error: null, note: "Waiting for the relayer to be topped up.", soon: true, rootsLeft: 80 },
  ]);
  assert.deepEqual(m.sent, ["a"]);
  assert.equal(m.list[0].status, "scheduled", "not marked sent before its notes are seen spent");
  assert.equal(m.list[1].status, "sending");
  assert.equal(m.list[2].note, "Waiting for the relayer to be topped up.");
  assert.equal(m.list[2].rootsLeft, 80);
  assert.deepEqual(m.changed, []);
});

test("patching one job only touches it, and only from the given statuses", () => {
  const list = [job("a", "scheduled"), job("b", "cancelled")];
  assert.equal(patchJob(list, "a", { status: "sending" })[0].status, "sending");
  assert.equal(patchJob(list, "b", { status: "scheduled" }, ["scheduled", "sending", "stale"])[1].status, "cancelled");
  assert.equal(patchJob(list, "b", { status: "scheduled" }, ["cancelled"])[1].status, "scheduled");
  assert.equal(patchJob(list, "a", { status: "sent" })[1], list[1]);
});

test("status questions go in groups of 50, those due first at the front", () => {
  const list = Array.from({ length: 120 }, (_, i) => job(`j${i}`, i % 10 === 0 ? "sent" : "scheduled", { latest: 10_000 - i }));
  const groups = pollGroups(list);
  assert.deepEqual(
    groups.map((g) => g.length),
    [50, 50, 8],
  );
  assert.equal(groups[0][0], "j119", "the earliest deadline first");
  assert.ok(!groups.flat().includes("j10"), "ended jobs aren't asked about");
  assert.deepEqual(pollGroups([job("x", "cancelled")]), []);
});

test("a fresh proof is made when stale, when roots run low, or once before it goes", () => {
  const now = 10 * 3_600_000;
  assert.equal(needsProof({ ...job("a", "stale"), created: 0 }, now), "stale");
  assert.equal(needsProof({ ...job("a", "stale"), created: 0, confirm: { amount: "1" } }, now), null, "waits for the owner's OK");
  assert.equal(needsProof({ ...job("a", "stale"), created: 0, nextTry: now + 1 }, now), null, "backing off");
  assert.equal(needsProof({ ...job("a", "scheduled"), created: 0, rootsLeft: FEW_ROOTS - 1 }, now), "roots");
  assert.equal(needsProof({ ...job("a", "scheduled"), created: 0, rootsLeft: FEW_ROOTS - 1, refreshed: now - 60_000 }, now), null, "just made");
  assert.equal(needsProof({ ...job("a", "scheduled"), created: now - 3_600_000, soon: true }, now), "timing");
  assert.equal(needsProof({ ...job("a", "scheduled"), created: now - 60_000, soon: true }, now), null, "proved only a minute ago");
  assert.equal(needsProof({ ...job("a", "scheduled"), created: 0, soon: true, refreshed: now - 20 * 60_000 }, now), "timing");
  assert.equal(needsProof({ ...job("a", "sending"), created: 0, soon: true }, now), null);
  assert.ok(backoff(1) < backoff(2) && backoff(4) === backoff(9));
});

const parts = [{ to: "AAAA1111111111111111111111111111" }, { to: "BBBB2222222222222222222222222222" }, { to: "CCCC3333333333333333333333333333" }, { to: "DDDD4444444444444444444444444444" }];

test("a split that stopped says who was paid and which payment didn't go", () => {
  const msg = splitSummary(parts, ["sent", "sent"], 2, "The relayer is busy.");
  assert.match(msg, /^Paid: AAAA…1111 and BBBB…2222\./);
  assert.match(msg, /Payment 3 \(CCCC…3333\) wasn't sent: The relayer is busy\./);
  assert.match(msg, /The 2 left are still in the form\./);
});

test("a payment whose outcome is unknown is named as such, not as failed", () => {
  const msg = splitSummary(parts, ["sent", "checking"], 1, "This payment may still go through.");
  assert.match(msg, /May still go through: BBBB…2222/);
  assert.doesNotMatch(msg, /wasn't sent/);
  assert.match(msg, /The 2 left are still in the form\./);
});

test("scheduled parts are named as scheduled", () => {
  const msg = splitSummary(parts, ["scheduled"], 1, "Too many requests.");
  assert.match(msg, /^Scheduled: AAAA…1111\. Payment 2 \(BBBB…2222\) wasn't sent/);
});

test("rows with an outcome leave the form, so a second press sends only the rest", () => {
  const rows = ["r1", "r2", "r3", "r4"];
  assert.deepEqual(rowsLeft(rows, ["sent", undefined, "checking"]), ["r2", "r4"]);
  assert.deepEqual(rowsLeft(rows, []), rows);
});

test("spent notes are put down to another payment only when the pool data covers the chain and every proof is known", () => {
  const base = { landed: false, ownNotes: false, caughtUp: true, allProofs: true };
  assert.equal(spentVerdict({ ...base, landed: true, caughtUp: false }), "sent");
  assert.equal(spentVerdict({ ...base, ownNotes: true, caughtUp: false }), "sent");
  // the data is still catching up (right after a restart, say): no verdict yet
  assert.equal(spentVerdict({ ...base, caughtUp: false }), null);
  assert.equal(spentVerdict(base), "other");
  // an earlier proof (a refresh whose answer was lost) may be the one that went
  assert.equal(spentVerdict({ ...base, allProofs: false }), "unclear");
});

test("only the server's own reasoned answers count as a definite 'not sent'", () => {
  assert.equal(definite({ status: 409, data: { error: "held", code: "held" } }), true);
  assert.equal(definite({ status: 400, data: { error: "Malformed request." } }), true);
  assert.equal(definite({ status: 503, data: { error: "Screening is briefly unavailable.", code: "screening_unavailable" } }), true);
  // gateway errors and uncoded server errors may hide a payment that went
  assert.equal(definite({ status: 502, data: null }), false);
  assert.equal(definite({ status: 504, data: null }), false);
  assert.equal(definite({ status: 500, data: { error: "Something went wrong. Please try again." } }), false);
  assert.equal(definite({ status: 404, data: null }), false);
});

test("a payment due soon gets a fresh proof sooner the shorter its window", () => {
  const now = 10 * 3_600_000;
  // proved 5 minutes ago, out within 15 minutes: a fresh one now names a root of the moment it leaves
  assert.equal(needsProof({ ...job("a", "scheduled"), window: "15m", created: now - 5 * 60_000, soon: true }, now), "timing");
  assert.equal(needsProof({ ...job("a", "scheduled"), window: "15m", created: now - 3 * 60_000, soon: true }, now), null);
  // payments spread over two minutes: after half a minute
  assert.equal(needsProof({ ...job("a", "scheduled"), window: "2m", created: now - 40_000, soon: true }, now), "timing");
  assert.equal(needsProof({ ...job("a", "scheduled"), window: "2m", created: now - 10_000, soon: true }, now), null);
  // longer windows keep the 15 minutes
  assert.equal(needsProof({ ...job("a", "scheduled"), window: "24h", created: now - 10 * 60_000, soon: true }, now), null);
  assert.equal(needsProof({ ...job("a", "scheduled"), window: "24h", created: now - 16 * 60_000, soon: true }, now), "timing");
});

test("a cancel the relayer could not confirm keeps being asked about", () => {
  const list = [job("a", "cancelled", { latest: 5 }), { ...job("b", "cancelled", { latest: 3 }), cancelPending: true }, job("c", "scheduled", { latest: 9 })];
  assert.deepEqual(pollGroups(list), [["b", "c"]]);
});

const MS = 1_000_000n; // 0.001 SOL
const PFEE = 2n * MS;
const ids = (xs: bigint[]) => xs.map((amount, id) => ({ id, amount }));

test("notes for later payments: a note another payment took is never cut from under it", () => {
  // the case that used to cut 1.0005 (taken by the 1.0 payment), join it back, and go round until it gave up
  const notes = [1_000_500_000n, 200n * MS, 200n * MS, 200n * MS];
  const needs = [1_000n * MS, 300n * MS];
  const first = prepStep(ids(notes), needs, PFEE, true);
  assert.equal(first.kind, "merge");
  assert.deepEqual(first.kind === "merge" && first.notes.map((i) => notes[i]), [200n * MS, 200n * MS]);
  assert.deepEqual(prepPlan(notes, needs, PFEE, true), { steps: 2, ok: true });
});

test("notes for later payments: the plan counts every cut and join", () => {
  // spread over two minutes, a bigger note may do: one join
  assert.deepEqual(prepPlan([1_000n * MS, 200n * MS, 200n * MS], [900n * MS, 250n * MS], PFEE, false), { steps: 1, ok: true });
  // one big note: two cuts
  assert.deepEqual(prepPlan([1_500n * MS, 200n * MS], [1_000n * MS, 300n * MS], PFEE, true), { steps: 2, ok: true });
  // a note of each size already: nothing to do
  assert.deepEqual(prepPlan([1_000n * MS, 300n * MS], [1_000n * MS, 300n * MS], PFEE, true), { steps: 0, ok: true });
  assert.deepEqual(prepStep(ids([1_000n * MS, 300n * MS]), [1_000n * MS, 300n * MS], PFEE, true), { kind: "ready", picks: [0, 1] });
  // not enough: refused before any fee is paid
  assert.equal(prepPlan([500n * MS, 200n * MS], [1_000n * MS], PFEE, true).ok, false);
});

test("a short window gets its fresh proof for timing only once", () => {
  const now = 10_000_000;
  const short = { ...job("a", "scheduled"), window: "2m", soon: true };
  assert.equal(needsProof({ ...short, created: now - 40_000 }, now), "timing");
  // already made once: each one is a full proof, and makes the batch share the newest root again
  assert.equal(needsProof({ ...short, created: now - 100_000, refreshed: now - 60_000 }, now), null);
  assert.equal(needsProof({ ...short, window: "15m", created: now - 10 * 60_000, refreshed: now - 5 * 60_000 }, now), null);
  // a long window keeps the 15-minute rule
  assert.equal(needsProof({ ...short, window: "1h", created: 0, refreshed: now - 20 * 60_000 }, now), "timing");
});

test("a payment cancelled while it was being handed over is listed as cancelled, not scheduled", () => {
  const parts = [{ to: "AAAAbbbbCCCCdddd" }, { to: "EEEEffffGGGGhhhh" }, { to: "IIIIjjjjKKKKllll" }];
  const msg = splitSummary(parts, ["scheduled", "cancelled"], 2, "no reason");
  assert.match(msg, /Scheduled: AAAA…dddd\./);
  assert.match(msg, /Cancelled: EEEE…hhhh\./);
  assert.doesNotMatch(msg, /Scheduled: [^.]*EEEE/);
  assert.deepEqual(rowsLeft(["a", "b", "c"], ["scheduled", "cancelled"]), ["c"]);
});

test("a refused hand-over of a payment cancelled meanwhile is a cancel, never a reason to schedule it again", () => {
  // its notes turned out to be held (by the hand-over itself, say), but the person cancelled it meanwhile
  assert.equal(cancelledMeanwhile(job("a", "cancelled"), false, true), "cancelled", "every answer was clear: nothing is held there");
  assert.equal(cancelledMeanwhile(job("a", "cancelled"), true, true), "call-off", "an earlier try may have got there: called off first");
  assert.equal(cancelledMeanwhile(job("a", "scheduled"), false, true), null, "still wanted: its notes are set aside and others picked");
  assert.equal(cancelledMeanwhile(undefined, false, true), null);
  // any other refusal
  assert.equal(cancelledMeanwhile(job("a", "cancelled"), false), "cancelled");
  assert.equal(cancelledMeanwhile(undefined, true), "call-off", "cleared from the list counts as cancelled");
  assert.equal(cancelledMeanwhile(job("a", "stale"), true), null);
});

test("a delivering job is still followed, and one the relayer leaves waiting for the app is 'waiting'", () => {
  const list = [job("a", "sending"), job("b", "delivering"), job("c", "scheduled")];
  const m = mergeReplies(list, [
    { id: "a", status: "delivering", signature: null, error: null, tx1: "T1", hop: "H1" },
    { id: "b", status: "delivering", signature: null, error: null, note: "Ready to finish: open VisionSwap and it is delivered." },
    { id: "c", status: "sent", signature: "D", error: null },
  ]);
  assert.equal(m.list[0].status, "delivering");
  assert.equal((m.list[0] as J & { tx1?: string; hop?: string }).tx1, "T1");
  assert.equal((m.list[0] as J & { tx1?: string; hop?: string }).hop, "H1");
  assert.equal(m.list[1].status, "waiting");
  assert.deepEqual(m.changed, ["a", "b"]);
  assert.deepEqual(m.sent, ["c"]);
  // and a delivering one's "sent" is still checked before it is said
  const m2 = mergeReplies([job("d", "delivering")], [{ id: "d", status: "sent", signature: "D2", error: null }]);
  assert.deepEqual(m2.sent, ["d"]);
});

test("delivering and waiting jobs are asked about until they end, but hold no notes", () => {
  assert.equal(isOpen("delivering"), true);
  assert.equal(isOpen("waiting"), true);
  assert.equal(isLive("delivering"), false);
  assert.equal(isLive("waiting"), false);
  assert.equal(isOpen("sent"), false);
  assert.deepEqual(pollGroups([job("a", "delivering", { latest: 3 }), job("b", "sent"), job("c", "waiting", { latest: 1 })]), [["c", "a"]]);
});

test("the app finishes a delivery itself once it waits for it, or after the relayer has had five minutes", () => {
  const now = 10_000_000;
  assert.equal(finishDue({ status: "waiting" }, now), true);
  assert.equal(finishDue({ status: "delivering" }, now), false, "not known since when: noted first");
  assert.equal(finishDue({ status: "delivering", delivering: now - 60_000 }, now), false);
  assert.equal(finishDue({ status: "delivering", delivering: now - 6 * 60_000 }, now), true);
  assert.equal(finishDue({ status: "delivering", delivering: 0 }, now), true);
  assert.equal(finishDue({ status: "scheduled" }, now), false);
});

test("a cancel answered with any going-out status (delivering included) is never taken as cancelled", () => {
  for (const s of ["sending", "delivering", "waiting", "sent"]) assert.equal(goneOut(s), true, s);
  for (const s of ["scheduled", "stale", "cancelled", "failed", "unknown"]) assert.equal(goneOut(s), false, s);
});

test("a sending address the relayer names is taken only when it is the job's own", () => {
  type H = J & { hop?: string; tx1?: string };
  const list: H[] = [{ ...job("a", "scheduled"), hop: "OwnHop" }, job("b", "scheduled")];
  const own = (j: H, h: string) => (j.id === "a" ? h === "OwnHop" : h === "HopB");
  const m = mergeReplies(
    list,
    [
      { id: "a", status: "delivering", signature: null, error: null, note: "Ready", hop: "SomeoneElsesHop", tx1: "T1x" },
      { id: "b", status: "delivering", signature: null, error: null, hop: "HopB", tx1: "T1b" },
    ],
    own,
  );
  assert.equal(m.list[0].hop, "OwnHop", "another payment's sending address is ignored");
  assert.equal(m.list[0].tx1, undefined);
  assert.equal(m.list[0].status, "waiting");
  assert.equal(m.list[1].hop, "HopB");
  assert.equal(m.list[1].tx1, "T1b");
});
