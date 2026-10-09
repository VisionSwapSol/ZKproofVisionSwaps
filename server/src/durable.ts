import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * Durable state for what only this server holds: open orders ("orders") and send-later payments
 * ("scheduled").
 *
 * Replit resets a published app's files on every publish, so each save is also uploaded, a moment
 * later and coalesced, to Replit App Storage, and a fresh deployment reads it back before the keeper
 * and the scheduler start. Elsewhere the local disk alone is used.
 *
 * Everything is sealed with AES-256-GCM, under a key derived from the relayer's secret, before it
 * touches the disk or leaves the machine: orders hold keys that can spend approved tokens, and
 * scheduled payments hold ready-to-send proofs. A leaked bucket or data folder reveals nothing.
 *
 * Each sealed copy also carries who wrote it (the published site, the workspace, or a plain machine)
 * and when, both bound into the seal: a published site is built from the workspace's files, so the
 * workspace's own copy arrives with it and must never stand in for the live one.
 *
 * Only one copy of the published site writes at a time. A publish starts the new copy while the old
 * one still runs, so the old copy holds a lease in App Storage (renewed every few seconds, released
 * once its last save is up), and the new copy reads the state and starts its keeper and scheduler
 * only after that (see takeOver). A holder that can't renew pauses before anyone could count its
 * lease as quiet, and losing the lease is never for good: a copy that lost it keeps watching and
 * takes it back once the copy holding it stops (a newer copy always comes first), then reads the
 * state again. Meanwhile it saves nothing that could later pass for the newer copy.
 */

/** A remote copy. `get` gives `undefined` when there is nothing stored and throws on outages, so the two are never confused. */
export interface Remote {
  readonly name: string;
  put(key: string, text: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
  del(key: string): Promise<void>;
}

/** Who writes the state: the published site, the Replit workspace, or any other machine. */
export type Scope = "deployment" | "workspace" | "local";

type Data = string | (() => string);
type Slot = {
  /** the newest data not yet written (a function is serialized only when the write happens) */
  pending?: Data;
  localTimer?: NodeJS.Timeout;
  /** the last plain text written, so an unchanged save costs nothing */
  last?: string;
  sealed?: string;
  writing: Promise<void>;
  uploadTimer?: NodeJS.Timeout;
  uploading?: Promise<void>;
  /** set when the sealed text changed after the last upload */
  dirty: boolean;
  /** the last write to this machine's disk (or getting it ready) failed */
  failed?: boolean;
  /** the remote copy couldn't be read at boot: nothing is uploaded over it until it has been read and added back */
  unchecked: boolean;
  recheckTimer?: NodeJS.Timeout;
  rechecks: number;
  /** when the copy this process started from was saved */
  loadedAt: number;
  /** how long the last write took to prepare (ms): a big list is written less often */
  cost: number;
  /** hands back a stored copy that could only be read after the start */
  onLate?: (text: string) => void;
};
type Opened = { text: string; at: number; raw: string; legacy?: boolean };

export type RestoredFrom = "local" | "remote" | "none" | "unreadable" | "unavailable";

const VERSION = 1;
const LOCAL_DELAY = 250;
const UPLOAD_DELAY = 2_000;
const UPLOAD_GAP = 5_000;
const RETRY_DELAY = 30_000;
/** the longest the site waits for App Storage before it starts answering */
const RESTORE_MS = 15_000;
/** a write never waits longer than this, however big the list */
const LOCAL_DELAY_MAX = 2_000;
/** App Storage not taking saves for this long is something the operator must hear about */
const UNSAVED_ALERT_MS = 10 * 60_000;

/** The hand-over between two copies of the published site (see takeOver). */
export type LeaseTimes = {
  /** how often the holder renews it */
  renewMs: number;
  /** a lease that hasn't changed for this long belongs to a copy that has stopped */
  ttlMs: number;
  /** how often a waiting copy looks again */
  pollMs: number;
  /** with no lease stored (a first start, or a copy from before hand-overs), counted from App Storage's first answer: how long to hold */
  holdMs: number;
  /** the longest a newer copy waits for an older one that keeps renewing (counted from its start): then it takes over, and the other stands down */
  capMs: number;
};
const LEASE: LeaseTimes = { renewMs: 15_000, ttlMs: 45_000, pollMs: 2_000, holdMs: 45_000, capMs: 10 * 60_000 };
/** `born`: when its holder started (0 for a copy from before it was stored); `yields`: held only until a newer copy comes */
type Lease = { instance: string; gen: number; released: boolean; born: number; yields: boolean };
/** Whether `a` outranks `b`: each take-over counts one up, so the newest holder always wins (ties by name). */
const outranks = (a: Lease, b: { instance: string; gen: number }) => a.gen > b.gen || (a.gen === b.gen && a.instance > b.instance);
/** Whether copy `a` started after copy `b` (ties by name). */
const younger = (a: { instance: string; born: number }, b: { instance: string; born: number }) => a.born > b.born || (a.born === b.born && a.instance > b.instance);
/** The gen for a take-over above `gen`: it also counts the seconds, so it outranks any lease taken before it, even one never read. */
const nextGen = (gen: number) => Math.max(gen + 1, Math.floor(Date.now() / 1000));
/** What a wait read last (`at` 0 when App Storage never answered): a take-over outranks its gen, and `yields` when it takes from a newer copy. */
type Seen = { gen: number; at: number; older: boolean; yields: boolean };
/** When each store in this process joined the hand-over: never the same twice. */
let lastBorn = 0;
const bornNow = () => (lastBorn = Math.max(Date.now(), lastBorn + 1));

/** The state key: HKDF-SHA256 of a secret, so nothing else derived from that secret can open it. */
export function stateKey(secret: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "visionswap", "visionswap state v1", 32));
}
/** A short fingerprint of the key, stored beside the data so a key change reads as one, not as damage. */
const keyId = (key: Buffer) => Buffer.from(hkdfSync("sha256", key, "", "visionswap state key id", 4)).toString("hex");
/** What the seal is bound to besides the data: the slot, who wrote it and when (none of it can be swapped). */
const aad = (name: string, scope: string, at: number) => Buffer.from(`${name}:${scope}:${at}:${VERSION}`);
const fail = (message: string, code: string) => Object.assign(new Error(message), { code });

/** Seals `text` for the slot `name`, written by `scope` at `at`. */
export function seal(key: Buffer, name: string, text: string, scope: Scope, at: number): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(name, scope, at));
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return JSON.stringify({ vs: "state", v: VERSION, scope, at, kid: keyId(key), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") });
}

/**
 * Opens what `seal` made for this `scope`. A plain JSON list (a file from before sealing) is taken
 * only when `allowLegacy` is set, which only this machine's own file ever gets.
 */
export function unseal(key: Buffer | null, name: string, raw: string, scope: Scope, opts: { allowLegacy?: boolean } = {}): { text: string; at: number; legacy?: boolean } {
  let env: { vs?: string; v?: number; scope?: string; at?: number; kid?: string; iv?: string; tag?: string; data?: string };
  try {
    env = JSON.parse(raw);
  } catch {
    throw fail("the saved file is damaged", "damaged");
  }
  if (Array.isArray(env)) {
    if (opts.allowLegacy) return { text: raw, at: 0, legacy: true };
    throw fail("it isn't sealed", "legacy");
  }
  if (env?.vs !== "state" || env.v !== VERSION) throw fail("the saved file is in a format this version doesn't know", "format");
  if (env.scope !== scope) throw fail(`it was saved by the ${env.scope ?? "unknown"} copy of the app`, "elsewhere");
  if (!key) throw fail("there is no relayer key to open it with", "key");
  if (env.kid !== keyId(key)) throw fail("it was saved under a different relayer key", "key");
  try {
    const at = Number(env.at);
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(env.iv ?? "", "base64"));
    d.setAAD(aad(name, scope, at));
    d.setAuthTag(Buffer.from(env.tag ?? "", "base64"));
    return { text: Buffer.concat([d.update(Buffer.from(env.data ?? "", "base64")), d.final()]).toString("utf8"), at };
  } catch {
    throw fail("the saved file is damaged", "damaged");
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (e: unknown) => ((e as Error)?.message ?? String(e)).slice(0, 160);
const codeOf = (e: unknown) => (e as { code?: string })?.code;
/** `p`, or a "timed out" error after `ms` (a hung call must never hold up the start or the shutdown). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return Promise.reject(new Error("timed out"));
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<never>((_, no) => (t = setTimeout(() => no(new Error("timed out")), ms)))]).finally(() => clearTimeout(t));
}

export class StateStore {
  private slots = new Map<string, Slot>();
  private readonly prefix: string;
  private readonly scope: Scope;
  private readonly retryMs: number[];
  private readonly recheckMs: number[];
  private restoreBy: number;
  private lastAt = 0;
  private lastUploadAt = 0;
  /** the last call to the remote store failed */
  private unreachable: boolean;
  /** since when saves haven't reached the remote store (it can't be reached, or a copy there is still to be read) */
  private unsavedSince: number | null = null;
  /** a remote store was wanted here (the published site on Replit) */
  private readonly expectRemote: boolean;
  private readonly lease: LeaseTimes;
  private leaseTimer?: NodeJS.Timeout;
  private leaseHeldBy: string | null = null;
  private leaseGen = 0;
  /** set while renewing is off (shutdown, or the lease went to another copy) */
  private leaseDone = false;
  /** set at shutdown: the lease is neither renewed nor taken (back) after that */
  private closed = false;
  /** the renewal on its way, so the hand-over marker is written after it, never before */
  private renewing?: Promise<void>;
  /** this copy doesn't hold the lease: nothing goes up from here meanwhile, so another copy's saves are never overwritten */
  private fenced = false;
  /** paused because renewals stopped landing (App Storage doesn't answer here), not because another copy took over */
  private paused = false;
  /** another copy has held the lease since this one last did: it ran the state meanwhile, so nothing is written here until it comes back */
  private superseded = false;
  /** slots to read from App Storage only (never from this machine's older copy) on their next load, after `superseded` */
  private remoteFirst = new Set<string>();
  /** who takes part in the hand-over, when to give up, and whom to tell when the lease is lost or taken back */
  private holder?: { instance: string; stop: () => boolean; onLost?: () => void; onRegained?: () => void };
  /** when this copy joined the hand-over (newer copies have the right of way) */
  private born = 0;
  /** this copy has held the lease since it started */
  private everHeld = false;
  /** this copy holds the lease only until a newer one comes (it took it back from a newer copy that stopped) */
  private yielding = false;
  /** when the last renewal that landed was sent */
  private renewedAt = 0;
  /** since when this copy has been waiting for the one it replaces (or, after losing the lease, for the one holding it) */
  private waitingSince: number | null = null;
  /** the last look at the lease while waiting got no answer from App Storage */
  private unanswered = false;
  errors = 0;
  readonly restored: Record<string, RestoredFrom> = {};

  constructor(
    private dir: string,
    private key: Buffer | null,
    private remote: Remote | null,
    opts: {
      prefix?: string;
      scope?: Scope;
      retryMs?: number[];
      recheckMs?: number[];
      restoreBy?: number;
      unreachable?: boolean;
      expectRemote?: boolean;
      lease?: Partial<LeaseTimes>;
    } = {},
  ) {
    this.prefix = opts.prefix ?? "state/";
    this.scope = opts.scope ?? "local";
    this.retryMs = opts.retryMs ?? [1_000, 3_000];
    this.recheckMs = opts.recheckMs ?? [30_000, 60_000, 120_000, 300_000];
    this.restoreBy = opts.restoreBy ?? Date.now() + RESTORE_MS;
    this.unreachable = opts.unreachable ?? false;
    this.expectRemote = opts.expectRemote ?? false;
    this.lease = { ...LEASE, ...opts.lease };
    this.note();
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      this.errors++;
      log(`state: couldn't create the data folder: ${short(e)}`);
    }
  }

  get backend() {
    if (!this.key) return "memory";
    if (!this.remote) return "disk";
    const waiting = this.unreachable || [...this.slots.values()].some((s) => s.unchecked);
    return waiting ? `${this.remote.name} (unreachable)` : this.remote.name;
  }
  private file = (name: string) => join(this.dir, `${name}.json`);
  private remoteKey = (name: string) => `${this.prefix}${name}.json`;
  private slot(name: string): Slot {
    let s = this.slots.get(name);
    if (!s) this.slots.set(name, (s = { writing: Promise.resolve(), dirty: false, unchecked: false, rechecks: 0, loadedAt: 0, cost: 0 }));
    return s;
  }
  /** Keeps `unsavedSince` in step with whether saves are reaching the remote store. */
  private note() {
    const behind = !!this.remote && (this.unreachable || [...this.slots.values()].some((s) => s.unchecked));
    if (!behind) this.unsavedSince = null;
    else this.unsavedSince ??= Date.now();
  }
  /** a save time that only ever goes up, so the newer of two copies is always clear */
  private nextAt() {
    return (this.lastAt = Math.max(Date.now(), this.lastAt + 1));
  }

  /**
   * The saved text, or `null` when there is none. With a remote store, both copies are read and the
   * newer one wins (a fresh deployment has only the remote one). When the remote can't be read in
   * time, the start goes on without it, and `onLate` is handed the stored copy once it can be read.
   */
  async load(name: string, onLate?: (text: string) => void): Promise<string | null> {
    const s = this.slot(name);
    s.onLate = onLate;
    if (!this.key) {
      this.restored[name] = "none";
      return null;
    }
    // after another copy ran the state, this machine's copy is older than what that one saved, whatever its time says
    const remoteFirst = this.remoteFirst.delete(name);
    if (remoteFirst) Object.assign(s, { last: undefined, sealed: undefined, dirty: false, loadedAt: 0 });
    const local = remoteFirst ? null : this.readLocal(name);
    if (!this.remote) return local ? this.use(name, local, "local") : this.none(name);
    let raw: string | undefined;
    try {
      raw = await this.fetchAtBoot(name);
      // read again after the lease came back: a look still due from before is no longer needed
      s.unchecked = false;
      clearTimeout(s.recheckTimer);
      s.recheckTimer = undefined;
      this.note();
    } catch (e) {
      // the start goes on; the stored copy is left alone, read again shortly and added back
      s.unchecked = true;
      this.note();
      this.errors++;
      this.restored[name] = "unavailable";
      const mine = local && !local.legacy ? local : null;
      log(`state: couldn't reach app storage for ${name} (${short(e)}); ${mine ? "using this machine's copy" : "starting without it"} for now, the stored copy is read again shortly`);
      this.recheckLater(name);
      return mine ? this.use(name, mine, "unavailable") : null;
    }
    const stored = raw === undefined ? null : await this.openRemote(name, raw);
    // a copy from before sealing is taken only when nothing is stored yet
    if (local && (!stored || (!local.legacy && local.at > stored.at))) return this.use(name, local, "local");
    if (!stored) return this.none(name);
    this.use(name, stored, "remote");
    this.writeSealed(name, stored.raw);
    return stored.text;
  }

  private none(name: string) {
    this.restored[name] ??= "none";
    return null;
  }

  /** This machine's copy, if it is one this copy of the app wrote (or one from before sealing, outside a published site). */
  private readLocal(name: string): Opened | null {
    const f = this.file(name);
    let raw: string;
    try {
      if (!existsSync(f)) return null;
      raw = readFileSync(f, "utf8");
    } catch (e) {
      this.errors++;
      this.restored[name] = "unreadable";
      log(`state: couldn't read the saved ${name} (${short(e)}); starting without it`);
      return null;
    }
    try {
      // a published site starts from the workspace's files, so an unsealed file there is never its own
      return { ...unseal(this.key, name, raw, this.scope, { allowLegacy: this.scope !== "deployment" }), raw };
    } catch (e) {
      if (codeOf(e) === "elsewhere" || codeOf(e) === "legacy") {
        log(`state: left out a saved ${name} that another copy of the app wrote (${short(e)})`);
        return null;
      }
      // kept aside, never deleted: an operator can still put the old key back and recover it
      try {
        renameSync(f, join(this.dir, `${name}.unreadable-${Date.now()}.json`));
      } catch {
        /* it stays where it is and is replaced on the next save */
      }
      log(`state: couldn't open the saved ${name} (${short(e)}); kept aside, starting without it`);
      this.restored[name] = "unreadable";
      return null;
    }
  }

  /** The stored copy, tried a few times but never past the start's time limit. */
  private async fetchAtBoot(name: string): Promise<string | undefined> {
    for (let i = 0; ; i++) {
      try {
        const raw = await within(this.remote!.get(this.remoteKey(name)), this.restoreBy - Date.now());
        this.unreachable = false;
        this.note();
        return raw;
      } catch (e) {
        this.unreachable = true;
        this.note();
        const wait = this.retryMs[i];
        if (wait === undefined || Date.now() + wait >= this.restoreBy) throw e;
        await sleep(wait);
      }
    }
  }

  /** Opens a stored copy (sealed only). One that can't be opened is kept aside under another name. */
  private async openRemote(name: string, raw: string): Promise<Opened | null> {
    try {
      return { ...unseal(this.key, name, raw, this.scope), raw };
    } catch (e) {
      log(`state: couldn't open the stored ${name} (${short(e)}); kept aside, starting without it`);
      this.restored[name] = "unreadable";
      await within(this.remote!.put(this.remoteKey(name).replace(/\.json$/, `.unreadable-${Date.now()}.json`), raw), 5_000).catch(() => {});
      return null;
    }
  }

  private use(name: string, o: Opened, from: RestoredFrom): string {
    const s = this.slot(name);
    this.restored[name] = from;
    s.loadedAt = o.at;
    if (o.legacy) {
      // a file from before sealing is sealed (and uploaded) straight away
      this.save(name, o.text);
      return o.text;
    }
    s.last = o.text;
    s.sealed = o.raw;
    // this machine's copy is newer than the stored one (a restart before the last upload): send it up
    if (from === "local" && this.remote) {
      s.dirty = true;
      this.scheduleUpload(name, UPLOAD_DELAY);
    }
    return o.text;
  }

  private recheckLater(name: string) {
    const s = this.slot(name);
    if (s.recheckTimer || !s.unchecked) return;
    const wait = this.recheckMs[Math.min(s.rechecks++, this.recheckMs.length - 1)];
    s.recheckTimer = setTimeout(() => void this.recheck(name).then((done) => done || this.recheckLater(name)), wait);
    s.recheckTimer.unref?.();
  }

  /** Reads a stored copy that couldn't be read at the start and hands it back. `true` once done. */
  private async recheck(name: string, ms = 20_000): Promise<boolean> {
    const s = this.slot(name);
    clearTimeout(s.recheckTimer);
    s.recheckTimer = undefined;
    if (!s.unchecked || !this.remote) return true;
    let raw: string | undefined;
    try {
      raw = await within(this.remote.get(this.remoteKey(name)), ms);
      this.unreachable = false;
    } catch {
      this.unreachable = true;
      this.note();
      return false;
    }
    if (!s.unchecked) return true;
    const stored = raw === undefined ? null : await this.openRemote(name, raw);
    if (stored && stored.at > s.loadedAt) {
      if (s.onLate) {
        try {
          s.onLate(stored.text);
          log(`state: app storage answered again; the stored ${name} was added back`);
        } catch (e) {
          this.errors++;
          log(`state: couldn't add back the stored ${name}: ${short(e)}`);
          return false;
        }
      } else {
        // nobody to hand it to: keep it under another name rather than replace it
        await this.remote.put(this.remoteKey(name).replace(/\.json$/, `.unrestored-${Date.now()}.json`), raw!);
      }
    }
    s.unchecked = false;
    this.note();
    // this machine's copy is the newer one: it goes up as it is
    if (s.sealed && s.loadedAt && (!stored || stored.at < s.loadedAt)) s.dirty = true;
    if (s.dirty) this.scheduleUpload(name, UPLOAD_DELAY);
    return true;
  }

  /** Saves `data` (text, or a function giving it, called once when the write happens). Returns at once. */
  save(name: string, data: Data) {
    const s = this.slot(name);
    s.pending = data;
    if (!s.localTimer) {
      // a big list takes a while to write: waiting ten times that keeps saving to a tenth of the server's time
      s.localTimer = setTimeout(() => void this.writeLocal(name), Math.max(LOCAL_DELAY, Math.min(LOCAL_DELAY_MAX, s.cost * 10)));
      s.localTimer.unref?.();
    }
  }

  /**
   * Saves `data` and resolves once it is on this machine's disk (uploaded as usual a moment later).
   * With `strict` it rejects when it isn't there: no key to seal it with, another copy runs the state
   * now, or the disk refused it (for a record that must exist before money moves).
   */
  async saveNow(name: string, data: Data, strict = false): Promise<void> {
    const s = this.slot(name);
    s.pending = data;
    await this.writeLocal(name);
    if (strict && (!this.key || (this.fenced && this.superseded) || s.failed)) throw new Error(`couldn't save ${name}`);
  }

  /** True while the stored copy of `name` couldn't be read yet (it is added back once it can). */
  restoring(name: string): boolean {
    return !!this.key && !!this.remote && (this.slots.get(name)?.unchecked ?? false);
  }

  private writeLocal(name: string): Promise<void> {
    const s = this.slot(name);
    clearTimeout(s.localTimer);
    s.localTimer = undefined;
    const data = s.pending;
    s.pending = undefined;
    // another copy runs the state now: a save from the copy that stopped here would read as the newer one later
    if (data === undefined || !this.key || (this.fenced && this.superseded)) return s.writing;
    const started = performance.now();
    let text: string;
    try {
      text = typeof data === "function" ? data() : data;
    } catch (e) {
      this.errors++;
      s.failed = true;
      log(`state: couldn't prepare ${name} for saving: ${short(e)}`);
      return s.writing;
    }
    if (text === s.last) {
      s.cost = performance.now() - started;
      return s.writing;
    }
    s.last = text;
    const sealed = seal(this.key, name, text, this.scope, this.nextAt());
    s.cost = performance.now() - started;
    s.sealed = sealed;
    s.dirty = true;
    this.scheduleUpload(name, UPLOAD_DELAY);
    return this.writeSealed(name, sealed);
  }

  /** One write at a time per file, each atomic (a crash mid-write leaves the previous copy whole). */
  private writeSealed(name: string, sealed: string): Promise<void> {
    const s = this.slot(name);
    const f = this.file(name);
    const tmp = `${f}.${process.pid}.tmp`;
    s.writing = s.writing
      .then(() => writeFile(tmp, sealed, { mode: 0o600 }))
      .then(() => rename(tmp, f))
      .then(() => void (s.failed = false))
      .catch((e) => {
        this.errors++;
        s.failed = true;
        log(`state: couldn't write ${name} to disk: ${short(e)}`);
      });
    return s.writing;
  }

  private scheduleUpload(name: string, delay: number) {
    const s = this.slot(name);
    if (!this.remote || this.fenced || s.uploadTimer || s.unchecked) return;
    const gap = this.lastUploadAt ? this.lastUploadAt + UPLOAD_GAP - Date.now() : 0;
    s.uploadTimer = setTimeout(() => void this.upload(name), Math.max(delay, gap));
    s.uploadTimer.unref?.();
  }

  private upload(name: string): Promise<void> {
    const s = this.slot(name);
    clearTimeout(s.uploadTimer);
    s.uploadTimer = undefined;
    if (!this.remote || this.fenced || s.uploading) return s.uploading ?? Promise.resolve();
    if (!s.dirty || !s.sealed || s.unchecked) return Promise.resolve();
    const remote = this.remote;
    s.uploading = (async () => {
      try {
        const sealed = s.sealed!;
        s.dirty = false;
        await remote.put(this.remoteKey(name), sealed);
        this.lastUploadAt = Date.now();
        this.unreachable = false;
        this.note();
      } catch (e) {
        s.dirty = true;
        this.errors++;
        this.unreachable = true;
        this.note();
        log(`state: couldn't upload ${name}: ${short(e)}; trying again shortly`);
        throw e;
      } finally {
        s.uploading = undefined;
      }
      // something new came in while uploading
      if (s.dirty) this.scheduleUpload(name, UPLOAD_DELAY);
    })().catch(() => {
      this.scheduleUpload(name, RETRY_DELAY);
    });
    return s.uploading;
  }

  /** Writes and uploads everything waiting, now (for shutdown). */
  async flush(): Promise<void> {
    await Promise.all(
      [...this.slots.keys()].map(async (name) => {
        const s = this.slot(name);
        // one last quick look at a stored copy that couldn't be read yet, so it is added back, not replaced
        if (s.unchecked) await this.recheck(name, 5_000);
        await this.writeLocal(name);
        if (s.uploading) await s.uploading;
        if (s.dirty) await this.upload(name);
      }),
    );
  }

  /**
   * True when orders and scheduled payments aren't reaching the remote store, so the next publish
   * would start without them: the published site has none (no bucket, or the SDK missing), or it
   * hasn't been able to save there for a while.
   */
  notSaved(now = Date.now()): boolean {
    if (!this.key) return false;
    if (!this.remote) return this.expectRemote;
    return this.unsavedSince != null && now - this.unsavedSince >= UNSAVED_ALERT_MS;
  }

  /** For /api/health: no times, so nothing in it tells when anyone placed an order or a payment. */
  status() {
    return { backend: this.backend, restored: this.restored, errors: this.errors, saved: !this.notSaved() };
  }

  /**
   * Waits until this copy may load and write the state, then holds the lease (renewing it) until
   * `release`. Only the published site with App Storage takes part; anywhere else this returns at
   * once. A copy still running (renewing) is waited for: it stops once the new copy is live. One
   * that never stops is taken over from after `capMs`; it sees that on its next renewal, stops
   * uploading and calls its `onLost`. A holder whose renewals stop landing pauses the same way before
   * another copy may count its lease as quiet. A copy that lost the lease keeps watching it and takes
   * it back once the holder hands over or stops renewing (or, after a pause, once App Storage answers),
   * then calls `onRegained` (load the state again and run it). Returns true when this copy holds the
   * lease; false when `stop` says to give up (a shutdown meanwhile), or when another copy took the
   * lease at once (`onRegained` then comes later).
   */
  async takeOver(instance: string, stop: () => boolean = () => false, hooks: { onLost?: () => void; onRegained?: () => void } = {}): Promise<boolean> {
    if (!this.remote || !this.key || this.scope !== "deployment") return !stop();
    this.holder = { instance, stop, ...hooks };
    this.born ||= bornNow();
    const seen = await this.waitTurn();
    return !!seen && this.hold(seen);
  }

  /**
   * Waits for this copy's turn and returns the newest lease read (null when told to stop). The newest
   * copy has the right of way, since the published site sends visitors to it: it takes the lease of
   * an older copy once that is released, held only until a newer copy comes, or unchanged for ttlMs
   * (its holder stopped without handing over), and after capMs from its start at the latest (an
   * older copy that never stops stands down once it sees the new lease). A copy older than the
   * holder (one that lost the lease) takes it only once it has stayed unchanged, released or not,
   * for twice ttlMs, so a new copy starting meanwhile always writes first. This copy's own lease
   * (left while App Storage didn't answer here) is taken back at once, and an empty store after
   * holdMs. A look App Storage doesn't answer tells nothing, so it never counts toward any of those.
   */
  private async waitTurn(): Promise<Seen | null> {
    const remote = this.remote!;
    const { instance, stop } = this.holder!;
    const me = { instance, born: this.born };
    const key = this.remoteKey("lease");
    const start = Date.now();
    this.waitingSince = start;
    // the lease as last read, and since when it has read the same
    let seen: { raw: string; at: number } | null = null;
    let emptySince: number | null = null;
    const last: Seen = { gen: 0, at: 0, older: true, yields: false };
    let noted = 0;
    let back = "";
    try {
      for (;;) {
        if (stop() || this.closed) return null;
        let raw: string | undefined;
        let answered = true;
        try {
          raw = await within(remote.get(key), 10_000);
        } catch {
          answered = false;
        }
        const now = Date.now();
        this.unanswered = !answered;
        if (answered) {
          const lease = parseLease(raw);
          if (!lease) {
            Object.assign(last, { at: now, older: true, yields: false });
            // nothing stored (a first start, or a copy from before hand-overs): that copy stops within
            // seconds of this one answering, so a short hold covers it
            seen = null;
            emptySince ??= now;
            if (now - emptySince >= this.lease.holdMs) break;
          } else {
            emptySince = null;
            const own = lease.instance === instance;
            const older = !own && younger(me, lease);
            // another copy ran the state since this one did: what this machine holds is older than what that one saved
            if (!own && this.everHeld) this.superseded = true;
            Object.assign(last, { gen: Math.max(last.gen, lease.gen), at: now, older, yields: own ? this.yielding : !older });
            if (!seen || seen.raw !== raw) seen = { raw: raw!, at: now };
            // the other copy's clock may differ from ours: it has stopped once its lease stops changing
            const quiet = now - seen.at;
            if (own) {
              back = "state: App Storage answers again; this copy takes orders and scheduled payments back";
              break;
            }
            if (older ? lease.released || lease.yields || quiet >= this.lease.ttlMs : quiet >= 2 * this.lease.ttlMs) {
              back = this.everHeld ? "state: the copy that took over has stopped; this copy takes orders and scheduled payments back" : "state: the copy before this one has handed over";
              break;
            }
          }
        }
        // the cap: over an older copy only (or, at a first start, when App Storage has never answered)
        if (now - this.born >= this.lease.capMs && (last.at ? last.older : !this.everHeld)) {
          const min = Math.round((now - this.born) / 60_000);
          log(
            last.at
              ? `state: WARNING: the copy before this one is still running after ${min} minutes; this copy takes over orders and scheduled payments now, and that one stands down`
              : `state: WARNING: app storage hasn't answered for ${min} minutes; this copy takes over orders and scheduled payments now, and a copy before it that still runs stands down once it sees that`,
          );
          break;
        }
        const what = this.everHeld ? "the copy holding orders and scheduled payments" : "the copy this one replaces";
        if (!noted) log(this.everHeld ? "state: watching for the copy holding orders and scheduled payments to stop" : "state: waiting for the copy this one replaces to save and stop");
        else if (now - noted >= 60_000) log(`state: still waiting for ${what} (${Math.round((now - start) / 60_000)} min); orders and scheduled payments wait here meanwhile`);
        if (!noted || now - noted >= 60_000) noted = now;
        // waiting for a newer copy is no hurry: it runs everything meanwhile
        await sleep(!last.at || last.older ? this.lease.pollMs : Math.max(this.lease.pollMs, this.lease.renewMs));
      }
    } finally {
      this.waitingSince = null;
      this.unanswered = false;
    }
    if (stop() || this.closed) return null;
    if (noted && back) log(back);
    return last;
  }

  /** Takes the lease above everything `seen`: true once held, false when lost again (or shut down) at once. */
  private async hold(seen: Seen): Promise<boolean> {
    this.leaseHeldBy = this.holder!.instance;
    this.leaseGen = nextGen(Math.max(seen.gen, this.leaseGen));
    this.yielding = seen.yields;
    this.leaseDone = false;
    this.paused = false;
    this.renewedAt = Date.now();
    if (this.superseded) {
      // whatever this copy hadn't written or sent up before it stopped is dropped: the other copy ran on without it
      this.superseded = false;
      for (const [name, s] of this.slots) {
        clearTimeout(s.localTimer);
        clearTimeout(s.uploadTimer);
        Object.assign(s, { localTimer: undefined, uploadTimer: undefined, pending: undefined, dirty: false });
        this.remoteFirst.add(name);
      }
    }
    this.fenced = false;
    // the state is read only now, so App Storage gets its full time from here
    this.restoreBy = Date.now() + RESTORE_MS;
    await this.tick();
    // lost already: the keeper and scheduler never start here, and the watch goes on (see lose)
    if (this.leaseDone) return false;
    this.everHeld = true;
    this.leaseTimer = setInterval(() => void this.tick(), this.lease.renewMs);
    this.leaseTimer.unref?.();
    return true;
  }

  private tick() {
    // renewals haven't landed for a while: this copy pauses before a waiting one may count its lease as quiet
    if (!this.leaseDone && Date.now() - this.renewedAt >= this.lease.ttlMs - this.lease.renewMs) {
      this.pause();
      return Promise.resolve();
    }
    return (this.renewing ??= this.renew()
      .catch((e) => {
        this.errors++;
        log(`state: couldn't renew the hand-over lease: ${short(e)}`);
      })
      .finally(() => (this.renewing = undefined)));
  }

  private async renew() {
    if (this.leaseDone) return;
    const remote = this.remote!;
    const key = this.remoteKey("lease");
    const { instance } = this.holder!;
    const sent = Date.now();
    let raw: string | undefined;
    let answered = true;
    try {
      raw = await within(remote.get(key), 10_000);
    } catch {
      // can't tell: renew, as before (renewals that keep failing end in a pause, see tick)
      answered = false;
    }
    if (this.leaseDone) return;
    const held = answered ? parseLease(raw) : null;
    // a copy that took over meanwhile (after its long wait, or after this one's renewals stopped
    // landing) runs the state now; should it stop without handing over, the watch takes the lease back
    if (held && !held.released && held.instance !== instance && outranks(held, { instance, gen: this.leaseGen })) return this.lose(held.instance);
    await within(remote.put(key, JSON.stringify({ instance, gen: this.leaseGen, born: this.born, at: sent, ...(this.yielding ? { yield: true } : {}) })), 10_000);
    this.renewedAt = Math.max(this.renewedAt, sent);
  }

  /** Stops renewing and uploading, tells the caller to stop the keeper and scheduler, and watches the lease to take it back. */
  private standDown() {
    this.leaseDone = true;
    clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    this.fenced = true;
    this.holder?.onLost?.();
    void (async () => {
      const seen = await this.waitTurn();
      if (seen && (await this.hold(seen))) this.holder?.onRegained?.();
    })().catch((e) => log(`state: couldn't take the lease back: ${short(e)}`));
  }

  /** Another copy holds the lease now: nothing more is written here until this copy takes it back. */
  private lose(other: string) {
    this.leaseHeldBy = null;
    this.paused = false;
    this.superseded = true;
    log(`state: WARNING: another copy of the site (${other}) has taken over orders and scheduled payments; this copy pauses them, saves nothing more, and takes them back if that copy stops`);
    this.standDown();
  }

  /** Renewals stopped landing (App Storage doesn't answer here): paused until it answers. The lease stays this copy's to hand over at shutdown. */
  private pause() {
    this.paused = true;
    log(`state: WARNING: App Storage hasn't taken this copy's lease renewals for ${Math.round((Date.now() - this.renewedAt) / 1000)}s; this copy pauses orders and scheduled payments, keeps saving them on this machine, and takes them back once App Storage answers`);
    this.standDown();
  }

  /** Lets the next copy take over at once (after the last save at shutdown). The marker is tried again until `by`. */
  async release(by = Date.now() + 8_000): Promise<void> {
    this.stopRenewing();
    // a renewal already on its way lands first, so it can't replace the marker below
    if (this.renewing) await within(this.renewing, Math.min(10_000, by - Date.now())).catch(() => {});
    const instance = this.leaseHeldBy;
    if (!instance || !this.remote) return;
    const key = this.remoteKey("lease");
    if (this.fenced) {
      // paused: handed over only while the lease is still this copy's, once what it saved meanwhile is up
      try {
        const l = parseLease(await within(this.remote.get(key), Math.min(5_000, by - Date.now())));
        if (l?.instance !== instance || l.released) return;
      } catch {
        return;
      }
      this.fenced = false;
      await within(this.flush(), by - Date.now() - 1_000).catch(() => {});
    }
    this.leaseHeldBy = null;
    const marker = JSON.stringify({ instance, gen: this.leaseGen, born: this.born, at: Date.now(), released: true });
    // a marker that never lands keeps the next copy waiting until the lease goes quiet
    for (let i = 0; ; i++) {
      try {
        return await within(this.remote.put(key, marker), Math.min(5_000, by - Date.now()));
      } catch {
        const wait = 250 * 2 ** i;
        if (Date.now() + wait + 500 >= by) return;
        await sleep(wait);
      }
    }
  }

  /** Stops renewing for good (at shutdown, before the last save, so a hung save can't keep the next copy waiting past the lease). */
  stopRenewing() {
    this.closed = true;
    this.leaseDone = true;
    clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  /**
   * For health: how long this copy has waited for the one it replaces (or, after losing the lease,
   * for the one holding it), whether it doesn't run the state because another copy took over from it
   * (`lost`) or because App Storage stopped taking its renewals (`lost` and `paused`), and whether
   * App Storage answered the wait's last look.
   */
  handover(now = Date.now()): { waitingSec: number | null; lost: boolean; paused: boolean; unanswered: boolean } {
    return { waitingSec: this.waitingSince == null ? null : Math.round((now - this.waitingSince) / 1000), lost: this.fenced, paused: this.fenced && this.paused, unanswered: this.unanswered };
  }
}

/** A stored lease, or null when there is none or it can't be read. */
function parseLease(raw: string | undefined | null): Lease | null {
  if (!raw) return null;
  try {
    const l = JSON.parse(raw) as { instance?: unknown; gen?: unknown; released?: unknown; born?: unknown; yield?: unknown };
    const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : 0);
    return typeof l?.instance === "string" ? { instance: l.instance, gen: num(l.gen), released: l.released === true, born: num(l.born), yields: l.yield === true } : null;
  } catch {
    return null;
  }
}

/** Replit App Storage through the official SDK (loaded only when used, so other hosts don't need it). */
async function replitRemote(bucketId: string): Promise<Remote> {
  type Result<T> = { ok: boolean; value?: T; error?: { message?: string } | Error };
  type Client = {
    uploadFromText(name: string, text: string): Promise<Result<null>>;
    downloadAsText(name: string): Promise<Result<string>>;
    exists(name: string): Promise<Result<boolean>>;
    delete(name: string, opts?: { ignoreNotFound?: boolean }): Promise<Result<null>>;
  };
  const modName = "@replit/object-storage";
  const mod = (await import(modName)) as { Client: new (opts?: { bucketId?: string }) => Client };
  // a client that failed to start stays failed, so after any error the next call makes a new one
  let client: Client | null = null;
  const call = async <T>(op: string, f: (c: Client) => Promise<Result<T>>): Promise<T> => {
    client ??= new mod.Client(bucketId ? { bucketId } : undefined);
    try {
      const r = await within(f(client), 20_000);
      if (!r.ok) throw new Error(`${op}: ${r.error instanceof Error ? r.error.message : (r.error?.message ?? "failed")}`);
      return r.value as T;
    } catch (e) {
      client = null;
      throw e;
    }
  };
  return {
    name: "replit app storage",
    async put(key, text) {
      await call("upload", (c) => c.uploadFromText(key, text));
    },
    async get(key) {
      if (!(await call("exists", (c) => c.exists(key)))) return undefined;
      return call("download", (c) => c.downloadAsText(key));
    },
    async del(key) {
      await call("delete", (c) => c.delete(key, { ignoreNotFound: true }));
    },
  };
}

let current: Promise<StateStore> | null = null;
let resolved: StateStore | null = null;

/** Picks the backend once: App Storage on Replit (checked with a real write and read), else disk. Never throws. */
export function initState(): Promise<StateStore> {
  current ??= (async () => {
    const secret = config.relayer?.secretKey;
    if (!secret) {
      log("state: no relayer key, so orders and scheduled payments are kept in memory only");
      return (resolved = new StateStore(config.dataDir, null, null));
    }
    const key = stateKey(secret);
    const restoreBy = Date.now() + RESTORE_MS;
    const onReplit = Boolean(process.env.REPL_ID || process.env.REPLIT_DEPLOYMENT || process.env.REPL_SLUG);
    const want = config.stateStore === "auto" ? (onReplit ? "replit" : "disk") : config.stateStore;
    // the published site and a copy run in the workspace never share (or overwrite) each other's state
    const scope: Scope = !onReplit ? "local" : process.env.REPLIT_DEPLOYMENT ? "deployment" : "workspace";
    const prefix = scope === "workspace" ? "state-workspace/" : "state/";
    let remote: Remote | null = null;
    let unreachable = false;
    if (want === "replit") {
      try {
        remote = await replitRemote(config.replitBucketId ?? "");
      } catch (e) {
        const missing = codeOf(e) === "ERR_MODULE_NOT_FOUND";
        log(`state: replit app storage can't be used (${short(e)}); orders and scheduled payments are kept on this machine's disk only.${missing ? ' Run "npm install" (the app needs @replit/object-storage) so they survive updates.' : ""}`);
      }
      if (remote) {
        // a real write and read, tried a few times: one slow answer at the start must not count as "no storage"
        let last: unknown;
        for (let i = 0; i < 3 && Date.now() < restoreBy; i++) {
          try {
            const probe = `${prefix}probe-${process.pid}.txt`;
            const stamp = new Date().toISOString();
            await within(remote.put(probe, stamp), restoreBy - Date.now());
            if ((await within(remote.get(probe), restoreBy - Date.now())) !== stamp) throw new Error("wrote a test file but couldn't read it back");
            void remote.del(probe).catch(() => {});
            last = undefined;
            break;
          } catch (e) {
            last = e;
            if (i < 2) await sleep(Math.min(1_000 * 3 ** i, Math.max(0, restoreBy - Date.now())));
          }
        }
        unreachable = last !== undefined;
        if (!unreachable) log("state: replit app storage connected");
        else
          log(
            `state: couldn't reach replit app storage yet (${short(last)}); orders and scheduled payments are saved on this machine meanwhile and stored there as soon as it answers. If this keeps happening, create a bucket in the App Storage tool.`,
          );
      }
    } else if (want !== "disk") {
      log(`state: unknown STATE_STORE "${want}", using this machine's disk`);
    } else {
      log("state: kept on this machine's disk");
    }
    // the published site keeps its state in App Storage (unless STATE_STORE=disk says otherwise): without it, health says so
    return (resolved = new StateStore(config.dataDir, key, remote, { prefix, scope, restoreBy, unreachable, expectRemote: scope === "deployment" && want === "replit" }));
  })();
  return current;
}

/**
 * The saved text of `name`, or `null`. When the stored copy can only be read after the start,
 * `onLateRestore` is handed it then: add back whatever is missing, then save.
 */
export async function loadState(name: string, onLateRestore?: (text: string) => void): Promise<string | null> {
  return (await initState()).load(name, onLateRestore);
}

/** Saves `name`: written to disk a moment later (coalesced), then uploaded. Never blocks. */
export function saveState(name: string, data: string | (() => string)): void {
  if (resolved) resolved.save(name, data);
  else void initState().then((s) => s.save(name, data));
}

/**
 * Saves `name` and resolves once it is on disk (for a record that must exist before something is
 * sent). With `strict`, rejects when it couldn't be saved, so the caller sends nothing.
 */
export async function saveStateNow(name: string, data: string | (() => string), strict = false): Promise<void> {
  await (resolved ?? (await initState())).saveNow(name, data, strict);
}

/** True while the stored copy of `name` is still to be added back (App Storage answered late). */
export function stateRestoring(name: string): boolean {
  return resolved ? resolved.restoring(name) : false;
}

/** Writes and uploads everything still waiting (for shutdown). */
export async function flushAll(): Promise<void> {
  if (current) await (await current).flush();
}

/** Waits until this copy may load and run orders and scheduled payments (see StateStore.takeOver). */
export async function takeOver(instance: string, stop?: () => boolean, hooks?: { onLost?: () => void; onRegained?: () => void }): Promise<boolean> {
  return (await initState()).takeOver(instance, stop, hooks);
}

/** For health: whether this copy is waiting on, or was replaced by, another copy (see StateStore.handover). */
export function stateHandover() {
  return resolved ? resolved.handover() : { waitingSec: null, lost: false, paused: false, unanswered: false };
}

/** At shutdown: stop renewing the lease now, and hand it over once the last save is up. */
export function stopRenewing() {
  resolved?.stopRenewing();
}
export async function releaseLease(by?: number): Promise<void> {
  if (current) await (await current).release(by);
}

/** True when orders and scheduled payments aren't being kept where the next publish finds them. */
export function stateNotSaved(): boolean {
  return resolved ? resolved.notSaved() : false;
}

/** For /api/health: where state is kept, what was restored at the start, and how many saves failed. */
export function stateStatus() {
  return resolved ? resolved.status() : { backend: current ? "starting" : "off" };
}
