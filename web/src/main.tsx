import "./polyfills";
import { Component, StrictMode, lazy, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/site.css";
import "./styles/app.css";
import "./styles/pages.css";
import { usePath, useLinkInterception } from "./lib/router";
import { Landing } from "./pages/Landing";

const AppPage = lazy(() => import("./pages/AppPage"));
const CheckPage = lazy(() => import("./pages/CheckPage"));
const DocsPage = lazy(() => import("./pages/DocsPage"));
const TermsPage = lazy(() => import("./pages/TermsPage"));
const TokenomicsPage = lazy(() => import("./pages/TokenomicsPage"));
const WhyPage = lazy(() => import("./pages/WhyPage"));
const RoadmapPage = lazy(() => import("./pages/RoadmapPage"));
const PayPage = lazy(() => import("./pages/PayPage"));

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
        <p>Something on it stopped working. Your private balance is safe: it lives on Solana, not on this page.</p>
        <button type="button" className="btn violet" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}

function Root() {
  useLinkInterception();
  const path = usePath().replace(/\/+$/, "") || "/";
  let page: React.ReactNode;
  if (path === "/") page = <Landing />;
  else if (path.startsWith("/app")) page = <AppPage />;
  else if (path.startsWith("/check")) page = <CheckPage />;
  else if (path.startsWith("/docs")) page = <DocsPage />;
  else if (path.startsWith("/terms")) page = <TermsPage />;
  else if (path.startsWith("/tokenomics")) page = <TokenomicsPage />;
  else if (path.startsWith("/why")) page = <WhyPage />;
  else if (path.startsWith("/roadmap")) page = <RoadmapPage />;
  else if (path.startsWith("/pay")) page = <PayPage />;
  else page = <Landing />;
  return (
    <Crashed>
      <Suspense fallback={<div className="page-wait" />}>{page}</Suspense>
    </Crashed>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
