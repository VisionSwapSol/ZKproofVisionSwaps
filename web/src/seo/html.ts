/**
 * Builds a page's HTML from the site's built index.html: its own title, description, canonical
 * address, link-preview tags and structured data, and (for a prerendered page) its words inside
 * #root. Every visitor gets these same bytes, people and crawlers alike.
 */
import { SOCIAL } from "../lib/config";
import { jsonLdFor } from "./jsonld";
import { ORIGIN, PAGES, canonicalOf, type PageKey } from "./pages";

/** Escapes text for an HTML attribute or element. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** JSON inside <script>: "<" written as <, so no text in it can close the tag. */
export const scriptJson = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c");

/** Replaces exactly one match, or stops the build: a template that changed shape must never ship pages without their tags. */
function swap(html: string, re: RegExp, to: string, what: string): string {
  const n = html.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))?.length ?? 0;
  if (n !== 1) throw new Error(`index.html: expected one ${what}, found ${n}`);
  return html.replace(re, to);
}

export type PageAssets = {
  /** the page's own stylesheets (its lazy chunk's), linked so it never shows unstyled */
  css?: string[];
  /** its scripts, preloaded so the browser takes it over sooner */
  js?: string[];
};

/**
 * The full HTML of one page. `body`: its prerendered markup, or null for a page the browser fills in
 * (it then gets a short description for visitors without JavaScript).
 */
export function pageHtml(
  template: string,
  key: PageKey,
  body: string | null,
  opts: { origin?: string; repoUrl?: string; assets?: PageAssets } = {},
): string {
  const origin = opts.origin ?? ORIGIN;
  const page = PAGES[key];
  const url = canonicalOf(page, origin);
  let markup = body ?? "";
  // React puts the resource hints it found (an image preload) ahead of the markup: they belong in <head>
  const hoisted: string[] = [];
  markup = markup.replace(/^(?:<link\b[^>]*>)+/, (m) => {
    hoisted.push(m);
    return "";
  });

  const tags = [
    page.index ? `<link rel="canonical" href="${esc(url)}" />` : `<meta name="robots" content="noindex" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="VisionSwap" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta name="twitter:site" content="@${esc(SOCIAL.x.split("/").pop() ?? "")}" />`,
    `<script type="application/ld+json">${scriptJson(jsonLdFor(key, { origin, repoUrl: opts.repoUrl }))}</script>`,
    // the page's words rise into view as scripts run; without scripts they are simply shown
    body != null ? `<noscript><style>.rise{opacity:1;transform:none;filter:none}</style></noscript>` : "",
    ...(opts.assets?.css ?? []).map((c) => `<link rel="stylesheet" crossorigin href="/${esc(c)}" />`),
    ...(opts.assets?.js ?? []).map((j) => `<link rel="modulepreload" crossorigin href="/${esc(j)}" />`),
    ...hoisted,
  ].filter(Boolean);

  let html = template;
  html = swap(html, /<title>[^<]*<\/title>/, `<title>${esc(page.title)}</title>`, "<title>");
  html = swap(html, /<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${esc(page.description)}" />`, "description");
  html = swap(html, /<meta property="og:title" content="[^"]*"\s*\/?>/, `<meta property="og:title" content="${esc(page.ogTitle ?? page.title)}" />`, "og:title");
  html = swap(html, /<meta property="og:description" content="[^"]*"\s*\/?>/, `<meta property="og:description" content="${esc(page.description)}" />`, "og:description");
  html = swap(html, /<meta property="og:image" content="[^"]*"\s*\/?>/, `<meta property="og:image" content="${esc(origin)}/og.png" />`, "og:image");
  html = swap(html, /<\/head>/, `  ${tags.join("\n    ")}\n  </head>`, "</head>");
  const noscript =
    body == null
      ? `\n    <noscript><p>${esc(page.description)} This page needs JavaScript. Read <a href="/docs">how it works</a> or the <a href="/faq">FAQ</a>.</p></noscript>`
      : "";
  html = swap(html, /<div id="root"><\/div>/, `<div id="root">${markup}</div>${noscript}`, '<div id="root">');
  return html;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** The words a reader (or a crawler that runs no scripts) gets from a page's body, as one line of text. */
export function pageText(html: string): string {
  const body = html.replace(/^[\s\S]*?<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
  return body
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:br|wbr)\s*\/?>/gi, "")
    .replace(/<\/?(?:p|div|li|ol|ul|h[1-6]|section|article|main|header|footer|nav|aside|dl|dt|dd|summary|details|button|tr|td|th|figure|figcaption|time|span|a|strong|em|code|label|input|svg|path)\b[^>]*>/gi, (t) =>
      /^<\/?(?:span|a|strong|em|code|time)\b/i.test(t) ? "" : " ",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();
}
