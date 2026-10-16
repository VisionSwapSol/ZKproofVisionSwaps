/**
 * The site's files for search engines and AI assistants: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, written when the site is built. They carry the same facts as the pages, in the
 * pages' own words, and nothing that addresses a reader differently from the site.
 */
import { FAQ_GROUPS, answerText } from "../lib/faq";
import { LANDING_FAQ } from "../lib/landing-faq";
import { SUPPORT_CATEGORIES, SUPPORT_FAQS } from "../lib/support-faq";
import { BUSINESS_EMAIL, SUPPORT_EMAIL } from "../lib/contacts";
import { FEE_SUMMARY } from "./jsonld";
import { ORIGIN, PAGES, canonicalOf, type PageMeta } from "./pages";

/** The pages open to search engines, homepage first. */
export function indexedPages(): PageMeta[] {
  return Object.values(PAGES).filter((p) => p.index);
}

/** Crawlers named for clarity: search engines and AI assistants' search and fetch agents all get the same rules as everyone. */
const NAMED_CRAWLERS = [
  "Googlebot",
  "Bingbot",
  "DuckDuckBot",
  "Applebot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "GPTBot",
  "Claude-SearchBot",
  "Claude-User",
  "ClaudeBot",
  "PerplexityBot",
  "Perplexity-User",
  "Meta-WebIndexer",
];

/** robots.txt: the whole site is open, except the API and the large proving and download files. */
export function robotsTxt(origin = ORIGIN): string {
  return [
    "# VisionSwap: every page is open to search engines and AI assistants, and every visitor gets the same pages.",
    ...NAMED_CRAWLERS.map((ua) => `User-agent: ${ua}`),
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /zk/",
    "Disallow: /download/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** sitemap.xml: each open page, with the date its words last changed (never the build's date). */
export function sitemapXml(origin = ORIGIN): string {
  const urls = indexedPages().map((p) => `  <url>\n    <loc>${xml(canonicalOf(p, origin))}</loc>\n    <lastmod>${p.updated}</lastmod>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** The contact line: the addresses every page's footer and the Support page show (lib/contacts.ts). */
const CONTACT = `Contact: ${SUPPORT_EMAIL} for support, legal, compliance, security and privacy requests; ${BUSINESS_EMAIL} for business, partnership and press enquiries.`;

const SUMMARY =
  "VisionSwap is a shielded pool for SOL on Solana, plus an app that uses it to send SOL and to buy and sell Solana tokens: payments and buys are paid from the pool instead of from the wallet you started from. A zero-knowledge proof (Groth16, checked by the Solana program) shows that a payment is yours without saying which deposit paid for it. Live on Solana mainnet since October 3, 2026.";

/** llms.txt: a short summary and the site's pages, each described in its own words. */
export function llmsTxt(origin = ORIGIN): string {
  const pages = indexedPages().map((p) => `- [${p.title}](${canonicalOf(p, origin)}): ${p.description}`);
  return [
    "# VisionSwap",
    "",
    `> ${SUMMARY}`,
    "",
    `Fees: ${FEE_SUMMARY}`,
    "",
    CONTACT,
    "",
    "## Pages",
    "",
    ...pages,
    "",
    "## More",
    "",
    `- [All questions and answers on one page](${origin}/llms-full.txt): the FAQ, the Support library and the homepage's questions as plain text.`,
    `- [Email VisionSwap support](mailto:${SUPPORT_EMAIL}): help with the app, legal, compliance, security and privacy requests.`,
    `- [Email VisionSwap business](mailto:${BUSINESS_EMAIL}): business, partnership and press enquiries.`,
    "- [VisionSwap on X](https://x.com/VisionSwapSol): news and announcements.",
    "",
  ].join("\n");
}

/** llms-full.txt: every question and answer the site shows, grouped as on its pages. */
export function llmsFullTxt(origin = ORIGIN): string {
  const out = ["# VisionSwap: questions and answers", "", `> ${SUMMARY}`, "", `Fees: ${FEE_SUMMARY}`, "", CONTACT, ""];
  out.push(`## FAQ (${origin}/faq)`, "");
  for (const g of FAQ_GROUPS) {
    out.push(`### ${g.title}`, "");
    for (const qa of g.items) out.push(`#### ${qa.q}`, "", answerText(qa), "", `${origin}/faq#${qa.id}`, "");
  }
  out.push(`## Support (${origin}/support)`, "");
  for (const c of SUPPORT_CATEGORIES) {
    out.push(`### ${c.label}`, "");
    for (const f of SUPPORT_FAQS.filter((x) => x.category === c.id)) out.push(`#### ${f.question}`, "", f.answer, "");
  }
  out.push(`## From the homepage (${origin}/)`, "");
  for (const f of LANDING_FAQ) out.push(`#### ${f.q}`, "", f.a, "");
  return out.join("\n");
}
