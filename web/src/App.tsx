import { Component, lazy, Suspense, useEffect, type ComponentType, type ReactNode } from "react";
import { usePath, useLinkInterception } from "./lib/router";
import { canonicalOf, pageOf, routeOf, type PageKey } from "./seo/pages";
import { Landing } from "./pages/Landing";

/** Pages never written ahead of time (wallet and proving code): left out of the build-time prerender entirely. */
const ClientOnly = () => null;
const AppPage = import.meta.env.SSR ? ClientOnly : lazy(() => import("./pages/AppPage"));
const PayPage = import.meta.env.SSR ? ClientOnly : lazy(() => import("./pages/PayPage"));
const CheckPage = lazy(() => import("./pages/CheckPage"));
const DocsPage = lazy(() => import("./pages/DocsPage"));
const FaqPage = lazy(() => import("./pages/FaqPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
const SecurityPage = lazy(() => import("./pages/SecurityPage"));
const CompliancePage = lazy(() => import("./pages/CompliancePage"));
const TokenomicsPage = lazy(() => import("./pages/TokenomicsPage"));
const SupportPage = lazy(() => import("./pages/SupportPage"));
const WhyPage = lazy(() => import("./pages/WhyPage"));
const RoadmapPage = lazy(() => import("./pages/RoadmapPage"));
const VerifyPage = lazy(() => import("./pages/VerifyPage"));
const UnavailablePage = lazy(() => import("./pages/UnavailablePage"));

const VIEWS: Record<PageKey, ComponentType> = {
  home: Landing,
  app: AppPage,
  check: CheckPage,
  docs: DocsPage,
  faq: FaqPage,
  terms: TermsPage,
  privacy: PrivacyPage,
  security: SecurityPage,
  compliance: CompliancePage,
  support: SupportPage,
  tokenomics: TokenomicsPage,
  why: WhyPage,
  roadmap: RoadmapPage,
  pay: PayPage,
  verify: VerifyPage,
  unavailable: UnavailablePage,
};

/**
 * A crash shows a way back instead of a blank page. The usual cause after a
 * new release is an old tab asking for a page chunk that no longer exists,
 * which a reload fixes. Keys live in memory only, so nothing is lost.
 */
class Crashed extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crashed" role="alert">
        <h1>This page needs a refresh.</h1>
        <p>Something on it stopped working. Your private balance isn't affected: it lives on Solana, not on this page.</p>
        <button type="button" className="btn violet" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}

/** Sets (or adds) one tag in <head>; `value` null takes it out. */
function headTag(selector: string, make: () => HTMLElement, attr: string, value: string | null) {
  let el = document.head.querySelector<HTMLElement>(selector);
  if (value == null) {
    el?.remove();
    return;
  }
  if (!el) {
    el = make();
    document.head.appendChild(el);
  }
  el.setAttribute(attr, value);
}
const meta = (key: "name" | "property", name: string) => () => {
  const m = document.createElement("meta");
  m.setAttribute(key, name);
  return m;
};

/** The tab title and the page's own tags follow the page shown (a prerendered page already has them). */
function usePageHead(path: string) {
  useEffect(() => {
    const page = pageOf(path);
    const url = canonicalOf(page);
    document.title = page.title;
    headTag('meta[name="description"]', meta("name", "description"), "content", page.description);
    headTag('meta[name="robots"]', meta("name", "robots"), "content", page.index ? null : "noindex");
    headTag(
      'link[rel="canonical"]',
      () => Object.assign(document.createElement("link"), { rel: "canonical" }),
      "href",
      page.index ? url : null,
    );
    headTag('meta[property="og:title"]', meta("property", "og:title"), "content", page.ogTitle ?? page.title);
    headTag('meta[property="og:description"]', meta("property", "og:description"), "content", page.description);
    headTag('meta[property="og:url"]', meta("property", "og:url"), "content", url);
  }, [path]);
}

export function Root() {
  useLinkInterception();
  const path = usePath();
  usePageHead(path);
  const Page = VIEWS[routeOf(path) ?? "home"];
  return (
    <Crashed>
      <Suspense fallback={<div className="page-wait" />}>
        <Page />
      </Suspense>
    </Crashed>
  );
}
