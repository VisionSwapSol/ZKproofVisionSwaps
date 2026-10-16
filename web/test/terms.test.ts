/**
 * The Terms of use and their acceptance (click-wrap):
 *
 * 1. lib/terms.ts: acceptance is recorded on this device only, holds no wallet address or identity,
 *    makes no network request, survives a reload, asks again after a material version or a change of
 *    the operator's legal settings, and copes with storage that is blocked, full or tampered with.
 * 2. Every way into an account checks it: the engine refuses to open one (or ask for a signature)
 *    without it, a wallet reconnects by itself only with it, and every screen with a way in shows the
 *    Terms window first. No passive "by connecting you agree" line is left.
 * 3. The Terms text: one source, an archived copy and fingerprint for every version, clauses that
 *    depend on the operator's legal settings only once they are set, and cross-references that point
 *    at real clauses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TERMS_ACKS,
  TERMS_KEY,
  TERMS_VERSION,
  TermsNeededError,
  TermsStore,
  autoConnectAllowed,
  isCurrent,
  majorOf,
  parseRecord,
  terms,
  type KV,
} from "../src/lib/terms.ts";
import { DEFAULT_LEGAL_SETTINGS, NO_LEGAL_SETTINGS, contactHref, legalRev, parseLegal, settingText, type LegalSettings } from "../src/legal/settings.ts";
import { DEFAULT_LEGAL_INFO, parseLegalInfo } from "../src/legal/info.ts";
import { plain, termsDoc, termsHash, termsText } from "../src/legal/terms-doc.ts";
import { TERMS_ARCHIVE } from "../src/legal/archive.ts";
import { TERMS_FOCUS_AFTER, focusAfterTerms } from "../src/lib/termsfocus.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const HASH = "0123456789abcdef".repeat(4);

/** A Storage stand-in; `fail` makes each method throw (blocked or full storage). */
function memoryKV(fail: { get?: boolean; set?: boolean } = {}): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => {
      if (fail.get) throw new Error("SecurityError");
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      if (fail.set) throw new Error("QuotaExceededError");
      data.set(k, v);
    },
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

const accept = (s: TermsStore, rev = "") => s.accept({ hash: HASH, rev, acks: TERMS_ACKS, surface: "web" }, new Date("2026-10-14T12:00:00Z"));

// ─── 1. the acceptance record ───

test("versions: the major number decides; anything else isn't a version", () => {
  assert.equal(majorOf("2.0"), 2);
  assert.equal(majorOf("2.13"), 2);
  assert.equal(majorOf("10"), 10);
  assert.ok(Number.isNaN(majorOf("v2")));
  assert.ok(Number.isNaN(majorOf("")));
  assert.ok(Number.isFinite(majorOf(TERMS_VERSION)));
});

test("never accepted: needed, and nothing may open", () => {
  const s = new TermsStore(() => memoryKV());
  assert.equal(s.status(), "needed");
  assert.equal(s.current(), false);
  assert.throws(() => s.require(), TermsNeededError);
});

test("accepting needs every box ticked", () => {
  const s = new TermsStore(() => memoryKV());
  for (const acks of [[], ["terms"], ["terms", "eligible"], ["eligible", "risks"]] as const) {
    assert.throws(() => s.accept({ hash: HASH, rev: "", acks, surface: "web" }), /Every box/);
  }
  assert.throws(() => s.accept({ hash: "nope", rev: "", acks: TERMS_ACKS, surface: "web" }), /fingerprint/);
  assert.equal(s.current(), false);
});

test("the record holds the version, the time, the boxes, the text's fingerprint and where: no address, no key, no identity", () => {
  const kv = memoryKV();
  const s = new TermsStore(() => kv);
  const rec = accept(s);
  assert.deepEqual(Object.keys(rec).sort(), ["acks", "at", "hash", "rev", "surface", "v"]);
  assert.equal(rec.v, TERMS_VERSION);
  assert.equal(rec.at, "2026-10-14T12:00:00.000Z");
  assert.deepEqual(rec.acks, [...TERMS_ACKS]);
  const stored = kv.data.get(TERMS_KEY)!;
  assert.deepEqual(JSON.parse(stored), rec);
  // nothing that looks like a Solana address or key rides along
  assert.doesNotMatch(stored, /[1-9A-HJ-NP-Za-km-z]{32,44}/);
  assert.equal(s.status(), "current");
  assert.doesNotThrow(() => s.require());
});

test("accepting makes no network request", () => {
  const was = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("no network here");
  }) as typeof fetch;
  try {
    accept(new TermsStore(() => memoryKV()));
  } finally {
    globalThis.fetch = was;
  }
  assert.equal(calls, 0);
});

test("remembered on this device: a reload (a new store over the same storage) needs nothing more", () => {
  const kv = memoryKV();
  accept(new TermsStore(() => kv));
  assert.equal(new TermsStore(() => kv).status(), "current");
});

test("a new major version asks again ('updated'); a minor one doesn't", () => {
  const kv = memoryKV();
  accept(new TermsStore(() => kv));
  const next = `${majorOf(TERMS_VERSION) + 1}.0`;
  assert.equal(new TermsStore(() => kv, next).status(), "updated");
  assert.equal(new TermsStore(() => kv, `${majorOf(TERMS_VERSION)}.7`).status(), "current");
  // accepting the new version makes it current there
  const s = new TermsStore(() => kv, next);
  accept(s);
  assert.equal(s.status(), "current");
  assert.equal(JSON.parse(kv.data.get(TERMS_KEY)!).v, next);
});

test("a change to the operator's legal settings asks again; until they are known, the version alone counts", () => {
  const kv = memoryKV();
  const s = new TermsStore(() => kv);
  accept(s, "");
  assert.equal(s.status(), "current");
  s.setLiveRev("");
  assert.equal(s.status(), "current");
  s.setLiveRev("0123456789abcdef");
  assert.equal(s.status(), "updated");
  accept(s, "0123456789abcdef");
  assert.equal(s.status(), "current");
  s.setLiveRev(null);
  assert.equal(s.status(), "current");
  assert.equal(isCurrent(parseRecord(JSON.parse(kv.data.get(TERMS_KEY)!)), ""), false);
});

test("storage that can't be written keeps the acceptance for this visit only", () => {
  for (const kv of [memoryKV({ set: true }), memoryKV({ get: true, set: true })]) {
    const s = new TermsStore(() => kv);
    accept(s);
    assert.equal(s.status(), "current", "this visit goes on");
    assert.equal(new TermsStore(() => kv).status(), "needed", "the next visit asks again");
  }
  // no storage at all, or a storage accessor that throws
  const none = new TermsStore(() => null);
  accept(none);
  assert.equal(none.current(), true);
  const throwing = new TermsStore(() => {
    throw new Error("SecurityError");
  });
  assert.equal(throwing.status(), "needed");
  accept(throwing);
  assert.equal(throwing.current(), true);
});

test("an unreadable, tampered or partial record counts as none", () => {
  const good = { v: TERMS_VERSION, rev: "", hash: HASH, at: "2026-10-14T12:00:00.000Z", acks: [...TERMS_ACKS], surface: "web" };
  assert.ok(parseRecord(good));
  for (const bad of [
    null,
    "yes",
    { ...good, v: "two" },
    { ...good, hash: "abc" },
    { ...good, rev: "zz" },
    { ...good, at: "not a time" },
    { ...good, acks: ["terms", "eligible"] },
    { ...good, surface: "bank" },
  ]) {
    assert.equal(parseRecord(bad), null, JSON.stringify(bad));
  }
  // extra fields never survive a read
  assert.deepEqual(Object.keys(parseRecord({ ...good, wallet: "x", ip: "1.2.3.4" })!).sort(), ["acks", "at", "hash", "rev", "surface", "v"]);
  const kv = memoryKV();
  kv.data.set(TERMS_KEY, "{not json");
  assert.equal(new TermsStore(() => kv).status(), "needed");
  kv.data.set(TERMS_KEY, JSON.stringify({ ...good, acks: [] }));
  assert.equal(new TermsStore(() => kv).status(), "needed");
});

test("forgetting asks again (funds aren't touched: there is nothing else to forget)", () => {
  const kv = memoryKV();
  const s = new TermsStore(() => kv);
  accept(s);
  let told = 0;
  const off = s.subscribe(() => told++);
  s.forget();
  off();
  assert.equal(s.status(), "needed");
  assert.equal(kv.data.has(TERMS_KEY), false);
  assert.equal(told, 1);
});

test("a wallet chosen before reconnects by itself only once the Terms are accepted here", async () => {
  // no localStorage in node: the shared store keeps this visit's acceptance in memory
  terms.forget();
  assert.equal(await autoConnectAllowed(), false);
  terms.accept({ hash: HASH, rev: "", acks: TERMS_ACKS, surface: "web" });
  assert.equal(await autoConnectAllowed(), true);
  terms.forget();
  assert.equal(await autoConnectAllowed(), false);
});

// ─── 2. every way in checks it ───

/** The body of a method of the engine, from its signature to its first line that does something. */
function methodBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `engine.ts has no ${signature}`);
  return src.slice(at, at + 900);
}

test("the engine opens no account, and asks for no signature, without a current acceptance", () => {
  const engine = read(web, "src", "lib", "engine.ts");
  assert.match(engine, /import \{ requireTerms \} from "\.\/terms";/);
  const gated: [string, RegExp][] = [
    ["async unlock(wallet: WalletLike", /signOrCancel|this\.set\(\{ busy/],
    ["private async open(keys: Keys", /this\.keys = keys/],
    ["async openSavedKey()", /deviceKey|unsealWith/],
    ["async openWithKey(text: string", /decodePrivateKey|forgetSavedKey|saveKey/],
  ];
  for (const [sig, firstAction] of gated) {
    const body = methodBody(engine, sig);
    const check = body.indexOf("requireTerms()");
    const act = body.search(firstAction);
    assert.ok(check > 0, `${sig} doesn't check the Terms`);
    assert.ok(act < 0 || check < act, `${sig} acts before it checks the Terms`);
  }
  // every place that sets an account open goes through open()
  assert.equal(engine.match(/unlocked: true,/g)?.length, 1, "an account opens somewhere other than open()");
});

test("a wallet reconnects by itself only through the Terms check", () => {
  const wallet = read(web, "src", "lib", "wallet.tsx");
  assert.match(wallet, /autoConnect=\{autoConnectAllowed\}/);
  assert.doesNotMatch(wallet, /\n\s*autoConnect\n/, "a bare autoConnect would reconnect before the Terms");
});

test("every screen with a way into an account shows the Terms window first", () => {
  const app = read(web, "src", "pages", "AppPage.tsx");
  assert.match(app, /needTerms \? \(\s*<TermsWall[\s\S]{0,200}\) : publicKey \? \(\s*<UnlockGate[\s\S]{0,80}<ConnectGate/);
  assert.match(app, /\{needTerms && termsOpen && <TermsGate /);
  const pay = read(web, "src", "pages", "PayPage.tsx");
  assert.match(pay, /if \(termsOk\) pickWallet\(w\.adapter\.name\);\s*else setAskTerms\(w\.adapter\.name\);/);
  assert.match(pay, /<TermsGate\s+purpose="pay"/);
  const panel = read(repo, "extension", "src", "Panel.tsx");
  assert.match(panel, /if \(termsStatus !== "current"\) \{[\s\S]{0,600}<TermsGate /);
  assert.match(panel, /if \(hasCurrentAcceptance\(\)\) return go\(\);/, "the extension's tab hand-off waits for the Terms");
});

test("no passive 'by connecting you agree' line is left anywhere", () => {
  const files = [
    ...readdirSync(join(web, "src", "pages")).map((f) => join(web, "src", "pages", f)),
    ...readdirSync(join(web, "src", "components")).filter((f) => f.endsWith(".tsx")).map((f) => join(web, "src", "components", f)),
    ...readdirSync(join(web, "src", "components", "app")).map((f) => join(web, "src", "components", "app", f)),
    ...readdirSync(join(repo, "extension", "src")).map((f) => join(repo, "extension", "src", f)),
  ];
  for (const f of files) {
    const t = readFileSync(f, "utf8").replace(/\s+/g, " ");
    assert.doesNotMatch(t, /By (?:connecting|continuing|opening)[^.]{0,80}you agree/i, f);
  }
});

test("the Terms window: three separate boxes, an Agree button that does nothing until all are ticked, a way out, and no pre-ticked box", () => {
  const gate = read(web, "src", "components", "TermsGate.tsx");
  assert.match(gate, /role="dialog"/);
  assert.match(gate, /aria-modal="true"/);
  assert.equal(gate.match(/type="checkbox"/g)?.length, 3);
  assert.match(gate, /useState<Record<TermsAck, boolean>>\(\{ terms: false, eligible: false, risks: false \}\)/);
  assert.doesNotMatch(gate, /defaultChecked|checked=\{true\}/);
  assert.match(gate, /aria-disabled=\{!all\}/);
  assert.match(gate, /const missing = TERMS_ACKS\.find\(\(a\) => !ticked\[a\]\);\s*if \(missing\) \{/);
  assert.match(gate, /By selecting <strong>Agree and continue<\/strong>, you accept the Terms of use/);
  assert.match(gate, />\s*Cancel\s*</);
  assert.match(gate, /e\.key === "Escape"/);
  assert.match(gate, /useCloseRequest\(true/);
  // the window's own summary points at the clauses it names
  const doc = termsDoc(NO_LEGAL_SETTINGS);
  const id = (n: number) => doc.sections.find((s) => s.n === n)?.id;
  assert.deepEqual([id(2), id(10), id(17), id(18), id(21)], ["eligibility", "risks", "liability", "never-limited", "disputes"]);
});

// a stand-in element and document for lib/termsfocus.ts
type Fake = { sel: string; shown: boolean; inert?: boolean; attrs: Record<string, string>; focused: number };
const fakeEl = (sel: string, shown = true, attrs: Record<string, string> = {}, inert = false): Fake => ({ sel, shown, inert, attrs: { ...attrs }, focused: 0 });
const fakeDoc = (els: Fake[], active: unknown = "BODY") => {
  const body = "BODY";
  const wrap = (f: Fake) => ({
    getClientRects: () => ({ length: f.shown ? 1 : 0 }) as unknown as DOMRectList,
    closest: (s: string) => (s === "[inert]" && f.inert ? ({} as Element) : null),
    hasAttribute: (n: string) => n in f.attrs,
    setAttribute: (n: string, v: string) => {
      f.attrs[n] = v;
    },
    focus: () => {
      f.focused++;
    },
  });
  return { activeElement: active, body, querySelectorAll: (s: string) => els.filter((e) => e.sel === s).map(wrap) };
};

test("closing the Terms window never leaves keyboard focus on nothing", () => {
  assert.equal(TERMS_FOCUS_AFTER[0], "[data-terms-landing]", "after Cancel, the line in place of the ways in comes first");
  // after Cancel on arrival: the line that replaced the ways in, its heading taken out of the Tab order
  const wall = fakeEl("[data-terms-landing]", true, { tabindex: "-1" });
  const gateH2 = fakeEl(".gate h2");
  assert.ok(focusAfterTerms(fakeDoc([gateH2, wall])));
  assert.equal(wall.focused, 1);
  assert.equal(gateH2.focused, 0);
  // after accepting: the heading of the way in now showing gets tabindex -1 (focusable, not in the Tab order)
  const h3 = fakeEl(".gate h3");
  focusAfterTerms(fakeDoc([fakeEl(".gate h2", false), h3, fakeEl("main h1")]));
  assert.equal(h3.focused, 1);
  assert.equal(h3.attrs.tabindex, "-1");
  assert.ok("data-focus-landing" in h3.attrs);
  // a heading that already has a tabindex keeps it; hidden or inert ones are passed over
  const keep = fakeEl("main h1", true, { tabindex: "0" });
  focusAfterTerms(fakeDoc([fakeEl(".gate h2", true, {}, true), keep]));
  assert.equal(keep.attrs.tabindex, "0");
  assert.equal(keep.focused, 1);
  // something already holds the focus (the button that opened the window): left alone
  const untouched = fakeEl(".gate h2");
  assert.equal(focusAfterTerms(fakeDoc([untouched], { isConnected: true })), null);
  assert.equal(untouched.focused, 0);
  // nothing to go to: nothing happens
  assert.equal(focusAfterTerms(fakeDoc([])), null);

  const gate = read(web, "src", "components", "TermsGate.tsx");
  // the window hands focus back to what opened it (never to the page itself), then makes sure something holds it
  assert.match(gate, /opener !== document\.body && opener\.isConnected[\s\S]{0,400}requestAnimationFrame\(\(\) => focusAfterTerms\(\)\)/);
  assert.match(gate, /<h2 tabIndex=\{-1\} data-terms-landing="">/);
  const app = read(web, "src", "pages", "AppPage.tsx");
  assert.doesNotMatch(app, /querySelector<HTMLElement>\("\.main-card \.gate h2"\)/, "one place decides where focus goes");
  // the same on /terms: "Remove it" takes its own button away, so the line saying what happened takes the focus
  const page = read(web, "src", "pages", "TermsPage.tsx");
  assert.match(page, /if \(removed && !rec\) result\.current\?\.focus\(\);/);
  assert.match(page, /<p ref=\{result\} tabIndex=\{-1\}/);
});

test("the Terms window works by keyboard and screen reader, and at every size", () => {
  const gate = read(web, "src", "components", "TermsGate.tsx");
  // named by its title, described by its intro, the page behind out of reach, focus starting on the title
  assert.match(gate, /aria-labelledby=\{`\$\{id\}-title`\}/);
  assert.match(gate, /aria-describedby=\{`\$\{id\}-intro`\}/);
  assert.match(gate, /root\.inert = true/);
  assert.match(gate, /<h2 id=\{`\$\{id\}-title`\} ref=\{titleRef\} tabIndex=\{-1\}>/);
  assert.match(gate, /titleRef\.current\?\.focus\(/);
  // Tab and Shift+Tab stay inside
  assert.match(gate, /if \(e\.key !== "Tab"\) return;[\s\S]{0,700}last\.focus\(\);[\s\S]{0,200}first\.focus\(\);/);
  // each statement is a real label around its box; Agree stays reachable (aria-disabled, not disabled) and says why
  assert.equal(gate.match(/<label className="tg-check">\s*<input/g)?.length, 3);
  assert.doesNotMatch(gate, /[^-]disabled=\{/);
  assert.match(gate, /role="alert"/);
  assert.match(gate, /Tick all three boxes first\./);

  const css = read(web, "src", "styles", "legal.css");
  const block = (q: string) => {
    const at = css.indexOf(q);
    assert.ok(at >= 0, `legal.css has no "${q}"`);
    return css.slice(at, css.indexOf("\n}\n", at));
  };
  // a screen reader's cursor or find-in-page can't slide the window out of place: it clips instead of hiding
  // (a hidden box can still be scrolled by the browser), and its screen-reader-only text stays in its own part
  assert.match(block(".tg {"), /overflow: hidden;/);
  assert.match(css, /@supports \(overflow: clip\) \{\s*\.tg \{\s*overflow: clip;/);
  assert.match(css, /\.tg-scroll,\s*\.tg-foot \{[^}]*position: relative;/);
  // a short window (a phone on its side, a page zoomed to 400%) scrolls as one instead of pinning the buttons over a sliver
  const short = block("@media (max-height: 420px)");
  assert.match(short, /\.tg \{\s*overflow-y: auto;/);
  assert.match(short, /\.tg-scroll \{[^}]*overflow: visible;/);
  // phones: a full-screen sheet, button text no smaller than the site's own (13 px)
  const phone = block("@media (max-width: 600px)");
  assert.match(phone, /height: 100dvh;/);
  for (const m of phone.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)) assert.ok(Number(m[1]) >= 13, `${m[0]} on phones`);
  // every row is a large target; motion off when people ask for less
  assert.match(block(".tg-check {"), /min-height: 44px;/);
  assert.match(block("@media (prefers-reduced-motion: reduce)"), /animation: none;/);
});

// ─── 3. the Terms text ───

const current = TERMS_ARCHIVE.find((v) => v.version === TERMS_VERSION);

test("the Terms in force are archived word for word, with their fingerprint", () => {
  assert.ok(current, `src/legal/archive.ts has no row for version ${TERMS_VERSION}`);
  // the text as the site shows it with the default settings: none set, and the legal contact support@visionswap.net
  const doc = termsDoc(DEFAULT_LEGAL_SETTINGS);
  const file = read(web, "public", current!.file);
  assert.equal(
    file,
    termsText(doc),
    `the Terms changed: decide the version in src/lib/terms.ts (a new major number when the change is material), then run "npm run terms:archive -w web"`,
  );
  assert.equal(termsHash(doc), current!.sha256);
  // every archived version is there, unchanged, and none is listed twice
  assert.equal(new Set(TERMS_ARCHIVE.map((v) => v.version)).size, TERMS_ARCHIVE.length);
  for (const v of TERMS_ARCHIVE) {
    const bytes = readFileSync(join(web, "public", v.file));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), v.sha256, v.file);
    assert.doesNotMatch(bytes.toString("utf8"), /\r/, `${v.file} has CR line ends`);
  }
  assert.equal(TERMS_ARCHIVE.at(-1)!.version, TERMS_VERSION, "the version in force is the newest");
  // the versions already published keep their words: 2.0 sent legal notices to X, 2.1 to support@visionswap.net
  assert.equal(TERMS_ARCHIVE.find((v) => v.version === "2.0")?.sha256, "d596cdccb35692cc297ef209a74c749e0ee6cafca823b6ff0aa2f143eb376fd9");
  assert.match(read(web, "public", "legal", "terms-2.0.txt"), /screening reviews: @VisionSwapSol on X\./);
  assert.match(read(web, "public", current!.file), /reports of stolen funds and screening reviews: support@visionswap\.net\./);
});

test("Terms 2.1 bake in the default contact without asking anyone who accepted 2.0 to accept again", () => {
  // a minor version: the same major number as 2.0
  assert.equal(TERMS_VERSION, "2.1");
  assert.equal(majorOf(TERMS_VERSION), 2);
  // someone who accepted 2.0 while nothing was set (the settings' fingerprint was "" then)
  const kv = memoryKV();
  const v20 = TERMS_ARCHIVE.find((v) => v.version === "2.0")!;
  kv.data.set(TERMS_KEY, JSON.stringify({ v: "2.0", rev: "", hash: v20.sha256, at: "2026-10-15T10:00:00.000Z", acks: [...TERMS_ACKS], surface: "web" }));
  const s = new TermsStore(() => kv);
  // what the server publishes now by default: the legal contact support@visionswap.net, nothing else set
  const live = parseLegalInfo({ contact: "mailto:support@visionswap.net", business: "mailto:business@visionswap.net", legal: { ...NO_LEGAL_SETTINGS, contact: "mailto:support@visionswap.net" } });
  assert.equal(legalRev(live.legal), "", "the contact alone (arbitration off) leaves the fingerprint empty");
  s.setLiveRev(legalRev(live.legal));
  assert.equal(s.status(), "current");
  // and the text shown with those settings, and before the server answers, is the archived 2.1 text: one fingerprint from now on
  assert.equal(termsHash(termsDoc(live.legal)), current!.sha256);
  assert.equal(termsHash(termsDoc(DEFAULT_LEGAL_INFO.legal)), current!.sha256);
  assert.equal(termsHash(termsDoc(parseLegalInfo(null).legal)), current!.sha256, "a server that can't be asked shows the same text");
  // the owner naming the same address leaves everything as it is
  assert.deepEqual(parseLegalInfo({ contact: "support@visionswap.net", legal: { contact: "support@visionswap.net" } }).legal, { ...DEFAULT_LEGAL_SETTINGS, contact: "support@visionswap.net" });
  assert.equal(termsHash(termsDoc({ ...DEFAULT_LEGAL_SETTINGS, contact: "support@visionswap.net" })), current!.sha256);
});

test("the plain text keeps every word of the page and drops only link markup", () => {
  assert.equal(plain("See the [Docs](/docs#fees) and [X](https://x.com/a)."), "See the Docs and X.");
  const text = termsText(termsDoc(NO_LEGAL_SETTINGS));
  assert.doesNotMatch(text, /\]\(|\[[^\]]*\]\(/);
  assert.match(text, /^VisionSwap Terms of Use\n\nVersion \d+\.\d+, effective [A-Z][a-z]+ \d{1,2}, \d{4}\n/);
  assert.ok(text.endsWith("\n") && !text.endsWith("\n\n"));
});

const CONFIGURED: LegalSettings = {
  entity: "Example Labs Ltd",
  address: "1 Example Street, London",
  registration: "company number 12345678",
  governingLaw: "the laws of England and Wales",
  forum: "England and Wales",
  arbitration: { provider: "Example Arbitration Association", rules: "its Consumer Rules", seat: "London", optOutDays: 30 },
  contact: "mailto:legal@example.org",
};

test("who we are, the law, the courts and arbitration appear only once set; the legal contact is support@visionswap.net unless the owner names another", () => {
  const plainText = termsText(termsDoc(DEFAULT_LEGAL_SETTINGS));
  assert.match(plainText, /between you and the operator of VisionSwap/);
  for (const clause of ["Governing law.", "Courts.", "Agreement to arbitrate.", "Opting out of arbitration."]) {
    assert.ok(!plainText.includes(clause), `"${clause}" shows with nothing set`);
  }
  assert.match(plainText, /law-enforcement requests, reports of stolen funds and screening reviews: support@visionswap\.net\./);
  assert.doesNotMatch(plainText, /screening reviews: @VisionSwapSol/);
  // with the contact turned off, legal notices go to the official X account
  assert.match(termsText(termsDoc(NO_LEGAL_SETTINGS)), /screening reviews: @VisionSwapSol on X\./);
  // the link in the page is a mailto: link
  assert.ok(JSON.stringify(termsDoc(DEFAULT_LEGAL_SETTINGS)).includes("[support@visionswap.net](mailto:support@visionswap.net)"));

  const set = termsText(termsDoc(CONFIGURED));
  assert.match(set, /between you and Example Labs Ltd, company number 12345678, whose registered address is 1 Example Street, London/);
  assert.match(set, /are governed by the laws of England and Wales\. If you are a consumer/);
  assert.match(set, /the courts of England and Wales have exclusive jurisdiction/);
  assert.match(set, /administered by Example Arbitration Association under its Consumer Rules, with its seat in London/);
  assert.match(set, /within 30 days after you first accept a version of these Terms that includes it, by writing to legal@example\.org/);
  // a consumer's home-court right is kept where their own law gives it, not promised to everyone
  assert.match(set, /If you are a consumer and the law of the country where you live gives you the right/);
  // the people protected by 17.3 can rely on the disputes section too (a non-party can't invoke terms it isn't named in)
  assert.match(set, /get the same protection from sections 15 to 19 and section 21 as we do/);
  assert.match(set, /doesn't apply to you if you are a consumer living in the United Kingdom or the European Union/);
  // the clauses after the optional ones keep their place in the numbering
  assert.match(set, /21\.\d+ Individual claims only\./);

  // without a legal contact, no arbitration (an opt-out needs somewhere to go)
  const noContact = parseLegal({ arbitration: { provider: "X", optOutDays: 30 } });
  assert.equal(noContact.arbitration, null);
});

test("the legal settings' fingerprint: empty when nothing is set, changed by anything that changes the agreement", () => {
  assert.equal(legalRev(NO_LEGAL_SETTINGS), "");
  assert.equal(legalRev(DEFAULT_LEGAL_SETTINGS), "", "the default contact never asks anyone again by itself");
  const rev = legalRev(CONFIGURED);
  assert.match(rev, /^[0-9a-f]{16}$/);
  assert.notEqual(legalRev({ ...CONFIGURED, governingLaw: "the laws of Ireland" }), rev);
  // the contact alone doesn't count, unless arbitration is on
  assert.equal(legalRev({ ...NO_LEGAL_SETTINGS, contact: "mailto:a@b.org" }), "");
  assert.notEqual(legalRev({ ...CONFIGURED, contact: "mailto:other@example.org" }), rev);
});

test("settings are plain text: no markup gets into the Terms", () => {
  for (const bad of ["[x](https://evil)", "<script>", "**bold**", "`x`", "a".repeat(300), 7, null]) assert.equal(settingText(bad), null);
  assert.equal(settingText("  Example\nLabs  "), "Example Labs");
  assert.equal(contactHref("legal@example.org"), "mailto:legal@example.org");
  assert.equal(contactHref("javascript:alert(1)"), null);
  assert.deepEqual(parseLegal({ entity: "<b>x</b>", governingLaw: "the laws of Ireland" }), { ...NO_LEGAL_SETTINGS, governingLaw: "the laws of Ireland" });
});

test("every cross-reference in the Terms points at a clause or section that exists", () => {
  for (const s of [NO_LEGAL_SETTINGS, CONFIGURED]) {
    const doc = termsDoc(s);
    const clauses = new Set<string>();
    for (const sec of doc.sections) {
      for (const b of sec.blocks) if (b.k === "clauses") b.items.forEach((_, i) => clauses.add(`${sec.n}.${i + 1}`));
    }
    const text = termsText(doc);
    for (const m of text.matchAll(/(?:sections? |\(|in |cap in )(\d{1,2})\.(\d{1,2})\b/g)) {
      assert.ok(clauses.has(`${m[1]}.${m[2]}`), `the Terms refer to ${m[1]}.${m[2]}, which doesn't exist`);
    }
    for (const m of text.matchAll(/sections? (\d{1,2})(?![.\d])/g)) {
      assert.ok(doc.sections.some((x) => x.n === Number(m[1])), `the Terms refer to section ${m[1]}, which doesn't exist`);
    }
  }
  // the clauses the Terms name by number are the ones they mean
  const doc = termsDoc(NO_LEGAL_SETTINGS);
  const title = (ref: string) => {
    const [n, i] = ref.split(".").map(Number);
    const b = doc.sections.find((x) => x.n === n)!.blocks.find((x) => x.k === "clauses");
    return b && b.k === "clauses" ? b.items[i - 1]?.t : undefined;
  };
  assert.equal(title("2.2"), "Sanctions");
  assert.equal(title("4.5"), "No recovery");
  assert.equal(title("4.8"), "Records kept only on your device");
  assert.equal(title("5.2"), "Deposit limits");
  assert.equal(title("5.4"), "The waiting room");
  assert.equal(title("6.11"), "Orders");
  assert.equal(title("6.13"), "Paying from your wallet");
  assert.equal(title("6.14"), "Actions across several Vision wallets");
  assert.equal(title("8.1"), "Upgrades");
  assert.equal(title("8.2"), "Settings");
  assert.equal(title("8.4"), "Changes to the Services");
  assert.equal(title("17.3"), "Who this protects");
});

test("the Terms state the owner's decisions as they stand: the team's upgrade control, the deposit limits, the trusted setup", () => {
  const text = termsText(termsDoc(NO_LEGAL_SETTINGS));
  assert.match(text, /the Pool program is upgradeable, and the VisionSwap team holds the key that upgrades it/);
  assert.match(text, /300 SOL per deposit and 30,000 SOL for the whole Pool/);
  assert.match(text, /its second phase was completed by the VisionSwap team and sealed with a Bitcoin block beacon/);
  assert.match(text, /not yet\b|has not been independently audited/);
  assert.doesNotMatch(text, /Deposit limits may be high or absent/);
});
