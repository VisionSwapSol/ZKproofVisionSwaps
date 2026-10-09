import { useRef } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { ExposureBox } from "../components/ExposureBox";
import { useRise } from "../lib/rise";

export default function CheckPage() {
  const root = useRef<HTMLDivElement>(null);
  useRise(root);
  const initial = new URLSearchParams(location.search).get("a") ?? "";
  return (
    <div ref={root} className="page check-page">
      <Header />
      <main className="wrap check-main">
        <p className="eyebrow rise">Exposure check</p>
        <h1 className="rise">What does your wallet say about you?</h1>
        <p className="lede rise">
          Solana keeps every transaction public forever. Paste any address to see what a stranger can piece together
          from it. We read the same public record anyone can, keep nothing, and never ask you to connect a wallet.
        </p>
        <div className="rise">
          <ExposureBox initial={initial} big />
        </div>
      </main>
      <Footer />
    </div>
  );
}
