import { useEffect, useRef, useState } from "react";
import { Header } from "../components/Header";
import { EyesTile } from "../components/EyesTile";
import { Footer } from "../components/Footer";
import { ExposureBox } from "../components/ExposureBox";
import { PoolDiagram } from "../components/PoolDiagram";
import { CodeBand } from "../components/CodeBand";
import { LiveStats } from "../components/LiveStats";
import { Tilt } from "../components/Tilt";
import { DemoVideo } from "../components/DemoVideo";
import { Icon, type IconName } from "../components/Icon";
import { useRise } from "../lib/rise";
import { FEES } from "../lib/config";

/** Why holding $VSWAP shares in VisionSwap's revenue: the same facts as the Tokenomics page. */
const VSWAP_WHY: { icon: IconName; title: string; text: string }[] = [
  { icon: "coins", title: "Cashback on trading fees", text: "$VSWAP holders earn cashback on all trading fees, shared in proportion to how much they hold." },
  { icon: "chart", title: "Half the revenue buys $VSWAP", text: "50% of VisionSwap's platform revenue buys $VSWAP on the open market, adding real buy volume." },
  { icon: "flame", title: "Every buyback is burned", text: "Tokens bought back are burned for good, so the supply only gets smaller." },
  { icon: "trend", title: "A bigger share over time", text: "Your share is your $VSWAP divided by the total supply. As burns shrink the supply, the same holding becomes a bigger share." },
];
/** The tokenomics video's stations, in seconds. */
const VSWAP_CHAPTERS: [string, number][] = [
  ["Fees", 7.2],
  ["Buyback", 14.4],
  ["Burn", 21.6],
  ["Rewards", 28.8],
  ["Your share", 36],
  ["The cycle", 43.2],
];

export function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLElement>(null);
  const [shield, setShield] = useState(0);
  const [network, setNetwork] = useState<string | null>(null);
  useRise(root);
  useEffect(() => {
    document.title = "VisionSwap · Private sends and swaps on Solana";
  }, []);

  // the glasses slide on as the hero scrolls away
  useEffect(() => {
    const on = () => {
      const h = hero.current;
      if (!h) return;
      const r = h.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, -r.top / (r.height * 0.55)));
      setShield(t);
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <div ref={root} className="landing">
      <Header />

      <section ref={hero} className="hero">
        <div className="wrap hero-grid">
          <div className="hero-copy">
            <p className="eyebrow rise">
              {network && network !== "mainnet" ? `Preview on a Solana ${network === "localnet" ? "test network" : network}` : "Deployed on Solana Mainnet"}
            </p>
            <h1 className="rise" style={{ ["--d" as string]: "80ms" }}>
              Sunglasses for your Solana wallet.
            </h1>
            <p className="lede rise" style={{ ["--d" as string]: "160ms" }}>
              Private transfers, buys and sells for your Solana wallet. VisionSwap lets you send SOL and buy or sell any
              token without a trail leading back to your funding wallet.
            </p>
            <div className="hero-cta rise" style={{ ["--d" as string]: "240ms" }}>
              <a className="btn" href="/app">
                Open app
              </a>
              <a className="btn ghost" href="/app?start=qr">
                No wallet? Use a QR code
              </a>
            </div>
            <p className="hero-note rise" style={{ ["--d" as string]: "320ms" }}>
              Non-custodial. Zero-knowledge proofs. Works with Phantom, Solflare, Backpack and the rest, or with no wallet at all.
            </p>
          </div>
          <Tilt className="hero-art rise" style={{ ["--d" as string]: "120ms" }}>
            <EyesTile shield={shield} />
          </Tilt>
        </div>
        <LiveStats onStats={(st) => setNetwork(st.network ?? null)} />
      </section>

      <section className="watch" id="watch">
        <div className="wrap">
          <div className="watch-head">
            <div>
              <p className="eyebrow rise">See it in action</p>
              <h2 className="rise">Two minutes, start to finish.</h2>
            </div>
            <p className="body rise" style={{ ["--d" as string]: "100ms" }}>
              Connect, shield, buy, sell and send, plus how zero-knowledge proofs keep every step private. Watch the whole
              flow, or jump to the part you need.
            </p>
          </div>
          <div className="rise" style={{ ["--d" as string]: "140ms" }}>
            <DemoVideo />
          </div>
        </div>
      </section>

      <section className="glass" id="exposure">
        <div className="wrap glass-grid">
          <div>
            <p className="eyebrow rise">Exposure check</p>
            <h2 className="rise">Your wallet is a glass house.</h2>
            <p className="body rise">
              Paste an address and see what anyone can learn from it in a few seconds: what it holds, who paid it
              first, who it deals with, even when its owner goes to sleep.
            </p>
            <p className="body muted rise">No wallet needed. Nothing is saved.</p>
          </div>
          <div className="rise" style={{ ["--d" as string]: "120ms" }}>
            <ExposureBox />
          </div>
        </div>
      </section>

      <section className="how" id="how">
        <div className="wrap">
          <p className="eyebrow rise">How it works</p>
          <h2 className="rise">Shield. Blend. Spend.</h2>
          <div className="steps">
            <article className="step rise">
              <span className="num mono">01</span>
              <h3>Shield</h3>
              <p>
                Move SOL from your wallet into the shielded pool, or send it by QR code from any wallet or exchange. It
                becomes a sealed note that only you can open.
              </p>
            </article>
            <article className="step rise" style={{ ["--d" as string]: "100ms" }}>
              <span className="num mono">02</span>
              <h3>Blend</h3>
              <p>
                Your note sits among everyone else's, and from the outside they all look the same. The longer you
                wait, the bigger the crowd.
              </p>
            </article>
            <article className="step rise" style={{ ["--d" as string]: "200ms" }}>
              <span className="num mono">03</span>
              <h3>Spend</h3>
              <p>
                Send it to any address, or buy a token from a fresh Vision wallet. A relayer pays the network fee, so
                your own address never shows up.
              </p>
            </article>
          </div>
          <div className="rise">
            <PoolDiagram />
          </div>
          <p className="how-proof rise">
            Your browser builds a zero-knowledge proof that you own one of the notes in the pool, without saying which
            one. The Solana program checks the proof, pays out, and marks the note as spent. Nobody, us included, can
            tell which deposit paid for which withdrawal.
          </p>
        </div>
      </section>

      <CodeBand />

      <section className="actions" id="actions">
        <div className="wrap">
          <p className="eyebrow rise">What you can do</p>
          <h2 className="rise">Three things, done quietly.</h2>
          <div className="cards">
            {[
              {
                t: "Send privately",
                d: "Pay anyone on Solana, straight from your wallet or from your private balance. They receive SOL from the pool, not from you.",
                hid: "Your wallet and your balance",
                vis: "The amount they receive, and when",
              },
              {
                t: "Buy privately",
                d: "Pick any token Jupiter can route. VisionSwap funds a brand-new Vision wallet from the pool and buys with it.",
                hid: "Who the buyer really is",
                vis: "That a new wallet bought a token",
              },
              {
                t: "Sell privately",
                d: "Sell from a Vision wallet and the SOL goes straight back into your private balance.",
                hid: "Where the money ends up",
                vis: "A sale, then a deposit into the pool",
              },
            ].map((c, i) => (
              <Tilt key={c.t} className="card rise" style={{ ["--d" as string]: `${i * 90}ms` }} max={6}>
                <h3>{c.t}</h3>
                <p>{c.d}</p>
                <dl>
                  <div>
                    <dt>Hidden</dt>
                    <dd>{c.hid}</dd>
                  </div>
                  <div>
                    <dt>Still visible</dt>
                    <dd>{c.vis}</dd>
                  </div>
                </dl>
              </Tilt>
            ))}
          </div>
        </div>
      </section>

      <section className="firsts pro" id="pro">
        <div className="wrap">
          <div className="why-head">
            <div>
              <p className="eyebrow rise">Pro tools</p>
              <h2 className="rise">Trade like a pro. Leave no trail back to you.</h2>
            </div>
            <p className="body rise" style={{ ["--d" as string]: "80ms" }}>
              Set your levels once and they run on their own, even with the page closed, from Vision wallets that nothing
              on-chain ties to you.
            </p>
          </div>
          <ul className="firsts-grid">
            {PRO.map((f, i) => (
              <li key={f.t} className="rise" style={{ ["--d" as string]: `${(i % 3) * 70}ms` }}>
                <span className="firsts-ico">
                  <Icon name={f.icon} size={20} />
                </span>
                <div>
                  <h3>{f.t}</h3>
                  <p>{f.d}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="pro-more rise">
            <a className="feature-link" href="/why">
              Everything VisionSwap can do →
            </a>
            <a className="feature-link" href="/docs#orders">
              How orders work →
            </a>
          </p>
        </div>
      </section>

      <section className="keys">
        <div className="wrap keys-grid">
          <div>
            <p className="eyebrow rise">Your keys</p>
            <h2 className="rise">No new seed phrase.</h2>
          </div>
          <div className="keys-copy">
            <p className="body rise">
              Connect the wallet you already use. VisionSwap asks it to sign one message, and that signature becomes
              the key to your private balance and every Vision wallet you open. Clear your browser or switch
              computers, it doesn't matter. Sign again and everything is back.
            </p>
            <p className="body rise">
              Rather not connect a wallet? Open a private account with a private key instead, and shield by QR code from
              any wallet or exchange.
            </p>
            <p className="body muted rise">
              Your spending and viewing keys are made and kept in your browser, and our servers never see them: only your
              keys can spend your private balance. An order you place can trade exactly the amount you set aside for it,
              and you can cancel it any time.
            </p>
          </div>
        </div>
      </section>

      <section className="fees" id="fees">
        <div className="wrap">
          <p className="eyebrow rise">Fees</p>
          <h2 className="rise">Fees, plainly.</h2>
          <div className="fee-row">
            <div className="fee rise">
              <strong>{FEES.actionPct}</strong>
              <span>to shield SOL into your private balance</span>
            </div>
            <div className="fee rise" style={{ ["--d" as string]: "90ms" }}>
              <strong>{FEES.actionPct}</strong>
              <span>per private send, buy or sell</span>
            </div>
            <div className="fee rise" style={{ ["--d" as string]: "180ms" }}>
              <strong>{FEES.networkSol}</strong>
              <span>network costs, mostly rent for the records that stop a note being spent twice, plus a small relayer margin</span>
            </div>
          </div>
          <p className="body muted rise">Swaps are routed through Jupiter for the best price across Solana's markets.</p>
        </div>
      </section>

      <section className="vswap" id="vswap">
        <div className="wrap">
          <div className="watch-head">
            <div>
              <p className="eyebrow rise">$VSWAP</p>
              <h2 className="rise">Hold $VSWAP. Share in the revenue.</h2>
            </div>
            <p className="body rise" style={{ ["--d" as string]: "100ms" }}>
              Every shield, private send, buy and sell on VisionSwap carries a {FEES.actionPct} platform fee. Holding $VSWAP is how you
              share in it: through cashback, buybacks and burns.
            </p>
          </div>
          <ul className="vswap-why">
            {VSWAP_WHY.map((w, i) => (
              <li key={w.title} className="rise" style={{ ["--d" as string]: `${i * 70}ms` }}>
                <span className="vswap-ico">
                  <Icon name={w.icon} />
                </span>
                <h3>{w.title}</h3>
                <p>{w.text}</p>
              </li>
            ))}
          </ul>
          <div className="rise" style={{ ["--d" as string]: "140ms" }}>
            <DemoVideo
              src="/media/vswap-tokenomics.mp4"
              poster="/media/vswap-tokenomics.jpg"
              chapters={VSWAP_CHAPTERS}
              label="Watch how $VSWAP works"
              length="0:55"
              name="$VSWAP tokenomics video, with on-screen captions"
              playName="Play the $VSWAP tokenomics video, 55 seconds"
            />
          </div>
          <div className="hero-cta vswap-cta rise">
            <a className="btn" href="/tokenomics">
              See the tokenomics
            </a>
            <a className="btn ghost" href="/app">
              Open app
            </a>
          </div>
          <p className="tiny muted vswap-note">Not financial advice.</p>
        </div>
      </section>

      <section className="crowd">
        <div className="wrap">
          <p className="eyebrow rise">For everyone</p>
          <h2 className="rise">Privacy works better in a crowd.</h2>
          <p className="body crowd-lede rise">
            A private payment is only as private as the number of people it could have come from. Every note in the
            pool makes every other note harder to pick out, so each person who uses VisionSwap protects everyone else
            who does.
          </p>
          <div className="crowd-grid">
            <div className="rise">
              <h3>Open code</h3>
              <p>The Solana program, the circuits and this website are open source. Read them, check them, run your own relayer.</p>
            </div>
            <div className="rise" style={{ ["--d" as string]: "80ms" }}>
              <h3>A free exposure check</h3>
              <p>Anyone can see how exposed a wallet is. No account, no wallet connection, no logs.</p>
            </div>
            <div className="rise" style={{ ["--d" as string]: "160ms" }}>
              <h3>A guarded door</h3>
              <p>Wallets on sanctions lists are turned away at deposit. As the program stands, nobody, us included, can freeze a note or stop a withdrawal.</p>
            </div>
            <div className="rise" style={{ ["--d" as string]: "240ms" }}>
              <h3>Receipts on request</h3>
              <p>Export a statement that shows where your funds came from, for an exchange or an accountant, and nothing more.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="faq">
        <div className="wrap faq-grid">
          <h2 className="rise">Questions</h2>
          <div className="qa">
            {FAQ.map((f) => (
              <details key={f.q} className="rise">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

const PRO: { icon: IconName; t: string; d: string }[] = [
  {
    icon: "crosshair",
    t: "Limit buys that hold your price",
    d: "Buy when a token drops to your price. A limit buy never pays more than your limit, taxed tokens included.",
  },
  {
    icon: "steps",
    t: "Take-profit in steps",
    d: "Scale out in up to four steps as the price climbs. Each step sells at or above its own price per token traded.",
  },
  {
    icon: "shield",
    t: "Stop-loss and trailing stop",
    d: "A trailing stop rises with the price. Stops are confirmed on a fresh price, then go first in line.",
  },
  {
    icon: "repeat",
    t: "DCA with natural timing",
    d: "Buy a little every hour, day or week, with varied timing so your buys keep no fixed rhythm. Pause any time.",
  },
  {
    icon: "sliders",
    t: "Edit live orders",
    d: "Move a target, tighten a stop or change the price room while it runs, with no new approval.",
  },
  {
    icon: "bolt",
    t: "Every trade, your way",
    d: "Normal, Fast or Turbo when you trade now, and a minimum received that the chain holds every trade to, orders included.",
  },
];

const FAQ = [
  {
    q: "Does VisionSwap hold my money?",
    a: "No. Shielded SOL sits in a Solana program that only pays out against a valid proof made with your keys. We never see those keys, and nothing on our servers can spend your notes. Orders are the exception you choose: our order service holds a key that can trade exactly the amount you set aside, from that order's own Vision wallet, until the order ends or you cancel it.",
  },
  {
    q: "Can I use limit orders and stop-losses privately?",
    a: "Yes. Limit buys, DCA, take-profit in up to four steps, stop-loss and trailing stops all run from Vision wallets that nothing on-chain ties to you, and they keep running with the page closed.",
  },
  {
    q: "What can people still see?",
    a: "That your wallet put SOL into VisionSwap, and how much. That a withdrawal happened, how much, and where it went. What they can't see is the line between the two.",
  },
  {
    q: "How long should I wait before spending?",
    a: "There's no magic number. Before you send, the app tells you how many notes your withdrawal could have come from. Bigger is better, and round amounts that differ from your deposit help a lot.",
  },
  {
    q: "What if VisionSwap disappears?",
    a: "Your notes live on Solana, not on our servers. The code is open, so anyone can run the app and a relayer, and the program pays out to any valid proof.",
  },
  {
    q: "Is this legal?",
    a: "Financial privacy is legal in most places, and it should be. VisionSwap turns away wallets on sanctions lists, and its terms rule out use from sanctioned places. Check the rules where you live before you use it.",
  },
];
