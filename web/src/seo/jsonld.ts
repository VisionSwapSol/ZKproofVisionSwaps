/**
 * Each page's structured data (schema.org JSON-LD). It only repeats what the page itself shows: its
 * questions and answers come from the same data the page renders (web/test/prerender.test.ts checks
 * every one against the page's visible text). No ratings, reviews or prices: VisionSwap has none to
 * state, and fees are described as the page describes them.
 */
import { FEES, SOCIAL } from "../lib/config";
import { BUSINESS_EMAIL, SUPPORT_EMAIL } from "../lib/contacts";
import { FAQ_ITEMS, answerText } from "../lib/faq";
import { LANDING_FAQ } from "../lib/landing-faq";
import { SUPPORT_FAQS } from "../lib/support-faq";
import { ORIGIN, PAGES, canonicalOf, type PageKey } from "./pages";

type Thing = Record<string, unknown>;

/** What the homepage lists under "What you can do" and "Pro tools" (each title is on the page). */
export const APP_FEATURES = [
  "Send privately",
  "Buy privately",
  "Sell privately",
  "Limit buys that hold your price",
  "Take-profit in steps",
  "Stop-loss and trailing stop",
  "DCA with natural timing",
  "Exposure check",
];

/** The fee line, in the homepage's own terms. */
export const FEE_SUMMARY = `${FEES.actionPct} to shield SOL and ${FEES.actionPct} per private send, buy or sell, enforced by the Solana program with a 1% cap, plus network costs of about 0.002 SOL. No sign-up.`;

const faqPage = (url: string, items: { q: string; a: string }[]): Thing => ({
  "@type": "FAQPage",
  "@id": `${url}#faq`,
  url,
  mainEntity: items.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
});

/** The structured data for one page, as a single JSON-LD document. `repoUrl`: the public source, when there is one. */
export function jsonLdFor(key: PageKey, opts: { origin?: string; repoUrl?: string } = {}): Thing {
  const origin = opts.origin ?? ORIGIN;
  const page = PAGES[key];
  const url = canonicalOf(page, origin);
  const org = { "@id": `${origin}/#organization` };
  const graph: Thing[] = [
    {
      "@type": "Organization",
      "@id": `${origin}/#organization`,
      name: "VisionSwap",
      url: `${origin}/`,
      logo: `${origin}/icon-512.png`,
      sameAs: [SOCIAL.x, ...(opts.repoUrl ? [opts.repoUrl] : [])],
      // the addresses every page's footer shows, and the Support page with them (lib/contacts.ts)
      email: SUPPORT_EMAIL,
      contactPoint: [
        { "@type": "ContactPoint", contactType: "customer support", email: SUPPORT_EMAIL, url: `${origin}/support`, availableLanguage: "en" },
        { "@type": "ContactPoint", contactType: "business enquiries", email: BUSINESS_EMAIL, availableLanguage: "en" },
      ],
    },
  ];
  if (key === "home") {
    graph.push(
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "VisionSwap",
        url: `${origin}/`,
        inLanguage: "en",
        publisher: org,
      },
      {
        "@type": "WebApplication",
        "@id": `${origin}/#app`,
        name: "VisionSwap",
        url: canonicalOf(PAGES.app, origin),
        description: page.description,
        applicationCategory: "FinanceApplication",
        operatingSystem: "Web, Android",
        browserRequirements: "Requires JavaScript and WebAssembly",
        featureList: APP_FEATURES,
        offers: { "@type": "Offer", description: FEE_SUMMARY, url: `${origin}/#fees` },
        publisher: org,
      },
      faqPage(url, LANDING_FAQ),
    );
  } else {
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${url}#breadcrumbs`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: PAGES.home.crumb, item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: page.crumb, item: url },
      ],
    });
  }
  if (key === "faq") graph.push(faqPage(url, FAQ_ITEMS.map((qa) => ({ q: qa.q, a: answerText(qa) }))));
  if (key === "support") graph.push(faqPage(url, SUPPORT_FAQS.map((f) => ({ q: f.question, a: f.answer }))));
  if (key === "docs") {
    graph.push({
      "@type": "TechArticle",
      "@id": `${url}#article`,
      headline: "How VisionSwap works",
      description: page.description,
      url,
      dateModified: page.updated,
      inLanguage: "en",
      author: org,
      publisher: org,
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}
