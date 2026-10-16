#!/usr/bin/env node
// Checks a VisionSwap site against a release's build manifest: every file the website serves, the deployed
// program, and (if you give them) the Android app and the Chrome extension you downloaded. Read-only: it
// only downloads public files and reads public chain data. It needs Node.js 18 or later and nothing else,
// so you can copy this one file anywhere and run it.
//
//   node scripts/check-release.mjs                         the live site, against the manifest it publishes
//   node scripts/check-release.mjs --manifest <file|url>   against a manifest you got elsewhere (the release's
//                                                          own copy: the stronger check)
//   Options: --site <https://...> (default https://visionswap.net), --apk <VisionSwap.apk>,
//            --extension <the extension's zip, or its unpacked folder>, --rpc <url> (or VS_RPC_URL; default
//            Solana's public RPC), --skip-program, --strict, --json
//
// The hosting platform adds its analytics tag (a <script src="..."> from its own domain) just before </body>
// of every page it serves, so those pages are never byte for byte the release's. A page that differs only by
// that tag, served with a Content-Security-Policy that lets scripts load from the site itself only (so the
// tag never runs), counts as the release's page and is listed in a note; with --strict it counts as
// different. A page with any other added script, or any other change, always fails.
//
// Before the Android app's release moment (ANDROID_RELEASE_AT), the site answers 404 for the APK and
// /api/legal says when it opens: the check says so in a note, and compares the APK once it is served.
//
// The manifest's own SHA-256 is printed first: compare it with the one published with the release (the
// release notes in the source repository, and the pinned post). A site that serves a manifest whose hash
// isn't the published one, or files that don't match the manifest, doesn't run the published release.
// Exit codes: 0 everything matches, 1 something differs or is missing, 2 the check couldn't run.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_SCHEMA = "visionswap-release/1";
export const RELEASE_PATH = "/.well-known/visionswap-release.json";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/**
 * One SHA-256 for a whole set of files: of the lines "<sha256>  <path>\n" sorted by path (the format
 * `sha256sum` prints), so a list can be checked against it file by file too.
 */
export function listingHash(files) {
  const lines = Object.keys(files)
    .sort()
    .map((p) => `${files[p]}  ${p}\n`)
    .join("");
  return sha256(Buffer.from(lines, "utf8"));
}

/** Every file under `dir`, as "a/b.js" paths (forward slashes), skipping the folders `skip` names (relative). */
export function filesUnder(dir, skip = []) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      const rel = relative(dir, full).replace(/\\/g, "/");
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(dir);
  return out;
}

/** The SHA-256 of each file under `dir`, keyed by path. */
export function hashFolder(dir, skip = []) {
  return Object.fromEntries(filesUnder(dir, skip).map((p) => [p, sha256(readFileSync(join(dir, p)))]));
}

/** What doesn't hold together in a manifest (an empty list for a good one). */
export function manifestProblems(m) {
  const bad = [];
  if (!m || typeof m !== "object") return ["not a JSON object"];
  if (m.schema !== RELEASE_SCHEMA) bad.push(`schema is not ${RELEASE_SCHEMA}`);
  const files = m.web?.files;
  if (!files || typeof files !== "object") bad.push("web.files is missing");
  else {
    for (const [p, h] of Object.entries(files)) {
      if (!/^\/[^\s?#]*$/.test(p) || p.includes("..")) bad.push(`web path ${JSON.stringify(p).slice(0, 80)} is not a site path`);
      if (!/^[0-9a-f]{64}$/.test(String(h))) bad.push(`web hash for ${p.slice(0, 80)} is not a SHA-256`);
    }
    if (m.web.sha256 !== listingHash(files)) bad.push("web.sha256 doesn't match web.files");
  }
  if (m.extension?.files && m.extension.sha256 !== listingHash(m.extension.files)) bad.push("extension.sha256 doesn't match extension.files");
  return bad;
}

/** The program's code as the chain holds it, hashed like `solana-verify get-program-hash` (trailing zero bytes left out). */
export async function programHash(rpc, programId, fetchImpl = fetch) {
  const call = async (method, params) => {
    const r = await fetchImpl(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error).slice(0, 160)}`);
    return j.result;
  };
  const prog = await call("getAccountInfo", [programId, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const dataAddress = prog?.value?.data?.parsed?.info?.programData;
  if (!dataAddress) throw new Error("the program account isn't an upgradeable program");
  const pd = await call("getAccountInfo", [dataAddress, { encoding: "base64", commitment: "confirmed" }]);
  const data = Buffer.from(pd?.value?.data?.[0] ?? "", "base64");
  if (data.length < 45) throw new Error("the program's data account can't be read");
  let end = data.length;
  while (end > 45 && data[end - 1] === 0) end--;
  return sha256(data.subarray(45, end));
}

/**
 * When a page served differs from the release only by <script> tags just before </body> (a host may add
 * its own), what they load ("inline" for one without a src); otherwise null. Such a page is still not the
 * release's: the check fails either way, this only says why.
 */
export function addedScripts(body, want) {
  const html = Buffer.from(body).toString("utf8");
  const m = /((?:<script\b[^>]*>[^<]*<\/script>\s*)+)(<\/body>)/i.exec(html);
  if (!m) return null;
  const without = html.slice(0, m.index) + m[2] + html.slice(m.index + m[0].length);
  if (sha256(Buffer.from(without, "utf8")) !== want) return null;
  return [...m[1].matchAll(/<script\b([^>]*)>/gi)].map((s) => /\bsrc="([^"]{1,200})"/i.exec(s[1])?.[1] ?? "inline");
}

/** Scripts a host adds to every page it serves: the hosting platform's analytics tag. */
export const HOST_SCRIPTS = [/^https:\/\/i\.replit\.com\/script\.js$/];

/**
 * Whether a Content-Security-Policy lets scripts load from the site itself only (script-src, or
 * default-src without one, naming nothing but 'self', 'wasm-unsafe-eval' or 'none'): a script tag
 * pointing anywhere else is then never run by the browser.
 */
export function scriptsStayHome(csp) {
  const dirs = String(csp ?? "")
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .filter((d) => d[0]);
  const d = dirs.find((x) => x[0].toLowerCase() === "script-src") ?? dirs.find((x) => x[0].toLowerCase() === "default-src");
  const sources = d?.slice(1) ?? [];
  return sources.length > 0 && sources.every((t) => ["'self'", "'wasm-unsafe-eval'", "'none'"].includes(t.toLowerCase()));
}

/** Runs `f` over `items`, `n` at a time, keeping the order. */
async function pool(items, n, f) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i]);
      }
    }),
  );
  return out;
}

/**
 * Compares a site with a manifest. `get(url)` answers { status, body: Buffer, csp?: the
 * Content-Security-Policy header }. Returns the lines to print, each { ok: boolean, text }, and whether
 * everything matched. `strict`: a page with the host's analytics tag counts as different.
 */
export async function check({ site, manifest, manifestBytes, served = null, get, rpc = PUBLIC_RPC, skipProgram = false, strict = false, apk = null, extension = null, fetchImpl = fetch }) {
  const lines = [];
  const say = (ok, text) => lines.push({ ok, text });
  say(true, `manifest sha256 ${sha256(manifestBytes)}: compare it with the one published with release ${manifest.version ?? "?"}`);
  if (served) {
    if (served.status !== 200) say(false, `the site doesn't publish a manifest at ${RELEASE_PATH} (HTTP ${served.status})`);
    else if (sha256(served.body) !== sha256(manifestBytes)) say(false, `the site publishes a different manifest (sha256 ${sha256(served.body)})`);
    else say(true, "the site publishes this same manifest");
  }
  for (const p of manifestProblems(manifest)) say(false, `manifest: ${p}`);

  // the server's own version
  const health = await get(`${site}/api/health`).catch(() => null);
  let h = null;
  try {
    h = health?.status === 200 || health?.status === 503 ? JSON.parse(health.body.toString("utf8")) : null;
  } catch {
    h = null;
  }
  if (!h?.version) say(false, "the site's /api/health didn't answer with a version");
  else say(h.version === manifest.version, `server version ${h.version}${h.version === manifest.version ? "" : `, but the manifest is for ${manifest.version}`}`);

  // the Android app's release moment (ANDROID_RELEASE_AT): before it, the APK answers 404 and /api/legal says when it opens
  let opens = null;
  const legal = await get(`${site}/api/legal`).catch(() => null);
  try {
    const a = legal?.status === 200 ? JSON.parse(legal.body.toString("utf8")).android : null;
    if (a && typeof a.releaseAt === "string" && typeof a.startsIn === "number" && a.startsIn > 0) opens = a.releaseAt;
  } catch {
    opens = null;
  }

  // every file the website serves
  const entries = Object.entries(manifest.web?.files ?? {});
  const results = await pool(entries, 4, async ([path, want]) => {
    const r = await get(`${site}${path}`).catch((e) => ({ status: 0, error: e }));
    if (r.status === 404 && opens && /\.apk$/i.test(path)) return { path, state: "waiting" };
    if (r.status !== 200) return { path, state: "missing", status: r.status };
    if (sha256(r.body) === want) return { path, state: "same" };
    // a page that is the release's own with script tags added at its end (some hosts insert their own)
    const extra = addedScripts(r.body, want);
    // the hosting platform's analytics tag, which the page's Content-Security-Policy keeps from running
    if (!strict && extra?.length && extra.every((src) => HOST_SCRIPTS.some((re) => re.test(src))) && scriptsStayHome(r.csp)) return { path, state: "host", extra };
    return { path, state: "different", ...(extra ? { extra } : {}) };
  });
  const same = results.filter((r) => r.state === "same").length;
  const host = results.filter((r) => r.state === "host");
  const waiting = results.filter((r) => r.state === "waiting");
  for (const r of results) {
    if (r.state === "different") say(false, `DIFFERENT ${r.path}${r.extra ? `: the release's page with a script tag added before </body> (${r.extra.join(", ")})` : ""}`);
    if (r.state === "missing") say(false, `NOT SERVED ${r.path} (HTTP ${r.status || "no answer"})`);
    if (r.state === "waiting") say(true, `NOT YET ${r.path}: the Android app's download opens at ${opens} (the site's ANDROID_RELEASE_AT); run the check again after that to compare it`);
  }
  if (host.length) {
    say(
      true,
      `note: ${host.length} page${host.length === 1 ? "" : "s"} (${host.map((r) => r.path).join(", ")}) carry the hosting platform's analytics tag (${[...new Set(host.flatMap((r) => r.extra))].join(", ")}) before </body>, ` +
        "which the platform adds as it serves them: otherwise byte for byte the release's, and the site's Content-Security-Policy keeps that tag from running (--strict counts them as different)",
    );
  }
  const counted = same + host.length + waiting.length;
  const asides = [host.length ? `${host.length} with the host's analytics tag` : "", waiting.length ? `${waiting.length} not open yet` : ""].filter(Boolean);
  say(counted === entries.length, `website: ${counted} of ${entries.length} files match${asides.length ? ` (${asides.join(", ")})` : ""}`);

  // the deployed program
  if (manifest.program && !skipProgram) {
    try {
      const onChain = await programHash(rpc, manifest.program.programId, fetchImpl);
      say(onChain === manifest.program.executableHash, `program ${manifest.program.programId}: on-chain code ${onChain === manifest.program.executableHash ? "matches" : `is ${onChain}, not`} release ${manifest.program.version} (${manifest.program.executableHash})`);
    } catch (e) {
      say(false, `program: couldn't read it from the chain (${String(e?.message ?? e).slice(0, 120)})`);
    }
    const claimed = h?.program?.sha256;
    if (claimed && claimed !== manifest.program.executableHash) say(false, `the site's /api/health reports program code ${claimed}, not the release's`);
  }

  // files you downloaded yourself
  if (apk) {
    if (!manifest.apk) say(false, "the manifest lists no Android app");
    else say(sha256(readFileSync(apk)) === manifest.apk.sha256, `Android app ${apk}: ${sha256(readFileSync(apk)) === manifest.apk.sha256 ? "matches" : "does NOT match"} the release (signing certificate ${manifest.apk.certSha256 ?? "?"})`);
  }
  if (extension) {
    if (!manifest.extension) say(false, "the manifest lists no extension");
    else if (statSync(extension).isDirectory()) {
      // an installed copy: Chrome adds its own _metadata folder
      const got = listingHash(hashFolder(extension, ["_metadata"]));
      say(got === manifest.extension.sha256, `extension folder ${extension}: ${got === manifest.extension.sha256 ? "matches" : "does NOT match"} release ${manifest.extension.version}`);
    } else {
      const got = sha256(readFileSync(extension));
      say(!!manifest.extension.zipSha256 && got === manifest.extension.zipSha256, `extension zip ${extension}: ${got === manifest.extension.zipSha256 ? "matches" : "does NOT match"} release ${manifest.extension.version}`);
    }
  }
  return { lines, ok: lines.every((l) => l.ok) };
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function httpGet(url) {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()), csp: r.headers.get("content-security-policy") };
}

async function main() {
  const site = (arg("--site") ?? "https://visionswap.net").replace(/\/$/, "");
  if (!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(site)) {
    console.error("--site takes an address like https://visionswap.net");
    process.exit(2);
  }
  const from = arg("--manifest");
  const served = await httpGet(`${site}${RELEASE_PATH}`).catch(() => ({ status: 0, body: Buffer.alloc(0) }));
  let bytes;
  if (!from) {
    if (served.status !== 200) {
      console.error(`${site} doesn't publish a manifest (HTTP ${served.status || "no answer"}); pass the release's own with --manifest`);
      process.exit(2);
    }
    bytes = served.body;
  } else bytes = /^https:\/\//.test(from) ? (await httpGet(from)).body : readFileSync(resolve(from));
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    console.error("the manifest isn't JSON");
    process.exit(2);
  }
  const rpcArg = arg("--rpc");
  // a keyed RPC address on the command line is visible to other programs on this computer: VS_RPC_URL keeps it out
  if (rpcArg && (/[?&](api[-_]?key|key|token|access[-_]?token|auth)=/i.test(rpcArg) || /\/v\d+\/[A-Za-z0-9_-]{20,}/.test(rpcArg))) console.error("note: --rpc carries a key, which other programs on this computer can see; set VS_RPC_URL instead");
  const { lines, ok } = await check({
    site,
    manifest,
    manifestBytes: bytes,
    served: from ? served : null,
    get: httpGet,
    rpc: rpcArg ?? process.env.VS_RPC_URL ?? PUBLIC_RPC,
    skipProgram: process.argv.includes("--skip-program"),
    strict: process.argv.includes("--strict"),
    apk: arg("--apk") ?? null,
    extension: arg("--extension") ?? null,
  });
  if (process.argv.includes("--json")) console.log(JSON.stringify({ site, ok, lines }, null, 2));
  else {
    console.log(`VisionSwap release check: ${site}`);
    for (const l of lines) console.log(`${l.ok ? "OK  " : "FAIL"}  ${l.text}`);
    console.log(ok ? "\nEverything matches the release." : "\nSomething doesn't match the release (see FAIL above).");
  }
  process.exitCode = ok ? 0 : 1;
}

const isMain = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main().catch((e) => {
    // an RPC address may carry a key: never printed
    console.error(`the check couldn't run: ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(2);
  });
}

