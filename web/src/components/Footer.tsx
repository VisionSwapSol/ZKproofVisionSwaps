import { XLink } from "./XLink";
import { TOKEN_LAUNCH_ENABLED } from "../lib/token-launch";
import { AndroidAppLink } from "./GetApp";
import { shownLegal, useLegal } from "../legal/useLegal";
import { contactText } from "../legal/settings";
import { SUPPORT_EMAIL, mailto } from "../lib/contacts";

export function Footer() {
  const legal = shownLegal(useLegal());
  const repo = legal.repo;
  // BUSINESS_CONTACT: business@visionswap.net unless the owner names another (the default until /api/legal answers)
  const business = legal.business;
  return (
    <footer className="foot">
      <div className="wrap">
        <p className="foot-big">Privacy is normal.</p>
        <div className="foot-row">
          <div className="foot-brand">
            <img src="/favicon-64.png" alt="" width={36} height={36} />
            <span>VisionSwap</span>
          </div>
          <nav className="foot-links" aria-label="Footer">
            <a href="/app">App</a>
            <a href="/why">Why VisionSwap?</a>
            <a href="/roadmap">Roadmap</a>
            {TOKEN_LAUNCH_ENABLED && <a href="/tokenomics">Tokenomics</a>}
            <a href="/check">Exposure check</a>
            <AndroidAppLink />
            <a href="/docs">Docs</a>
            <a href="/faq">FAQ</a>
            <a href="/support">Support</a>
            <a href="/security">Security</a>
            <a href="/compliance">Compliance</a>
            <a href="/terms">Terms</a>
            <a href="/privacy">Privacy</a>
            <XLink className="foot-x" label />
            {repo && (
              <a href={repo} target="_blank" rel="noreferrer noopener">
                Source code
              </a>
            )}
          </nav>
        </div>
        <p className="foot-contact">
          <span>
            Contact: <a href={mailto(SUPPORT_EMAIL)}>{SUPPORT_EMAIL}</a>
          </span>{" "}
          {business && (
            <span>
              Business and press: <a href={business}>{contactText(business)}</a>
            </span>
          )}
        </p>
        <p className="foot-small">
          {repo ? "VisionSwap is open-source software that runs on Solana." : "VisionSwap is software that runs on Solana."} Your
          spending and viewing keys stay in your browser, and we never receive them. Not offered to people on sanctions lists or in{" "}
          <a href="/compliance#places">restricted places</a> (Terms of use, section 2). Nothing here is financial advice.
        </p>
      </div>
    </footer>
  );
}
