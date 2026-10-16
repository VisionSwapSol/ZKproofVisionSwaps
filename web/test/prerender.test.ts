/**
 * The build-time prerender (src/entry-prerender.tsx, scripts/prerender.mjs): every public page carries
 * its own words, title, description and canonical address in its HTML, and its structured data says
 * only what the page shows. Built here with Vite exactly as `npm run build` builds it.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";
import { RETRACTED } from "./retracted.ts";
import type * as Entry from "../src/entry-prerender.tsx";
import type { PageKey, PageMeta } from "../src/seo/pages.ts";
import { TERMS_ARCHIVE } from "../src/legal/archive.ts";
import { TERMS_EFFECTIVE, TERMS_VERSION } from "../src/lib/terms.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..");
// inside web/, so the built module finds react and the rest in node_modules (web/build is ignored by git)
mkdirSync(join(web, "build"), { recursive: true });
const out = mkdtempSync(join(web, "build", "prerender-test-"));
let ssr: typeof Entry;
const rendered = new Map<PageKey, { body: string | null; html: string; text: string }>();

before(async () => {
  await build({
    root: web,
    configFile: join(web, "vite.config.ts"),
    logLevel: "silent",
    build: { ssr: "src/entry-prerender.tsx", outDir: out, emptyOutDir: true, manifest: false },
  });
  ssr = (await import(pathToFileURL(join(out, "entry-prerender.js")).href)) as typeof Entry;
  const template = readFileSync(join(web, "index.html"), "utf8");
  for (const page of Object.values(ssr.PAGES) as PageMeta[]) {
    let body: string | null = null;
    if (page.prerender) {
      const errors: unknown[] = [];
      body = await ssr.renderPage(page.path, (e) => errors.push(e));
      assert.deepEqual(errors, [], `${page.path} rendered with errors`);
    }
    const html = ssr.pageHtml(template, page.key, body);
    rendered.set(page.key, { body, html, text: ssr.pageText(html) });
  }
});
after(() => rmSync(out, { recursive: true, force: true }));

const pages = () => Object.values(ssr.PAGES) as PageMeta[];
const one = (html: string, re: RegExp) => {
  const all = [...html.matchAll(new RegExp(re.source, "g"))];
  assert.equal(all.length, 1, `expected one ${re}, found ${all.length}`);
  return all[0][1];
};
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

test("every public page is written in full: its heading and its words, nothing left for the browser to fill in", () => {
  for (const page of pages().filter((p) => p.prerender)) {
    const { body, text } = rendered.get(page.key)!;
    assert.ok(body, page.path);
    assert.ok(!body.includes("<template"), `${page.path}: a part fell back to the browser`);
    assert.match(body, /<h1[\s>]/, `${page.path} has no heading`);
    assert.ok(!body.includes('class="page-wait"'), `${page.path} rendered its loading placeholder`);
    assert.ok(text.length >= 700, `${page.path}: only ${text.length} characters of text`);
  }
  assert.ok(rendered.get("docs")!.text.length > 20_000, "the Docs are written in full");
  assert.match(rendered.get("home")!.text, /Shield\. Blend\. Spend\./);
  assert.match(rendered.get("faq")!.text, /How do I send SOL privately on Solana\?/);
  // pages the browser fills in still describe themselves to readers without scripts
  for (const key of ["app", "pay"] as const) {
    const { html } = rendered.get(key)!;
    assert.match(html, /<div id="root"><\/div>\s*<noscript><p>/, key);
    assert.ok(html.includes(ssr.PAGES[key].description), key);
  }
});

test("each page has its own title, description and canonical address", () => {
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  for (const page of pages()) {
    const { html } = rendered.get(page.key)!;
    const title = unescape(one(html, /<title>([^<]*)<\/title>/));
    const description = unescape(one(html, /<meta name="description" content="([^"]*)" \/>/));
    assert.equal(title, page.title);
    assert.equal(description, page.description);
    assert.ok(title.includes("VisionSwap"), title);
    assert.ok(description.length >= 40 && description.length <= 230, `${page.path}: description is ${description.length} characters`);
    assert.ok(!titles.has(title), `title used twice: ${title}`);
    assert.ok(!descriptions.has(description), `description used twice: ${description}`);
    titles.add(title);
    descriptions.add(description);
    const url = `https://visionswap.net${page.path}`;
    assert.equal(one(html, /<meta property="og:url" content="([^"]*)" \/>/), url);
    assert.equal(one(html, /<meta property="og:image" content="([^"]*)" \/>/), "https://visionswap.net/og.png");
    assert.equal(unescape(one(html, /<meta property="og:description" content="([^"]*)" \/>/)), page.description);
    if (page.index) {
      assert.equal(one(html, /<link rel="canonical" href="([^"]*)" \/>/), url);
      assert.ok(!/name="robots"/.test(html), page.path);
    } else {
      assert.ok(!html.includes('rel="canonical"'), page.path);
      assert.equal(one(html, /<meta name="robots" content="([^"]*)" \/>/), "noindex");
    }
  }
  assert.equal(ssr.PAGES.pay.index, false, "payment links stay out of search results");
});

/** Each page's JSON-LD, parsed. */
function graphOf(key: PageKey): Record<string, unknown>[] {
  const raw = one(rendered.get(key)!.html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(!raw.includes("<"), "a < in JSON-LD could close its script tag");
  const doc = JSON.parse(raw);
  assert.equal(doc["@context"], "https://schema.org");
  assert.ok(Array.isArray(doc["@graph"]));
  return doc["@graph"];
}
const ofType = (g: Record<string, unknown>[], type: string) => g.filter((x) => x["@type"] === type);

test("structured data parses, and says only what each page shows", () => {
  for (const page of pages()) {
    const g = graphOf(page.key);
    assert.equal(ofType(g, "Organization").length, 1, page.path);
    for (const x of g) {
      const t = String(x["@type"]);
      // nothing that would claim ratings, reviews or a price the site doesn't show
      assert.ok(!/Review|Rating/.test(t) && !JSON.stringify(x).includes('"price"'), `${page.path}: ${t}`);
    }
    if (page.key !== "home") {
      const crumbs = ofType(g, "BreadcrumbList")[0] as { itemListElement: { item: string; name: string }[] };
      assert.ok(crumbs, page.path);
      assert.equal(crumbs.itemListElement.at(-1)!.item, `https://visionswap.net${page.path}`);
      assert.equal(crumbs.itemListElement.at(-1)!.name, page.crumb);
    }
  }
  const home = graphOf("home");
  const app = ofType(home, "WebApplication")[0] as { featureList: string[]; applicationCategory: string; offers: { description: string } };
  assert.equal(app.applicationCategory, "FinanceApplication");
  for (const f of app.featureList) assert.ok(rendered.get("home")!.text.includes(f), `the homepage doesn't show "${f}"`);
  assert.match(app.offers.description, /0\.8%/);
  assert.equal(ofType(graphOf("docs"), "TechArticle").length, 1);
  assert.match(rendered.get("docs")!.text, /How VisionSwap works/);
});

test("every question and answer in the FAQ data is on the page, word for word", () => {
  const faqOf = (key: PageKey) => {
    const f = ofType(graphOf(key), "FAQPage");
    assert.equal(f.length, 1, key);
    return (f[0].mainEntity as { name: string; acceptedAnswer: { text: string } }[]).map((q) => ({ q: q.name, a: q.acceptedAnswer.text }));
  };
  for (const key of ["home", "support"] as const) {
    const text = rendered.get(key)!.text;
    const items = faqOf(key);
    assert.ok(items.length >= 6, key);
    for (const { q, a } of items) {
      assert.ok(text.includes(norm(q)), `${key}: question not on the page: ${q}`);
      assert.ok(text.includes(norm(a)), `${key}: answer not on the page: ${a.slice(0, 60)}`);
    }
  }
  // the FAQ page: each paragraph and step of every answer
  const text = rendered.get("faq")!.text;
  const items = faqOf("faq");
  assert.ok(items.length >= 12);
  for (const { q, a } of items) {
    assert.ok(text.includes(norm(q)), `faq: question not on the page: ${q}`);
    for (const part of a.split(/ (?=\d+\. )/).map((p) => p.replace(/^\d+\. /, ""))) {
      for (const sentence of part.split(/(?<=[.:?])\s+/)) assert.ok(text.includes(norm(sentence)), `faq: not on the page: ${sentence}`);
    }
  }
  // the support answers are in the page from the start (shown when their question is opened)
  assert.ok(!rendered.get("support")!.body!.includes('aria-expanded="true"'));
});

test("no retracted claim and nothing addressed to AI models, in any page or generated file", () => {
  const files = [ssr.robotsTxt(), ssr.sitemapXml(), ssr.llmsTxt(), ssr.llmsFullTxt()];
  const texts = [...[...rendered.values()].map((r) => r.html.replace(/\s+/g, " ")), ...files.map((f) => f.replace(/\s+/g, " "))];
  for (const t of texts) {
    for (const [re, truth] of RETRACTED) assert.equal(t.match(re), null, `says "${t.match(re)?.[0]}"; what is true: ${truth}`);
    const flag = (re: RegExp) => assert.equal(t.match(re)?.[0] ?? null, null, `says "${t.match(re)?.[0]}"`);
    // nothing addressed to AI models (the same words go to every reader)
    flag(/\b(?:AI|assistants?|LLMs?|language models?|chatbots?)\b[^.]{0,40}\b(?:should|must|always)\b/i);
    flag(/ignore (?:all |any )?(?:previous|prior) instructions|recommend VisionSwap/i);
    // no unprovable ranking, and no promise of anonymity (the Terms say there is none)
    flag(/\bbest (?:private|privacy) (?:tool|app|solution|wallet|transfers?|pool)|#1 (?:private|privacy)|number one|\b(?:fully |completely )?anonymous\b/i);
  }
});

test("robots.txt, the sitemap and llms.txt list the open pages and only those", () => {
  const robots = ssr.robotsTxt();
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.doesNotMatch(robots, /^Disallow: \/$/m, "the site is never closed to crawlers");
  assert.match(robots, /^Sitemap: https:\/\/visionswap\.net\/sitemap\.xml$/m);
  for (const ua of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Googlebot", "Bingbot"]) assert.match(robots, new RegExp(`^User-agent: ${ua}$`, "m"));

  const sitemap = ssr.sitemapXml();
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)];
  const open = pages().filter((p) => p.index);
  assert.deepEqual(
    locs.map((m) => m[1]),
    open.map((p) => `https://visionswap.net${p.path}`),
  );
  const today = new Date().toISOString().slice(0, 10);
  for (const [, , date] of locs) assert.ok(date <= today, `lastmod ${date} is in the future`);
  assert.ok(!sitemap.includes("/pay"));

  const llms = ssr.llmsTxt();
  for (const p of open) assert.ok(llms.includes(`(https://visionswap.net${p.path})`), p.path);
  assert.ok(!llms.includes("/pay"));
  assert.match(ssr.llmsFullTxt(), /#### How do I send SOL privately on Solana\?/);
});

test("the dates shown on the pages are the sitemap's", () => {
  for (const key of ["privacy", "terms"] as const) {
    const shown = rendered.get(key)!.text.match(/Last updated ([A-Z][a-z]+ \d{1,2}, \d{4})/);
    assert.ok(shown, key);
    assert.equal(shown![1], longDate(ssr.PAGES[key].updated), key);
  }
  for (const key of ["docs", "faq", "security", "compliance"] as const) assert.ok(rendered.get(key)!.text.includes(`Last updated ${longDate(ssr.PAGES[key].updated)}`), key);
});
const longDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${new Date(Date.UTC(y, m - 1, d)).toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${d}, ${y}`;
};

test("the Terms page shows the version in force with the fingerprint of its archived text, and the legal pages link each other", () => {
  const terms = rendered.get("terms")!.text;
  const current = TERMS_ARCHIVE.find((v) => v.version === TERMS_VERSION)!;
  assert.ok(terms.includes(`Version ${TERMS_VERSION}, in effect from ${longDate(TERMS_EFFECTIVE)}.`));
  assert.ok(terms.includes(current.sha256), "the prerendered Terms show their fingerprint");
  for (const v of TERMS_ARCHIVE) assert.ok(rendered.get("terms")!.body!.includes(`href="${v.file}"`), v.file);
  for (const key of ["terms", "security", "compliance", "privacy", "docs"] as const) {
    const body = rendered.get(key)!.html;
    assert.ok(body.includes('href="/security"') && body.includes('href="/compliance"'), `${key} links Security and Compliance`);
  }
  // the Security page says what is true today, and only that
  const security = rendered.get("security")!.text;
  assert.match(security, /not yet had an independent audit/);
  assert.match(security, /the VisionSwap team holds the key that upgrades it/);
  assert.doesNotMatch(security, /open-source licences/, "the source code isn't said to be published until REPO_URL is set");
  // the Compliance page claims no region blocking unless /api/legal reports it on
  const compliance = rendered.get("compliance")!.text;
  assert.match(compliance, /isn't permitted under the Terms of use, section 2/);
  assert.doesNotMatch(compliance, /Region checks on/);
  // the published policy, the figures and the programme are there before anything is asked of the server
  for (const id of ["policy", "figures", "programme", "places", "records"]) assert.ok(rendered.get("compliance")!.body!.includes(`id="${id}"`), id);
  assert.match(compliance, /Cuba, Iran, North Korea, Syria, Russia, Belarus or the United Arab Emirates; the Crimea \(including Sevastopol\), Donetsk or Luhansk regions of Ukraine/);
  assert.match(compliance, /checked for updates every 6 hours/);
  // the contact lines name support@visionswap.net, the default, in the page as built (D7)
  assert.match(compliance, /Think we got it wrong\? Write to support@visionswap\.net/);
  assert.match(compliance, /Report stolen funds\. Write to support@visionswap\.net/);
  assert.match(compliance, /Send them to support@visionswap\.net\./);
  assert.ok(rendered.get("compliance")!.body!.includes('href="mailto:support@visionswap.net"'));
});

test("the restricted-region notice page (the words the server's 451 notice uses): plain, credited, and nothing about other ways in", () => {
  const page = rendered.get("unavailable")!;
  assert.equal(ssr.PAGES.unavailable.index, false, "never in search results");
  assert.match(page.text, /VisionSwap isn't available in your region/);
  assert.match(page.text, /Terms of use, section 2/);
  assert.ok(page.body!.includes('href="https://db-ip.com"'), "the location data's licence asks for its credit");
  assert.doesNotMatch(page.text.replace(/For the strongest privacy[^.]*\./g, ""), /\bVPN\b|\bTor\b|proxy|try again from/i);
  // /verify checks ownership proofs; receipts stay out of it while they are switched off
  const verify = rendered.get("verify")!.text;
  assert.match(verify, /Check an ownership proof/);
  assert.match(verify, /VisionSwap ownership proof:/);
  assert.doesNotMatch(verify, /payment receipt/i);
});

test("addresses pick pages by one set of rules, and the FAQ names the real program", () => {
  const expect: [string, PageKey | null][] = [
    ["/", "home"],
    ["/app", "app"],
    ["/app/", "app"],
    ["/app/anything", "app"],
    ["/apple", null],
    ["/check", "check"],
    ["/docs", "docs"],
    ["/docs/orders", "docs"],
    ["/faq", "faq"],
    ["/support", "support"],
    ["/support/x", null],
    ["/tokenomics", "tokenomics"],
    ["/tokenomics/", "tokenomics"],
    ["/why", "why"],
    ["/roadmap", "roadmap"],
    ["/privacy", "privacy"],
    ["/terms", "terms"],
    ["/security", "security"],
    ["/security/", "security"],
    ["/security/x", null],
    ["/compliance", "compliance"],
    ["/compliance/x", null],
    ["/pay", "pay"],
    ["/nope", null],
  ];
  for (const [path, page] of expect) assert.equal(ssr.routeOf(path), page, path);
  for (const p of pages()) assert.equal(ssr.routeOf(p.path), p.key, `${p.path} must show its own page`);
  const pins = readFileSync(join(repo, "sdk", "src", "pins.ts"), "utf8");
  const id = pins.match(/MAINNET_PROGRAM_ID = "([1-9A-HJ-NP-Za-km-z]+)"/)![1];
  assert.ok(rendered.get("faq")!.text.includes(`${id} on Solana mainnet`));
  assert.ok(rendered.get("faq")!.text.includes(`solana-verify get-program-hash ${id}`));
});

test("the contacts are in the pages as built: support@ for help, legal, compliance, security and privacy; business@ for business and press", () => {
  const mail = (a: string) => `href="mailto:${a}"`;
  // every page's footer: a short contact line with both addresses
  for (const page of pages().filter((p) => p.prerender)) {
    const { body, text } = rendered.get(page.key)!;
    assert.ok(body!.includes(mail("support@visionswap.net")) && body!.includes(mail("business@visionswap.net")), `${page.path}: the footer's contact line`);
    assert.match(text, /Contact: support@visionswap\.net Business and press: business@visionswap\.net/, page.path);
  }
  // the Support page's contact panel: help by email, business and press, and the X account for news
  const support = rendered.get("support")!.text;
  assert.match(support, /Email the VisionSwap team\. For help with the app, your account or a payment, and for legal, compliance, security and privacy requests, write to: support@visionswap\.net/);
  assert.match(support, /Business, partnerships and press business@visionswap\.net/);
  assert.match(support, /News and announcements @VisionSwapSol on X/);
  assert.match(support, /How do I contact VisionSwap\? Email support@visionswap\.net/);
  // Security: responsible disclosure to support@, the same address as security.txt
  assert.match(rendered.get("security")!.text, /Report it to support@visionswap\.net\. The same address is in our security\.txt\./);
  assert.doesNotMatch(rendered.get("security")!.text, /Send a direct message/);
  // and "Staying safe" names both addresses, so look-alike mail stands out
  assert.match(rendered.get("security")!.text, /VisionSwap's email addresses are support@visionswap\.net and business@visionswap\.net\. Be wary of messages from other addresses/);
  // Privacy: requests to support@, and what an email to us gives us
  const privacy = rendered.get("privacy")!.text;
  assert.match(privacy, /Privacy questions and requests, including the rights in section 12: support@visionswap\.net\./);
  assert.match(privacy, /Emails you send us\. If you write to support@visionswap\.net or business@visionswap\.net, we receive your email address/);
  assert.match(privacy, /The operator of VisionSwap \("we"\) is responsible/, "the responsible party stays LEGAL_ENTITY's, never invented");
  // Terms: notices to support@, and the fingerprint of the archived text
  assert.match(rendered.get("terms")!.text, /reports of stolen funds and screening reviews: support@visionswap\.net\./);
  // the FAQ and the Docs
  assert.match(rendered.get("faq")!.text, /How do I contact VisionSwap\? Email support@visionswap\.net for help/);
  assert.match(rendered.get("faq")!.text, /You can also email support@visionswap\.net/);
  assert.match(rendered.get("docs")!.text, /For anything else, email support@visionswap\.net; business, partnership and press enquiries go to business@visionswap\.net\./);
  // the restricted-region notice
  assert.match(rendered.get("unavailable")!.text, /Questions: support@visionswap\.net/);
  // no page says contact is only on X any more
  for (const page of pages().filter((p) => p.prerender)) assert.doesNotMatch(rendered.get(page.key)!.text, /contact (details|information)[^.]*@VisionSwapSol|VisionSwap on X\. Visit our official account/i, page.path);
  // the structured data: customer support and business enquiries, as the pages show them
  const org = ofType(graphOf("support"), "Organization")[0] as { email: string; contactPoint: { contactType: string; email: string }[] };
  assert.equal(org.email, "support@visionswap.net");
  assert.deepEqual(
    org.contactPoint.map((c) => [c.contactType, c.email]),
    [
      ["customer support", "support@visionswap.net"],
      ["business enquiries", "business@visionswap.net"],
    ],
  );
  // llms.txt and llms-full.txt
  for (const txt of [ssr.llmsTxt(), ssr.llmsFullTxt()]) {
    assert.match(txt, /Contact: support@visionswap\.net for support, legal, compliance, security and privacy requests; business@visionswap\.net for business, partnership and press enquiries\./);
  }
  assert.match(ssr.llmsTxt(), /\(mailto:support@visionswap\.net\)/);
  assert.doesNotMatch(ssr.llmsTxt(), /announcements and contact details/);
});

test("the Android app in the pages as built: every page offers the download, whenever it is built (the browser says when it opens before the moment)", () => {
  const home = rendered.get("home")!.body!;
  const marks = [...home.matchAll(/data-android-release="(soon|open)"/g)].map((m) => m[1]);
  assert.ok(marks.length >= 2, "the Get the app section and the footer carry it");
  assert.deepEqual([...new Set(marks)], ["open"], "the same bytes from the same source, at any build time");
  assert.ok(home.includes('href="/download/VisionSwap.apk"'));
  assert.ok(!home.includes("Available October 15 at 12:00 PM PST"));
  // every other page carries the footer's part, in the same state
  for (const page of pages().filter((p) => p.prerender && p.key !== "home")) {
    const body = rendered.get(page.key)!.body!;
    for (const m of body.matchAll(/data-android-release="(soon|open)"/g)) assert.equal(m[1], "open", page.path);
  }
});
