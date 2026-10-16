// Builds the extension: `node scripts/build.mjs prod` -> extension/dist (the one to publish),
// `node scripts/build.mjs dev` -> extension/dist-dev (local server and local site, for testing).
//
// Everything the extension runs ships inside it: the side panel (the website's own app code,
// built with VITE_EXTENSION=1), the background worker, the proving files, fonts and icons.
// Nothing is loaded from anywhere else.
//
// The development build can pin a test extension ID: set VS_EXT_DEV_KEY to a JSON file holding
// { "key": "<base64 public key>" }. The published build never carries a key.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV, SITE, manifest } from "./manifest.mjs";
import { provingPins } from "../../web/scripts/proving-pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, "..");
const ROOT = resolve(EXT, "..");
const dev = process.argv[2] === "dev";
const OUT = join(EXT, dev ? "dist-dev" : "dist");
const STAGE = join(EXT, dev ? "public-dev" : "public-gen");
const { version } = JSON.parse(readFileSync(join(EXT, "package.json"), "utf8"));

// ─── the files served as they are: fonts, icons, the mascot's flat logo, the proving files ───
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, "zk"), { recursive: true });
cpSync(join(ROOT, "web", "public", "fonts"), join(STAGE, "fonts"), { recursive: true });
cpSync(join(EXT, "icons"), join(STAGE, "icons"), { recursive: true });
copyFileSync(join(ROOT, "web", "public", "logo-600.webp"), join(STAGE, "logo-600.webp"));
// content-hashed names, exactly as web/scripts/copy-zk.mjs makes them for the website, and only the
// files pinned in the app (sdk/src/provingfiles.ts, VS-54): the panel proves with its own packaged
// copies, checked against the same pins before each first use
const zk = {};
const pins = provingPins();
for (const name of ["transaction.wasm", "transaction.zkey"]) {
  const src = join(ROOT, "circuits", "artifacts", name);
  const bytes = readFileSync(src);
  const full = createHash("sha256").update(bytes).digest("hex");
  const [base, ext] = name.split(".");
  if (full !== pins[ext].sha256 || bytes.length !== pins[ext].size) {
    console.error(`${name} is not the pinned file (see sdk/src/provingfiles.ts): the extension isn't built with it.`);
    process.exit(1);
  }
  const h = full.slice(0, 12);
  copyFileSync(src, join(STAGE, "zk", `${base}-${h}.${ext}`));
  zk[ext] = `/zk/${base}-${h}.${ext}`;
}
// not "manifest.json": the Chrome Web Store refuses a package with more than one file of that name
writeFileSync(join(STAGE, "zk", "proof-files.json"), JSON.stringify(zk));

// ─── what the app code reads from import.meta.env ───
const env = {
  VITE_EXTENSION: "1",
  VITE_API_URL: dev ? DEV.api : SITE,
  VITE_SITE_URL: dev ? DEV.site : SITE,
  VITE_EXT_DEV: dev ? "1" : "",
};
const define = Object.fromEntries(Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));
// features built but off by default, as on the website (web/src/lib/features.ts)
define.__VS_RECEIPTS__ = JSON.stringify(process.env.VITE_RECEIPTS === "1");

// ─── the side panel ───
await build({
  configFile: false,
  root: EXT,
  base: "/",
  publicDir: STAGE,
  plugins: [react()],
  define,
  logLevel: "warn",
  worker: { format: "es" },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    modulePreload: { polyfill: false },
    rollupOptions: { input: { sidepanel: join(EXT, "sidepanel.html") } },
  },
});

// ─── the background worker: one file, nothing shared with the panel ───
await build({
  configFile: false,
  root: EXT,
  publicDir: false,
  define,
  logLevel: "warn",
  build: {
    outDir: OUT,
    emptyOutDir: false,
    copyPublicDir: false,
    target: "es2022",
    sourcemap: false,
    lib: { entry: join(EXT, "src", "background.ts"), formats: ["es"], fileName: () => "background.js" },
  },
});

// ─── the manifest ───
let key = null;
if (dev) {
  const f = process.env.VS_EXT_DEV_KEY;
  if (f && existsSync(f)) key = JSON.parse(readFileSync(f, "utf8")).key ?? null;
  else console.log("dev build without a pinned ID (set VS_EXT_DEV_KEY to pin one)");
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest({ dev, version, key }), null, 2) + "\n");
rmSync(STAGE, { recursive: true, force: true });

// ─── checks: everything the pages load is in the package, and the published build knows no local addresses ───
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(OUT);
const text = (p) => /\.(js|html|css|json)$/.test(p);
const problems = [];
for (const p of files.filter(text)) {
  const s = readFileSync(p, "utf8");
  const rel = relative(OUT, p).replace(/\\/g, "/");
  if (rel.endsWith(".html")) {
    for (const m of s.matchAll(/<(script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) if (!m[2].startsWith("/")) problems.push(`${rel} loads ${m[2]}`);
    if (/<script(?![^>]*\bsrc=)[^>]*>/.test(s)) problems.push(`${rel} has an inline script`);
  }
  if (!dev && (s.includes(DEV.api) || s.includes(DEV.site) || s.includes(DEV.siteAlt))) problems.push(`${rel} mentions a local address`);
  if (/importScripts\(\s*["']https?:/.test(s)) problems.push(`${rel} imports a remote script`);
}
const man = readFileSync(join(OUT, "manifest.json"), "utf8");
if (!dev && /localhost|127\.0\.0\.1|"key"/.test(man)) problems.push("manifest.json has a local address or a key");
for (const need of ["sidepanel.html", "background.js", "zk/proof-files.json", "fonts/fonts.css", "icons/icon-128.png"]) if (!existsSync(join(OUT, need))) problems.push(`missing ${need}`);
for (const p of files) {
  const rel = relative(OUT, p).replace(/\\/g, "/");
  if (rel !== "manifest.json" && /(^|\/)manifest\.json$/i.test(rel)) problems.push(`${rel}: the Chrome Web Store allows only one manifest.json`);
}
if (problems.length) {
  console.error("Extension build FAILED its checks:\n  " + problems.join("\n  "));
  process.exit(1);
}
const size = files.reduce((s, p) => s + statSync(p).size, 0);
console.log(`extension ${version} (${dev ? "dev" : "published"}) -> ${relative(ROOT, OUT)}: ${files.length} files, ${(size / 1e6).toFixed(1)} MB`);
