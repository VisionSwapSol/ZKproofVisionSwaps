/**
 * The compliance features on the website's side (spec P0-1, P0-3, P0-7, P0-8, P0-10, P1-2, P1-4, P1-7,
 * P1-8): the restricted-region screen and what drives it, the published sanctions list checked in the
 * browser, the Terms header, the gateway's refusals, the screening policy and the monthly figures, the
 * statement's limits, ownership proofs, and the place lists, which must all name the same places.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { RESTRICTED_CODES, RESTRICTED_PLACES, RESTRICTED_SENTENCE, andList, placeName } from "../src/legal/places.ts";
import { termsDoc, termsText } from "../src/legal/terms-doc.ts";
import { NO_LEGAL_SETTINGS } from "../src/legal/settings.ts";
import { DEFAULT_LEGAL_INFO, parseLegalInfo, refusedPlaces, shownLegal } from "../src/legal/info.ts";
import { REGION_UNKNOWN, RegionStore, creditsGeoDatabase, isRegionRefusal, parseRegion } from "../src/lib/region.ts";
import { ScreenList, parseSanctionsList } from "../src/lib/screenlist.ts";
import { TermsStore, termsHeaderFor, type KV } from "../src/lib/terms.ts";
import { chainError, gatewayRefusal, refusedForSure } from "../src/lib/chainerr.ts";
import { countText, monthName, parseTransparency } from "../src/lib/transparency.ts";
import { STATEMENT_LIMITS, VIEW_KEY_LIMIT, buildStatement } from "../src/lib/statement.ts";
import { OWNERSHIP_PREFIX, looksLikeTransaction, ownershipMessage, ownershipTextProblem, readSignature, signOwnership, verifyOwnership } from "../src/lib/ownership.ts";
import { Figures, ScreeningPolicy } from "../src/components/ComplianceParts.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const repo = join(web, "..");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
/** The checks against the VisionSwap service's own source run where that source is present. */
const NO_SERVICE_SOURCE = !existsSync(join(repo, "server", "src")) && "the VisionSwap service's source is not part of this repository";
const flat = (s: string) => s.replace(/\s+/g, " ");
/** Rendered markup as its text reads: whitespace flattened, entities back to characters. */
const html = (s: string) => flat(s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

// ─── D2: the restricted places, everywhere the same ───

test("the restricted places are exactly the owner's list (D2)", () => {
  assert.deepEqual([...RESTRICTED_CODES].sort(), ["AE", "BY", "CU", "IR", "KP", "RU", "SY", "UA-09", "UA-14", "UA-40", "UA-43"].sort());
  assert.equal(placeName("UA-43"), "Crimea (Ukraine)");
  assert.equal(placeName("ae"), "United Arab Emirates");
  assert.equal(andList(["a", "b", "c"]), "a, b and c");
});

test("the Terms (2.3), the Compliance page, the FAQ and the support answers name the same places", () => {
  const terms = termsText(termsDoc(NO_LEGAL_SETTINGS));
  assert.ok(terms.includes(RESTRICTED_SENTENCE), "Terms 2.3 uses the shared sentence");
  const compliance = read(web, "src", "pages", "CompliancePage.tsx");
  assert.match(compliance, /formed in \{RESTRICTED_SENTENCE\}/);
  const names = ["Cuba", "Iran", "North Korea", "Syria", "Russia", "Belarus", "United Arab Emirates", "Crimea", "Sevastopol", "Donetsk", "Luhansk"];
  for (const n of names) {
    assert.ok(terms.includes(n), `Terms: ${n}`);
    assert.ok(RESTRICTED_SENTENCE.includes(n), `shared sentence: ${n}`);
  }
  // (the FAQ data reads build-time settings, so it is read here as text; the prerender test checks the pages themselves)
  const faq = flat(read(web, "src", "lib", "faq.ts")).match(/id: "restricted",[\s\S]*?links:/)?.[0] ?? "";
  assert.ok(faq, "the FAQ answers 'Why can't I use VisionSwap where I am?'");
  for (const n of names) assert.ok(faq.includes(n), `FAQ: ${n}`);
  assert.match(flat(read(web, "src", "lib", "support-faq.ts")), /id: "restricted",[^}]*Compliance page/);
  // every place the list knows has a name in plain English
  for (const p of RESTRICTED_PLACES) assert.ok(!/^[A-Z-0-9]+$/.test(placeName(p.code)), p.code);
});

test("the server's default lists name the same places, once the server's region work is merged", { skip: NO_SERVICE_SOURCE }, (t) => {
  const config = read(repo, "server", "src", "config.ts");
  if (!/BLOCKED_REGIONS/.test(config)) {
    t.skip("server/src/config.ts has no BLOCKED_REGIONS yet (the server branch adds it)");
    return;
  }
  const list = (name: string) => {
    // env("NAME", "CU,…"), or env("NAME", DEFAULT_NAME) with `DEFAULT_NAME = "CU,…"` (as the server branch writes it)
    const m = config.match(new RegExp(`env\\("${name}", "([A-Z0-9,\\-]*)"\\)`)) ?? config.match(new RegExp(`\\bDEFAULT_${name} = "([A-Z0-9,\\-]*)"`));
    assert.ok(m, `config.ts no longer gives ${name} a plain default`);
    return m![1].split(",").filter(Boolean);
  };
  assert.deepEqual([...list("BLOCKED_COUNTRIES"), ...list("BLOCKED_REGIONS")].sort(), [...RESTRICTED_CODES].sort());
});

test("the restricted-region notice never mentions VPNs or another way in", () => {
  for (const f of [join(web, "src", "components", "Restricted.tsx"), join(web, "src", "pages", "UnavailablePage.tsx")]) {
    const s = flat(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""));
    assert.doesNotMatch(s, /VPN|proxy|Tor\b|try again from|another (?:way|network|country)/i, f);
  }
});

// ─── /api/region and 451 ───

test("/api/region: parsed field by field; nothing malformed ever reads as restricted", () => {
  assert.deepEqual(parseRegion({ restricted: true, regionBlocking: "on", source: "DB-IP Lite 2026-10", where: "ua-43" }), {
    restricted: true,
    regionBlocking: "on",
    source: "DB-IP Lite 2026-10",
    where: "UA-43",
  });
  assert.deepEqual(parseRegion({ restricted: false, regionBlocking: "off", source: null, where: "IR" }), { ...REGION_UNKNOWN, regionBlocking: "off" }, "a place only comes with a refusal");
  assert.equal(parseRegion({ restricted: "yes" }).restricted, false);
  assert.equal(parseRegion(null).restricted, false);
  assert.equal(parseRegion({ restricted: true, where: "<script>" }).where, null);
  assert.equal(parseRegion({ regionBlocking: "degraded" }).regionBlocking, "degraded");
});

test("a 451 is a region refusal unless it names another code", () => {
  assert.equal(isRegionRefusal(451, { error: "x", code: "restricted_region" }), true);
  assert.equal(isRegionRefusal(451, { error: "VisionSwap is not available in your region." }), true, "servers from before the code");
  assert.equal(isRegionRefusal(451, undefined), true);
  assert.equal(isRegionRefusal(451, { code: "something_else" }), false);
  assert.equal(isRegionRefusal(451, { error: "x", code: "region_unknown" }), false, "a connection the server can't place isn't told it is restricted");
  assert.equal(isRegionRefusal(403, { code: "restricted_region" }), false);
});

test("the region is asked once per page load, and a refusal stands for the rest of it", async () => {
  let calls = 0;
  let answer: unknown = { restricted: false, regionBlocking: "on", source: null };
  const store = new RegionStore(() => async (url: string) => {
    calls++;
    assert.equal(url, "https://api.example/api/region");
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  await Promise.all([store.load("https://api.example"), store.load("https://api.example")]);
  await store.load("https://api.example");
  assert.equal(calls, 1);
  assert.equal(store.get().restricted, false);
  let heard = 0;
  store.subscribe(() => heard++);
  store.noteRefusal("IR");
  assert.deepEqual([store.get().restricted, store.get().where, heard], [true, "IR", 1]);
  // a server that can't be asked leaves it unknown, never restricted
  const down = new RegionStore(() => async () => new Response("", { status: 404 }));
  await down.load();
  assert.equal(down.get().restricted, false);
  answer = { restricted: false };
});

test("a 451 that names no place shows the restricted screen only once /api/region confirms it", async () => {
  // a 451 naming no place may not come from a restricted place (the server also refuses a deposit from a connection it can't place)
  let answer: unknown = { restricted: false, regionBlocking: "on", source: "built-in lookup" };
  const urls: string[] = [];
  const store = new RegionStore(() => async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  await store.load("https://api.example");
  await store.noteRefusal(undefined);
  assert.equal(store.get().restricted, false, "a connection the server can't place isn't told it is in a restricted place");
  assert.deepEqual(urls, ["https://api.example/api/region", "https://api.example/api/region"], "asked again, fresh, at the same server");
  // confirmed: the screen shows, with the place the server names
  answer = { restricted: true, regionBlocking: "on", source: "built-in lookup", where: "IR" };
  await store.noteRefusal(undefined);
  assert.deepEqual([store.get().restricted, store.get().where], [true, "IR"]);
  // and stands: a later answer can't take it away
  answer = { restricted: false, regionBlocking: "on", source: null };
  await store.noteRefusal(undefined);
  assert.equal(store.get().restricted, true);
  // a server that can't be asked (one from before /api/region): the 451 alone shows it
  const old = new RegionStore(() => async () => new Response("", { status: 404 }));
  await old.noteRefusal(undefined);
  assert.deepEqual([old.get().restricted, old.get().where], [true, null]);
});

test("the restricted screen credits DB-IP whenever the server's own lookup answered", () => {
  assert.equal(creditsGeoDatabase("built-in lookup"), true, "what the server says for its own DB-IP lookup");
  assert.equal(creditsGeoDatabase("DB-IP Lite 2026-10"), true);
  assert.equal(creditsGeoDatabase(null), true, "not known: credited, which is harmless");
  assert.equal(creditsGeoDatabase("trusted proxy"), false, "a service in front of the server is another source");
});

test("api() and the chain gateway carry the Terms header and switch to the restricted screen on 451", () => {
  const net = read(web, "src", "lib", "net.ts");
  assert.match(net, /for \(const \[k, v\] of Object\.entries\(termsHeader\(\)\)\) headers\.set\(k, v\);[\s\S]{0,120}const r = await fetch\(`\$\{API\}\$\{path\}`/);
  assert.match(net, /if \(r\.status === 451\) noteRegionRefusal\(451, j, API\);/);
  assert.match(net, /new Connection\(rpcUrl\(\), \{[^}]*fetch: gatewayFetch \}\)/);
  assert.match(net, /const gatewayFetch: typeof fetch = async[\s\S]{0,300}termsHeader\(\)[\s\S]{0,200}r\.status === 451\) noteRegionRefusal/);
});

test("the restricted screen comes before the Terms window in the app, on payment links and in the extension", () => {
  const app = read(web, "src", "pages", "AppPage.tsx");
  assert.match(app, /const needTerms = termsStatus !== "current" && !st\.unlocked && !restricted;/);
  assert.match(app, /\{restricted \? \(\s*<Restricted info=\{regionInfo\}/);
  const pay = read(web, "src", "pages", "PayPage.tsx");
  assert.match(pay, /if \(regionInfo\.restricted\) \{\s*return \(\s*<section className="pay-wrap">\s*<Restricted/);
  const panel = read(repo, "extension", "src", "Panel.tsx");
  assert.match(panel, /\{regionInfo\.restricted \? \([\s\S]{0,400}<Restricted info=\{regionInfo\}[\s\S]{0,200}\) : st\.unlocked && st\.pool \?/);
});

// ─── P1-7: the Terms header ───

class Mem implements KV {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}

test("x-vs-terms: the major version accepted here, and nothing before acceptance", () => {
  const kv = new Mem();
  const store = new TermsStore(() => kv, "2.0");
  assert.deepEqual(termsHeaderFor(store), {});
  store.accept({ hash: "a".repeat(64), rev: "", acks: ["terms", "eligible", "risks"], surface: "web" });
  assert.deepEqual(termsHeaderFor(store), { "x-vs-terms": "2" });
  // an older major version accepted: no header until the current one is
  const newer = new TermsStore(() => kv, "3.0");
  assert.deepEqual(termsHeaderFor(newer), {});
});

// ─── P0-3, P0-4: the gateway's own refusals ───

test("a transaction the chain gateway refused (403 or 451) is a sure refusal, told in the gateway's words", () => {
  const listed = new Error('403 Forbidden: {"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"This recipient can\'t receive from VisionSwap. Nothing was sent."}}');
  assert.equal(gatewayRefusal(listed), "This recipient can't receive from VisionSwap. Nothing was sent.");
  assert.equal(refusedForSure(listed), true);
  assert.equal(chainError(listed).message, "This recipient can't receive from VisionSwap. Nothing was sent.");
  const held = new Error('403 : {"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"This deposit is on hold for a review. You can take it back at any time."}}');
  assert.equal(chainError(held).message, "This deposit is on hold for a review. You can take it back at any time.");
  const region = new Error('451 Unavailable For Legal Reasons: {"error":"VisionSwap isn\'t available in your region.","code":"restricted_region"}');
  assert.equal(gatewayRefusal(region), "VisionSwap isn't available in your region.");
  assert.equal(refusedForSure(region), true);
  assert.equal(gatewayRefusal(new Error("451 : not json")), "VisionSwap isn't available in your region. Nothing was sent.");
  assert.equal(gatewayRefusal(new Error("failed to fetch")), null);
  assert.equal(gatewayRefusal(new Error('429 Too Many Requests: {"error":{"message":"busy"}}')), null, "a busy gateway is no refusal");
});

// ─── P0-3: "Send all" checks the recipient first ───

/** The body of an engine method, from its signature to `limit` characters on. */
function method(src: string, signature: string, limit = 4000): string {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `engine.ts has no ${signature}`);
  return src.slice(at, at + limit);
}

test("Send all from a Vision wallet or a deposit address screens the recipient before anything is signed", () => {
  const engine = read(web, "src", "lib", "engine.ts");
  for (const sig of ["async sendFromVision(index: number, to: string)", "async sendFromDeposit(index: number, to: string)"]) {
    const body = method(engine, sig);
    const check = body.indexOf("await this.checkSendAll(dest.toBase58());");
    assert.ok(check > 0, `${sig} doesn't check the recipient`);
    for (const later of ["new Transaction()", "sendAndConfirm(", ".sign("]) {
      const at = body.indexOf(later);
      assert.ok(at < 0 || check < at, `${sig}: ${later} comes before the check`);
    }
  }
  // the check is the full one a payment sent without the relayer gets: no answer, no transfer
  const all = method(engine, "private async checkSendAll(to: string)", 600);
  assert.match(all, /await this\.checkRecipients\(\[\{ to, amount: 0n, offCurveOk: true, lookalikeOk: true \}\], false, true\);/);
  // and the published list is checked here first, before the server is asked
  const rec = method(engine, "private async checkRecipients(parts: Part[], later: boolean, strict = false)", 4000);
  assert.ok(rec.indexOf("screenList.listed(p.to) === true") < rec.indexOf('api("/api/relay/check"'));
});

// ─── P1-8: the published list, checked in the browser ───

const LISTED = "7JqLKw8m8EqkkU5r5NTz5D9fTaAsdz3QXsGeRuyNcyfS";

test("the sanctions list is one download, the same for everyone, and a listed wallet or recipient is told at once", async () => {
  const urls: string[] = [];
  const list = new ScreenList(() => async (url: string, init?: RequestInit) => {
    urls.push(url);
    assert.equal(init?.body, undefined, "nothing about the wallet is sent");
    assert.equal(init?.credentials, "omit");
    return new Response(JSON.stringify({ addresses: [LISTED, "not an address"], updatedAt: "2026-10-01T00:00:00Z", source: "ofac" }), { status: 200 });
  });
  assert.equal(list.listed(LISTED), null, "unknown until it is downloaded");
  await Promise.all([list.load(), list.load()]);
  await list.load();
  assert.deepEqual(urls, ["/api/sanctions/list"]);
  assert.equal(list.listed(LISTED), true);
  assert.equal(list.listed(Keypair.generate().publicKey.toBase58()), false);
  assert.equal(list.get()?.addresses.size, 1, "only addresses are kept");
  assert.equal(list.get()?.source, "ofac");
  // other spellings of the answer
  assert.equal(parseSanctionsList({ sol: [LISTED] })?.addresses.has(LISTED), true);
  assert.equal(parseSanctionsList({ nothing: true }), null);
  // a list that can't be downloaded refuses nothing
  const down = new ScreenList(() => async () => new Response("", { status: 500 }));
  await down.load();
  assert.equal(down.listed(LISTED), null);
});

test("a listed wallet opens no account: the engine checks the list before any signature, and the app shows a calm screen", () => {
  const engine = read(web, "src", "lib", "engine.ts");
  const unlock = method(engine, "async unlock(wallet: WalletLike", 2000);
  const check = unlock.indexOf("screenList.listed(owner) === true");
  assert.ok(check > 0 && check < unlock.indexOf("signOrCancel"));
  const app = read(web, "src", "pages", "AppPage.tsx");
  assert.match(app, /const listed = useListed\(st\.owner\);\s*if \(listed\) return <ListedWallet/);
  // connecting a wallet asks for its balance: the list is checked first, so no request ever names a listed wallet
  const pub = method(engine, "async refreshPublic()", 800);
  const listedAt = pub.indexOf("screenList.listed(owner) === true");
  assert.ok(pub.indexOf("await screenList.load(API)") >= 0 && listedAt > 0 && listedAt < pub.indexOf("getBalance"));
});

// ─── P0-6, P0-7: /api/legal, the screening policy, the contact ───

const LEGAL_FIXTURE = {
  contact: "compliance@visionswap.net",
  regionBlocking: "on",
  restricted: ["CU", "IR", "UA-43"],
  blockedCountries: ["CU", "IR"],
  blockedRegions: ["UA-43"],
  screening: { mode: "official-list", lists: ["OFAC SDN"], updatedAt: "2026-10-14T06:00:00Z", source: "ofac" },
  legal: { contact: "mailto:compliance@visionswap.net" },
};

test("/api/legal: the screening block, the restricted places and the contact (top-level, or the legal settings')", () => {
  const info = parseLegalInfo(LEGAL_FIXTURE);
  assert.deepEqual(info.screening, { mode: "official-list", riskService: false, lists: ["OFAC SDN"], updatedAt: "2026-10-14T06:00:00Z", source: "ofac" });
  assert.deepEqual(refusedPlaces(info), ["CU", "IR", "UA-43"]);
  assert.equal(info.contact, "compliance@visionswap.net");
  assert.equal(parseLegalInfo({ ...LEGAL_FIXTURE, contact: null }).contact, "mailto:compliance@visionswap.net");
  assert.equal(parseLegalInfo({ ...LEGAL_FIXTURE, contact: null, legal: {} }).contact, null);
  assert.deepEqual(refusedPlaces(parseLegalInfo({ ...LEGAL_FIXTURE, regionBlocking: "off" })), [], "nothing is claimed while blocking is off");
  // "degraded" refuses nothing for its region on the server, so nothing is claimed then either
  assert.deepEqual(refusedPlaces(parseLegalInfo({ ...LEGAL_FIXTURE, regionBlocking: "degraded", blockedCountries: [], blockedRegions: [] })), []);
  // a region the server's lookup can't tell apart is in the policy list but isn't claimed as refused
  assert.deepEqual(refusedPlaces(parseLegalInfo({ ...LEGAL_FIXTURE, blockedRegions: [] })), ["CU", "IR"]);
  // a server that doesn't name its refused regions: its list
  assert.deepEqual(refusedPlaces(parseLegalInfo({ ...LEGAL_FIXTURE, blockedRegions: undefined })), ["CU", "IR", "UA-43"]);
  assert.equal(parseLegalInfo({ ...LEGAL_FIXTURE, screening: { mode: "risk-score" } }).screening, null, "a mode this page can't describe isn't described");
});

test("the screening policy renders from /api/legal: the official list only, its source and date, and a contest line only with a contact", () => {
  const info = parseLegalInfo(LEGAL_FIXTURE);
  const out = html(renderToStaticMarkup(createElement(ScreeningPolicy, { screening: info.screening, contact: info.contact })));
  assert.match(out, /Specially Designated Nationals/);
  assert.match(out, /checked for updates every 6 hours/);
  assert.match(out, /last updated October 14, 2026, from OFAC's own published file/);
  assert.match(out, /Screening: OFAC SDN/);
  assert.match(out, /mailto:compliance@visionswap\.net/);
  assert.match(out, /careful filter, not proof/);
  assert.doesNotMatch(out, /risk score|risk service|commercial/i, "D1: no commercial risk feed is described");
  const none = html(renderToStaticMarkup(createElement(ScreeningPolicy, { screening: null, contact: null })));
  assert.doesNotMatch(none, /If you think we got it wrong|mailto:/);
  assert.match(none, /Specially Designated Nationals/, "the policy itself doesn't depend on the server answering");
  // should the built-in risk service ever be switched on, the server says so and the policy doesn't leave it out
  const risk = parseLegalInfo({ ...LEGAL_FIXTURE, screening: { ...LEGAL_FIXTURE.screening, mode: "official-list+risk-service" } }).screening;
  assert.equal(risk?.riskService, true);
  const withRisk = html(renderToStaticMarkup(createElement(ScreeningPolicy, { screening: risk, contact: null })));
  assert.match(withRisk, /An outside address risk service is switched on too/);
  assert.match(withRisk, /Screening: OFAC SDN, plus a risk service/);
});

test("contact lines on the Compliance page: LEGAL_CONTACT, support@visionswap.net by default, and none when it is off (D7)", () => {
  const page = read(web, "src", "pages", "CompliancePage.tsx");
  assert.doesNotMatch(page, /@VisionSwapSol on X/, "no stand-in contact");
  assert.match(page, /const contact = shownLegal\(legal\)\.contact;/);
  assert.match(page, /\{contact && \(\s*<li>\s*Think we got it wrong\?/);
  assert.match(page, /\{contact && \(\s*<>\s*\{" "\}\s*Send them to <ContactLink/);
});

test("/api/legal's default contacts are the pages' own (checked against the service's source)", { skip: NO_SERVICE_SOURCE }, () => {
  // the pages' defaults are the server's, so the pages as built say what /api/legal will
  const server = read(repo, "server", "src", "legal.ts");
  for (const [name, address] of [["SUPPORT_EMAIL", "support@visionswap.net"], ["BUSINESS_EMAIL", "business@visionswap.net"]]) {
    assert.ok(server.includes(`export const ${name} = "${address}";`), name);
  }
});

test("/api/legal's contacts: support@ and business@ by default, the owner's own addresses when set, none when off", () => {
  const pages = read(repo, "web", "src", "lib", "contacts.ts");
  for (const [name, address] of [["SUPPORT_EMAIL", "support@visionswap.net"], ["BUSINESS_EMAIL", "business@visionswap.net"]]) {
    assert.ok(pages.includes(`export const ${name} = "${address}";`), name);
  }
  // before the server answers (and in the pages as built), or when it can't be asked: the defaults
  for (const info of [shownLegal(null), parseLegalInfo(null), DEFAULT_LEGAL_INFO]) {
    assert.equal(info.contact, "mailto:support@visionswap.net");
    assert.equal(info.legal.contact, "mailto:support@visionswap.net");
    assert.equal(info.security, "mailto:support@visionswap.net");
    assert.equal(info.business, "mailto:business@visionswap.net");
    assert.equal(info.ok, false);
  }
  // what the server publishes by default
  const live = parseLegalInfo({
    contact: "mailto:support@visionswap.net",
    business: "mailto:business@visionswap.net",
    security: "mailto:support@visionswap.net",
    legal: { contact: "mailto:support@visionswap.net" },
  });
  assert.deepEqual([live.contact, live.business, live.security], ["mailto:support@visionswap.net", "mailto:business@visionswap.net", "mailto:support@visionswap.net"]);
  // the owner's own addresses
  const own = parseLegalInfo({ ...LEGAL_FIXTURE, business: "partners@example.org", security: "https://example.org/report" });
  assert.equal(own.business, "mailto:partners@example.org");
  assert.equal(own.security, "https://example.org/report");
  // turned off: nothing shown
  const off = parseLegalInfo({ contact: null, business: null, security: null, legal: { contact: null } });
  assert.deepEqual([off.contact, off.business, off.security], [null, null, null]);
  // a server from before BUSINESS_CONTACT: the default business address stands
  assert.equal(parseLegalInfo({ contact: null, legal: {} }).business, "mailto:business@visionswap.net");
  // the business address is an email address, nothing else
  for (const bad of ["https://example.org", "javascript:alert(1)", "<a@b.org>", 7]) assert.equal(parseLegalInfo({ business: bad }).business, null, String(bad));
});

// ─── P1-4: monthly figures ───

test("monthly figures: counts only, newest first, 1 to 4 shown as 'fewer than 5', and a graceful empty table", () => {
  const t = parseTransparency({
    since: "2026-10",
    months: [
      { month: "2026-10", depositsScreened: 120, depositsReturned: 3, recipientsRefused: 0, regionRefusals: 41 },
      { month: "2026-11", depositsScreened: 12, depositsReturned: 0, recipientsRefused: 1, regionRefusals: 5, address: "x" },
      { month: "nope", depositsScreened: 1 },
    ],
  });
  assert.deepEqual(
    t?.months.map((m) => m.month),
    ["2026-11", "2026-10"],
  );
  assert.ok(!JSON.stringify(t).includes("address"), "nothing but counts is kept");
  assert.equal(countText(3), "fewer than 5");
  assert.equal(countText(1), "fewer than 5");
  assert.equal(countText(0), "0");
  assert.equal(countText(5), "5");
  assert.equal(countText(1234), "1,234");
  assert.equal(monthName("2026-10"), "October 2026");
  const out = html(renderToStaticMarkup(createElement(Figures, { data: t })));
  assert.match(out, /October 2026/);
  assert.match(out, /fewer than 5/);
  assert.doesNotMatch(out, />3</, "a count below 5 is never shown as itself");
  const empty = html(renderToStaticMarkup(createElement(Figures, { data: { months: [], since: "2026-10" } })));
  assert.match(empty, /Figures are counted from October 2026/);
  assert.match(html(renderToStaticMarkup(createElement(Figures, { data: null, failed: true }))), /can't be loaded right now/);
  assert.equal(parseTransparency({ months: "x" }), null);
});

// ─── P0-8: the statement says what it shows and what it doesn't ───

const STATEMENT_INPUT = {
  network: "mainnet",
  programId: "VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6",
  fingerprint: "abcd",
  pubKey: "11".repeat(32),
  viewKey: "22".repeat(32),
  balanceLamports: "5",
  notes: [],
  activity: [],
};

test("statement(false) carries no viewing key; both carry their limits, and the activity is marked self-reported", () => {
  const without = buildStatement(STATEMENT_INPUT, false);
  assert.ok(!("viewKey" in without.account));
  assert.ok(!JSON.stringify(without).includes("22".repeat(32)));
  assert.deepEqual(without.limits, [...STATEMENT_LIMITS]);
  assert.equal(without.activityIsSelfReported, true);
  assert.match(without.howToVerify, /doesn't show which are unspent, that the list is complete, or that the presenter controls the account/);
  const withKey = buildStatement(STATEMENT_INPUT, true);
  assert.equal((withKey.account as { viewKey?: string }).viewKey, "22".repeat(32));
  assert.ok(withKey.limits.includes(VIEW_KEY_LIMIT));
  assert.match(VIEW_KEY_LIMIT, /every note this account has received or will receive[\s\S]*can't be taken back/);
});

test("the viewing key needs a confirmation that says it can't be taken back", () => {
  const panels = read(web, "src", "components", "app", "Panels.tsx");
  assert.match(panels, /if \(e\.target\.checked\) setAskKey\(true\);\s*else setWithKey\(false\);/);
  assert.match(flat(panels), /Include my viewing key: lets the holder see every note you've received, before and after today\. It can't be taken back\./);
  assert.match(flat(panels), /<strong>Share your viewing key\?<\/strong>/);
});

// ─── P1-2: ownership proofs ───

test("ownership proofs: signed with the prefix, checked by anyone, and never over a transaction", () => {
  const kp = Keypair.generate();
  const proof = signOwnership(kp.secretKey, "  exchange challenge 9182  ");
  assert.equal(proof.address, kp.publicKey.toBase58());
  assert.equal(proof.message, `${OWNERSHIP_PREFIX}exchange challenge 9182`);
  // anyone checks it, with the exchange's own text or the whole signed message
  assert.deepEqual(verifyOwnership({ address: proof.address, message: "exchange challenge 9182", signature: proof.signature }), {
    ok: true,
    address: proof.address,
    text: "exchange challenge 9182",
  });
  assert.equal(verifyOwnership(proof).ok, true);
  // hex and base64 signatures too
  const raw = bs58.decode(proof.signature);
  assert.equal(verifyOwnership({ ...proof, signature: Buffer.from(raw).toString("hex") }).ok, true);
  assert.equal(verifyOwnership({ ...proof, signature: Buffer.from(raw).toString("base64") }).ok, true);
  // the prefix is enforced: a signature over the bare text is not a VisionSwap ownership proof
  const bare = bs58.encode(ed25519.sign(new TextEncoder().encode("exchange challenge 9182"), kp.secretKey.slice(0, 32)));
  assert.equal(verifyOwnership({ address: proof.address, message: "exchange challenge 9182", signature: bare }).ok, false);
  // another address, another text
  assert.equal(verifyOwnership({ ...proof, address: Keypair.generate().publicKey.toBase58() }).ok, false);
  assert.equal(verifyOwnership({ ...proof, message: "exchange challenge 9183" }).ok, false);
  assert.equal(readSignature("abc"), null);
});

test("a text that reads as a transaction, one of VisionSwap's own messages or an off-chain message is never signed", () => {
  // a legacy transaction message whose every byte is ASCII, so it can arrive as pasted text
  const msg = new Uint8Array([1, 0, 1, 2, ...new Uint8Array(32).fill(0x41), ...new Uint8Array(32).fill(0x42), ...new Uint8Array(32).fill(0x43), 1, 1, 1, 0, 0]);
  assert.equal(looksLikeTransaction(msg), true);
  const txText = new TextDecoder().decode(msg);
  assert.ok(ownershipTextProblem(txText), "transaction-shaped text is refused");
  assert.throws(() => signOwnership(Keypair.generate().secretKey, txText));
  assert.match(ownershipTextProblem("vs:refund something") ?? "", /VisionSwap's own messages/);
  assert.match(ownershipTextProblem("ÿsolana offchain abc") ?? "", /hidden control characters|off-chain/);
  assert.match(ownershipTextProblem("") ?? "", /Paste the message/);
  assert.match(ownershipTextProblem("x".repeat(1001)) ?? "", /longer than 1000/);
  assert.throws(() => ownershipMessage("vs:x"));
  const m = ownershipMessage("hello");
  assert.equal(new TextDecoder().decode(m), `${OWNERSHIP_PREFIX}hello`);
});
