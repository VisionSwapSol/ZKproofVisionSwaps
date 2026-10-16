/**
 * Public claims stay true to the code.
 *
 * 1. Wording listed in retracted.ts never appears in the site's pages,
 *    the repo's guides or the code comments that describe guarantees.
 * 2. Every "kept for" figure in the privacy policy matches the server constant it describes, so a
 *    change of retention on the server fails here until the policy says the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RETRACTED } from "./retracted.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const repo = join(web, "..");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
/** The checks against the VisionSwap service's own source run where that source is present. */
const NO_SERVICE_SOURCE = !existsSync(join(repo, "server", "src")) && "the VisionSwap service's source is not part of this repository";
const tsxIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e): string[] => (e.isDirectory() ? tsxIn(join(dir, e.name)) : e.name.endsWith(".tsx") ? [join(dir, e.name)] : []));

/** The user-facing text and guarantee-describing comments this check covers. */
const SOURCES = [
  join(web, "index.html"),
  ...tsxIn(join(web, "src", "pages")),
  ...tsxIn(join(web, "src", "components")),
  join(web, "src", "lib", "support-faq.ts"),
  join(web, "src", "lib", "faq.ts"),
  join(web, "src", "lib", "landing-faq.ts"),
  join(web, "src", "lib", "terms.ts"),
  join(web, "src", "legal", "terms-doc.ts"),
  join(web, "src", "legal", "archive.ts"),
  join(web, "src", "seo", "pages.ts"),
  join(web, "src", "seo", "jsonld.ts"),
  join(web, "src", "seo", "files.ts"),
  join(web, "src", "seo", "html.ts"),
  join(repo, "README.md"),
  join(repo, "program", "programs", "vision_pool", "src", "lib.rs"),
  join(repo, "circuits", "scripts", "setup.mjs"),
  join(repo, "sdk", "src", "delivery.ts"),
];

test("retracted security and privacy claims stay out of the site, the guides and the comments", () => {
  for (const file of SOURCES) {
    // one line, so a claim wrapped across lines of JSX or a comment is still found
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const [re, truth] of RETRACTED) {
      const m = text.match(re);
      assert.equal(m, null, `${file.slice(repo.length + 1)} says "${m?.[0]}"; what is true: ${truth}`);
    }
  }
});

test("'no setting can move' the pool's funds is only ever said next to the upgrade caveat", () => {
  // the site's pages, components, FAQ data and the Terms (the repo's guides describe the upgrade authority on their own)
  const site = SOURCES.filter((f) => f.startsWith(web));
  let found = 0;
  for (const file of site) {
    const text = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const m of text.matchAll(/no (?:admin )?setting (?:can|lets(?: \w+)?(?:, including us,)?) (?:move|hand)/gi)) {
      found++;
      const near = text.slice(m.index!, m.index! + 400);
      assert.match(near, /upgrad|section 8\b|section 8\./i, `${file.slice(repo.length + 1)} says "${m[0]}" without the upgrade caveat`);
    }
  }
  assert.ok(found >= 5, "the claim is still made where it was");
});

test("the compliance copy says what the screening is, never that it makes anything compliant", () => {
  const compliance = read(web, "src", "pages", "CompliancePage.tsx").replace(/\s+/g, " ");
  // D1: the official list and our own; no commercial risk service is described while none is used
  assert.doesNotMatch(compliance, /risk service|risk feed|risk score/i);
  assert.match(compliance, /Payments made with other software can skip the checks our app and server make\./);
  // P0-4: holds are what our app and servers do, not something the program enforces
  assert.doesNotMatch(compliance, /held in the waiting room until it can join/i);
  assert.match(compliance, /our app and servers won't add it to the pool/);
  const terms = read(web, "src", "legal", "terms-doc.ts").replace(/\s+/g, " ");
  assert.doesNotMatch(terms, /hold it in the waiting room until it can join the Pool/);
});

test("the docs put the waiting room in time only from a measured slot time", () => {
  const docs = read(web, "src", "pages", "DocsPage.tsx");
  assert.doesNotMatch(docs, /\*\s*0\.4\b/, "DocsPage converts slots at a fixed 0.4 s");
  assert.match(docs, /slotsToText\(/);
});

/** Evaluates `const NAME = a * b * ...;` from a source file, following other constants of the same file. */
function constOf(src: string, name: string, seen = new Set<string>()): number {
  if (seen.has(name)) throw new Error(`circular constant ${name}`);
  seen.add(name);
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`constant ${name} not found`);
  return m[1].split("*").reduce((acc, part) => {
    const t = part.trim().replace(/_/g, "");
    const v = /^\d+(\.\d+)?$/.test(t) ? Number(t) : constOf(src, t, seen);
    return acc * v;
  }, 1);
}

/** The "kept" text of each row of the privacy policy's lists. */
function keptByRow(): Map<string, string> {
  const page = read(web, "src", "pages", "PrivacyPage.tsx");
  const rows = new Map<string, string>();
  for (const m of page.matchAll(/<Row name="([^"]+)" kept="([^"]+)">/g)) rows.set(m[1], m[2]);
  return rows;
}

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const MINUTE = 60_000;
const n = (x: number) => x.toLocaleString("en-US");

test("the privacy policy's retention figures match the server's constants", { skip: NO_SERVICE_SOURCE }, () => {
  const rows = keptByRow();
  const kept = (row: string) => {
    const k = rows.get(row);
    assert.ok(k, `the privacy policy has no "${row}" row`);
    return k!;
  };
  const server = (f: string) => read(repo, "server", "src", f);

  const hops = server("hops.ts");
  // HOP_SEEN_DAYS can only shorten it: the policy gives its default, which is also its most
  const seenDays = server("config.ts").match(/hopSeenDays: Math\.min\((\d+), Math\.max\((\d+), posInt\(env\("HOP_SEEN_DAYS"\), (\d+)\)\)\)/);
  assert.ok(seenDays, "config.ts no longer bounds HOP_SEEN_DAYS the way the policy describes");
  assert.equal(seenDays![1], seenDays![3], "HOP_SEEN_DAYS' default is no longer its most");
  assert.match(hops, /KEEP_SEEN_MS = config\.hopSeenDays \* 24 \* 3600_000;/);
  assert.match(kept("Sending addresses"), new RegExp(`^Up to ${seenDays![1]} days\\b`));
  assert.match(kept("Sending addresses"), new RegExp(`\\bmore than ${n(constOf(hops, "MAX_SEEN"))} are kept\\b`));
  assert.match(kept("Deliveries"), new RegExp(`\\b${constOf(hops, "KEEP_DONE_MS") / DAY} days after\\b`));
  assert.match(kept("Deliveries"), new RegExp(`\\bup to ${constOf(hops, "KEEP_WAITING_MS") / DAY} days\\b`));

  const schedule = server("schedule.ts");
  assert.match(kept("Scheduled payments"), new RegExp(`\\boutcome for ${constOf(schedule, "KEEP_DONE_MS") / DAY} days\\b`));
  assert.match(kept("Scheduled payments"), new RegExp(`\\(${constOf(schedule, "KEEP_STALE_MS") / DAY} days for one waiting`));
  // the per-note scheduling count: in memory, a day long
  const noteWindow = schedule.match(/noteUses\.set\([^;]*now - (\d+) \* 3600_000/);
  assert.ok(noteWindow, "schedule.ts no longer counts a note's schedulings the way the policy describes");
  assert.equal(Number(noteWindow![1]), 24);
  assert.match(kept("Fair-use counters"), /after a day, for the counts kept by a note's spend IDs or a depositing address/);
  // the proof checker's per-note counts (VS-19): checks in the last hour, and "checked before" for a day
  const zk = server("zkverify.ts");
  assert.match(zk, /const hourAgo = now - 3600_000;/);
  assert.match(zk, /seenMs: 24 \* 3600_000,/);

  const keeper = server("keeper.ts");
  assert.match(kept("Orders"), new RegExp(`\\bkept for ${constOf(keeper, "KEEP_DONE_MS") / DAY} days\\b`));
  assert.match(kept("Orders"), new RegExp(`\\bdropped after ${constOf(keeper, "PENDING_TTL") / MINUTE} minutes\\b`));

  const screening = server("screening.ts");
  assert.match(kept("Screening"), new RegExp(`\\bup to ${constOf(screening, "VENDOR_TTL") / HOUR} hour\\b`));
  const guard = server("guard.ts");
  const funders = guard.match(/funderCache\.size > (\d+)\)/);
  assert.ok(funders, "guard.ts no longer caps its funder cache the way the policy describes");
  assert.match(kept("Screening"), new RegExp(`\\blatest ${n(Number(funders![1]))} addresses\\b`));
  // free take-backs, counted per depositing address for a day (VS-17)
  assert.match(guard, /function takebackAllowed\([^{]*\{\s+const day = now - 24 \* 3600_000;/);

  const exposure = server("exposure.ts");
  const reuse = exposure.match(/hit\.at < (\d+) \* 60_000/);
  const cap = exposure.match(/cache\.size > (\d+)\)/);
  assert.ok(reuse && cap, "exposure.ts no longer caches results the way the policy describes");
  assert.match(kept("Exposure checks"), new RegExp(`\\breused for ${reuse![1]} minutes\\b`));
  assert.match(kept("Exposure checks"), new RegExp(`\\bonce ${cap![1]} newer checks\\b`));

  // set-aside records: deleted once they have been kept aside for KEEP_ASIDE_MS, checked daily (VS-22)
  const durable = server("durable.ts");
  assert.match(kept("Records we can't open"), new RegExp(`\\bfor ${constOf(durable, "KEEP_ASIDE_MS") / DAY} days, then deleted\\b`));
  assert.match(durable, /setInterval\(\(\) => void store\.purgeAside\(\), 24 \* 3600_000\)/);

  // the sanctions list refresh and the icon cache
  const policy = read(web, "src", "pages", "PrivacyPage.tsx");
  const every = screening.match(/setInterval\(\(\) => void refreshOfac\(\), (\d+) \* 3600_000\)/);
  assert.ok(every, "screening.ts no longer refreshes the sanctions list the way the policy describes");
  assert.match(policy, new RegExp(`every ${every![1]} hours`));
  const swap = server("swap.ts");
  assert.equal(constOf(swap, "ICON_TTL"), DAY);
  assert.match(kept("Token icon hosts"), /for a day/);
});

test("the privacy policy names the public RPC the server falls back to", { skip: NO_SERVICE_SOURCE }, () => {
  const config = read(repo, "server", "src", "config.ts");
  const fallback = config.match(/rpcFallbackUrl: env\("RPC_FALLBACK_URL", network === "mainnet" \? "https:\/\/([^"]+)"/);
  assert.ok(fallback, "config.ts no longer falls back to a public RPC the way the policy describes");
  assert.match(read(web, "src", "pages", "PrivacyPage.tsx"), new RegExp(fallback![1].replace(/\./g, "\\.")));
  // and the name service the Exposure check asks
  const exposure = read(repo, "server", "src", "exposure.ts");
  const sns = exposure.match(/https:\/\/([a-z0-9.-]+)\/favorite-domain/);
  assert.ok(sns);
  assert.match(read(web, "src", "pages", "PrivacyPage.tsx"), new RegExp(sns![1].replace(/\./g, "\\.")));
});
