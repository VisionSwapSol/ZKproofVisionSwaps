import { useEffect, useRef } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Icon, type IconName } from "../components/Icon";
import { useRise } from "../lib/rise";

type Item = [string, "done" | "now" | "next"];
type Phase = { n: string; name: string; status: "done" | "now" | "next"; when: string; icon: IconName; items: Item[] };

const PHASES: Phase[] = [
  {
    n: "01",
    name: "Foundation",
    status: "done",
    when: "Complete",
    icon: "layers",
    items: [
      ["A zero-knowledge shielded pool written from scratch for Solana", "done"],
      ["Private-transaction circuit: two notes in, two out, 64-bit amounts", "done"],
      ["Public trusted setup, sealed with a Bitcoin block beacon", "done"],
      ["Proof-free deposits: the program builds every note on-chain", "done"],
      ["A relayer that keeps your wallet out of every spend", "done"],
      ["Note discovery on your device, so no server learns which notes are yours", "done"],
    ],
  },
  {
    n: "02",
    name: "Mainnet launch",
    status: "done",
    when: "October 3, 2026",
    icon: "rocket",
    items: [
      ["Deployed on Solana mainnet, with visionswap.net live the same day", "done"],
      ["Private sends, buys and sells verified with real funds on mainnet", "done"],
      ["Any-token private trading through fresh Vision wallets", "done"],
      ["Screened waiting room, with deposits you can take back", "done"],
      ["Fees enforced on-chain, with a 1% hard cap", "done"],
      ["Free exposure check and downloadable statements with viewing keys", "done"],
      ["Live program upgrade shipped and verified byte for byte", "done"],
      ["Every major Solana wallet supported, on desktop and mobile", "done"],
    ],
  },
  {
    n: "03",
    name: "Growth",
    status: "now",
    when: "Now",
    icon: "chart",
    items: [
      ["Shield by QR code from any wallet or exchange", "done"],
      ["Accounts without a wallet: a private key that works on any device", "done"],
      ["Screening that also checks who funded each deposit", "done"],
      ["Phone-perfect trading screens and a full video walkthrough", "done"],
      ["Private limit buys, DCA, take-profit and stop-loss", "done"],
      ["Send later at a random moment, and split payments across wallets", "done"],
      ["Passkey sign-in and payment links", "done"],
      ["Send it yourself whenever the relayer is down", "done"],
      ["Pro orders: take-profit in up to 4 steps, trailing stops, and edits with no new approval", "done"],
      ["DCA with varied timing, pause and resume", "done"],
      ["Limit buys and take-profit steps that hold your price", "done"],
      ["Stop-losses confirmed on a fresh price and run first", "done"],
      ["Speed setting, custom price room and a guaranteed minimum received", "done"],
      ["Orders and scheduled payments that keep running through every update", "done"],
      ["Fair-share limits that keep trades moving when the site is busy", "done"],
      ["Split payments to up to 20 people, and one payment link per payer", "done"],
      ["Strict content security policy and device-sealed keys", "done"],
      ["$VSWAP buyback and burn, with holder cashback on trading fees", "now"],
      ["Deposits of any size, with no per-deposit limit", "now"],
    ],
  },
  {
    n: "04",
    name: "Expansion",
    status: "next",
    when: "Next",
    icon: "globe",
    items: [
      ["Private transfers between VisionSwap accounts, inside the pool", "next"],
      ["Private USDC", "next"],
      ["Native iOS and Android apps", "next"],
      ["Independent security audit", "next"],
      ["Program upgrades controlled by a multisig", "next"],
      ["A developer SDK so other Solana apps can plug into the pool", "next"],
    ],
  },
];

const FIRSTS: { icon: IconName; title: string; text: string }[] = [
  { icon: "swap", title: "Any token, privately", text: "Buy and sell anything Jupiter can route, not a short list of pool tokens." },
  { icon: "wallet", title: "Tokens in a wallet you own", text: "Purchases land in a standard Solana wallet you can export, not locked inside a pool or an app." },
  { icon: "undo", title: "Deposits you can take back", text: "Every deposit waits in a screened waiting room and can be cancelled, fee included, until it joins." },
  { icon: "shield", title: "Screening that follows the money", text: "Each deposit is checked against sanctions lists, along with the wallets that funded it." },
  { icon: "qr", title: "Shield from any wallet or exchange", text: "QR-code deposits to an address only your account controls. No wallet connection needed." },
  { icon: "key", title: "No wallet required", text: "Open a private account with a private key that works on any device." },
  { icon: "eyeOff", title: "Balances nobody else can see", text: "Your balance lives in sealed notes that only your keys can read. It never appears on-chain." },
  { icon: "relay", title: "Your wallet never appears", text: "A relayer submits every private send and Vision wallet funding, with the details sealed in the proof." },
  { icon: "proof", title: "Our own zero-knowledge pool", text: "Built from scratch for Solana: Groth16 proofs on BN254 with Poseidon hashing, verified on-chain." },
  { icon: "spark", title: "Public trusted setup", text: "Perpetual Powers of Tau plus three phase-2 contributions, sealed with a Bitcoin block beacon." },
  { icon: "bolt", title: "Proof-free deposits", text: "Shielding needs no proof: the program computes each note itself, so deposits are fast and simple." },
  { icon: "lock", title: "Non-custodial and unfreezable", text: "As the program stands, no admin setting can move, freeze or redirect funds, and private sends can't be paused." },
  { icon: "chart", title: "Fees enforced on-chain", text: "0.8% per action, with a hard cap of 1% written into the program." },
  { icon: "radar", title: "Built-in exposure check", text: "See what any wallet reveals: holdings, first funder, counterparties and active hours." },
  { icon: "doc", title: "Statements with viewing keys", text: "Prove where funds came from to an exchange or accountant, without handing over control." },
  { icon: "server", title: "Nothing leaks to third parties", text: "Every chain, price and token request goes through VisionSwap. No logs, and explorer links are copy-only." },
  { icon: "check", title: "A program you can verify", text: "The live program's code fingerprint is published in the Docs for anyone to check." },
  { icon: "devices", title: "Works everywhere you trade", text: "Every major Solana wallet, on desktop and mobile. No extension, no download." },
  { icon: "crosshair", title: "Private orders", text: "Limit buys, DCA, take-profit in steps, stop-loss and trailing stops, each from a Vision wallet that nothing on-chain ties to you." },
  { icon: "repeat", title: "Payments on a random clock", text: "Schedule a payment and it leaves at an unpredictable moment, so it is much harder to tie to your deposit by timing." },
  { icon: "steps", title: "Limits that hold", text: "A limit buy never pays more than your price, and a take-profit step never sells for less than its own per token traded." },
  { icon: "trend", title: "Stop-losses first", text: "Confirmed on a fresh price, then first in line with a higher network priority." },
  { icon: "sliders", title: "Edit orders on the fly", text: "Move targets, tighten a stop or pause a DCA while it runs, with no new approval." },
  { icon: "clock", title: "Orders that never sleep", text: "Open orders and scheduled payments keep running through every site update." },
];

const STATUS: Record<Item[1], string> = { done: "Done", now: "In progress", next: "Planned" };

export default function RoadmapPage() {
  const root = useRef<HTMLDivElement>(null);
  useRise(root);
  useEffect(() => {
    document.title = "VisionSwap · Roadmap";
  }, []);
  return (
    <div ref={root} className="page roadmap">
      <Header />
      <main>
        <section className="page-hero">
          <div className="wrap">
            <p className="eyebrow rise">Roadmap</p>
            <h1 className="rise wide" style={{ ["--d" as string]: "80ms" }}>
              Built, shipped, and just getting started.
            </h1>
            <p className="lede rise wide" style={{ ["--d" as string]: "160ms" }}>
              VisionSwap went live on Solana mainnet on October 3, 2026. Here's what we've built, what we're shipping now, and where
              we're going next.
            </p>
            <div className="track rise" style={{ ["--d" as string]: "240ms" }} aria-label="Where we are now: phase 3, Growth">
              {PHASES.map((p) => (
                <div key={p.n} className={`track-step ${p.status}`}>
                  <i aria-hidden="true">{p.status === "now" && <b />}</i>
                  <span className="mono">Phase {p.n}</span>
                  <strong>{p.name}</strong>
                  {p.status === "now" && <em>We are here</em>}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="phases">
          <div className="wrap">
            <div className="timeline">
              {PHASES.map((p, pi) => (
                <article key={p.n} className={`phase ${p.status} rise`} style={{ ["--d" as string]: `${pi * 60}ms` }}>
                  <div className="phase-side">
                    <span className="phase-dot" aria-hidden="true">
                      <Icon name={p.icon} size={22} />
                    </span>
                  </div>
                  <div className="phase-card">
                    <header>
                      <div>
                        <span className="mono phase-n">Phase {p.n}</span>
                        <h2>{p.name}</h2>
                      </div>
                      <span className={`badge ${p.status}`}>{p.when}</span>
                    </header>
                    <ul>
                      {p.items.map(([t, s]) => (
                        <li key={t} className={s}>
                          <span className="tick" aria-label={STATUS[s]}>
                            {s === "done" ? <Icon name="check" size={15} /> : <i />}
                          </span>
                          <span>{t}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="firsts">
          <div className="wrap">
            <div className="why-head">
              <div>
                <p className="eyebrow rise">What sets us apart</p>
                <h2 className="rise">Already shipped. Already live.</h2>
              </div>
              <p className="body rise" style={{ ["--d" as string]: "80ms" }}>
                The features privacy traders on Solana have been asking for, working on mainnet today.
              </p>
            </div>
            <ul className="firsts-grid">
              {FIRSTS.map((f, i) => (
                <li key={f.title} className="rise" style={{ ["--d" as string]: `${(i % 3) * 70}ms` }}>
                  <span className="firsts-ico">
                    <Icon name={f.icon} size={20} />
                  </span>
                  <div>
                    <h3>{f.title}</h3>
                    <p>{f.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="cta-band">
          <div className="wrap cta-in">
            <h2 className="rise">Be early to private trading on Solana.</h2>
            <p className="rise" style={{ ["--d" as string]: "80ms" }}>
              Every feature above is live today. Open the app and try it.
            </p>
            <div className="hero-cta rise" style={{ ["--d" as string]: "160ms" }}>
              <a className="btn violet" href="/app">
                Open app
              </a>
              <a className="btn ghost light" href="/why">
                Why VisionSwap
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
