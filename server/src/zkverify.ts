import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { bn254 } from "@noble/curves/bn254.js";
import { log } from "./log.ts";

/**
 * Checks a spend proof right here, with the pool's verifying key, the same Groth16 check the
 * program runs on-chain. Used when a payment is scheduled, so a bad proof is refused at once
 * without showing the payment to any outside service before it is actually sent.
 */

type G1J = [string, string, string];
type G2J = [[string, string], [string, string], [string, string]];
type Vk = { nPublic: number; vk_alpha_1: G1J; vk_beta_2: G2J; vk_gamma_2: G2J; vk_delta_2: G2J; IC: G1J[] };

const { Fp12 } = bn254.fields;
const g1 = (x: bigint, y: bigint) => bn254.G1.Point.fromAffine({ x, y });
const g2 = (xc0: bigint, xc1: bigint, yc0: bigint, yc1: bigint) => bn254.G2.Point.fromAffine({ x: { c0: xc0, c1: xc1 }, y: { c0: yc0, c1: yc1 } });
const g1j = (p: G1J) => g1(BigInt(p[0]), BigInt(p[1]));
const g2j = (p: G2J) => g2(BigInt(p[0][0]), BigInt(p[0][1]), BigInt(p[1][0]), BigInt(p[1][1]));

let key: { alpha: ReturnType<typeof g1>; beta: ReturnType<typeof g2>; gamma: ReturnType<typeof g2>; delta: ReturnType<typeof g2>; ic: ReturnType<typeof g1>[] } | null | undefined;

/** The verifying key shipped with the server (its hash is the one the program was built from). */
function vk() {
  if (key !== undefined) return key;
  try {
    // the server's own copy, or the circuit's (the same file; the hosting zip ships the circuit's)
    const at = [new URL("../zk/verification_key.json", import.meta.url), new URL("../../circuits/artifacts/verification_key.json", import.meta.url)];
    const file = at.find((u) => existsSync(u)) ?? at[0];
    const v = JSON.parse(readFileSync(file, "utf8")) as Vk;
    key = { alpha: g1j(v.vk_alpha_1), beta: g2j(v.vk_beta_2), gamma: g2j(v.vk_gamma_2), delta: g2j(v.vk_delta_2), ic: v.IC.map(g1j) };
  } catch (e) {
    log(`zk: no verifying key (${(e as Error).message.slice(0, 120)}); scheduled proofs are checked when they are sent`);
    key = null;
  }
  return key;
}

const be = (b: Uint8Array, at: number) => BigInt("0x" + Buffer.from(b.subarray(at, at + 32)).toString("hex"));

/**
 * The quick part of the check (well under a millisecond): sizes, inputs in the field, and -A and C
 * real curve points. Random bytes fail here, before any of the costly work or the shared budget.
 */
export function looksValid(proof: Uint8Array, inputs: bigint[]): boolean {
  const k = vk();
  if (!k) return true;
  if (proof.length !== 256 || inputs.length + 1 !== k.ic.length) return false;
  if (inputs.some((x) => x < 0n || x >= bn254.fields.Fr.ORDER)) return false;
  try {
    g1(be(proof, 0), be(proof, 32)).assertValidity();
    g1(be(proof, 192), be(proof, 224)).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/**
 * `proof` is the 256 bytes the program takes (-A, B with each coordinate's halves as (c1, c0), C);
 * `inputs` are the public inputs in the program's order. Returns null when no key is available.
 */
export function verifySpendProof(proof: Uint8Array, inputs: bigint[]): boolean | null {
  const k = vk();
  if (!k) return null;
  if (!looksValid(proof, inputs)) return false;
  try {
    const negA = g1(be(proof, 0), be(proof, 32));
    const B = g2(be(proof, 96), be(proof, 64), be(proof, 160), be(proof, 128));
    const C = g1(be(proof, 192), be(proof, 224));
    B.assertValidity();
    let acc = k.ic[0];
    inputs.forEach((x, i) => {
      if (x !== 0n) acc = acc.add(k.ic[i + 1].multiply(x));
    });
    // e(-A, B) · e(alpha, beta) · e(vk_x, gamma) · e(C, delta) = 1
    const gt = bn254.pairingBatch([
      { g1: negA, g2: B },
      { g1: k.alpha, g2: k.beta },
      { g1: acc, g2: k.gamma },
      { g1: C, g2: k.delta },
    ]);
    return Fp12.eql(gt, Fp12.ONE);
  } catch {
    return false;
  }
}

// ─── off the main thread ───
// One check is a few hundred milliseconds of CPU: done here it would stall every request and the
// scheduler meanwhile. So checks run on a worker thread or two, a few at a time, and past that the
// server says it is busy rather than queue without end.

const THREADS = Math.max(1, Math.min(2, availableParallelism() - 1));
/** checks waiting or running at once, and checks a minute, across everyone (a backstop for the CPU) */
const MAX_PENDING = 8;
const PER_MINUTE = 240;
/** each network's own share, so a few can't use up everyone's: checks a minute, and at once */
const KEY_PER_MINUTE = 20;
const KEY_PENDING = 2;
/** proofs that fail: a real app almost never sends one, so a few in a row pause that address for a while */
const STRIKES = 3;
const STRIKE_MS = 10 * 60_000;
const PAUSE_MS = 10 * 60_000;

type Slot = { w: Worker; jobs: Map<number, { resolve: (ok: boolean | null) => void; reject: (e: Error) => void }> };
let slots: Slot[] = [];
let seq = 0;
let pending = 0;
let minute = { start: 0, n: 0 };
const keyMinute = new Map<string, { start: number; n: number }>();
const keyPending = new Map<string, number>();
/** recent strikes by wider network, each with the address it came from */
const strikes = new Map<string, { t: number; key: string }[]>();
const paused = new Map<string, number>();
let swept = 0;

const busy = () =>
  Object.assign(new Error("Lots of payments are being scheduled right now. Please try again in a minute."), { status: 503, code: "busy", retryAfter: 20 });
const slowDown = (sec: number) =>
  Object.assign(new Error(`You're scheduling payments quickly. Try again in ${sec} seconds.`), { status: 429, retryAfter: sec });
const pausedErr = (sec: number) =>
  Object.assign(new Error("Scheduling from your network is paused for a few minutes. Please try again soon."), { status: 429, retryAfter: sec });

/** The wider network (an IPv4 /24, an IPv6 /48) an address belongs to, so hopping between nearby addresses doesn't reset strikes. */
export function strikeKey(key: string): string {
  const v4 = /^(\d+\.\d+\.\d+)\.\d+$/.exec(key);
  if (v4) return `${v4[1]}.0/24`;
  const v6 = /^([0-9a-f]+:[0-9a-f]+:[0-9a-f]+):[0-9a-f]+::\/64$/i.exec(key);
  return v6 ? `${v6[1].toLowerCase()}::/48` : key;
}

/**
 * Three strikes from one address pause that address only (a shared network, like a phone carrier's,
 * stays open for everyone else on it). Three from two or more addresses nearby pause the wider network.
 */
function strike(key: string, now: number) {
  const wide = strikeKey(key);
  const recent = [...(strikes.get(wide) ?? []).filter((s) => s.t > now - STRIKE_MS), { t: now, key }];
  if (recent.length >= STRIKES && new Set(recent.map((s) => s.key)).size >= 2) {
    strikes.delete(wide);
    paused.set(wide, now + PAUSE_MS);
  } else if (recent.filter((s) => s.key === key).length >= STRIKES) {
    // its strikes are spent on its own pause, so they don't count against its neighbours too
    strikes.set(wide, recent.filter((s) => s.key !== key));
    paused.set(key, now + PAUSE_MS);
  } else {
    strikes.set(wide, recent);
  }
}

/** Forgets what has run out, once a minute, so the maps stay small. */
function sweep(now: number) {
  if (now - swept < 60_000) return;
  swept = now;
  for (const [k, w] of keyMinute) if (now - w.start >= 60_000) keyMinute.delete(k);
  for (const [k, t] of strikes) if (t.every((x) => x.t <= now - STRIKE_MS)) strikes.delete(k);
  for (const [k, until] of paused) if (until <= now) paused.delete(k);
}

function spawn(): Slot {
  const slot: Slot = { w: new Worker(new URL(import.meta.url), { workerData: { zkverify: true } }), jobs: new Map() };
  slot.w.on("message", (m: { id: number; ok: boolean | null }) => {
    slot.jobs.get(m.id)?.resolve(m.ok);
    slot.jobs.delete(m.id);
  });
  const down = (e: Error) => {
    slots = slots.filter((s) => s !== slot);
    for (const j of slot.jobs.values()) j.reject(e);
    slot.jobs.clear();
  };
  slot.w.on("error", (e) => down(e));
  slot.w.on("exit", () => down(new Error("the proof checker stopped")));
  // after the listeners (adding one holds the thread again): an idle checker never keeps the process up
  slot.w.unref();
  return slot;
}

/**
 * `verifySpendProof` on a worker thread. `key` is the caller's network (its rate-limit key): each
 * one gets its own share of checks (a 429 past it), and one sending proofs that fail is paused for
 * a while. Across everyone there is a cap on how many wait: a 503 "busy" when full.
 */
export async function checkSpendProof(proof: Uint8Array, inputs: bigint[], key = ""): Promise<boolean | null> {
  if (!vk()) return null;
  const now = Date.now();
  sweep(now);
  let w: { start: number; n: number } | undefined;
  if (key) {
    const until = Math.max(paused.get(key) ?? 0, paused.get(strikeKey(key)) ?? 0);
    if (until > now) throw pausedErr(Math.ceil((until - now) / 1000));
    w = keyMinute.get(key);
    if (!w || now - w.start >= 60_000) keyMinute.set(key, (w = { start: now, n: 0 }));
    if (w.n >= KEY_PER_MINUTE) throw slowDown(Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000)));
    if ((keyPending.get(key) ?? 0) >= KEY_PENDING) throw slowDown(5);
    w.n++;
  }
  // junk is turned away here, without touching everyone's budget
  if (!looksValid(proof, inputs)) {
    if (key) strike(key, now);
    return false;
  }
  if (now - minute.start >= 60_000) minute = { start: now, n: 0 };
  if (pending >= MAX_PENDING || minute.n >= PER_MINUTE) {
    // not checked, so it doesn't use up the caller's own share either (a retry after "busy" isn't held against them)
    if (w) w.n--;
    throw busy();
  }
  minute.n++;
  pending++;
  if (key) keyPending.set(key, (keyPending.get(key) ?? 0) + 1);
  try {
    const ok = await runCheck(proof, inputs);
    if (ok === false && key) strike(key, Date.now());
    return ok;
  } finally {
    pending--;
    if (key) {
      const n = (keyPending.get(key) ?? 1) - 1;
      if (n > 0) keyPending.set(key, n);
      else keyPending.delete(key);
    }
  }
}

async function runCheck(proof: Uint8Array, inputs: bigint[]): Promise<boolean | null> {
  try {
    try {
      while (slots.length < THREADS) slots.push(spawn());
    } catch {
      // no worker threads here: checked on this thread, still capped above
      if (!slots.length) return verifySpendProof(proof, inputs);
    }
    const slot = slots.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
    return await new Promise<boolean | null>((resolve, reject) => {
      const id = ++seq;
      slot.jobs.set(id, { resolve, reject });
      slot.w.postMessage({ id, proof, inputs });
    });
  } catch (e) {
    log(`zk: ${(e as Error).message.slice(0, 120)}`);
    throw busy();
  }
}

if (!isMainThread && (workerData as { zkverify?: boolean } | null)?.zkverify) {
  parentPort!.on("message", (m: { id: number; proof: Uint8Array; inputs: bigint[] }) => parentPort!.postMessage({ id: m.id, ok: verifySpendProof(m.proof, m.inputs) }));
}
