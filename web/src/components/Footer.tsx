import { useEffect, useState } from "react";
import { API } from "../lib/config";
import { XLink } from "./XLink";

let legalCache: Promise<{ repo: string | null; contact: string | null }> | null = null;

export function Footer() {
  const [repo, setRepo] = useState<string | null>(null);
  useEffect(() => {
    legalCache ??= fetch(`${API}/api/legal`)
      .then((r) => r.json())
      .catch(() => ({ repo: null, contact: null }));
    legalCache.then((l) => setRepo(l.repo)).catch(() => {});
  }, []);
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
            <a href="/tokenomics">Tokenomics</a>
            <a href="/check">Exposure check</a>
            <a href="/docs">Docs</a>
            <a href="/docs#security">Security</a>
            <a href="/terms">Terms</a>
            <XLink className="foot-x" label />
            {repo && (
              <a href={repo} target="_blank" rel="noreferrer noopener">
                Source code
              </a>
            )}
          </nav>
        </div>
        <p className="foot-small">
          VisionSwap is open-source software that runs on Solana. It does not hold your money. Not available to people
          or places under sanctions. Nothing here is financial advice.
        </p>
      </div>
    </footer>
  );
}
