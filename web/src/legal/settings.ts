/**
 * The operator's legal settings, as the server publishes them at /api/legal ("legal"), from its
 * LEGAL_* settings. Each clause of the Terms that depends on one (who we are,
 * the governing law, the courts, arbitration) appears only once it is set; until then the Terms keep
 * their neutral wording. Nothing here is invented: every value is the owner's. The legal contact is
 * the one setting with a default, the owner's support address (DEFAULT_LEGAL_SETTINGS).
 *
 * Plain data only, so the node tests can use it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { SUPPORT_EMAIL, mailto } from "../lib/contacts";

export type Arbitration = {
  /** the arbitration provider, e.g. its full name */
  provider: string;
  /** the rules that apply, as the owner words them (null: the provider's rules for consumer or commercial disputes) */
  rules: string | null;
  /** the seat (legal place) of the arbitration */
  seat: string | null;
  /** days after first accepting the Terms in which someone may opt out of arbitration */
  optOutDays: number;
};

export type LegalSettings = {
  /** the contracting entity's full legal name */
  entity: string | null;
  /** its registered address */
  address: string | null;
  /** its registration, e.g. "company number 123456, registered in …" */
  registration: string | null;
  /** e.g. "the laws of England and Wales" */
  governingLaw: string | null;
  /** where the courts are, e.g. "England and Wales" (the Terms say "the courts of …") */
  forum: string | null;
  /** only when a provider and a legal contact are both set: an opt-out needs somewhere to go */
  arbitration: Arbitration | null;
  /** where legal notices, disputes and opt-outs go: an email address or an https address */
  contact: string | null;
};

/** Nothing set at all, not even a contact (the owner turned LEGAL_CONTACT "off"). */
export const NO_LEGAL_SETTINGS: LegalSettings = {
  entity: null,
  address: null,
  registration: null,
  governingLaw: null,
  forum: null,
  arbitration: null,
  contact: null,
};

/**
 * The settings as the server has them by default: none set, and the legal contact the owner's support
 * address (support@visionswap.net). The Terms as the site shows them with these
 * are the published archive's text (legal/archive.ts), and what the pages show before /api/legal
 * answers (and in the pages as built).
 */
export const DEFAULT_LEGAL_SETTINGS: LegalSettings = { ...NO_LEGAL_SETTINGS, contact: mailto(SUPPORT_EMAIL) };

const MAX = 240;
/** A setting as text: trimmed, one line, no markup characters, not too long; null when empty or unusable. */
export function settingText(v: unknown, max = MAX): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.length > max || /[<>[\]{}`*]/.test(s)) return null;
  return s;
}

/** An email address or an https address, as a link target; null otherwise. */
export function contactHref(c: string | null): string | null {
  if (!c) return null;
  if (/^https:\/\/[^\s<>"()]+$/i.test(c)) return c;
  const m = /^(?:mailto:)?([^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,})$/i.exec(c);
  return m ? `mailto:${m[1]}` : null;
}

/** How a contact reads in the text ("legal@example.com", or the web address). */
export function contactText(c: string | null): string | null {
  const href = contactHref(c);
  return href ? href.replace(/^mailto:/i, "") : null;
}

/** /api/legal's "legal" field, checked; anything missing or malformed is simply not set. */
export function parseLegal(raw: unknown): LegalSettings {
  if (!raw || typeof raw !== "object") return NO_LEGAL_SETTINGS;
  const r = raw as Record<string, unknown>;
  const contact = contactHref(settingText(r.contact)) ? settingText(r.contact) : null;
  const a = r.arbitration && typeof r.arbitration === "object" ? (r.arbitration as Record<string, unknown>) : null;
  const provider = a ? settingText(a.provider) : null;
  const days = a && Number.isInteger(a.optOutDays) ? Math.min(90, Math.max(30, a.optOutDays as number)) : 30;
  return {
    entity: settingText(r.entity),
    address: settingText(r.address),
    registration: settingText(r.registration),
    governingLaw: settingText(r.governingLaw),
    forum: settingText(r.forum),
    arbitration: provider && contact ? { provider, rules: settingText(a!.rules), seat: settingText(a!.seat), optOutDays: days } : null,
    contact,
  };
}

/**
 * A short fingerprint of the settings that change the agreement itself (who it is with, the law, the
 * courts, arbitration): "" when none is set. A change asks everyone to accept the Terms again. The
 * contact alone doesn't count, unless arbitration (whose opt-out goes there) is on.
 */
export function legalRev(s: LegalSettings): string {
  const material = [s.entity, s.address, s.registration, s.governingLaw, s.forum, s.arbitration ? JSON.stringify(s.arbitration) : null, s.arbitration ? s.contact : null];
  if (material.every((x) => x == null)) return "";
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(material)))).slice(0, 16);
}
