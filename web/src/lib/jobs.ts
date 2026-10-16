/**
 * Bookkeeping for scheduled payments and split sends, kept apart from the engine so the rules
 * can be tested on their own.
 */
import { secureRandom } from "./poll";

/**
 * "unclear": its SOL was spent and it can't be told here whether by it (check the activity; never offered again).
 * "delivering": the pool paid its one-time sending address, whose transfer to the recipient is on its way;
 * "waiting": that transfer is this app's to finish (it does so by itself while it is open).
 */
export type JobStatus = "scheduled" | "sending" | "delivering" | "waiting" | "sent" | "failed" | "stale" | "cancelled" | "unclear";
type JobLike = {
  id: string;
  status: JobStatus;
  window?: string;
  created: number;
  latest?: number;
  refreshed?: number;
  nextTry?: number;
  rootsLeft?: number | null;
  soon?: boolean;
  confirm?: unknown;
  ripening?: boolean;
  goAt?: number;
};

/**
 * A payment still waiting here for its notes to be old enough (see ripening in the engine) goes out at
 * once when it falls due this close to its deadline: a payment sent now, which names the newest root.
 * (One with a moment of its own, `goAt`, goes then: see drawGoAt.)
 */
export const RIPE_DUE_MS = 60_000;

/**
 * The moment a payment kept here for its notes goes by itself if they don't get old enough first
 * (a payment sent now, handed over to go within two minutes): drawn at random over its window, like
 * the relayer's own moments (never in the window's first tenth, and early enough to be out by the
 * deadline), so it is never a fixed time after its notes joined the pool. `rnd` gives numbers in
 * [0, 1): the secure random source unless a test passes its own.
 */
export function drawGoAt(created: number, latest: number, rnd: () => number = secureRandom): number {
  const span = Math.max(0, latest - created);
  const first = created + Math.round(span * 0.1);
  const last = latest - RIPE_DUE_MS;
  if (last <= first) return first;
  return first + Math.floor(rnd() * (last - first));
}

/**
 * Payments sent later: the cuts and joins that prepare their notes are spaced out, each a random
 * 15 to 60 seconds after the one before, so they don't run back to back (and the payments
 * themselves go at their own random moments later).
 */
export const PREP_GAP_MS: readonly [number, number] = [15_000, 60_000];

/** When a payment kept here for its notes goes by itself: its own moment, or (one made before there were any) just before its deadline. */
export const goAtOf = (j: { goAt?: number; latest: number }) => j.goAt ?? j.latest - RIPE_DUE_MS;

/** How long each send-later window is. */
export const WINDOW_LEN: Record<string, number> = { "2m": 2 * 60_000, "15m": 15 * 60_000, "1h": 3_600_000, "24h": 24 * 3_600_000 };

/** A job still holding its notes: it may yet go out. */
export const isLive = (s: JobStatus) => s === "scheduled" || s === "sending" || s === "stale";

/** A job not finished yet: one holding its notes, or one whose pool payment landed and whose delivery is still on its way. */
export const isOpen = (s: JobStatus) => isLive(s) || s === "delivering" || s === "waiting";

/**
 * A status the relayer answers (to a cancel, say) that means the payment's pool spend went out or is
 * going out: it can't be called back, and it is followed until its recipient is paid.
 */
export const goneOut = (s: string) => s === "sending" || s === "delivering" || s === "waiting" || s === "sent";

/**
 * Changes one job in the list as it is now (never a copy taken earlier), and only while it is in
 * one of `from`: a reply that arrives after the person cancelled can't bring the job back.
 */
export function patchJob<J extends { id: string; status: JobStatus }>(list: J[], id: string, patch: Partial<J>, from?: readonly JobStatus[]): J[] {
  return list.map((j) => (j.id === id && (!from || from.includes(j.status)) ? { ...j, ...patch } : j));
}

export type JobReply = {
  id: string;
  status: JobStatus | "unknown";
  signature: string | null;
  error: string | null;
  note?: string | null;
  soon?: boolean;
  rootsLeft?: number | null;
  /** once the pool has paid a delivery's sending address: that payment's signature, and the address */
  tx1?: string;
  hop?: string;
};

/**
 * The relayer's answers merged into the current list, by id. Jobs the person ended here (a
 * cancel) are left alone; "unknown" is for the caller to resolve. Returns the ids whose status
 * changed, and those that the relayer reports sent (to be checked before saying so). A delivering
 * job the relayer leaves a note on is waiting for this app to finish it. A sending address the
 * relayer names is taken (with its pool spend) only when `ownHop` says it is that job's own.
 */
export function mergeReplies<
  J extends { id: string; status: JobStatus; signature?: string | null; error?: string | null; note?: string | null; soon?: boolean; rootsLeft?: number | null; tx1?: string; hop?: string },
>(list: J[], replies: JobReply[], ownHop: (j: J, hop: string) => boolean = () => true): { list: J[]; changed: string[]; sent: string[] } {
  const byId = new Map(replies.map((r) => [r.id, r]));
  const changed: string[] = [];
  const sent: string[] = [];
  const out = list.map((j) => {
    const r = byId.get(j.id);
    if (!r || r.status === "unknown" || !isOpen(j.status)) return j;
    if (r.status === "sent") {
      // reported separately, so the notes can be seen spent before the app says "sent"
      sent.push(j.id);
      return j;
    }
    const status: JobStatus = r.status === "delivering" && r.note ? "waiting" : r.status;
    if (status !== j.status) changed.push(j.id);
    const hopOk = !!r.hop && ownHop(j, r.hop);
    return {
      ...j,
      status,
      signature: r.signature ?? j.signature ?? null,
      error: r.error,
      note: r.note ?? null,
      soon: r.soon,
      rootsLeft: r.rootsLeft,
      ...(hopOk && r.tx1 ? { tx1: r.tx1 } : {}),
      ...(hopOk ? { hop: r.hop } : {}),
    };
  });
  return { list: out, changed, sent };
}

/**
 * Whether the open app should finish a scheduled payment's delivery itself now: the relayer says it
 * waits for the app, or it has been delivering for longer than the relayer ever takes.
 */
export function finishDue(j: { status: JobStatus; delivering?: number }, now: number): boolean {
  if (j.status === "waiting") return true;
  return j.status === "delivering" && j.delivering != null && now - j.delivering > 5 * 60_000;
}

/**
 * A scheduled payment whose notes were spent, which the relayer can't account for: "sent" when its
 * own send landed or any of its own new notes is in the pool data; "other" (spent by another payment)
 * only when that pool data covers the chain and every proof it was given is known; "unclear" when the
 * data covers the chain but not every proof is known; null while the data is still catching up.
 */
export function spentVerdict(o: { landed: boolean; ownNotes: boolean; caughtUp: boolean; allProofs: boolean }): "sent" | "other" | "unclear" | null {
  if (o.landed || o.ownNotes) return "sent";
  if (!o.caughtUp) return null;
  return o.allProofs ? "other" : "unclear";
}

/**
 * The server's own answer with a reason: a refusal (4xx), or an error it tagged with a code. Either
 * way that request didn't go out. A gateway error, or a reply that isn't the server's, may hide one
 * that did, so it never counts.
 */
export const definite = (e: { status: number; data: Record<string, unknown> | null }) =>
  typeof e.data?.error === "string" && (e.status < 500 || typeof e.data.code === "string");

/**
 * The live jobs to ask about, those whose deadline comes first at the front, in groups the relayer
 * answers in one go. A job cancelled here whose cancel the relayer couldn't confirm yet is asked about too.
 * One still waiting here for its notes to be old enough (`ripening`) was never handed over: not asked about.
 */
export function pollGroups<J extends { id: string; status: JobStatus; latest: number; cancelPending?: boolean; ripening?: boolean }>(list: J[], size = 50): string[][] {
  const ids = list
    .filter((j) => (isOpen(j.status) && !(j.ripening && j.status === "stale")) || j.cancelPending)
    .sort((a, b) => a.latest - b.latest)
    .map((j) => j.id);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** Roots left before a scheduled proof would go stale, below which the open app makes a fresh one. */
export const FEW_ROOTS = 100;

/**
 * Whether the open app should make this job a fresh proof now, and why: it went stale (or was never
 * proved: its notes were too new, see ripening), its root is getting old in a busy pool, or it goes
 * out soon and was proved a while ago (a fresh proof then names the newest root, like any payment
 * sent at once, instead of the moment it was scheduled). Failures back off.
 */
export function needsProof(j: JobLike, now: number): "stale" | "roots" | "timing" | null {
  if (j.nextTry && j.nextTry > now) return null;
  // one never handed over because its notes were too new: proved for later once they're old enough
  // ("stale"), or, once its own random moment comes (or it is due), sent at once like any payment sent now ("timing")
  if (j.status === "stale" && j.ripening && !j.confirm && j.latest != null && now >= goAtOf({ goAt: j.goAt, latest: j.latest })) return "timing";
  if (j.status === "stale") return j.confirm ? null : "stale";
  if (j.status !== "scheduled") return null;
  if (j.rootsLeft != null && j.rootsLeft < FEW_ROOTS && now - (j.refreshed ?? 0) > 10 * 60_000) return "roots";
  // a short window gets its fresh proof sooner (once: each one is a full proof, and the job waits
  // while it is made), so payments scheduled together each name a root of their own moment
  const minAge = Math.min(15 * 60_000, Math.max(30_000, (WINDOW_LEN[j.window ?? ""] ?? 3_600_000) / 4));
  if (minAge < 15 * 60_000 && j.refreshed) return null;
  if (j.soon && now - (j.refreshed ?? j.created) > minAge) return "timing";
  return null;
}

/**
 * A payment's hand-over was refused: was it cancelled meanwhile? `cur` is the app's own record as
 * it is now (undefined once cleared from the list), `unclear` whether an earlier try had no clear
 * answer. "cancelled": every answer was clear, so the relayer holds nothing and the cancel stands;
 * "call-off": an earlier try may have got there, so it is called off there first; null: not
 * cancelled, the refusal stands. With `held` (its notes belong to another payment) a record that
 * is gone isn't a cancel: its notes are set aside and others picked. Either way a cancelled payment
 * is never scheduled again under a new id.
 */
export function cancelledMeanwhile(cur: { status: JobStatus } | undefined, unclear: boolean, held = false): "cancelled" | "call-off" | null {
  if (cur ? isLive(cur.status) : held) return null;
  return unclear ? "call-off" : "cancelled";
}

/** Waits between failed tries at a fresh proof: 1 min, 5 min, 30 min, then 2 hours. */
export function backoff(tries: number): number {
  return [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000][Math.min(Math.max(tries, 1), 4) - 1];
}

// ─── split payments ───

/** What happened to each payment of a split so far. */
export type PartOutcome = "sent" | "scheduled" | "checking" | "cancelled";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The message for a split that stopped partway: who was paid (or scheduled), who may still be,
 * and which payment didn't go and why, so nobody is paid twice by pressing the button again.
 */
export function splitSummary(parts: { to: string }[], outcomes: (PartOutcome | undefined)[], failedAt: number, reason: string): string {
  const pick = (o: PartOutcome) => parts.flatMap((p, i) => (outcomes[i] === o ? [short(p.to)] : []));
  const sent = pick("sent");
  const scheduled = pick("scheduled");
  const checking = pick("checking");
  const cancelled = pick("cancelled");
  const out: string[] = [];
  if (sent.length) out.push(`Paid: ${list(sent)}.`);
  if (scheduled.length) out.push(`Scheduled: ${list(scheduled)}.`);
  if (cancelled.length) out.push(`Cancelled: ${list(cancelled)}.`);
  if (checking.length) out.push(`May still go through: ${list(checking)} (check your activity before sending ${checking.length > 1 ? "them" : "it"} again).`);
  if (failedAt >= 0 && failedAt < parts.length && outcomes[failedAt] === undefined) {
    out.push(`Payment ${failedAt + 1} (${short(parts[failedAt].to)}) wasn't sent: ${reason}`);
  } else if (reason && (failedAt < 0 || failedAt >= parts.length)) out.push(reason);
  const left = parts.length - outcomes.filter(Boolean).length;
  if (left > 0 && (sent.length || scheduled.length || checking.length || cancelled.length)) out.push(`${left === 1 ? "The one left is" : `The ${left} left are`} still in the form.`);
  return out.join(" ");
}

/** The form's rows once the payments with an outcome are taken out: pressing the button again sends only the rest. */
export function rowsLeft<R>(rows: R[], outcomes: (PartOutcome | undefined)[]): R[] {
  return rows.filter((_, i) => !outcomes[i]);
}

// ─── notes of their own for later payments ───

export type PrepStep =
  | { kind: "ready"; picks: number[] }
  | { kind: "cut"; note: number; need: bigint }
  | { kind: "merge"; notes: [number, number] }
  | { kind: "short" };

const asc = (a: { amount: bigint }, b: { amount: bigint }) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0);

/**
 * The next step towards giving each later payment a note of its own. Each payment, largest first,
 * takes the smallest note that covers it (nearly exactly, when `exact`). When one has none: cut the
 * largest note no other payment took; else join the two largest of those; cut a note another
 * payment took only when what's left still covers that payment; join any two as a last resort.
 * Each cut and each join costs `fee`.
 */
export function prepStep(notes: { id: number; amount: bigint }[], needs: bigint[], fee: bigint, exact: boolean): PrepStep {
  const free = [...notes].sort(asc);
  const owner = new Map<number, bigint>();
  const picks: number[] = [];
  let missing = -1;
  const order = needs.map((need, i) => ({ need, i })).sort((a, b) => asc({ amount: b.need }, { amount: a.need }));
  for (const { need, i } of order) {
    const pick = free.find((nt) => !owner.has(nt.id) && nt.amount >= need && (!exact || nt.amount - need <= fee));
    if (!pick) {
      missing = i;
      break;
    }
    owner.set(pick.id, need);
    picks[i] = pick.id;
  }
  if (missing < 0) return { kind: "ready", picks };
  const need = needs[missing];
  const largest = [...free].reverse();
  const untaken = largest.filter((nt) => !owner.has(nt.id));
  const big = untaken.find((nt) => nt.amount >= need + fee);
  if (big) return { kind: "cut", note: big.id, need };
  if (untaken.length >= 2 && untaken.reduce((t, nt) => t + nt.amount, 0n) - BigInt(untaken.length - 1) * fee >= need) {
    return { kind: "merge", notes: [untaken[0].id, untaken[1].id] };
  }
  const spare = largest.find((nt) => owner.has(nt.id) && nt.amount >= need + fee + owner.get(nt.id)!);
  if (spare) return { kind: "cut", note: spare.id, need };
  if (largest.length >= 2) return { kind: "merge", notes: [largest[0].id, largest[1].id] };
  return { kind: "short" };
}

/** Rounds of cuts and joins tried before giving up. */
export const prepRounds = (needs: number) => needs * 3 + 4;

/**
 * What getting notes ready costs, worked out by running prepStep on the amounts: how many cuts and
 * joins (one fee each), and whether every payment ends up with a note at all.
 */
export function prepPlan(amounts: bigint[], needs: bigint[], fee: bigint, exact: boolean): { steps: number; ok: boolean } {
  let notes = amounts.map((amount, id) => ({ id, amount }));
  let next = notes.length;
  for (let steps = 0; steps <= prepRounds(needs.length); steps++) {
    const st = prepStep(notes, needs, fee, exact);
    if (st.kind === "ready") return { steps, ok: true };
    if (st.kind === "short") return { steps, ok: false };
    if (st.kind === "cut") {
      const cut = notes.find((x) => x.id === st.note)!;
      notes = [...notes.filter((x) => x !== cut), { id: next++, amount: st.need }, { id: next++, amount: cut.amount - st.need - fee }];
    } else {
      const [a, b] = st.notes.map((id) => notes.find((x) => x.id === id)!);
      notes = [...notes.filter((x) => x !== a && x !== b), { id: next++, amount: a.amount + b.amount - fee }];
    }
  }
  return { steps: prepRounds(needs.length), ok: false };
}

// ─── proofs held for later and the pool's roots (VS-16) ───

/** Said on a scheduled payment whose held proof the pool moved past: it gets a fresh one while the app is open. */
export const ROOT_MOVED_NOTE = "The pool moved on past this payment's proof, so it gets a fresh one while VisionSwap is open.";

/**
 * Whether a scheduled payment's held proof names a root that a read of the pool's recent roots
 * (`ring`, hex, read at `ringAt`) doesn't hold: then it can never land. Only a read made after the
 * proof (`refreshed`, else `created`, plus a little margin) counts: an older read can't know its root.
 */
export function rootGone(
  j: { request?: unknown; refreshed?: number; created: number },
  ring: ReadonlySet<string> | null,
  ringAt: number,
  margin = 5_000,
): boolean {
  const root = String((j.request as { root?: unknown } | undefined)?.root ?? "").toLowerCase();
  if (!ring || !ring.size || !/^[0-9a-f]{64}$/.test(root)) return false;
  if (ringAt < (j.refreshed ?? j.created) + margin) return false;
  return !ring.has(root);
}

// ─── a payment sent now to one of this account's Vision wallets (see the engine's sendMany) ───

/**
 * A payment sent now to one of this account's Vision wallets, followed from the moment it's handed to the relayer
 * until its wallet is read after it landed (`at`: when it landed, Infinity until then). `nfs`: the notes it spends;
 * `base`: what the wallet showed as it went out.
 */
export type Paying = { amount: bigint; nfs: string[]; since: number; at: number; base: bigint };

/** Followed for five minutes at most (as long as spent notes stay hidden from the balance). */
export const PAYING_MS = 5 * 60_000;

/**
 * Whether a read of the wallet a payment is on its way to waits: it shows more than the wallet shows now while the
 * payment's notes are still in the private balance (they leave it once the relayer has answered). Taken then, the
 * payment would be counted twice, in the balance and in the wallet.
 */
export function holdPayingRead(x: Paying | undefined, shown: bigint, read: bigint, unspent: ReadonlySet<string>, now: number): boolean {
  return !!x && now - x.since <= PAYING_MS && read > shown && x.nfs.some((nf) => unspent.has(nf));
}

/**
 * Whether the total counts the payment as landing in its wallet: its notes have left the balance, and the wallet as
 * shown doesn't hold it yet. A read that shows it there ends that at once, whenever that read was made.
 */
export function payingLands(x: Paying, shown: bigint, unspent: ReadonlySet<string>, now: number): boolean {
  return now - x.since <= PAYING_MS && !x.nfs.some((nf) => unspent.has(nf)) && shown < x.base + x.amount;
}
