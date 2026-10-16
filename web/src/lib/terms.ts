/**
 * Acceptance of the Terms of use (click-wrap), recorded on this device only.
 *
 * Every way into an account (a wallet connecting, a wallet's signature, a private key, a passkey, a
 * saved sign-in, the Chrome extension, the Android app, which runs the website) first needs a current
 * acceptance: the person ticks each box in the Terms window and selects "Agree and continue". What is
 * kept, in this browser's (or the extension's) own storage, is the Terms version, the time, which boxes
 * were ticked, the fingerprint (SHA-256) of the exact Terms text shown, a fingerprint of the operator's
 * legal settings at the time, and where it happened (website, Android app or extension). No wallet
 * address, public key, IP address or anything else that identifies a person is kept, and nothing is
 * sent anywhere: accepting makes no network request at all.
 *
 * A new version whose major number differs ("3.0" after "2.x"), or a change to the operator's legal
 * settings (who we are, governing law, courts, arbitration), asks again. An editorial fix ("2.1") does
 * not. When storage can't be used (a private window, blocked site data), the acceptance is kept in
 * memory for this visit only, and asked for again next time.
 *
 * Plain data only: no React, no network, no build-time settings, so the node tests can run it as it is.
 */

/** The version of the Terms of use in force. The major number decides when people must accept again. */
export const TERMS_VERSION = "2.1";
/**
 * The oldest server release whose behaviour these Terms describe (screening as section 5 sets it out,
 * the restricted places of section 2.3 as the server's defaults, and support@visionswap.net as the
 * default contact of section 24: 1.10.1).
 * The Terms' change log names no server version, so VisionSwap's monthly self-test compares
 * /api/health's version with this, and fails while the live server is older.
 */
export const TERMS_NEEDS_SERVER = "1.10.1";
/** YYYY-MM-DD: the date this version took effect (also the Terms page's "Last updated", see seo/pages.ts). */
export const TERMS_EFFECTIVE = "2026-10-15";
/** What changed in this version, shown when someone who accepted an earlier version is asked again. */
export const TERMS_CHANGES: readonly string[] = [
  "You now accept the Terms in this window, once per device, before any account opens.",
  "Legal notices, law-enforcement requests, reports of stolen funds and screening reviews now go to support@visionswap.net (section 24).",
  "New sections on what these Terms never limit, the risks you take on and the claims you release, and how disputes work.",
  "The risks now name the VisionSwap team's control over program upgrades and settings, advances in cryptography, records kept only on your device, and look-alike sites.",
  "Screening, deposit limits and returns are described as they work today, with new Security and Compliance pages.",
  "Russia and Belarus are added to the places where VisionSwap isn't offered, and Crimea is named as including Sevastopol.",
];
/**
 * What changed when the same major version is asked for again: the operator's legal settings (who the
 * Terms are with, the governing law, the courts, arbitration and, with arbitration, where to opt out).
 */
export const TERMS_SETTINGS_CHANGE =
  "Who these Terms are with, the law that governs them, or how disputes are resolved has changed (sections 1, 21 and 24).";

/** Where the browser keeps the record. */
export const TERMS_KEY = "vs:terms";

/** Each box the person ticks. All three are needed. */
export type TermsAck = "terms" | "eligible" | "risks";
export const TERMS_ACKS: readonly TermsAck[] = ["terms", "eligible", "risks"];

/** Where the acceptance was given. */
export type TermsSurface = "web" | "android" | "extension";

/** What this device keeps after "Agree and continue". */
export type TermsRecord = {
  /** the Terms version accepted, as shown ("2.0") */
  v: string;
  /** the operator's legal settings at the time ("" when none were set), see legal/settings.ts legalRev */
  rev: string;
  /** SHA-256 (hex) of the exact Terms text shown, see legal/terms-doc.ts */
  hash: string;
  /** when, as an ISO 8601 time */
  at: string;
  /** the boxes ticked */
  acks: TermsAck[];
  surface: TermsSurface;
};

/** "needed": never accepted on this device; "updated": an earlier version or legal settings were accepted; "current": nothing to do. */
export type TermsStatus = "current" | "needed" | "updated";

/** The major number of a version: 2 for "2.0" and "2.1"; NaN for something that isn't a version. */
export function majorOf(v: string): number {
  const m = /^(\d{1,4})(?:\.\d{1,4})?$/.exec(v);
  return m ? Number(m[1]) : NaN;
}

const HEX64 = /^[0-9a-f]{64}$/;
const REV = /^(?:|[0-9a-f]{16})$/;

/** A stored record, checked field by field; anything else (an old or tampered value) reads as none. */
export function parseRecord(raw: unknown): TermsRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.v !== "string" || !Number.isFinite(majorOf(r.v))) return null;
  if (typeof r.rev !== "string" || !REV.test(r.rev)) return null;
  if (typeof r.hash !== "string" || !HEX64.test(r.hash)) return null;
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return null;
  if (!Array.isArray(r.acks) || !TERMS_ACKS.every((a) => (r.acks as unknown[]).includes(a))) return null;
  if (r.surface !== "web" && r.surface !== "android" && r.surface !== "extension") return null;
  // only the known fields are kept: nothing else rides along in a record
  return { v: r.v, rev: r.rev, hash: r.hash, at: r.at, acks: [...TERMS_ACKS], surface: r.surface };
}

/** Whether `rec` covers the Terms in force: same major version and, once the live legal settings are known, the same ones. */
export function isCurrent(rec: TermsRecord | null, liveRev: string | null, version = TERMS_VERSION): boolean {
  if (!rec) return false;
  if (majorOf(rec.v) !== majorOf(version)) return false;
  return liveRev == null || rec.rev === liveRev;
}

/** The part of the Storage interface used here. */
export type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Thrown by anything that would open an account before the Terms are accepted. */
export class TermsNeededError extends Error {
  constructor() {
    super("Please accept the Terms of use first.");
    this.name = "TermsNeededError";
  }
}

/**
 * This device's acceptance. `kv` gives the storage to use (or null, or throws, when there is none);
 * the record is read from it each time, so another tab's acceptance counts here too.
 */
export class TermsStore {
  private memory: TermsRecord | null = null;
  private liveRev: string | null = null;
  private listeners = new Set<() => void>();
  private version: string;

  constructor(
    private kv: () => KV | null,
    version = TERMS_VERSION,
  ) {
    this.version = version;
  }

  private storage(): KV | null {
    try {
      return this.kv();
    } catch {
      return null;
    }
  }

  /** The record kept on this device (storage first, then this visit's memory), or null. */
  read(): TermsRecord | null {
    const s = this.storage();
    if (s) {
      try {
        const v = s.getItem(TERMS_KEY);
        const rec = v ? parseRecord(JSON.parse(v)) : null;
        if (rec) return rec;
      } catch {
        /* unreadable: fall back to memory */
      }
    }
    return this.memory;
  }

  status(): TermsStatus {
    const rec = this.read();
    if (isCurrent(rec, this.liveRev, this.version)) return "current";
    return rec ? "updated" : "needed";
  }

  /** Whether an account may open now. */
  current(): boolean {
    return this.status() === "current";
  }

  /** The fingerprint of the operator's legal settings, once loaded (null: not known yet, so only the version counts). */
  setLiveRev(rev: string | null) {
    if (rev === this.liveRev) return;
    this.liveRev = rev;
    this.emit();
  }

  getLiveRev(): string | null {
    return this.liveRev;
  }

  /**
   * Records "Agree and continue". Every box must have been ticked. Kept in storage, or in memory for
   * this visit when storage can't be written. Returns what was kept.
   */
  accept(o: { hash: string; rev: string; acks: readonly TermsAck[]; surface: TermsSurface }, now: Date = new Date()): TermsRecord {
    if (!TERMS_ACKS.every((a) => o.acks.includes(a))) throw new Error("Every box needs a tick before you can continue.");
    if (!HEX64.test(o.hash)) throw new Error("The Terms' fingerprint is missing.");
    if (!REV.test(o.rev)) throw new Error("The legal settings' fingerprint is malformed.");
    const rec: TermsRecord = { v: this.version, rev: o.rev, hash: o.hash, at: now.toISOString(), acks: [...TERMS_ACKS], surface: o.surface };
    this.memory = rec;
    const s = this.storage();
    if (s) {
      try {
        s.setItem(TERMS_KEY, JSON.stringify(rec));
      } catch {
        /* full or blocked: memory only, asked again next visit */
      }
    }
    this.emit();
    return rec;
  }

  /** Forgets this device's acceptance (the window then shows again). Funds are not affected. */
  forget() {
    this.memory = null;
    const s = this.storage();
    if (s) {
      try {
        s.removeItem(TERMS_KEY);
      } catch {
        /* blocked */
      }
    }
    this.emit();
  }

  /** Throws TermsNeededError unless the Terms in force are accepted on this device. */
  require() {
    if (!this.current()) throw new TermsNeededError();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Lets every open part of the page (and other tabs, through the storage event) see a change. */
  emit = () => {
    for (const fn of [...this.listeners]) fn();
  };
}

/** This device's store: the browser's (or the extension's) localStorage. */
export const terms = new TermsStore(() => (typeof localStorage === "undefined" ? null : localStorage));

// another tab accepting (or forgetting) shows here at once
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === TERMS_KEY || e.key === null) terms.emit();
  });
}

/** Whether the Terms in force are accepted on this device. */
export const hasCurrentAcceptance = () => terms.current();

/**
 * What requests to VisionSwap's server carry once the Terms in force are accepted here (P1-7):
 * `x-vs-terms` with the major version accepted ("2"). Only the major number goes, because only a major
 * change asks people to accept again; it is the same value for everyone who accepted that version, and
 * nothing else from the record (no time, no fingerprint) leaves the device. Nothing when there is no
 * current acceptance.
 */
export function termsHeaderFor(store: TermsStore): Record<string, string> {
  const rec = store.read();
  if (!rec || !store.current()) return {};
  const major = majorOf(rec.v);
  return Number.isFinite(major) ? { "x-vs-terms": String(major) } : {};
}

/** This device's x-vs-terms header (see termsHeaderFor). */
export const termsHeader = () => termsHeaderFor(terms);

/** For the engine: refuses to open an account without a current acceptance. */
export const requireTerms = () => terms.require();

/**
 * The wallet provider's autoConnect: a wallet chosen on an earlier visit reconnects only once the
 * Terms in force are accepted here (a wallet the person picks after accepting connects as usual).
 */
export const autoConnectAllowed = async (): Promise<boolean> => terms.current();
