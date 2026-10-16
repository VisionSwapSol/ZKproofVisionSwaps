import { useEffect, useRef, useState } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Icon, type IconName } from "../components/Icon";
import { useRise } from "../lib/rise";
import { API, SOCIAL } from "../lib/config";
import { copyText } from "../lib/copy";

const STEPS: { icon: IconName; label: string; title: string; text: string }[] = [
  {
    icon: "coins",
    label: "Cashback",
    title: "Holders earn cashback",
    text: "$VSWAP holders get cashback on all trading fees.",
  },
  {
    icon: "chart",
    label: "Buy",
    title: "Revenue buys $VSWAP",
    text: "50% of VisionSwap's platform revenue buys $VSWAP on the open market.",
  },
  {
    icon: "bolt",
    label: "Volume",
    title: "Buys add volume and rewards",
    text: "Every buyback adds real buy volume to the chart, and that volume creates more fee rewards, shared among holders.",
  },
  {
    icon: "flame",
    label: "Burn",
    title: "Every buyback is burned",
    text: "Tokens bought back are burned, permanently shrinking the supply, so every remaining $VSWAP is a bigger share of what's left.",
  },
  {
    icon: "repeat",
    label: "Repeat",
    title: "The cycle repeats",
    text: "More private trades bring more revenue, and the cycle runs again.",
  },
];

/** Five stations around a ring, with flowing arrows between them. */
function CycleFigure() {
  const C = 210;
  const R = 142;
  const at = (deg: number, r = R) => [C + r * Math.cos((deg * Math.PI) / 180), C + r * Math.sin((deg * Math.PI) / 180)] as const;
  const angle = (i: number) => -90 + i * 72;
  const arc = (i: number) => {
    const a0 = angle(i) + 15;
    const a1 = angle(i + 1) - 15;
    const [x0, y0] = at(a0);
    const [x1, y1] = at(a1);
    return `M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${R} ${R} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  return (
    <figure className="cycle-fig">
      <svg viewBox="-44 0 508 420" role="img" aria-label="The $VSWAP cycle: cashback, buy, volume, burn, repeat">
        <defs>
          <marker id="cyc-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="cyc-head" />
          </marker>
          <radialGradient id="cyc-core" cx="50%" cy="38%" r="70%">
            <stop offset="0%" stopColor="#a947ff" />
            <stop offset="60%" stopColor="#8804fe" />
            <stop offset="100%" stopColor="#5b02ad" />
          </radialGradient>
        </defs>
        <circle cx={C} cy={C} r={R} className="cyc-ring" />
        {STEPS.map((_, i) => (
          <path key={i} d={arc(i)} className="cyc-flow" markerEnd="url(#cyc-head)" style={{ animationDelay: `${i * -0.28}s` }} />
        ))}
        <circle cx={C} cy={C} r={74} fill="url(#cyc-core)" className="cyc-core" />
        <text x={C} y={C - 4} textAnchor="middle" className="cyc-ticker">
          $VSWAP
        </text>
        <text x={C} y={C + 20} textAnchor="middle" className="cyc-sub">
          the cycle
        </text>
        {STEPS.map((s, i) => {
          const [x, y] = at(angle(i));
          const [lx, ly] = at(angle(i), R + 48);
          const anchor = Math.abs(lx - C) < 12 ? "middle" : lx > C ? "start" : "end";
          return (
            <g key={s.label} className="cyc-node" style={{ ["--i" as string]: i }}>
              <circle cx={x} cy={y} r={27} />
              <text x={x} y={y + 6} textAnchor="middle" className="cyc-num">
                {i + 1}
              </text>
              <text x={lx} y={ly + 5} textAnchor={anchor} className="cyc-label">
                {s.label}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

function ContractAddress() {
  const [mint, setMint] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    fetch(`${API}/api/legal`)
      .then((r) => r.json())
      .then((l: { token?: string | null }) => setMint(l.token ?? null))
      .catch(() => setMint(null));
  }, []);
  if (mint === undefined) return <span className="muted">…</span>;
  if (!mint)
    return (
      <span>
        Published here and on{" "}
        <a href={SOCIAL.x} target="_blank" rel="noreferrer noopener">
          @VisionSwapSol
        </a>
        . Trust no other address.
      </span>
    );
  return (
    <span className="ca">
      <code className="mono">{mint}</code>
      <span className="ca-actions">
        <button
          type="button"
          className="link-btn"
          onClick={async () => {
            setCopied(await copyText(mint));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <a href={`https://solscan.io/token/${mint}`} target="_blank" rel="noreferrer noopener">
          Solscan
        </a>
      </span>
    </span>
  );
}

export default function TokenomicsPage() {
  const root = useRef<HTMLDivElement>(null);
  useRise(root);
  return (
    <div ref={root} className="page tokenomics">
      <Header />
      <main>
        <section className="page-hero">
          <div className="wrap page-hero-grid">
            <div>
              <p className="eyebrow rise">Tokenomics · $VSWAP</p>
              <h1 className="rise" style={{ ["--d" as string]: "80ms" }}>
                $VSWAP gets bought and burnt.
              </h1>
              <p className="lede rise" style={{ ["--d" as string]: "160ms" }}>
                Half of VisionSwap's platform revenue buys $VSWAP on the open market and burns it, and holders earn cashback on
                trading fees. Every private trade feeds the cycle.
              </p>
              <div className="hero-cta rise" style={{ ["--d" as string]: "240ms" }}>
                <a className="btn" href="#cycle">
                  See the cycle
                </a>
                <a className="btn ghost" href="/app">
                  Open app
                </a>
              </div>
            </div>
            <div className="token-card rise" style={{ ["--d" as string]: "140ms" }}>
              <div className="token-mark">
                <Icon name="flame" size={30} />
              </div>
              <p className="token-ticker">$VSWAP</p>
              <p className="token-net mono">Solana</p>
              <dl>
                <div>
                  <dt>Platform revenue to buybacks</dt>
                  <dd>50%</dd>
                </div>
                <div>
                  <dt>Every token bought back</dt>
                  <dd>Burned</dd>
                </div>
                <div>
                  <dt>Holder cashback</dt>
                  <dd>On all trading fees</dd>
                </div>
              </dl>
            </div>
          </div>
        </section>

        <section className="cycle" id="cycle">
          <div className="wrap">
            <p className="eyebrow rise">The cycle</p>
            <h2 className="rise">Buy. Burn. Reward. Repeat.</h2>
            <div className="cycle-grid">
              <div className="cycle-sticky rise">
                <CycleFigure />
              </div>
              <ol className="cycle-steps">
                {STEPS.map((s, i) => (
                  <li key={s.title} className="rise" style={{ ["--d" as string]: `${i * 70}ms` }}>
                    <span className="cycle-ico">
                      <Icon name={s.icon} />
                    </span>
                    <div>
                      <span className="mono cycle-n">{String(i + 1).padStart(2, "0")}</span>
                      <h3>{s.title}</h3>
                      <p>{s.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className="share">
          <div className="wrap share-grid">
            <div>
              <p className="eyebrow rise">Fair by design</p>
              <h2 className="rise">The more you hold, the more you earn.</h2>
              <p className="body rise">
                Rewards are shared in proportion to holdings, so every holder's share matches their stake. And because each buyback is
                burned, the supply only gets smaller: the same holding becomes a larger share of $VSWAP over time.
              </p>
            </div>
            <div className="share-card rise" style={{ ["--d" as string]: "120ms" }}>
              <p className="share-formula mono">
                your share <span>=</span> your $VSWAP <span>÷</span> total supply
              </p>
              <div className="share-bars" aria-hidden="true">
                {(
                  [
                    ["Today", 100],
                    ["After burns", 82],
                    ["After more burns", 66],
                  ] as [string, number][]
                ).map(([label, w]) => (
                  <div key={label} className="share-row">
                    <span>{label}</span>
                    <i style={{ ["--w" as string]: `${w}%`, ["--h" as string]: `${(1000 / w).toFixed(2)}%` }}>
                      <b />
                    </i>
                    <em>{(1000 / w).toFixed(1)}%</em>
                  </div>
                ))}
              </div>
              <p className="tiny">
                Illustration: a holding of 10 tokens out of a supply of 100. As burns shrink the supply, the same 10 tokens become a
                larger share.
              </p>
            </div>
          </div>
        </section>

        <section className="revenue">
          <div className="wrap">
            <p className="eyebrow rise">Where the revenue comes from</p>
            <h2 className="rise">Every private trade fuels $VSWAP.</h2>
            <div className="flow-row">
              <div className="flow-box rise">
                <Icon name="swap" />
                <h3>Private trades and transfers</h3>
                <p>Shields, private sends, buys and sells on VisionSwap each carry a 0.8% platform fee.</p>
              </div>
              <span className="flow-arrow rise" aria-hidden="true" />
              <div className="flow-box rise" style={{ ["--d" as string]: "90ms" }}>
                <Icon name="coins" />
                <h3>Platform revenue</h3>
                <p>The fee is enforced on-chain by the VisionSwap program and collected as revenue.</p>
              </div>
              <span className="flow-arrow rise" aria-hidden="true" />
              <div className="flow-box accent rise" style={{ ["--d" as string]: "180ms" }}>
                <Icon name="flame" />
                <h3>50% buys and burns $VSWAP</h3>
                <p>Half of that revenue buys $VSWAP on the open market, and every token bought is burned.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="details">
          <div className="wrap details-grid">
            <div>
              <p className="eyebrow rise">Token details</p>
              <h2 className="rise">$VSWAP at a glance.</h2>
            </div>
            <dl className="details-list rise" style={{ ["--d" as string]: "100ms" }}>
              <div>
                <dt>Ticker</dt>
                <dd>$VSWAP</dd>
              </div>
              <div>
                <dt>Network</dt>
                <dd>Solana</dd>
              </div>
              <div>
                <dt>Contract address</dt>
                <dd>
                  <ContractAddress />
                </dd>
              </div>
              <div>
                <dt>Buybacks</dt>
                <dd>50% of VisionSwap's platform revenue</dd>
              </div>
              <div>
                <dt>Supply</dt>
                <dd>Shrinks with every burn</dd>
              </div>
              <div>
                <dt>Holder rewards</dt>
                <dd>Cashback on all trading fees, shared by holding size</dd>
              </div>
            </dl>
          </div>
          <div className="wrap">
            <p className="fine rise">
              $VSWAP is VisionSwap's community token. You don't need it to use VisionSwap, and holding it doesn't make you an owner of
              VisionSwap or give you a claim on the pool or anyone's funds. The buyback, burn and reward program may change over time.
              Crypto tokens are volatile and can lose their value. Nothing here is financial advice.
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
