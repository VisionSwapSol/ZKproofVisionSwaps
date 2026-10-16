/**
 * Extension 1.1.0 (compliance spec, section 2): the screens a store release brings to the panel. The
 * server's refusals already reach 1.0.1; this release shows them properly: the restricted-region
 * screen before anything else (the Terms window included), the Terms window before every way into an
 * account, and the website's own panels (the statement's limits and viewing-key confirmation, "Prove I
 * control an address", the recipient checks), built from the same code.
 *
 * Extension 1.1.1: the same panel with the website's contacts. The Terms window shows Terms 2.1 (legal
 * notices to support@visionswap.net), and the restricted-region screen and the listed-wallet card name
 * support@visionswap.net too, before /api/legal answers and after (unless the operator turns it off).
 * The panel's links add "Support and contact", the Support page's contact panel.
 *
 * Extension 1.2.0: the panel redesigned (one total on Home, five tabs, compact Wallets rows with a
 * selection bar that takes the navigation's place, sheets, Activity by day, "Hide amounts"). The same
 * permissions, and the screens and links pinned below keep their place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error: a plain .mjs build helper, checked here by what it returns
import { manifest } from "../scripts/manifest.mjs";

const ext = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(ext, ...p), "utf8");

test("the release is 1.2.0, and its manifest asks for nothing more than before", () => {
  const { version } = JSON.parse(read("package.json"));
  assert.equal(version, "1.2.0");
  const m = manifest({ version });
  assert.equal(m.version, "1.2.0");
  assert.deepEqual(m.permissions, ["sidePanel", "storage"], "no new permission (no location, nothing else)");
  assert.deepEqual(m.host_permissions, ["https://visionswap.net/*"]);
});

test("the restricted-region screen comes first in the panel, before the Terms window and every way in", () => {
  const panel = read("src", "Panel.tsx");
  assert.match(panel, /import \{ Restricted, useRegion \} from "\.\.\/\.\.\/web\/src\/components\/Restricted";/);
  const at = panel.indexOf("{regionInfo.restricted ? (");
  assert.ok(at > 0);
  assert.ok(at < panel.indexOf("<Unlocked "), "before the open account");
  assert.ok(at < panel.indexOf("<Locked "), "before the ways in, and so before the Terms window");
  // and the Terms window still comes before every way into an account
  assert.match(panel, /if \(termsStatus !== "current"\) \{[\s\S]{0,600}<TermsGate /);
});

test("the panel shows the website's own records and recipient checks, so the new copy and checks ship with it", () => {
  const unlocked = read("src", "Unlocked.tsx");
  assert.match(unlocked, /import \{[^}]*\bRecords\b[^}]*\} from "\.\.\/\.\.\/web\/src\/components\/app\/Panels";/);
  assert.match(unlocked, /<Records st=\{st\} \/>/);
  const records = readFileSync(join(ext, "..", "web", "src", "components", "app", "Panels.tsx"), "utf8");
  assert.match(records, /<ProveControl st=\{st\} \/>/);
  assert.match(records, /setAskKey\(true\)/);
  // the website's region screen never mentions VPNs, in the extension either
  const restricted = readFileSync(join(ext, "..", "web", "src", "components", "Restricted.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(restricted, /VPN/);
});

test("the extension build keeps receipts off unless the release is built with them on", () => {
  const build = read("scripts", "build.mjs");
  assert.match(build, /define\.__VS_RECEIPTS__ = JSON\.stringify\(process\.env\.VITE_RECEIPTS === "1"\);/);
});

test("1.1.1: the panel's Terms window, region screen and listed-wallet card show the website's default contact", () => {
  const web = (...p: string[]) => readFileSync(join(ext, "..", "web", "src", ...p), "utf8");
  // the Terms window builds the Terms from the default settings until /api/legal answers: the archived 2.1 text
  assert.match(web("components", "TermsGate.tsx"), /const settings = shownLegal\(info\)\.legal;/);
  assert.match(web("lib", "terms.ts"), /export const TERMS_VERSION = "2\.1";/);
  assert.match(web("components", "Restricted.tsx"), /const legal = shownLegal\(useLegal\(\)\);/);
  assert.match(web("components", "app", "Listed.tsx"), /const raw = shownLegal\(useLegal\(\)\)\.contact;/);
  assert.match(web("lib", "contacts.ts"), /export const SUPPORT_EMAIL = "support@visionswap\.net";/);
  // the panel's own links lead to the Support page's contact panel, beside the Docs, the Terms and the Privacy policy
  assert.match(read("src", "Unlocked.tsx"), /openSite\("\/support#contact"\)\}>\s*<Glyph name="out" size=\{18\} \/> Support and contact/);
  // a mailto: link needs no new permission: the manifest above is unchanged
});
