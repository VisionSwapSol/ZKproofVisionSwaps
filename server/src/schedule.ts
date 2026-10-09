import { createHash, randomBytes, randomInt } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { relay, cleanRequest, cleanBody, rootRing, lastRing, notesInFlight, type RelayRequest, type RelayBody, type RelayResult, type DeliveryBody, type OwnBody, type Ring } from "./relayer.ts";
import { nonces } from "./nonces.ts";
import { hops, type HopRec } from "./hops.ts";
import { conn, pool } from "./chain.ts";
import { store, indexerStatus } from "./indexer.ts";
import { log } from "./log.ts";
import { config } from "./config.ts";
import { loadState, saveState, saveStateNow, stateRestoring } from "./durable.ts";

/**
 * "Send later": a private payment whose proof is made now and handed to the relayer, which
 * sends it at a random moment inside the chosen window, so when it lands can't be matched to
 * the deposit it came from. (The proof itself names a recent state of the pool, so the chain
 * still shows roughly when it was made; the owner's app makes a fresh one near the send time
 * when it is open.)
 *
 * The relayer only ever holds the proof: it can send that exact payment (recipient, amount
 * and fee are sealed inside the proof) or not send it. If it never does, the notes stay
 * unspent and the owner can spend them again. Jobs are kept in durable state (sealed, and in
 * App Storage on Replit) so a restart or a republish loses nothing. Once a job has ended only
 * its outcome is kept, for two days; the proof goes as soon as it can't be sent any more.
 *
 * A proof names one of the pool's last 256 roots, and every pool transaction adds one or two.
 * A job whose root is close to falling out of that list is sent early (still inside its window)
 * rather than let it go stale.
 *
 * A payment to an outside address is delivered in two steps (see hops.ts): the job is "delivering"
 * once the pool has paid its one-time hop, and "sent" once the hop's transfer to the recipient has
 * landed. That transfer was signed by the owner's browser on one of the relayer's durable nonces,
 * leased to the job for as long as it waits.
 */

// SEND_LATER_SCALE shrinks every window for automated tests on a local chain (e.g. 60 → 15 minutes become 15 seconds)
const SCALE = Math.max(1, Number(process.env.SEND_LATER_SCALE ?? 1) || 1);
const MIN = 60_000 / SCALE;
/** "2m" spreads a batch of payments sent "now" over two minutes, so they don't land together. */
export const WINDOWS: Record<string, number> = { "2m": 2 * MIN, "15m": 15 * MIN, "1h": 60 * MIN, "24h": 24 * 60 * MIN };

export type JobStatus = "scheduled" | "sending" | "delivering" | "sent" | "failed" | "stale" | "cancelled";
type Job = {
  id: string;
  tokenHash: string;
  status: JobStatus;
  /** the proof and its details, kept only while the job may still be sent */
  req?: RelayRequest;
  /** 2 for a job handed over with its delivery (or own-wallet signature); none for one from before deliveries */
  v?: 2;
  /** where the hop passes the payment on, and the hop's signed N2 (kept with the proof) */
  delivery?: DeliveryBody;
  own?: OwnBody;
  /** once the pool has paid the hop: the pool spend's signature and the hop (the delivery ledger follows the rest) */
  tx1?: string;
  hop?: string;
  /** while it is delivering: the recipient, so a hop the delivery ledger let go of is still checked against it (see followMissing) */
  to?: string;
  /** the notes it spends, kept while it holds them */
  nullifiers?: [string, string];
  window?: string;
  due?: number;
  latest?: number;
  tries?: number;
  /** every send of it so far (newest last), and the block height after which the newest can't land */
  sigs?: string[];
  lastValid?: number;
  /** why a waiting job hasn't gone yet (the relayer is being topped up, a network problem) */
  note?: string;
  /** after a failed try: not tried again before this, even when its root is getting old */
  retryAt?: number;
  signature?: string;
  error?: string;
  done?: number;
};

const MAX_JOBS = 5000;
/** live jobs one network may hold; fewer once the scheduler is nearly full, so nobody can fill it */
const PER_IP = 60;
const PER_IP_CROWDED = 10;
/** how often the same notes may be scheduled in a day (cancel and schedule again, over and over) */
const PER_NOTE_DAY = 12;
const KEEP_DONE_MS = 48 * 3600_000;
const KEEP_STALE_MS = 7 * 24 * 3600_000;
/** payments sent at the same time (each holds its place until it has landed, which can take a while on a busy network) */
const CONCURRENCY = Math.max(1, Math.floor(Number(process.env.SEND_LATER_CONCURRENCY ?? 8)) || 8);
/** roots the program remembers, and how many from the end a job is sent early */
const RING = 256;
const MARGIN = 48;
/** a job still failing this long after its window gave up (a relayer being topped up never gives up) */
const GIVE_UP_MS = 30 * 60_000;
/** after the payments start loading, how long an unknown id may still be on its way back from storage */
const RESTORE_GRACE_MS = 10 * 60_000;
/** a cancelled id that never became a job is refused for this long, however often its hand-over is sent again */
const CALLED_OFF_MS = 60 * 60_000;
/** the clock for the start's grace (tests move it) */
let clock = () => Date.now();
/** when the payments last started loading (set again by startScheduler, which may wait for the copy before this one) */
let loadedAt = clock();
/** the scheduler holds the payments (never while it waits for, or has paused for, another copy of the site) */
let loaded = false;

const jobs = new Map<string, Job>();
/** not saved: which network scheduled each live job, for the per-network cap */
const owners = new Map<string, string>();
/** not saved: when each note was scheduled lately */
const noteUses = new Map<string, number[]>();
/** notes being checked for a new job right now */
const reserved = new Set<string>();
/** jobs being sent right now */
const running = new Set<string>();
/** jobs getting a fresh proof right now: they wait */
const pausing = new Set<string>();
/** new jobs being checked right now (id: token hash) */
const checkingIds = new Map<string, string>();
/** new jobs cancelled while they were checked: they never go out, not even when the app sends them again (kept an hour) */
const calledOff = new Map<string, { tokenHash: string; at: number }>();

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const live = (j: Job) => j.status === "scheduled" || j.status === "sending" || j.status === "stale";
/** A job from before deliveries that pays someone other than the relayer: the relayer can't send it any more. */
const oldPayout = (j: Job) => j.v !== 2 && !!j.req && BigInt(j.req.withdraw) > BigInt(j.req.relayerFee);
const MIGRATED = "Moving to the new delivery format. Open VisionSwap to confirm it, and it is sent.";
const err = (message: string, status: number, code?: string) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
/** The answer when notes belong to another scheduled payment: the same shape /api/relay gives, so the app can set them aside. */
const heldErr = (h: { nullifiers: string[]; jobs: string[] }) =>
  Object.assign(err("Those notes are already scheduled in another payment.", 409, "held"), { held: h.nullifiers, jobs: h.jobs });
/** Notes being checked for a scheduled payment this very moment: nothing else may spend them until that's done. */
export const isReserved = (nfs: readonly string[]) => nfs.some((n) => reserved.has(String(n).toLowerCase()));
const beingChecked = () => err("Those notes are being scheduled in another payment right now. Please try again in a moment.", 409, "in_flight");

/** App Storage hasn't answered yet, so a job this server doesn't know may still come back. */
let restoringNow = () => stateRestoring("scheduled");
const stillLoading = () => Object.assign(err("Scheduled payments are still loading. Try again in a moment.", 503), { retryAfter: 15 });
/** The same, within the start's grace: past it, an unknown job is answered as unknown and may be handed back. */
const restoring = () => clock() - loadedAt < RESTORE_GRACE_MS && restoringNow();
/** Nothing is answered as "unknown" or "ended" before the payments are loaded (a relayer runs here, but the scheduler doesn't yet). */
const notLoaded = () => !!config.relayer && !loaded;
let toldStuck = false;

/** Adds the saved jobs this server doesn't hold yet (the ones it holds are newer). */
function adopt(text: string): number {
  let added = 0;
  try {
    for (const j of JSON.parse(text) as (Job & { created?: number; resumed?: boolean })[]) {
      const cur = jobs.get(j.id);
      if (cur) {
        // handed back (or given a fresh proof) while storage was slow, but the saved copy was mid-send:
        // its sends may still land, so they are followed too before this one goes again
        if (j.status === "sending" && j.sigs?.length && (cur.status === "scheduled" || cur.status === "sending")) {
          cur.sigs = [...new Set([...j.sigs, ...(cur.sigs ?? [])])].slice(-6);
          cur.lastValid = Math.max(cur.lastValid ?? 0, j.lastValid ?? 0) || undefined;
          if (cur.status === "scheduled" && !running.has(cur.id)) cur.status = "sending";
        }
        continue;
      }
      // fields older versions kept
      delete j.created;
      delete j.resumed;
      // made before deliveries: its owner's app makes it again in the new format (its notes stay unspent meanwhile)
      if (j.status === "scheduled" && oldPayout(j)) finish(j, "stale", { error: MIGRATED });
      // a job caught mid-send by a restart stays "sending": the tick finds out from the chain whether it went
      jobs.set(j.id, j);
      added++;
    }
  } catch (e) {
    log(`schedule: couldn't read the saved payments: ${(e as Error).message}`);
  }
  return added;
}

async function load() {
  // App Storage may only answer after the start: what it holds is added back then
  const text = await loadState("scheduled", (late) => {
    log(`schedule: ${adopt(late)} payment(s) added back from storage`);
    save();
  });
  if (text) adopt(text);
}

/** Returns at once: the list is written a moment later, once, however many changes came in. */
function save() {
  saveState("scheduled", () => JSON.stringify([...jobs.values()]));
}

/** Resolves once the list is on disk, or rejects (then nothing is sent). */
function saveNow() {
  return saveStateNow("scheduled", () => JSON.stringify([...jobs.values()]), true);
}

/** Ends a job: only its outcome stays, and only for a while. */
function finish(j: Job, status: JobStatus, patch: { signature?: string; error?: string } = {}) {
  // a nonce still leased to it goes back (one whose delivery went out is the delivery ledger's to let go)
  if (status !== "sent" && j.delivery?.leaseId) nonces.release(j.delivery.leaseId);
  j.status = status;
  if (patch.signature) j.signature = patch.signature;
  j.error = patch.error;
  // rounded, so the record says nothing about when exactly it went
  j.done = Math.ceil(Date.now() / 600_000) * 600_000;
  delete j.req;
  delete j.window;
  delete j.due;
  delete j.latest;
  delete j.tries;
  delete j.sigs;
  delete j.lastValid;
  delete j.note;
  delete j.retryAt;
  delete j.delivery;
  delete j.own;
  delete j.v;
  delete j.to;
  // a stale job still holds its notes until its owner sends a fresh proof or cancels
  if (status !== "stale") {
    delete j.nullifiers;
    owners.delete(j.id);
  }
}

const READY = "Ready to finish: open VisionSwap and it is delivered.";
/** a delivery whose SOL the owner's app moved elsewhere (into the private balance, or anywhere the owner picked) before it went */
export const MOVED = "Not delivered: its SOL was moved from its one-time sending address by your app (into your private balance, or to an address you picked).";

/**
 * The job's pool spend landed. A delivery goes on as "delivering" until its hop's transfer lands
 * (the delivery ledger says when); anything else is sent. Either way the proof and the notes go.
 */
function landed(j: Job, tx1: string, res?: RelayResult) {
  if (!j.delivery) return finish(j, "sent", { signature: tx1 });
  const d = res?.delivery;
  j.hop = j.req?.recipient ?? j.hop;
  j.to = j.delivery.to;
  if (tx1) j.tx1 = tx1;
  if (d?.status === "delivered") return finish(j, "sent", { signature: d.signature ?? undefined });
  j.status = "delivering";
  j.note = d?.status === "waiting" ? READY : undefined;
  for (const k of ["req", "v", "delivery", "own", "window", "due", "latest", "tries", "sigs", "lastValid", "retryAt", "nullifiers"] as const) delete j[k];
  owners.delete(j.id);
}

/** A delivering job follows its delivery: sent once the hop's transfer landed (or the owner's app finished it). */
function followDelivery(j: Job, rec: HopRec) {
  // a record taken as dropped is asked about again on-chain (see followDropped)
  if (j.status !== "delivering" || rec.status === "dropped") return;
  if (rec.status === "delivered") return finish(j, "sent", { signature: rec.delivered });
  if (rec.status === "withdrawn") return finish(j, "failed", { error: MOVED });
  j.note = rec.status === "waiting" ? READY : undefined;
}

/**
 * Delivering jobs whose hop the ledger no longer holds (or holds as dropped): when each may next be
 * looked at on-chain (not saved). A look that can't tell, or finds the hop still waiting, keeps its
 * place in line; only a job that ended leaves it.
 */
const lookAt = new Map<string, number>();
/** how long after a look one is looked at again: soon after one that couldn't tell, seldom while one waits for its owner */
const LOOK_AGAIN_MS = 60_000;
const WAITING_LOOK_MS = 10 * 60_000;
/** how many such looks one tick makes at most */
const LOOKS_PER_TICK = 5;

/**
 * A delivering job whose delivery the ledger let go of (long after it ended) or lost: the hop itself
 * says how it stands. Delivered (the hop paid for its own transfer to the recipient, or holds nothing)
 * is sent; one whose SOL the owner's app moved elsewhere first is not delivered; a hop still holding
 * SOL waits for the owner's app, which finishes it.
 */
async function followMissing(j: Job, now: number) {
  lookAt.set(j.id, now + LOOK_AGAIN_MS);
  const s = await hops.settleMissing(j.hop!, { tx1: j.tx1, to: j.to }).catch(() => null);
  if (!s || j.status !== "delivering") return;
  if (s.delivered || s.withdrawn) {
    lookAt.delete(j.id);
    if (s.delivered) finish(j, "sent", s.signature ? { signature: s.signature } : {});
    else finish(j, "failed", { error: MOVED });
    return save();
  }
  // still waiting for its owner's app (for weeks, maybe): looked at again now and then, saved only when that's news
  lookAt.set(j.id, now + WAITING_LOOK_MS);
  if (j.note !== READY) {
    j.note = READY;
    save();
  }
}

/**
 * A delivering job (its pool payment was seen landing) whose delivery record says that payment never
 * landed: the chain is asked again. One that did land goes back to the finisher; one that certainly
 * didn't spent nothing, so the job ends "not sent" (its owner's app offers to send it again).
 */
async function followDropped(j: Job, rec: HopRec, now: number) {
  lookAt.set(j.id, now + LOOK_AGAIN_MS);
  const s = await hops.recheck(rec.hop).catch(() => "unknown" as const);
  if (j.status !== "delivering" || s === "unknown") return;
  // landed: back with the finisher, followed through its record again
  lookAt.delete(j.id);
  if (s === "dropped") finish(j, "failed", { error: "Not sent. Your SOL is still in your private balance." });
  save();
}

/**
 * Deliveries the ledger finished meanwhile (it tells as it goes; this catches up after a restart). Ones
 * it no longer holds, or holds as dropped, are looked up on-chain, a few per tick: only ones due a look
 * count, the longest-waiting first, so a handful that never end can't keep the rest from their turn.
 */
async function followDeliveries(now: number) {
  const due: Job[] = [];
  for (const j of [...jobs.values()]) {
    if (j.status !== "delivering" || !j.hop) continue;
    const rec = hops.get(j.hop);
    if (rec && rec.status !== "dropped") {
      followDelivery(j, rec);
      if (j.status !== "delivering") save();
    } else if ((lookAt.get(j.id) ?? 0) <= now) due.push(j);
  }
  due.sort((a, b) => (lookAt.get(a.id) ?? 0) - (lookAt.get(b.id) ?? 0));
  for (const j of due.slice(0, LOOKS_PER_TICK)) {
    // as it stands now (an earlier look in this tick may have taken a while)
    if (j.status !== "delivering" || !j.hop) continue;
    const rec = hops.get(j.hop);
    if (!rec) await followMissing(j, now);
    else if (rec.status === "dropped") await followDropped(j, rec, now);
    else followDelivery(j, rec);
  }
}

hops.onChange = (rec) => {
  const j = rec.jobId ? jobs.get(rec.jobId) : undefined;
  if (!j || j.hop !== rec.hop) return;
  followDelivery(j, rec);
  save();
};
// a nonce leased to a job is kept while that job may still be sent or delivered
nonces.hooks.ownerLive = (owner) => {
  // not before the payments are in (App Storage's copy too): a job not loaded yet isn't gone
  if (!owner.startsWith("job:") || !loaded || restoringNow()) return null;
  const s = jobs.get(owner.slice(4))?.status;
  return s === "scheduled" || s === "sending" || s === "delivering";
};

/** Whether `tokenHash` is the owner's of job `id` (true for an id no job has: it is new, or was lost). */
export function jobTokenOk(id: string, tokenHash: string): boolean {
  const j = jobs.get(id);
  return !j || j.tokenHash === tokenHash;
}

/** Live jobs holding any of these notes: such notes can't be spent by another payment meanwhile. */
export function heldBy(nullifiers: readonly string[]): { nullifiers: string[]; jobs: string[] } {
  const want = new Set(nullifiers.map((n) => String(n).toLowerCase()));
  const out = { nullifiers: [] as string[], jobs: [] as string[] };
  for (const j of jobs.values()) {
    if (!live(j) || !j.nullifiers) continue;
    const hit = j.nullifiers.filter((n) => want.has(n));
    if (!hit.length) continue;
    out.nullifiers.push(...hit);
    out.jobs.push(j.id);
  }
  return out;
}

/** How many roots ago this root was the newest, or null once the pool no longer accepts it. */
export function rootAge(ring: Ring, rootHex: string): number | null {
  const root = BigInt("0x" + rootHex);
  const pos = ring.roots.indexOf(root);
  if (pos < 0) return null;
  return (ring.rootIndex - pos + RING) % RING;
}

/**
 * Which waiting jobs go now: those that are due, and those whose root would fall out of the
 * pool's list before long. Every send ahead of a job adds two roots itself, so the margin
 * grows with the queue. Oldest roots go first. Jobs whose root is already gone are stale.
 */
export function pickRuns(cands: { id: string; due: number; age: number | null; hold?: number }[], now: number, busy: number, free: number, margin = MARGIN) {
  const stale = cands.filter((c) => c.age === null).map((c) => c.id);
  const send: string[] = [];
  const early: string[] = [];
  const queue = cands.filter((c) => c.age !== null).sort((a, b) => b.age! - a.age! || a.due - b.due);
  let ahead = busy;
  for (const c of queue) {
    const risky = c.age! + 2 * ahead >= RING - margin;
    if (c.due > now && !risky) continue;
    ahead++;
    // backing off after a failed try: it waits, even near the end of the ring (it still counts as ahead)
    if ((c.hold ?? 0) > now || send.length >= free) continue;
    send.push(c.id);
    if (c.due > now) early.push(c.id);
  }
  return { send, stale, early };
}

/** When a job goes: uniform over the window, never in its first tenth (so "later" is never "now"). */
function drawDue(now: number, latest: number) {
  const span = Math.max(1, latest - now);
  return now + Math.round(span * 0.1) + randomInt(Math.max(1, Math.round(span * 0.9)));
}

export type ScheduleInput = {
  /** 2: with `delivery` (an outside address) or `own` (one of the sender's wallets); pages from before send none */
  v?: unknown;
  request?: unknown;
  delivery?: unknown;
  own?: unknown;
  window?: string;
  /** the owner's own token (so a resubmit is recognised), or none for one made here */
  token?: string;
  /** keep an earlier deadline (a payment handed back after the relayer lost it) */
  until?: number;
  /** the job's id: an existing job of the same notes gets this fresh proof, a lost one comes back */
  id?: string;
};

/**
 * Checks the payment (here, without telling anyone outside about it), then schedules it. With
 * an `id` it updates that job in place (a fresh proof for the same notes keeps its send moment
 * and its deadline), so asking twice never makes two jobs.
 */
export async function schedule(b: ScheduleInput, ip = ""): Promise<{ id: string; token: string; window: string; latest: number }> {
  const body: RelayBody = b.v === 2 ? cleanBody({ v: 2, request: b.request, delivery: b.delivery, own: b.own }) : { v: 1, request: cleanRequest(b.request) };
  const req = body.request;
  // a delivery's nonce is leased to the job's own id (see /api/relay/prepare)
  if (body.delivery && b.id == null) throw err("Malformed request.", 400);
  const window = String(b.window ?? "");
  const span = WINDOWS[window];
  if (!span) throw err("Pick 15 minutes, 1 hour or 24 hours.", 400);
  if (b.token != null && !/^[0-9a-f]{32,64}$/.test(String(b.token))) throw err("Malformed request.", 400);
  if (b.id != null && !/^[0-9a-f]{24}$/.test(String(b.id))) throw err("Malformed request.", 400);
  const token = b.token ? String(b.token) : randomBytes(16).toString("hex");
  const tokenHash = sha(token);
  const nfs = req.nullifiers;
  const now = Date.now();

  const same = b.id ? jobs.get(b.id) : undefined;
  if (same) {
    if (same.tokenHash !== tokenHash) throw err("Not allowed.", 403);
    if (same.status === "sending" || same.status === "delivering" || running.has(same.id)) throw err("It's already going out.", 409, "going");
    if (same.status !== "scheduled" && same.status !== "stale") throw err(`That payment has already ${same.status === "sent" ? "gone out" : "ended"}.`, 409, same.status === "sent" ? "sent" : undefined);
    // the same payment: it spends the same note (a padding input gets a new random nullifier each proof)
    if (!same.nullifiers?.some((n) => nfs.includes(n))) throw err("Malformed request.", 400);
  }
  // cancelled while an earlier try of this very hand-over was checked: the app may send it again after a lost answer
  if (!same && b.id && calledOff.get(b.id)?.tokenHash === tokenHash) throw err("That payment has already ended.", 409);
  const others = (h: ReturnType<typeof heldBy>) => {
    const jobs = h.jobs.filter((id) => id !== same?.id);
    return { jobs, nullifiers: jobs.length ? h.nullifiers.filter((n) => !same?.nullifiers?.includes(n)) : [] };
  };
  const held = others(heldBy(nfs));
  if (held.jobs.length) throw heldErr(held);
  if (isReserved(nfs)) throw beingChecked();

  if (!same) {
    const all = [...jobs.values()].filter(live);
    const ipKey = sha("ip:" + ip);
    const mine = all.filter((j) => owners.get(j.id) === ipKey).length;
    if (all.length >= MAX_JOBS) throw err("Too many payments are scheduled right now. Try again later.", 503, "full");
    if (mine >= PER_IP || (all.length >= MAX_JOBS * 0.8 && mine >= PER_IP_CROWDED)) {
      throw err("Too many payments are scheduled from your network right now. Try again later.", 429);
    }
    const day = now - 24 * 3600_000;
    for (const n of nfs) {
      const uses = (noteUses.get(n) ?? []).filter((t) => t > day);
      if (uses.length >= PER_NOTE_DAY) throw err("This payment has been scheduled too many times today. Send it now, or try again tomorrow.", 429);
    }
  }

  // held while checked, so two requests for the same notes can't both get through
  // (and a job getting a fresh proof doesn't start going out with its old one meanwhile)
  for (const n of nfs) reserved.add(n);
  if (same) pausing.add(same.id);
  const checking = !same && b.id ? b.id : null;
  if (checking) checkingIds.set(checking, tokenHash);
  let off = false;
  try {
    await relay(body, { dryRun: true, ip, ...(body.delivery ? { jobId: String(b.id) } : {}) });
  } finally {
    for (const n of nfs) reserved.delete(n);
    if (same) pausing.delete(same.id);
    if (checking) {
      checkingIds.delete(checking);
      off = calledOff.has(checking);
    }
  }
  // cancelled while it was being checked: the cancel stands
  if (off) throw err("That payment has already ended.", 409);
  const heldNow = others(heldBy(nfs));
  if (heldNow.jobs.length) throw heldErr(heldNow);
  // an instant payment of the same notes got in while this was checked: it spends them
  if (notesInFlight(nfs)) throw err("Those notes are being spent in another payment right now.", 409, "in_flight");
  if (same && (jobs.get(same.id) !== same || (same.status !== "scheduled" && same.status !== "stale") || running.has(same.id))) {
    throw err(same.status === "cancelled" ? "That payment has already ended." : "It's already going out.", 409);
  }
  // the nonce its delivery was signed on is the job's now, for as long as it waits (checked just above to be leased to this id)
  const leaseId = body.delivery?.leaseId;
  if (leaseId && !nonces.bind(leaseId, `job:${b.id}`)) throw err("This payment needs a fresh signature. Please try again. Nothing was spent.", 409, "stale");
  // a fresh signature on another nonce: the one before goes back
  const oldLease = same?.delivery?.leaseId;
  if (oldLease && oldLease !== leaseId) nonces.release(oldLease);
  for (const n of nfs) noteUses.set(n, [...(noteUses.get(n) ?? []).filter((t) => t > now - 24 * 3600_000), now]);

  let latest: number;
  let due: number;
  if (same && same.latest && same.latest > now) {
    // a fresh proof keeps the payment's moment, unless that moment has just passed
    latest = same.latest;
    due = same.due && same.due > now + 20_000 ? same.due : drawDue(now, latest);
  } else {
    const until = Number(b.until);
    latest = Number.isFinite(until) && until > now ? Math.min(Math.max(until, now + WINDOWS["2m"]), now + WINDOWS["24h"]) : now + span;
    due = drawDue(now, latest);
  }
  const id = same?.id ?? (b.id && !jobs.has(b.id) ? b.id : randomBytes(12).toString("hex"));
  const job: Job = {
    id,
    tokenHash,
    status: "scheduled",
    req,
    ...(body.v === 2 ? { v: 2 as const } : {}),
    ...(body.delivery ? { delivery: body.delivery } : {}),
    ...(body.own ? { own: body.own } : {}),
    nullifiers: nfs,
    window,
    due,
    latest,
    tries: 0,
  };
  if (same) {
    // the same record, so nothing holding it sees a different job
    for (const k of Object.keys(same) as (keyof Job)[]) delete same[k];
    Object.assign(same, job);
  } else {
    jobs.set(id, job);
    owners.set(id, sha("ip:" + ip));
  }
  save();
  return { id, token, window, latest };
}

/** How each job is doing. `soon` and `rootsLeft` let the owner's open app refresh a proof in time. */
export function statuses(ids: string[]) {
  // "unknown" tells the app to hand a job back: not while it may still come back from storage
  if ((notLoaded() || restoring()) && ids.slice(0, 200).some((id) => !jobs.has(id))) throw stillLoading();
  const ring = lastRing();
  const now = Date.now();
  return ids.slice(0, 200).map((id) => {
    const j = jobs.get(id);
    if (!j) return { id, status: "unknown" as const, signature: null, error: null };
    const waiting = j.status === "scheduled";
    const age = waiting && ring && j.req ? rootAge(ring, j.req.root) : null;
    return {
      id,
      status: j.status,
      // a delivered payment's signature is its delivery's (what the recipient sees); the pool spend's is tx1
      signature: j.signature ?? (j.tx1 ? null : (j.sigs?.at(-1) ?? null)),
      error: j.error ?? null,
      note: j.note ?? null,
      ...(j.tx1 ? { tx1: j.tx1 } : {}),
      ...(j.hop ? { hop: j.hop } : {}),
      ...(waiting ? { soon: (j.due ?? 0) - now < 10 * 60_000, rootsLeft: age == null ? null : RING - age } : {}),
    };
  });
}

/** Job ids for a status look: the well-formed ones, at most 200 (null when there are more, or no list). */
export function jobIds(list: unknown): string[] | null {
  if (!Array.isArray(list) || list.length > 200) return null;
  return list.filter((x): x is string => typeof x === "string" && /^[0-9a-f]{24}$/.test(x));
}

/**
 * How the app asks after its scheduled payments: POST /api/relay/jobs/status with {ids}, so the ids
 * never sit in a URL (where logs and proxies keep them). GET /api/relay/jobs?ids=… stays for pages
 * opened before the change. Both answer in the app's {error} shape, with Retry-After while loading.
 */
export function jobStatusRoutes(app: FastifyInstance, fail: (reply: FastifyReply, e: unknown) => void) {
  const limit = { rateLimit: { max: 120, timeWindow: "1 minute" } };
  app.post("/api/relay/jobs/status", { bodyLimit: 8 * 1024, config: limit }, async (req, reply) => {
    try {
      const ids = jobIds((req.body as { ids?: unknown } | null)?.ids);
      if (!ids) return reply.code(400).send({ error: "Malformed request." });
      return statuses(ids);
    } catch (e) {
      fail(reply, e);
    }
  });
  app.get("/api/relay/jobs", { config: limit }, async (req, reply) => {
    try {
      return statuses(jobIds(String((req.query as Record<string, string>).ids ?? "").split(",").slice(0, 200)) ?? []);
    } catch (e) {
      fail(reply, e);
    }
  });
}

/** Cancels a payment that hasn't gone yet. Only the holder of its token can. */
export function cancel(id: string, token: string): { status: JobStatus | "unknown" } {
  const j = jobs.get(id);
  if (!j) {
    // it may still come back from storage and go out: never say it ended (no time limit, money is at stake)
    if (notLoaded()) throw stillLoading();
    if (restoringNow()) {
      if (!toldStuck && clock() - loadedAt > RESTORE_GRACE_MS) {
        toldStuck = true;
        log("schedule: App Storage still hasn't answered, so cancelling a payment this server doesn't hold is refused until it does. Check App Storage.");
      }
      throw stillLoading();
    }
    // still being checked: it is stopped here for good, so "unknown" only ever means it never arrived
    const tokenHash = sha(String(token ?? ""));
    if (checkingIds.get(id) === tokenHash || calledOff.get(id)?.tokenHash === tokenHash) {
      calledOff.set(id, { tokenHash, at: Date.now() });
      // a crowd of them is cut down to the newest (each a few dozen bytes)
      for (const old of calledOff.keys()) {
        if (calledOff.size <= 10_000) break;
        calledOff.delete(old);
      }
      return { status: "cancelled" };
    }
    return { status: "unknown" };
  }
  if (j.tokenHash !== sha(String(token ?? ""))) throw err("Not allowed.", 403);
  if (j.status !== "scheduled" && j.status !== "stale") return { status: j.status };
  // on its way, or its notes already spent: it can't be called back (one getting a fresh proof can)
  const spent = (j.nullifiers ?? []).some((n) => store.isSpent(BigInt("0x" + n)));
  if (running.has(j.id) || spent) return { status: "sending" };
  finish(j, "cancelled");
  save();
  return { status: "cancelled" };
}

/** Sends one job. Whatever happens, it is never reported sent unless it landed, nor dropped while it might have. */
async function runOne(j: Job, early = false) {
  if (!j.req) return;
  running.add(j.id);
  try {
    // a moment of its own, so scheduled sends don't line up on the scheduler's beat
    if (!early) await new Promise((r) => setTimeout(r, randomInt(0, 2000)));
    if (stopping || j.status !== "scheduled") return;
    j.status = "sending";
    save();
    try {
      const body: RelayBody | RelayRequest = j.v === 2 ? { v: 2, request: j.req, ...(j.delivery ? { delivery: j.delivery } : {}), ...(j.own ? { own: j.own } : {}) } : j.req;
      const res = await relay(body, {
        ...(j.delivery ? { jobId: j.id } : {}),
        // on disk before it is sent: a restart then always finds it "sending" with this signature, so it
        // is never sent again while this send may still land
        onSigned: async (sig, lastValid) => {
          j.sigs = [...(j.sigs ?? []), sig].slice(-6);
          j.lastValid = lastValid;
          await saveNow();
        },
      });
      // pending: it may still land; settle() finds out on a later tick
      if (!res.pending) landed(j, res.signature, res);
    } catch (e) {
      await onError(j, e as Error & { status?: number; code?: string });
    }
  } finally {
    running.delete(j.id);
    save();
  }
}

/**
 * Puts a job back in line after a passing problem, saying why when it is running late. It goes
 * again in `ms`, or after `hold` when its root is getting old (that hold applies even then).
 */
function retry(j: Job, msg: string, ms: number, count = true, hold = ms) {
  const now = Date.now();
  if (count) j.tries = (j.tries ?? 0) + 1;
  if (count && (j.latest ?? now) + GIVE_UP_MS < now && (j.tries ?? 0) >= 3) {
    finish(j, "failed", { error: "Not sent: the network or the screening service was unavailable for too long. Your SOL is still in your private balance." });
    return;
  }
  j.status = "scheduled";
  j.due = Math.max(j.due ?? now, now + ms);
  j.retryAt = now + hold;
  j.note = msg || undefined;
}

async function onError(j: Job, e: Error & { status?: number; code?: string }) {
  const msg = e.message ?? "";
  const late = Date.now() > (j.latest ?? 0);
  if (e.code === "update_required") {
    // a payment made before deliveries, caught mid-send by the update: its owner's app makes it again in the new format
    finish(j, "stale", { error: MIGRATED });
  } else if (e.code === "relayer_unfunded") {
    // paused, never failed: it goes as soon as the relayer is topped up
    // (a job whose root is getting old looks again every 10 s, so it catches the top-up in time)
    retry(j, "Waiting for the relayer to be topped up. It goes out as soon as it is.", 2 * 60_000, false, 10_000);
  } else if (e.code === "in_flight") {
    // its earlier send is still being followed: not a failure, just not yet
    retry(j, "", 30_000, false);
  } else if (e.code === "dropped") {
    retry(j, late ? "Running late: the network is busy. Still trying." : "", 5_000);
  } else if (e.code === "stale" || /moved on while your proof|pool fee changed|proof did not check out|no longer covers network costs/i.test(msg)) {
    // the pool moved on, or the operator changed the fee or the relayer: only the owner can make a fresh proof
    finish(j, "stale", {
      error: /fee/i.test(msg)
        ? "The pool fee changed before this went out. Open VisionSwap to confirm it and send it."
        : "This payment needs a fresh proof. Open VisionSwap and it is made for you.",
    });
  } else if (/already been spent/i.test(msg)) {
    j.status = "sending";
    await settleSpent(j);
  } else if (!e.status || e.status >= 500 || e.status === 409 || e.status === 429) {
    // a passing problem (network, screening service): try again shortly, at most five minutes apart
    retry(j, late ? `Running late: ${msg.replace(/[.\s]+$/, "") || "the network is busy"}. Still trying.` : "", Math.min(5 * 60_000, 30_000 * 2 ** Math.min(j.tries ?? 0, 4)));
  } else {
    finish(j, "failed", { error: msg });
  }
}

/** A send that landed: confirmed (or final), never one merely processed, which can still be dropped with its fork. */
const confirmedOk = (s: { err: unknown; confirmationStatus?: string } | null) => !!s && !s.err && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized");

/**
 * The job's notes are spent: did this job spend them? Its own sends are looked up first, then its
 * new notes in the pool. Only when neither is there, with the index caught up, did another payment.
 * Until then it stays "sending" and is looked at again.
 */
async function settleSpent(j: Job) {
  if (j.sigs?.length) {
    const st = await conn.getSignatureStatuses(j.sigs, { searchTransactionHistory: true }).catch(() => null);
    const hit = st?.value.findIndex(confirmedOk);
    if (st && hit != null && hit >= 0) return landed(j, j.sigs[hit]);
  }
  const outs = j.req?.commitments.map((c) => BigInt("0x" + c));
  if (outs && store.hasLeaves(outs)) return landed(j, j.sigs?.at(-1) ?? "");
  // the index holds the transaction that spent them, and it didn't make this job's notes: another payment did
  const indexed = (j.nullifiers ?? []).every((n) => store.isSpent(BigInt("0x" + n)));
  if (outs && indexed && indexerStatus().behind === 0) {
    finish(j, "failed", { error: "These notes were spent in another payment, so this one was not sent. Nothing was lost." });
  }
}

/**
 * A job left "sending" (the network couldn't say in time, or a restart came in the middle):
 * settled from the chain. A send still able to land is waited for; one that can't any more,
 * with its notes unspent, goes back in line with the same proof.
 */
async function settle(j: Job) {
  // a delivery's record holds every send of it, saved before each went out: those count too
  const rec = j.req && j.delivery ? hops.get(j.req.recipient) : undefined;
  const mine = rec && rec.nullifiers[0] === j.nullifiers?.[0] && rec.nullifiers[1] === j.nullifiers?.[1] && (rec.status === "sending" || rec.status === "funded");
  const sigs = [...new Set([...(j.sigs ?? []), ...(mine ? [...(rec.tx1s ?? []), rec.tx1] : [])])];
  const lastValid = Math.max(j.lastValid ?? 0, mine ? rec.lastValid : 0) || undefined;
  if (sigs.length) {
    const st = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true }).catch(() => null);
    if (!st) return;
    const hit = st.value.findIndex(confirmedOk);
    if (hit >= 0) return landed(j, sigs[hit]);
    if (lastValid) {
      const height = await conn.getBlockHeight("confirmed").catch(() => null);
      if (height == null || height <= lastValid) return;
    }
  }
  if (!j.nullifiers) return;
  const pdas = await conn.getMultipleAccountsInfo(j.nullifiers.map((n) => pool.nullifier(BigInt("0x" + n))), "confirmed").catch(() => null);
  if (!pdas) return;
  if (pdas.every((a) => !a)) {
    if (!j.req) return finish(j, "failed", { error: "Not sent. Your SOL is still in your private balance." });
    // never landed: same proof, back in line straight away (or at its own moment, if that is still ahead)
    j.status = "scheduled";
    j.due = j.due && j.due > Date.now() ? j.due : Date.now();
    delete j.retryAt;
    return;
  }
  await settleSpent(j);
}

let ticking = false;
let stopping = false;
const settledAt = new Map<string, number>();
let ringOk = 0;
async function tick() {
  if (ticking || stopping) return;
  ticking = true;
  try {
    const now = Date.now();
    for (const j of [...jobs.values()]) {
      // ended jobs are forgotten after two days; a stale one (waiting for its owner) after a week
      const keep = j.status === "stale" ? KEEP_STALE_MS : KEEP_DONE_MS;
      if (j.done && (j.status === "stale" || !live(j)) && now - j.done > keep) {
        jobs.delete(j.id);
        owners.delete(j.id);
        lookAt.delete(j.id);
      }
    }
    for (const [n, uses] of noteUses) if (uses.every((t) => t < now - 24 * 3600_000)) noteUses.delete(n);
    // deliveries the ledger finished meanwhile, only once the ledger is ready: one not back from App Storage yet isn't gone
    if (hops.ready()) await followDeliveries(now);
    for (const [id, c] of calledOff) if (now - c.at > CALLED_OFF_MS && !checkingIds.has(id)) calledOff.delete(id);
    // jobs caught mid-send, a few per tick, each looked at every 15 s at most
    let n = 0;
    for (const j of jobs.values()) {
      if (j.status !== "sending" || running.has(j.id) || now - (settledAt.get(j.id) ?? 0) < 15_000) continue;
      if (n++ >= 10 || stopping) break;
      settledAt.set(j.id, now);
      await settle(j).catch(() => {});
      if (j.status !== "sending") {
        settledAt.delete(j.id);
        save();
      }
    }
    const waiting = [...jobs.values()].filter((j) => j.status === "scheduled" && j.req && !running.has(j.id) && !pausing.has(j.id));
    const free = CONCURRENCY - running.size;
    if (!waiting.length || free <= 0) return;
    // the root list, read every 20 s at most while anything waits (one public account, nothing about anyone's payment)
    const ring = await rootRing(20_000).catch(() => null);
    if (ring) ringOk = now;
    // without a look at the roots, only due jobs go
    const cands = waiting.map((j) => ({ id: j.id, due: j.due ?? 0, age: ring ? rootAge(ring, j.req!.root) : 0, hold: j.retryAt ?? 0 }));
    const plan = pickRuns(cands, now, running.size, free);
    for (const id of plan.stale) {
      const j = jobs.get(id)!;
      finish(j, "stale", { error: "This payment needs a fresh proof. Open VisionSwap and it is made for you." });
      save();
    }
    // logged on a job's first early try only, not on each retry after it
    const first = plan.early.filter((id) => !jobs.get(id)!.retryAt).length;
    if (first) log(`schedule: sending ${first} payment(s) early, before the pool moves on too far`);
    for (const id of plan.send) {
      const j = jobs.get(id)!;
      void runOne(j, plan.early.includes(id)).catch((e) => log(`schedule: ${(e as Error).message}`));
    }
  } catch (e) {
    log(`schedule: ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}

/** For /api/health: how much is waiting, and whether anything runs late. */
export function schedulerStatus() {
  const now = Date.now();
  const all = [...jobs.values()];
  const waiting = all.filter((j) => j.status === "scheduled");
  const overdue = waiting.filter((j) => (j.due ?? now) < now - 60_000);
  return {
    waiting: waiting.length,
    sending: all.filter((j) => j.status === "sending").length,
    delivering: all.filter((j) => j.status === "delivering").length,
    stale: all.filter((j) => j.status === "stale").length,
    paused: waiting.filter((j) => /topped up/.test(j.note ?? "")).length,
    late: waiting.filter((j) => (j.latest ?? now) < now).length,
    inFlight: running.size,
    oldestOverdueSec: overdue.length ? Math.round((now - Math.min(...overdue.map((j) => j.due ?? now))) / 1000) : 0,
    rootsReadAgoSec: ringOk ? Math.round((now - ringOk) / 1000) : null,
  };
}

/** For tests only: stands in for durable state's "still restoring" answer, and for its late restore. */
export const testHooks = {
  restoring: (fn: () => boolean) => void (restoringNow = fn),
  restore: (text: string) => adopt(text),
  /** a new job being checked right now, as schedule() marks it; `true` once a cancel has called it off */
  checking: (id: string, token: string) => {
    checkingIds.set(id, sha(token));
    return () => (checkingIds.delete(id), calledOff.has(id));
  },
  /** the clock for the start's grace */
  clock: (fn: () => number) => void (clock = fn),
  /** as if the scheduler had loaded its payments (tests run without starting it, whatever .env says about a relayer) */
  loaded: (v: boolean) => void (loaded = v),
  /** the tick's following of delivering jobs, by itself */
  followDeliveries: (now: number) => followDeliveries(now),
};

let timer: NodeJS.Timeout | undefined;
/** Loads the payments and runs them. Also after stopScheduler (another copy of the site ran them meanwhile): the stored list replaces what was held here. */
export async function startScheduler() {
  loadedAt = clock();
  stopping = false;
  jobs.clear();
  owners.clear();
  await load();
  loaded = true;
  save();
  // a short tick, so sends don't all line up on one beat
  clearInterval(timer);
  timer = setInterval(() => void tick(), SCALE > 1 ? 500 : 2_000);
  timer.unref?.();
  log(`schedule: ${[...jobs.values()].filter((j) => j.status === "scheduled").length} scheduled payment(s) waiting`);
}

/** For shutdown: starts no new payment and waits for the ones already being sent. */
export async function stopScheduler() {
  stopping = true;
  loaded = false;
  clearInterval(timer);
  while (running.size || ticking) await new Promise((r) => setTimeout(r, 200));
}
