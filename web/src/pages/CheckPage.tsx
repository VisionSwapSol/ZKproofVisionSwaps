import { useEffect, useRef, useState } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { ExposureBox } from "../components/ExposureBox";
import { useRise } from "../lib/rise";

export default function CheckPage() {
  const root = useRef<HTMLDivElement>(null);
  useRise(root);
  // the address to check comes after # (never sent to the server, so never in its logs); ?a= still works for older links.
  // It is read once the page is up, so the prerendered page and the browser's first render are the same.
  const [initial, setInitial] = useState("");
  useEffect(() => {
    setInitial(new URLSearchParams(location.hash.slice(1)).get("a") ?? new URLSearchParams(location.search).get("a") ?? "");
  }, []);
  return (
    <div ref={root} className="page check-page">
      <Header />
      <main className="wrap check-main">
        <p className="eyebrow rise">Exposure check</p>
        <h1 className="rise">What does your wallet say about you?</h1>
        <p className="lede rise">
          Solana keeps every transaction public forever. Paste any address to see what a stranger can piece together
          from it. We read the same public record anyone can, keep a result only briefly in memory, and never ask you to connect a wallet.
        </p>
        <div className="rise">
          {/* a new address starts a fresh box, which runs the check straight away */}
          <ExposureBox key={initial} initial={initial} big />
        </div>
      </main>
      <Footer />
    </div>
  );
}
