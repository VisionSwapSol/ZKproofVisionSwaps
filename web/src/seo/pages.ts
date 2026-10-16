/**
 * The site's pages: which address shows which page, and what each page is called in search results,
 * link previews and the browser tab. Data only (no JSX, no CSS), so the app, the build-time
 * prerender and the server all read the same list.
 *
 * Every title and description says what the page itself says (most are its own lede): the same words
 * for people, search engines and AI assistants.
 */
import { TOKEN_LAUNCH_ENABLED } from "../lib/token-launch";

export type PageKey =
  | "home"
  | "app"
  | "check"
  | "docs"
  | "faq"
  | "terms"
  | "privacy"
  | "security"
  | "compliance"
  | "support"
  | "tokenomics"
  | "why"
  | "roadmap"
  | "pay"
  | "verify"
  | "unavailable";

/** The site's address: canonical links, link previews and the sitemap always name it. */
export const ORIGIN = "https://visionswap.net";

/**
 * How an address picks its page, in this order: the first rule that matches wins. "prefix" also takes
 * the page's sub-addresses (/docs/anything shows the Docs), never a longer word (/apple isn't /app).
 * An address no rule takes shows the homepage, and the server answers it 404.
 */
export const ROUTES: { path: string; match: "exact" | "prefix"; page: PageKey }[] = [
  { path: "/", match: "exact", page: "home" },
  { path: "/app", match: "prefix", page: "app" },
  { path: "/check", match: "prefix", page: "check" },
  { path: "/docs", match: "prefix", page: "docs" },
  { path: "/faq", match: "exact", page: "faq" },
  { path: "/terms", match: "prefix", page: "terms" },
  { path: "/privacy", match: "prefix", page: "privacy" },
  { path: "/security", match: "exact", page: "security" },
  { path: "/compliance", match: "exact", page: "compliance" },
  { path: "/support", match: "exact", page: "support" },
  { path: "/tokenomics", match: "exact", page: "tokenomics" },
  { path: "/why", match: "prefix", page: "why" },
  { path: "/roadmap", match: "prefix", page: "roadmap" },
  { path: "/pay", match: "prefix", page: "pay" },
  { path: "/verify", match: "exact", page: "verify" },
  { path: "/unavailable", match: "exact", page: "unavailable" },
];

/** The address without trailing slashes ("/" stays "/"). */
export function cleanPath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

/** The page an address shows; null when none does (the homepage then shows, as a 404 on the server). */
export function routeOf(path: string): PageKey | null {
  const p = cleanPath(path);
  for (const r of ROUTES) {
    if (r.match === "exact" ? p === r.path : p === r.path || p.startsWith(`${r.path}/`)) return r.page;
  }
  return null;
}

export type PageMeta = {
  key: PageKey;
  /** its address */
  path: string;
  /** the browser tab and the search result's headline */
  title: string;
  /** the search result's summary and the link preview's text */
  description: string;
  /** the link preview's headline, when it differs from the title */
  ogTitle?: string;
  /** open to search engines and listed in the sitemap */
  index: boolean;
  /** its words are written into the page when the site is built; otherwise the browser fills it in */
  prerender: boolean;
  /** the page's own module, whose styles the prerendered page links straight away (null: in the main bundle) */
  src: string | null;
  /** YYYY-MM-DD: when its words last changed (the sitemap's lastmod, and "Last updated" where the page shows one) */
  updated: string;
  /** its name in breadcrumbs */
  crumb: string;
};

export const PAGES: Record<PageKey, PageMeta> = {
  home: {
    key: "home",
    path: "/",
    title: "VisionSwap · Private SOL sends and token swaps on Solana",
    ogTitle: "VisionSwap",
    description:
      "Send SOL and buy or sell any Solana token from a shared pool that keeps the deposit that paid hidden among everyone else's. Zero-knowledge proofs, live on Solana mainnet, from the wallet you already use.",
    index: true,
    prerender: true,
    src: null,
    updated: "2026-10-15",
    crumb: "Home",
  },
  why: {
    key: "why",
    path: "/why",
    title: "Why VisionSwap · Private trading on Solana",
    description:
      "Every Solana wallet is public. VisionSwap gives you a private balance and fresh wallets to trade from, funded from a shared pool instead of from you, secured by zero-knowledge proofs.",
    index: true,
    prerender: true,
    src: "src/pages/WhyPage.tsx",
    updated: "2026-10-14",
    crumb: "Why VisionSwap",
  },
  docs: {
    key: "docs",
    path: "/docs",
    title: "How VisionSwap works · Docs",
    description:
      "You put SOL into a shared pool, and later take it out somewhere else. A zero-knowledge proof convinces the Solana program that the money is yours without saying which deposit it came from.",
    index: true,
    prerender: true,
    src: "src/pages/DocsPage.tsx",
    updated: "2026-10-15",
    crumb: "Docs",
  },
  faq: {
    key: "faq",
    path: "/faq",
    title: "VisionSwap FAQ · Private SOL transfers on Solana",
    description:
      "Plain answers about sending SOL privately on Solana with VisionSwap: how the shielded pool works, what stays private and what is public, what it costs, and how to check it for yourself.",
    index: true,
    prerender: true,
    src: "src/pages/FaqPage.tsx",
    updated: "2026-10-15",
    crumb: "FAQ",
  },
  support: {
    key: "support",
    path: "/support",
    title: "VisionSwap Support · Help with private sends and trading",
    description:
      "Answers for private sends, fresh-wallet trading and using the VisionSwap app, searchable by topic, and how to email the VisionSwap team.",
    index: true,
    prerender: true,
    src: "src/pages/SupportPage.tsx",
    updated: "2026-10-15",
    crumb: "Support",
  },
  tokenomics: {
    key: "tokenomics",
    path: "/tokenomics",
    title: "$VSWAP tokenomics · VisionSwap",
    description:
      "Half of VisionSwap's platform revenue buys $VSWAP on the open market and burns it, and holders earn cashback on trading fees.",
    index: TOKEN_LAUNCH_ENABLED,
    prerender: true,
    src: "src/pages/TokenomicsPage.tsx",
    updated: "2026-10-05",
    crumb: "Tokenomics",
  },
  roadmap: {
    key: "roadmap",
    path: "/roadmap",
    title: "VisionSwap roadmap",
    description:
      "VisionSwap went live on Solana mainnet on October 3, 2026. Here's what we've built, what we're shipping now, and where we're going next.",
    index: true,
    prerender: true,
    src: "src/pages/RoadmapPage.tsx",
    updated: "2026-10-15",
    crumb: "Roadmap",
  },
  check: {
    key: "check",
    path: "/check",
    title: "Solana wallet exposure check · VisionSwap",
    description:
      "Paste any Solana address to see what a stranger can piece together from its public history. Free, and no wallet connection needed.",
    index: true,
    prerender: true,
    src: "src/pages/CheckPage.tsx",
    updated: "2026-10-15",
    crumb: "Exposure check",
  },
  privacy: {
    key: "privacy",
    path: "/privacy",
    title: "Privacy policy · VisionSwap",
    description:
      "What the VisionSwap website, the Android app and the Chrome extension handle, what each service behind them sees, and how long anything is kept.",
    index: true,
    prerender: true,
    src: "src/pages/PrivacyPage.tsx",
    updated: "2026-10-15",
    crumb: "Privacy policy",
  },
  terms: {
    key: "terms",
    path: "/terms",
    title: "Terms of use · VisionSwap",
    description: "The terms for using VisionSwap, its website and apps, and the shielded pool on Solana.",
    index: true,
    prerender: true,
    src: "src/pages/TermsPage.tsx",
    updated: "2026-10-15",
    crumb: "Terms",
  },
  security: {
    key: "security",
    path: "/security",
    title: "Security · VisionSwap",
    description:
      "How VisionSwap is designed to keep your funds under your control: keys made on your device, zero-knowledge proofs checked on-chain, the team's control over upgrades and settings, audit status, and how to report a problem.",
    index: true,
    prerender: true,
    src: "src/pages/SecurityPage.tsx",
    updated: "2026-10-15",
    crumb: "Security",
  },
  compliance: {
    key: "compliance",
    path: "/compliance",
    title: "Compliance · VisionSwap",
    description:
      "What VisionSwap screens and when, the public waiting room, how flagged deposits go back only to where they came from, where VisionSwap isn't offered, and what data exists for requests from authorities.",
    index: true,
    prerender: true,
    src: "src/pages/CompliancePage.tsx",
    updated: "2026-10-15",
    crumb: "Compliance",
  },
  app: {
    key: "app",
    path: "/app",
    title: "VisionSwap app · Private sends, buys and sells on Solana",
    description:
      "Open your private balance: shield SOL, send it privately, and buy or sell Solana tokens from Vision wallets funded from the pool. Runs in your browser, with the wallet you already use, a private key or a passkey.",
    index: true,
    prerender: false,
    src: null,
    updated: "2026-10-14",
    crumb: "App",
  },
  pay: {
    key: "pay",
    path: "/pay",
    title: "VisionSwap · Payment request",
    description: "A request for SOL, made with VisionSwap.",
    index: false,
    prerender: false,
    src: null,
    updated: "2026-10-14",
    crumb: "Payment request",
  },
  verify: {
    key: "verify",
    path: "/verify",
    title: "Check an ownership proof · VisionSwap",
    description:
      "Check, in your own browser, that a Solana address signed a message: how an exchange confirms that a customer controls a wallet, a deposit address or a Vision wallet.",
    index: true,
    prerender: true,
    src: "src/pages/VerifyPage.tsx",
    updated: "2026-10-15",
    crumb: "Check an ownership proof",
  },
  unavailable: {
    key: "unavailable",
    path: "/unavailable",
    title: "Not available in your region · VisionSwap",
    description: "VisionSwap isn't offered in some places. The Terms of use, section 2, and the Compliance page list them.",
    index: false,
    prerender: true,
    src: "src/pages/UnavailablePage.tsx",
    updated: "2026-10-15",
    crumb: "Not available in your region",
  },
};

/** The page an address shows (the homepage for an unknown one). */
export function pageOf(path: string): PageMeta {
  return PAGES[routeOf(path) ?? "home"];
}

/** A page's full canonical address. */
export function canonicalOf(page: PageMeta, origin = ORIGIN): string {
  return origin + page.path;
}

/** "October 14, 2026" from "2026-10-14" (the same on every computer: no time zone involved). */
export function longDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[m - 1]} ${d}, ${y}`;
}
