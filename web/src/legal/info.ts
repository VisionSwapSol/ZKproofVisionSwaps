/**
 * What /api/legal publishes, checked field by field (useLegal.ts asks for it). Plain data only (no
 * React, no build-time settings), so the node tests can run it.
 */
import { BUSINESS_EMAIL, SUPPORT_EMAIL, mailto } from "../lib/contacts";
import { parseAndroidRelease, type AndroidReleaseInfo } from "../lib/androidRelease";
import { DEFAULT_LEGAL_SETTINGS, contactHref, parseLegal, settingText, type LegalSettings } from "./settings";

/**
 * How deposits and payments are screened, as /api/legal publishes it ("screening"). Today the mode is
 * "official-list": the U.S. sanctions list (OFAC's SDN list) plus the operator's own list of refused
 * addresses (owner decision D1). The server says "official-list+risk-service" only if its outside risk
 * service (built in, switched off) is ever switched on, and the page then says so too.
 */
export type Screening = {
  mode: "official-list" | "official-list+risk-service";
  /** the outside risk service is switched on as well */
  riskService: boolean;
  /** the official lists checked, by name ("OFAC SDN") */
  lists: string[];
  /** when the server's copy of the list last changed (ISO 8601), when known */
  updatedAt: string | null;
  /** where that copy came from: OFAC's own file, a public copy of it, or the copy built into the server */
  source: "ofac" | "mirror" | "seed" | null;
};

/** What /api/legal says, checked. `ok` false: the server couldn't be asked (everything then reads as not set). */
export type LegalInfo = {
  ok: boolean;
  legal: LegalSettings;
  /** the public source repository, once the owner sets REPO_URL */
  repo: string | null;
  /** where to report a security problem (SECURITY_CONTACT, support@ by default), a mailto: or https: address; null when "off" */
  security: string | null;
  /** the published Chrome extension's ID */
  extensionId: string | null;
  /**
   * whether the server refuses money requests by region right now ("degraded": wanted, but not trusted
   * yet, say while its location database downloads after a start; nothing is refused for its region then)
   */
  regionBlocking: "on" | "off" | "degraded" | null;
  /** the countries refused right now (empty unless region blocking is on) */
  blockedCountries: string[];
  /**
   * the regions refused right now ("UA-43"; empty unless region blocking is on, and never a region the
   * server's lookup can't tell apart); null from a server that doesn't say
   */
  blockedRegions: string[] | null;
  /** the restricted places (Terms of use, section 2), whether or not blocking is on: country codes ("IR") and regions ("UA-43") */
  restricted: string[];
  /** how deposits and payments are screened; null from a server that doesn't say */
  screening: Screening | null;
  /**
   * where legal notices, requests and questions go (LEGAL_CONTACT, support@ by default): an email or
   * https address; null when the owner turns it "off"
   */
  contact: string | null;
  /** where business, partnership and press enquiries go (BUSINESS_CONTACT, business@ by default), a mailto: address; null when "off" */
  business: string | null;
  /**
   * when the Android app's download opens (ANDROID_RELEASE_AT) and the seconds left by the server's clock;
   * null from a server that doesn't say (the site's default moment then stands, see lib/androidRelease.ts)
   */
  android: AndroidReleaseInfo | null;
};

/**
 * What the pages go by before /api/legal answers (and in the pages as built), or when it can't be
 * asked: nothing set and nothing claimed, except the owner's addresses, which are the server's defaults
 * too (lib/contacts.ts): support@ for legal, compliance and security, business@ for business enquiries.
 */
export const DEFAULT_LEGAL_INFO: LegalInfo = {
  ok: false,
  legal: DEFAULT_LEGAL_SETTINGS,
  repo: null,
  security: mailto(SUPPORT_EMAIL),
  extensionId: null,
  regionBlocking: null,
  blockedCountries: [],
  blockedRegions: null,
  restricted: [],
  screening: null,
  contact: mailto(SUPPORT_EMAIL),
  business: mailto(BUSINESS_EMAIL),
  android: null,
};

/**
 * What a page shows: the server's answer once it is here, and until then (and in the pages as built)
 * DEFAULT_LEGAL_INFO: no legal settings, and the owner's support and business addresses.
 */
export const shownLegal = (info: LegalInfo | null): LegalInfo => info ?? DEFAULT_LEGAL_INFO;

const str = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);

/** /api/legal's "screening", checked; null when missing or not a mode this page knows. */
export function parseScreening(raw: unknown): Screening | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.mode !== "official-list" && r.mode !== "official-list+risk-service") return null;
  const lists = Array.isArray(r.lists) ? r.lists.map((l) => settingText(l, 40)).filter((l): l is string => !!l).slice(0, 8) : [];
  const updatedAt = typeof r.updatedAt === "string" && !Number.isNaN(Date.parse(r.updatedAt)) ? r.updatedAt : null;
  const source = r.source === "ofac" || r.source === "mirror" || r.source === "seed" ? r.source : null;
  return { mode: r.mode, riskService: r.mode === "official-list+risk-service", lists: lists.length ? lists : ["OFAC SDN"], updatedAt, source };
}

/** /api/legal's answer, checked field by field. */
export function parseLegalInfo(raw: unknown): LegalInfo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_LEGAL_INFO;
  const r = raw as Record<string, unknown>;
  const legal = parseLegal(r.legal);
  const top = settingText(r.contact);
  return {
    ok: true,
    legal,
    repo: str(r.repo, /^https:\/\/[^\s<>"]+$/),
    security: str(r.security, /^(?:mailto:[^\s<>"]+@[^\s<>"]+|https:\/\/[^\s<>"]+)$/i),
    extensionId: str(r.extensionId, /^[a-p]{32}$/),
    regionBlocking: r.regionBlocking === "on" || r.regionBlocking === "off" || r.regionBlocking === "degraded" ? r.regionBlocking : null,
    blockedCountries: Array.isArray(r.blockedCountries) ? r.blockedCountries.filter((c): c is string => typeof c === "string" && /^[A-Z]{2}$/.test(c)) : [],
    blockedRegions: Array.isArray(r.blockedRegions)
      ? r.blockedRegions.filter((c): c is string => typeof c === "string" && /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(c)).slice(0, 60)
      : null,
    restricted: Array.isArray(r.restricted)
      ? r.restricted.filter((c): c is string => typeof c === "string" && /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/.test(c)).slice(0, 60)
      : [],
    screening: parseScreening(r.screening),
    // the top-level contact, or the one in the legal settings: both come from LEGAL_CONTACT
    contact: top && contactHref(top) ? top : legal.contact,
    // an email address only; a server from before BUSINESS_CONTACT says nothing, and the default stands
    business: "business" in r ? emailHref(r.business) : mailto(BUSINESS_EMAIL),
    android: parseAndroidRelease(r.android),
  };
}

/** An email address (with or without "mailto:") as a mailto: link; null for anything else. */
function emailHref(v: unknown): string | null {
  const href = contactHref(settingText(v));
  return href && href.startsWith("mailto:") ? href : null;
}

/**
 * The places the server refuses right now: none unless region blocking is on ("degraded" refuses nothing
 * for its region). What it really refuses (blockedCountries and blockedRegions) rather than the policy
 * list, so a region its lookup can't tell apart is never claimed; a server that doesn't name its refused
 * regions falls back to its list.
 */
export function refusedPlaces(info: LegalInfo | null): string[] {
  if (!info || info.regionBlocking !== "on") return [];
  if (info.blockedRegions) return [...info.blockedCountries, ...info.blockedRegions];
  return info.restricted.length ? info.restricted : info.blockedCountries;
}
