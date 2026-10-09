import { useEffect, useRef } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Icon, type IconName } from "../components/Icon";
import { Tilt } from "../components/Tilt";
import { useRise } from "../lib/rise";

type Feature = { icon: IconName; title: string; text: string; tech: string; href?: [string, string] };

const GROUPS: { kicker: string; title: string; lede: string; items: Feature[] }[] = [
  {
    kicker: "Built for traders",
    title: "Trade like nobody's watching.",
    lede: "Public wallets leak your strategy. VisionSwap keeps your entries, your stack and your history to yourself.",
    items: [
      {
        icon: "crosshair",
        title: "Invisible to copy-traders",
        text: "Copy-trade bots and wallet trackers follow known wallets. Every private buy comes from a brand-new Vision wallet with no history and no link to you, so there's nothing to follow.",
        tech: "A fresh keypair per buy, funded from the pool by a relayer",
      },
      {
        icon: "swap",
        title: "Any token, best route",
        text: "Buy anything Jupiter can route, priced across Solana's markets, with your choice of price room on every trade.",
        tech: "Jupiter routing · Auto, or your own room from 0.1% to 25%",
      },
      {
        icon: "eyeOff",
        title: "Your stack stays private",
        text: "Your private balance never shows up on-chain. Nobody can see how much you hold, or when you move it.",
        tech: "Amounts sealed inside notes that only your viewing key can read",
      },
      {
        icon: "repeat",
        title: "Sell straight back to privacy",
        text: "Sell from any Vision wallet and the SOL heads back into your private balance, ready for the next trade.",
        tech: "Swap, then a screened deposit into a fresh note",
      },
      {
        icon: "wallet",
        title: "Real wallets, fully yours",
        text: "Every Vision wallet is a standard Solana wallet. Export it to any Solana wallet app and keep trading from there.",
        tech: "Ed25519 keypairs derived from your account",
      },
      {
        icon: "qr",
        title: "Fund from anywhere",
        text: "Shield from your connected wallet in one tap, or scan a QR code to send from any wallet or exchange. No wallet connection needed.",
        tech: "Deposit addresses unique to your account",
      },
    ],
  },
  {
    kicker: "Pro orders, privately",
    title: "Set your levels. Walk away.",
    lede: "Limit buys, DCA, take-profits and stops that run on their own, even with the page closed, from Vision wallets that nothing on-chain ties to you.",
    items: [
      {
        icon: "crosshair",
        title: "Limit buys that hold your price",
        text: "Buy when the price drops to yours. Each fill is checked against the trade's own quote, so a limit buy never pays more than your limit, even on tokens that tax transfers.",
        tech: "The least you receive is written into the trade, on-chain",
      },
      {
        icon: "steps",
        title: "Take-profit in up to 4 steps",
        text: "Scale out as the price climbs. Each step sells its share at or above its own price per token traded, and the SOL heads home to your private balance.",
        tech: "Each step's price is a floor on the SOL it brings back",
      },
      {
        icon: "shield",
        title: "Stop-loss and trailing stop",
        text: "Set a fixed stop, or a trailing stop that rises with the price. Give the stop its own price room so it still sells in a fast drop. Even when a token's price feed goes quiet, a stop keeps checking a real sell quote.",
        tech: "Trails 1% to 50% below the highest price it has seen",
      },
      {
        icon: "bolt",
        title: "Stops come first",
        text: "A stop-loss arms on one price and sells on a newer one, so a single odd tick can't set it off. Then it goes to the front of the line, with a higher network priority.",
        tech: "Queue order: stop-loss, take-profit, limit buy, DCA",
      },
      {
        icon: "repeat",
        title: "DCA with natural timing",
        text: "Buy a little every hour, every few hours, daily or weekly. Varied timing moves each buy a little, so your buys keep no fixed rhythm. Pause and resume whenever you like.",
        tech: "Each buy moves up to 10% of the interval, at most 30 min, or Exact",
      },
      {
        icon: "sliders",
        title: "Edit live orders",
        text: "Move a take-profit, tighten a stop, add steps, change the price room or lower the amount while the order runs, with no new approval.",
        tech: "New terms apply from the very next price check",
      },
    ],
  },
  {
    kicker: "Trader controls",
    title: "Every trade, your way.",
    lede: "The controls you expect from a serious trading app, with every number shown before you confirm.",
    items: [
      {
        icon: "bolt",
        title: "Speed when it matters",
        text: "Pick Normal, Fast or Turbo. Faster speeds add a network priority fee, capped and shown up front, so your trade lands sooner when Solana is busy.",
        tech: "Faster landing when Solana is busy, cost shown before you confirm",
      },
      {
        icon: "sliders",
        title: "Your price room",
        text: "Auto picks a sensible price room for you, including room for tokens that tax transfers. Or tap a preset, or type your own.",
        tech: "Auto, presets from 0.5% to 10%, or custom from 0.1% to 25%",
      },
      {
        icon: "check",
        title: "Minimum received, guaranteed",
        text: "See the least you'll receive before you confirm. The trade is held to it on-chain: if the price moves past it, the trade stops instead of filling lower.",
        tech: "The minimum shown is the trade's on-chain threshold",
      },
      {
        icon: "coins",
        title: "Max and quick amounts",
        text: "Max fills in the most you can spend after every fee. 25%, 50%, 75% and 100% chips size a sale or an order in one tap.",
        tech: "Max is exactly what you can spend",
      },
      {
        icon: "wallet",
        title: "Spread a buy over many wallets",
        text: "Spread one token across up to 10 Vision wallets: new ones funded privately from the pool, or ones you funded already. They buy one after another with slightly different amounts, and sell the same share just as easily.",
        tech: "Paced, varied, harder to link",
      },
    ],
  },
  {
    kicker: "Payments on your terms",
    title: "Pay when, and how, you like.",
    lede: "Pay any address in one step straight from your wallet, or many people at once from your private balance, at a moment nobody can predict.",
    items: [
      {
        icon: "relay",
        title: "Pay any address in one step",
        text: "Type an address and an amount, and approve once in your wallet. Your SOL joins your private balance, then goes to the recipient from the pool by itself, right away or at a random moment. Your wallet never appears next to the payment.",
        tech: "One deposit of the exact size, proved in your browser once it joins",
      },
      {
        icon: "clock",
        title: "Send later, at a random moment",
        text: "Pick 15 minutes, an hour or a day, and each payment leaves at its own random moment inside it, so it doesn't land right after your deposit and is much harder to match to it by timing. Close the page; it still goes.",
        tech: "Proof made now, sent by the relayer inside your window",
      },
      {
        icon: "users",
        title: "Pay several people at once",
        text: "Send to up to 20 recipients in one go, each its own private payment. Sent now, they leave one by one at random moments over about two minutes.",
        tech: "Each recipient gets a payment and a proof of its own",
      },
      {
        icon: "check",
        title: "Arrives like any deposit",
        text: "Every private payment to another wallet or an exchange arrives as a standard SOL transfer from a one-time sending address, so exchanges and wallets credit it like any other deposit. Your activity keeps its Transaction ID.",
        tech: "Pool to a one-time address to the recipient, signed in your browser",
      },
      {
        icon: "link",
        title: "Payment links",
        text: "Ask anyone for SOL with a link. Each link gets a fresh address of yours, one per payer, and what they send lands in your private balance.",
        tech: "A fresh deposit address per link; your note never leaves the browser",
      },
      {
        icon: "devices",
        title: "Sign in with a passkey",
        text: "No wallet and nothing to copy: Face ID, a fingerprint or your phone opens your private account on any device it syncs to. It's confirmed with a second tap and backed up before you add any SOL.",
        tech: "Account key from the passkey's PRF output, made on your device",
      },
    ],
  },
  {
    kicker: "Privacy you can verify",
    title: "Math, not promises.",
    lede: "Zero-knowledge cryptography does the hiding, and the Solana program checks every step.",
    items: [
      {
        icon: "proof",
        title: "Zero-knowledge proofs",
        text: "Your device proves you own funds in the pool without revealing which deposit was yours. The program verifies every proof before it pays out.",
        tech: "Groth16 on BN254 · Poseidon hashing",
      },
      {
        icon: "relay",
        title: "Your wallet never appears",
        text: "A relayer submits private sends and Vision wallet funding, so your public wallet is never part of the transaction.",
        tech: "Recipient, amount and fees are sealed into the proof",
      },
      {
        icon: "layers",
        title: "One crowd of sealed notes",
        text: "Every deposit becomes a sealed note in one shared pool, and every note looks like all the others. Each new user makes everyone harder to trace.",
        tech: "A Merkle tree with room for 67 million notes",
      },
      {
        icon: "server",
        title: "Nothing leaks to third parties",
        text: "Chain data, prices and token lists all come through VisionSwap, so no outside service sees your IP next to your activity. No logs are kept.",
        tech: "Single-origin site · copy-only explorer links",
      },
    ],
  },
  {
    kicker: "Your money stays yours",
    title: "Your balance answers only to you.",
    lede: "Your private balance answers only to your keys. Orders get exactly the permission you give them, and nothing more.",
    items: [
      {
        icon: "lock",
        title: "Unfreezable by design",
        text: "Funds sit in a program-owned vault that only pays out against a valid proof made with your keys. As the program stands, no admin setting can move, freeze or redirect them, and private sends can't be paused.",
        tech: "Rules enforced by the Solana program · its code fingerprint is in the Docs",
      },
      {
        icon: "key",
        title: "Keys that never leave your device",
        text: "Your spending and viewing keys are made in your browser, from one wallet signature, a private key or a passkey, and never reach our servers.",
        tech: "Orders use a separate single-purpose key for each order",
      },
      {
        icon: "crosshair",
        title: "Orders on a short leash",
        text: "An order's key can move only the amount you set aside, from its own Vision wallet, and our order service sends every trade's result back to that wallet. Cancel any time and the permission is gone.",
        tech: "Amount capped on-chain · order keys deleted the moment an order ends",
      },
      {
        icon: "undo",
        title: "Deposits you can take back",
        text: "Every deposit is screened in a waiting room first. Changed your mind? Take it back, fee included, before it joins the pool.",
        tech: "Refunds go only to the depositing address",
      },
      {
        icon: "shield",
        title: "A screened, clean pool",
        text: "Every deposit is checked against sanctions lists, including who funded it, which keeps flagged money out of the pool withdrawals are paid from. Our relayer won't pay a sanctioned address either.",
        tech: "OFAC sanctions list, refreshed every 6 hours · recipients screened too",
      },
    ],
  },
  {
    kicker: "Built to stay up",
    title: "Running when it counts.",
    lede: "Your orders and payments keep going through updates, busy hours and relayer outages.",
    items: [
      {
        icon: "server",
        title: "Orders that never sleep",
        text: "Open orders and scheduled payments keep running through every site update, even with the page closed.",
        tech: "Order and payment state kept encrypted in durable storage",
      },
      {
        icon: "users",
        title: "Fair share when it's busy",
        text: "Trades, quotes, order price checks and display prices each have a guaranteed share of the price service, and trades get the most. So trades and stop-loss checks keep moving when the site is busy, and no single visitor can crowd anyone out.",
        tech: "Guaranteed lanes, plus reserved network room for sends",
      },
      {
        icon: "check",
        title: "Never traded twice",
        text: "Every order trade is written down before it is sent and settled from the chain, so nothing is ever bought or sold twice, even across a restart.",
        tech: "Recorded before sending, confirmed from the chain",
      },
      {
        icon: "relay",
        title: "Never stuck behind a relayer",
        text: "If the relayer is ever down, send it yourself: a fee wallet of yours, a fresh one for every payment, submits it instead, and the payment pays it back.",
        tech: "The proof names whichever fee payer you choose",
      },
      {
        icon: "lock",
        title: "A locked-down site",
        text: "A strict content security policy lets the site run only its own code. A key you choose to keep on a device is sealed so only that browser can open it.",
        tech: "CSP script-src 'self' (plus WASM) · AES-GCM, non-extractable browser key",
      },
    ],
  },
  {
    kicker: "Simple and transparent",
    title: "Everything in plain sight.",
    lede: "Clear fees, open tools, and it runs wherever you trade.",
    items: [
      {
        icon: "chart",
        title: "Fees enforced on-chain",
        text: "0.8% per private action, enforced by the program itself with a hard cap of 1%. Network costs come to about 0.002 SOL.",
        tech: "Fee rules written into the program",
      },
      {
        icon: "radar",
        title: "Free exposure check",
        text: "See what any wallet already gives away: holdings, first funder, repeat counterparties, even when its owner sleeps.",
        tech: "No account, no wallet connection, nothing saved",
        href: ["/check", "Check a wallet"],
      },
      {
        icon: "doc",
        title: "Proof of funds on demand",
        text: "Download a statement, with an optional viewing key, for an exchange or an accountant. It shows where your money came from and can never spend it.",
        tech: "Verifiable against the chain",
      },
      {
        icon: "devices",
        title: "Desktop and mobile",
        text: "Runs in your browser with every major Solana wallet, on any device. No extension, no download.",
        tech: "Wallet Standard and Mobile Wallet Adapter",
      },
      {
        icon: "flame",
        title: "$VSWAP buyback and burn",
        text: "Half of platform revenue buys and burns $VSWAP, and holders earn cashback on trading fees.",
        tech: "Bought on the open market, burned for good",
        href: ["/tokenomics", "See tokenomics"],
      },
    ],
  },
];

/** What a tracker sees: a public wallet next to a Vision wallet. Illustrative values. */
function TrackerCompare() {
  return (
    <div className="compare rise" style={{ ["--d" as string]: "160ms" }} aria-label="A public wallet next to a Vision wallet">
      <Tilt className="cmp-card public" max={6}>
        <header>
          <span className="cmp-who">
            <Icon name="wallet" size={18} />
            Public wallet
          </span>
          <span className="cmp-tag bad">Tracked</span>
        </header>
        <p className="cmp-addr mono">7xKX…3fAq</p>
        <dl>
          <div>
            <dt>Last buy</dt>
            <dd>48 SOL of a new token</dd>
          </div>
          <div>
            <dt>Funded by</dt>
            <dd>An exchange account</dd>
          </div>
          <div>
            <dt>Followed by</dt>
            <dd>Copy-trade bots, trackers</dd>
          </div>
        </dl>
      </Tilt>
      <Tilt className="cmp-card private" max={6}>
        <header>
          <span className="cmp-who">
            <Icon name="eyeOff" size={18} />
            Vision wallet #1
          </span>
          <span className="cmp-tag good">Private</span>
        </header>
        <p className="cmp-addr mono">9xWn…XyBkD</p>
        <dl>
          <div>
            <dt>Funded by</dt>
            <dd>The shared pool</dd>
          </div>
          <div>
            <dt>History</dt>
            <dd>None</dd>
          </div>
          <div>
            <dt>Link to you</dt>
            <dd>Nothing on-chain</dd>
          </div>
        </dl>
      </Tilt>
    </div>
  );
}

const BUY_STEPS = [
  ["Pick", "Choose any token and an amount from your private balance."],
  ["Prove", "Your device builds a zero-knowledge proof in seconds."],
  ["Fund", "A relayer funds a brand-new Vision wallet straight from the pool."],
  ["Swap", "The Vision wallet buys through Jupiter at the best route."],
  ["Own", "Your tokens sit in a wallet only you control, ready to sell or export."],
];

export default function WhyPage() {
  const root = useRef<HTMLDivElement>(null);
  useRise(root);
  useEffect(() => {
    document.title = "VisionSwap · Why VisionSwap";
  }, []);
  return (
    <div ref={root} className="page why">
      <Header />
      <main>
        <section className="page-hero">
          <div className="wrap">
            <div className="page-hero-grid">
              <div>
                <p className="eyebrow rise">Why VisionSwap</p>
                <h1 className="rise wide" style={{ ["--d" as string]: "80ms" }}>
                  Trade without being tracked.
                </h1>
                <p className="lede rise" style={{ ["--d" as string]: "160ms" }}>
                  Every Solana wallet is public. Wallet trackers, copy-trade bots and anyone with an explorer can follow your buys,
                  your size and your timing. VisionSwap gives you a private balance and a fresh, unlinkable wallet for every trade,
                  secured by zero-knowledge proofs.
                </p>
                <div className="hero-cta rise" style={{ ["--d" as string]: "240ms" }}>
                  <a className="btn" href="/app">
                    Open app
                  </a>
                  <a className="btn ghost" href="/#watch">
                    Watch the walkthrough
                  </a>
                </div>
              </div>
              <TrackerCompare />
            </div>
            <dl className="stats why-stats rise" style={{ ["--d" as string]: "300ms" }}>
              <div>
                <dt>Tokens you can trade</dt>
                <dd>Any</dd>
              </div>
              <div>
                <dt>Notes per pool</dt>
                <dd className="mono">67M</dd>
              </div>
              <div>
                <dt>Proof check on-chain</dt>
                <dd className="mono">&lt;200k CU</dd>
              </div>
              <div>
                <dt>Fee cap, in the program</dt>
                <dd className="mono">1%</dd>
              </div>
            </dl>
          </div>
        </section>

        {GROUPS.map((g, gi) => (
          <section key={g.kicker} className={`why-group ${gi % 2 ? "alt" : ""}`}>
            <div className="wrap">
              <div className="why-head">
                <div>
                  <p className="eyebrow rise">{g.kicker}</p>
                  <h2 className="rise">{g.title}</h2>
                </div>
                <p className="body rise" style={{ ["--d" as string]: "80ms" }}>
                  {g.lede}
                </p>
              </div>
              <div className={`feature-grid n${g.items.length}`}>
                {g.items.map((f, i) => (
                  <Tilt key={f.title} className="feature rise" style={{ ["--d" as string]: `${(i % 3) * 80}ms` }} max={5}>
                    <span className="feature-ico">
                      <Icon name={f.icon} />
                    </span>
                    <h3>{f.title}</h3>
                    <p>{f.text}</p>
                    <p className="feature-tech mono">{f.tech}</p>
                    {f.href && (
                      <a className="feature-link" href={f.href[0]}>
                        {f.href[1]} →
                      </a>
                    )}
                  </Tilt>
                ))}
              </div>
              {gi === 0 && (
                <div className="buy-flow rise">
                  <p className="eyebrow">How a private buy works</p>
                  <ol>
                    {BUY_STEPS.map(([t, d], i) => (
                      <li key={t}>
                        <span className="mono">{String(i + 1).padStart(2, "0")}</span>
                        <strong>{t}</strong>
                        <p>{d}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          </section>
        ))}

        <section className="cta-band">
          <div className="wrap cta-in">
            <h2 className="rise">Ready when you are.</h2>
            <p className="rise" style={{ ["--d" as string]: "80ms" }}>
              Open the app, shield some SOL, and make your first private trade in minutes.
            </p>
            <div className="hero-cta rise" style={{ ["--d" as string]: "160ms" }}>
              <a className="btn violet" href="/app">
                Open app
              </a>
              <a className="btn ghost light" href="/roadmap">
                See the roadmap
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
