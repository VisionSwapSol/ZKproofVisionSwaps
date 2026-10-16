// Writes each public page's HTML when the site is built, so its words are there before any script
// runs: dist/_pages/<page>.html (served by the VisionSwap service), plus robots.txt, sitemap.xml,
// llms.txt and llms-full.txt. Every visitor, person or crawler, gets these same files.
//
// Runs after `vite build` and `vite build --ssr src/entry-prerender.tsx --outDir build/prerender`
// (see "build" in package.json). Needs no browser, no network and no git.
process.env.NODE_ENV ??= "production";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(web, "dist");
const entry = join(web, "build", "prerender", "entry-prerender.js");
for (const f of [join(dist, "index.html"), join(dist, ".vite", "manifest.json"), entry]) {
  if (!existsSync(f)) throw new Error(`prerender: ${f} is missing (run the full "npm run build -w web")`);
}

const ssr = await import(pathToFileURL(entry).href);
const template = readFileSync(join(dist, "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));
const origin = ssr.ORIGIN;
// the public source repository, when this build is told about it (it is listed with the X account)
const repoUrl = /^https:\/\/[^\s"<>]+$/.test(process.env.REPO_URL ?? "") ? process.env.REPO_URL : undefined;

/** A lazy page's own styles and scripts (and what they import), so it neither shows unstyled nor waits on a second round trip. */
function assetsOf(src) {
  if (!src) return {};
  if (!manifest[src]) throw new Error(`prerender: ${src} is not in the build manifest`);
  const css = new Set();
  const js = new Set();
  const seen = new Set();
  const walk = (key) => {
    const m = manifest[key];
    if (!m || seen.has(key) || m.isEntry) return;
    seen.add(key);
    js.add(m.file);
    for (const c of m.css ?? []) css.add(c);
    for (const i of m.imports ?? []) walk(i);
  };
  walk(src);
  return { css: [...css], js: [...js] };
}

const out = join(dist, "_pages");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const pages = {};
const rows = [];
for (const page of Object.values(ssr.PAGES)) {
  let body = null;
  if (page.prerender) {
    const errors = [];
    body = await ssr.renderPage(page.path, (e) => errors.push(e));
    if (errors.length) throw new Error(`prerender ${page.path}: ${errors.map((e) => e?.message ?? e).join("; ")}`);
    if (body.includes("<template")) throw new Error(`prerender ${page.path}: a part of the page fell back to the browser`);
    if (!/<h1[\s>]/.test(body)) throw new Error(`prerender ${page.path}: the page has no heading`);
  }
  const html = ssr.pageHtml(template, page.key, body, { origin, repoUrl, assets: assetsOf(page.src) });
  const file = `${page.key}.html`;
  writeFileSync(join(out, file), html);
  pages[page.key] = file;
  rows.push(`${page.path.padEnd(12)} ${String(html.length).padStart(7)} bytes  ${String(ssr.pageText(html).length).padStart(6)} characters of text${page.index ? "" : "  (noindex)"}`);
}
writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    {
      origin,
      pages,
      paths: Object.fromEntries(Object.values(ssr.PAGES).map((p) => [p.key, p.path])),
      routes: ssr.ROUTES,
      // an address no route takes: the homepage, answered 404
      notFound: "home",
    },
    null,
    2,
  ),
);
writeFileSync(join(dist, "robots.txt"), ssr.robotsTxt(origin));
writeFileSync(join(dist, "sitemap.xml"), ssr.sitemapXml(origin));
writeFileSync(join(dist, "llms.txt"), ssr.llmsTxt(origin));
writeFileSync(join(dist, "llms-full.txt"), ssr.llmsFullTxt(origin));
// the build manifest was only for this script; the site never serves it
rmSync(join(dist, ".vite"), { recursive: true, force: true });
console.log(`prerendered ${rows.length} pages for ${origin}:\n  ${rows.join("\n  ")}`);
