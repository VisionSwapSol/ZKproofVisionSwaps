import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { api, conn, explorerAccount } from "../lib/net";
import { measuredMsPerSlot, msPerSlotFromSamples, saveMsPerSlot, slotsToText } from "../lib/slottime";
import { PAGES, longDate } from "../seo/pages";
import { BUSINESS_EMAIL, SUPPORT_EMAIL, mailto } from "../lib/contacts";

type Info = {
  network: string;
  programId: string;
  feeBps: number;
  depositDelaySlots: string;
  /** Solana's measured slot time, when the server publishes it (slots have run at about 0.2 s, not 0.4 s, since October 2026) */
  msPerSlot?: number;
  minDeposit: string;
  maxDeposit: string;
  tvlCap?: string;
  treasury: string;
  /** what the relayer charges a payment now (lamports), when one runs */
  relayerFee?: string;
  accounts?: { config: string; vault: string; tree: string };
  program?: { dataAddress: string; upgradeAuthority: string | null; deployedSlot: number; sha256: string; size: number } | null;
};

/** The order service's floors and bounds (GET /api/orders/limits). */
type Limits = {
  minSellUsd: number;
  minBuyLamports: string;
  minDcaBuyLamports: string;
  minDcaEverySec: number;
  maxDcaEverySec: number;
  dcaCount: [number, number];
  maxSlippageBps: number;
  trailPct: [number, number];
  maxLegs: number;
  maxDays: number;
};

/** What the order service uses when nothing else is set, shown until the live values arrive. */
const LIMITS: Limits = {
  minSellUsd: 2,
  minBuyLamports: "20000000",
  minDcaBuyLamports: "5000000",
  minDcaEverySec: 3600,
  maxDcaEverySec: 2_592_000,
  dcaCount: [2, 100],
  maxSlippageBps: 2500,
  trailPct: [1, 50],
  maxLegs: 4,
  maxDays: 90,
};

const SECTIONS: [string, string][] = [
  ["what", "What VisionSwap is"],
  ["how", "How a private payment works"],
  ["visible", "What stays hidden"],
  ["vision", "Vision wallets"],
  ["qr", "Shielding by QR code"],
  ["trading", "Buying and selling"],
  ["several", "Several wallets at once"],
  ["orders", "Orders: the basics"],
  ["limit", "Limit buys and DCA"],
  ["tpsl", "Take-profit and stops"],
  ["managing", "Editing, pausing, cancelling"],
  ["status", "Order statuses"],
  ["waits", "Why a trade might wait"],
  ["fromwallet", "Paying from your wallet"],
  ["later", "Sending later"],
  ["split", "Paying several people"],
  ["links", "Payment links"],
  ["backup", "Sending it yourself"],
  ["exchanges", "Sending to an exchange"],
  ["fees", "Fees and limits"],
  ["keys", "Your keys"],
  ["passkeys", "Passkeys"],
  ["android", "The Android app"],
  ["security", "Security and trust"],
  ["onchain", "Check it on-chain"],
  ["compliance", "Screening and the waiting room"],
  ["faq", "Questions"],
  ["developers", "For developers"],
];

/** More SOL than exists: how the program's settings say "no limit". */
const UNLIMITED = 10n ** 18n;
const noMax = (i: Info) => BigInt(i.maxDeposit) >= UNLIMITED;
const noCap = (i: Info) => i.tvlCap != null && (BigInt(i.tvlCap) === 0n || BigInt(i.tvlCap) >= UNLIMITED);
const sol = (l: string | bigint) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });
const span = (sec: number) => (sec === 86_400 ? "day" : sec === 3600 ? "hour" : sec % 86_400 === 0 ? `${sec / 86_400} day${sec === 86_400 ? "" : "s"}` : sec % 3600 === 0 ? `${sec / 3600} hour${sec === 3600 ? "" : "s"}` : `${Math.round(sec / 60)} minutes`);

/** The deposit limits exactly as the program's settings hold them right now. */
function limitsText(i: Info): string {
  let rest: string;
  if (noMax(i) && noCap(i)) rest = "There is no largest deposit and no cap on the pool's size.";
  else {
    const max = noMax(i) ? "There is no largest deposit" : `The largest single deposit is ${sol(i.maxDeposit)} SOL`;
    const cap = i.tvlCap == null ? "" : noCap(i) ? ", and there is no cap on the pool's size" : `, and the pool holds at most ${sol(i.tvlCap)} SOL for now`;
    rest = `${max}${cap}.`;
  }
  return `Deposits start at ${sol(i.minDeposit)} SOL. ${rest}`;
}

function Proof({ label, address, network, children }: { label: string; address: string; network: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <a className="mono proof-addr" href={explorerAccount(address, network)} target="_blank" rel="noreferrer noopener">
          {address}
        </a>
        <span>{children}</span>
      </dd>
    </div>
  );
}

const FAQ: [string, string][] = [
  [
    "Do my orders run with the page closed?",
    "Yes. Orders and scheduled payments run on VisionSwap's servers and keep running through site updates. A few tidy-ups wait for your next visit on the device that placed the order: a sale's SOL moving into your private balance (or tap Move back to private balance in the Wallets tab on any device), and the clean-up of an order that ended. A scheduled payment that needs a fresh proof, and paid payment links, also wait for VisionSwap to be open.",
  ],
  [
    "Can an order spend more than I set aside?",
    "No. The token program caps each order's permission at the amount you first set aside, from that one Vision wallet. Lowering an order needs no approval: the on-chain cap stays at the first amount, and the order service trades only the new one. To shrink the permission itself, cancel and place a new order. Raising an order means placing a new one.",
  ],
  [
    "Will a limit buy ever pay more than my price?",
    "No. Before a limit buy or a take-profit trades, its own quote is checked against your price, and the least the trade must deliver is written into the transaction. If the market can't meet your price, the order keeps waiting instead.",
  ],
  [
    "Why did my stop-loss sell below its price?",
    "A stop-loss is there to get you out. Once a newer price confirms the drop, it sells at the market, within its price room. In a fast fall the market can already be below your stop by then. A wider stop-loss room makes it more likely to go through.",
  ],
  [
    "I placed an order on my phone. Can I see it on my laptop?",
    "Your laptop finds the order's permission on your Vision wallet and shows it as an order from this account, which you can cancel there. Its prices and fills show on the device that placed it.",
  ],
  [
    "Can I change a take-profit without cancelling?",
    "Yes. Tap Edit on the order: move prices, add or remove steps, change the stop, the price room or the end date, or lower the amount. The new terms apply from the next price check, with no new approval.",
  ],
  [
    "I paid SOL to fresh wallets of mine. Where is it?",
    "In your Vision wallets, and only you control them. Open the Wallets tab: each one is listed from the moment you pay it, as arriving until the SOL lands. From there you can buy a token with it, move it back to your private balance, send it to any address, or show its private key.",
  ],
  [
    "What if I close the page while several wallets are buying?",
    "Nothing is lost. Wallets that haven't had their turn keep their SOL (or, for new wallets, nothing was spent for them yet). The next time you open VisionSwap on the same device, it checks where the interrupted wallet got to and asks whether to continue or stop. Nothing is ever paid or bought twice.",
  ],
  [
    "Why does Send later sometimes go earlier than I expected?",
    "Each payment goes at a random moment inside the window you chose, and when the pool is busy it may go a little early, still inside your window, so its proof stays valid.",
  ],
];

export default function DocsPage() {
  const [info, setInfo] = useState<Info | null>(null);
  const [lim, setLim] = useState<Limits>(LIMITS);
  const [sampled, setSampled] = useState<number | null>(null);
  useEffect(() => {
    api<Info>("/api/pool/info").then(setInfo).catch(() => {});
    api<Partial<Limits>>("/api/orders/limits")
      .then((l) => setLim({ ...LIMITS, ...l }))
      .catch(() => {});
    // the network's own recent slot time (kept for next time too)
    conn()
      .getRecentPerformanceSamples(6)
      .then((s) => {
        const ms = msPerSlotFromSamples(s);
        if (ms) {
          saveMsPerSlot(ms);
          setSampled(ms);
        }
      })
      .catch(() => {});
  }, []);
  // the waiting room is set in slots; it is put in time only from a measured slot time (the server's
  // figure, the network's, or the one this device measured last), never a fixed 0.4 s
  const delay = info ? slotsToText(info.depositDelaySlots, measuredMsPerSlot(info.msPerSlot, sampled)) : null;
  const waitFor = delay ? ` for ${delay}` : " for a short while (the app shows the time left)";
  const fee = info ? `${info.feeBps / 100}%` : "0.8%";

  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap docs">
        <aside className="docs-nav">
          <p className="eyebrow">Docs</p>
          <nav>
            {SECTIONS.map(([id, t]) => (
              <a key={id} href={`#${id}`}>
                {t}
              </a>
            ))}
          </nav>
        </aside>
        <article className="prose">
          <h1>How VisionSwap works</h1>
          <p className="lede">
            The short version: you put SOL into a shared pool, and later take it out somewhere else. A zero-knowledge proof convinces the
            Solana program that the money is yours without saying which deposit it came from.
          </p>
          <p className="muted docs-updated">
            Last updated {longDate(PAGES.docs.updated)}. Short answers to common questions are in the <a href="/faq">FAQ</a>.
          </p>

          <h2 id="what">What VisionSwap is</h2>
          <p>
            VisionSwap is a shielded pool for SOL on Solana, plus an app that uses it to send SOL and to buy and sell any token, paid
            from the pool instead of from the wallet you started from. The pool is a Solana program. The app runs in your browser. A small server
            relays transactions, serves public pool data, sends scheduled payments and runs your orders. It never holds the keys to your
            private balance.
          </p>

          <h2 id="how">How a private payment works</h2>
          <ol>
            <li>
              <strong>Shield.</strong> You deposit SOL from your wallet, or send it by QR code from any wallet or exchange. The deposit
              carries a <em>commitment</em>: a hash of the amount, your private key's public half and a random value. Only you can open it.
            </li>
            <li>
              <strong>Wait.</strong> The deposit sits in a public waiting room{info ? waitFor : ""} while
              it is screened, then anyone can add it to the pool's Merkle tree. Every note in the tree looks alike.
            </li>
            <li>
              <strong>Spend.</strong> To send, your browser builds a Groth16 proof that you own some notes in the tree and that the
              amounts add up, without revealing which notes. It also reveals a <em>nullifier</em> for each note, a value that marks it as
              spent without pointing to it. The program checks the proof, records the nullifiers so the notes can never be spent again,
              and pays the recipient.
            </li>
            <li>
              <strong>Relay.</strong> A relayer signs and pays for that transaction, so your own wallet never appears in it. The
              recipient, the amount, the relayer's fee and the highest pool fee you accept are bound into the proof, so the relayer cannot
              change them.
            </li>
            <li>
              <strong>Deliver.</strong> A payment to an address outside your own VisionSwap wallets is paid to a one-time sending
              address made for that payment, and that address passes the exact amount on in a standard SOL transfer your browser signed
              beforehand. Every private payment to another wallet or an exchange arrives as a standard SOL transfer from a one-time
              sending address, so exchanges and wallets credit it like any other deposit. Anyone can see that the payment came out of
              the pool; the proof keeps which deposit paid for it to itself.
            </li>
          </ol>

          <h2 id="visible">What stays hidden, and what doesn't</h2>
          <p>
            Hidden: which deposit paid for which withdrawal (no transaction says), and your private balance. Visible to everyone, as on
            any blockchain: that a wallet deposited into the pool, how much and when; that a withdrawal happened, how much, when and where
            it went; and how much the pool holds in total. A few private steps are recognisable for what they are, though not whose they
            are: a transfer inside the pool that joins or cuts notes (it pays only the relayer's fee), a payment's one-time sending
            address (one step from the pool), and a payment sent later (its delivery is co-signed by the relayer's published key).
          </p>
          <p>
            That means your privacy grows with the crowd and with good habits. The proof hides which deposit paid, but amounts and timing
            can still match the two: if you shield 3.217 SOL and someone receives 3.19 SOL a minute later while the pool is quiet, an
            observer can guess. A payment from your wallet deposits a standard amount and keeps the rest private as change, so its
            deposit doesn't mirror the payment, and sending it later keeps their timing apart too. Wait, use amounts that differ from your
            deposit, send later, and never send back to the wallet you shielded from. The app reminds you.
          </p>

          <h2 id="vision">Vision wallets</h2>
          <p>
            Buying privately funds a brand-new Solana address, a Vision wallet, straight from the pool, and swaps through Jupiter from
            there. The pool keeps which deposit paid for it to itself, so the wallet doesn't start from yours. From then on, a Vision
            wallet is an ordinary public wallet: its funding from the pool, its trades and its deposits back into the pool are visible and
            connected to each other, so use a fresh one when you want a fresh start. Selling from a Vision wallet sends the SOL back into
            the pool. Vision wallets are ordinary Solana keypairs derived from your account, so you can export any of them into another
            Solana wallet app.
            On a new device, the app finds your earlier Vision wallets from their on-chain history; <strong>Check for more</strong> in the
            Wallets tab looks again.
          </p>
          <p>
            The <strong>Wallets</strong> tab lists them all, in a fixed order by number, each with its SOL, the tokens it holds and a
            status: <strong>Ready to use</strong>, <strong>Holds tokens</strong>, <strong>Buy to finish</strong> (its swap didn't finish
            and the pool fee is already paid), <strong>Too small to move</strong> or <strong>Arriving</strong> (SOL on its way from a
            payment you made to it). From each one you can buy a token, <strong>move it back to your private balance</strong>, send it to
            an address (an ordinary, public transfer), show its private key, or give it a name that stays on this device. These actions
            run quietly in the background, one at a time: tap another wallet while one runs and it waits its turn as{" "}
            <strong>Next in line</strong>. Each result shows on its own row, and an emptied wallet stays where it was until your next
            visit, then folds into <strong>Emptied wallets</strong>.
          </p>
          <p>
            <strong>+ Fund new wallets</strong> pays 2 to 10 new Vision wallets from your private balance in one go, each in its own
            private payment: now (spread over about 2 minutes) or at a random moment within 15 minutes, 1 hour or 24 hours. They show as
            arriving straight away. On the Send tab, <strong>+ A fresh wallet of mine</strong> does the same for one wallet, and payments
            to your own wallets read "Vision wallet #N (yours)" everywhere.
          </p>

          <h2 id="qr">Shielding by QR code</h2>
          <p>
            Every account has deposit addresses: ordinary Solana addresses whose keys come from your account, like Vision wallets. The
            Shield tab shows one as a QR code. Send SOL to it from any wallet or exchange, without connecting anything. When it arrives,
            the app screens where it came from and moves it into the waiting room, then it joins your private balance like any deposit.
            The deposit takes everything at the address; only the waiting room's small account deposit comes back to it afterwards
            (see below), and it stays there until that address's next deposit.
          </p>
          <p>
            What arrives pays for its own deposit: the pool fee, Solana's network fee, and a small account deposit for the waiting room
            that returns to the address when your SOL joins the pool. The app shows the smallest amount worth sending. If less arrives,
            it waits at the address until more does. If a single deposit would go over the pool's per-deposit limit, the app splits it
            into as few deposits as fit. A deposit you take back returns to the deposit address and waits there for you: move it into the
            pool again, or send it to any wallet. Only your account holds these addresses' keys, and you can export any of them.
          </p>

          <h2 id="trading">Buying and selling</h2>
          <p>
            <strong>Buy</strong> picks any token Jupiter can trade and an amount from your private balance; <strong>Sell</strong> picks a
            holding in one of your Vision wallets. Before you confirm, the app shows the route, the fees and the{" "}
            <strong>minimum you'll receive</strong>. That minimum is the trade's on-chain threshold: if the price moves past it, the trade
            stops instead of filling lower.
          </p>
          <ul>
            <li>
              <strong>Price room</strong> is how far the price may move while the trade goes through. <strong>Auto</strong> picks it for
              you and leaves room for tokens that tax transfers. Or tap 0.5%, 1%, 3%, 5% or 10%, or type your own from 0.1% to 25%.
            </li>
            <li>
              <strong>Speed</strong>: Normal pays the usual small network fee, and a try that doesn't land is retried with a little more.
              Fast and Turbo add a network priority fee so the trade lands sooner when Solana is busy, at most 0.0015 SOL and 0.005 SOL.
              The app remembers your choice on that device.
            </li>
            <li>
              <strong>Max</strong> fills in the most you can spend once every fee is counted. On a sale, the 25%, 50%, 75% and 100% chips
              size it in one tap.
            </li>
            <li>
              <strong>Pay with: My Vision wallets</strong> buys with SOL already in your Vision wallets (ones holding only SOL), with no
              pool fee. <strong>Buy a token</strong> on a wallet in the Wallets tab opens it with that wallet ticked.
            </li>
          </ul>
          <p>
            When a sale's SOL is big enough for a deposit, it goes straight back into the pool. Selling from a wallet that also has a live
            take-profit or stop-loss asks first, and the order is lowered (or ended) only once the sale has gone through.
          </p>

          <h2 id="several">Several wallets at once</h2>
          <p>You can spread one token over several Vision wallets, up to 10 in one go, or act on several wallets together:</p>
          <ul>
            <li>
              <strong>From your private balance</strong>: <strong>Spread across</strong> 2, 3, 5 or 10 new wallets. The amount is the
              total. Each new wallet gets its part, plus a little SOL it keeps for its own fees, in its own private payment, so each part
              pays the pool fee and a relayer fee. The fee SOL comes back when a wallet is emptied.
            </li>
            <li>
              <strong>With wallets you funded already</strong>: tick them under <strong>My Vision wallets</strong>, then choose{" "}
              <strong>Same in each</strong> or <strong>All of it</strong> (everything except what each keeps for its fees). No pool fee.
            </li>
            <li>
              <strong>Selling</strong>: pick a holding, then <strong>All wallets holding</strong> that token, and sell 25%, 50%, 75% or all
              of each wallet's holding. Each wallet's SOL goes back to your private balance right after its sale.
            </li>
            <li>
              <strong>Moving back or sending</strong>: tick wallets in the Wallets tab and use the bar that appears. Sending several
              wallets to one address shows on-chain that they belong together.
            </li>
          </ul>
          <p>
            <strong>Timing.</strong> The wallets take their turns one at a time. <strong>One after another</strong>, the default, waits a
            random 10 to 60 seconds between them. <strong>Back to back</strong> is fastest, about 6 seconds apart, and makes it easier to
            see the wallets belong together. Wallets that buy the same token at the same moment with the same amount are easy to group on
            the chain, so spacing them out and varying each amount a little (up to 3%, on by default) makes them harder to link. Prices can
            move between wallets. With One after another, each wallet trades at the price of its own turn, within your price room; with
            Back to back, the least each one may get is its share of the quote you saw. With One after another, when a new wallet's
            funding needs pieces of your private balance joined first, the joins get a turn of their own and the funding and buy come
            at the next turn, after another random gap, so the joins never run back to back with the payment.
          </p>
          <p>
            <strong>Progress, and closing the page.</strong> A card shows each wallet as it goes: waiting, its turn coming up, done with its
            transaction link, or didn't go through with the reason. One that doesn't go through never stops the rest, and{" "}
            <strong>Try those again</strong> gives just those another turn at a fresh price. Keep the page open while it runs. If you close
            it, the wallets that haven't had their turn keep their SOL, and the next time you open VisionSwap on the same device it asks{" "}
            <strong>Continue</strong> or <strong>Stop</strong>. It first checks where an interrupted wallet got to, so nothing is paid or
            bought twice: a wallet whose SOL had already arrived finishes its buy there, with no second pool fee. A batch runs in one tab at
            a time; another tab of the same browser shows its progress and leaves it to that tab.
          </p>

          <h2 id="orders">Orders: the basics</h2>
          <p>
            Place a <strong>limit buy</strong> or a <strong>DCA</strong> on the Buy tab, and a <strong>take-profit</strong>, a{" "}
            <strong>stop-loss</strong>, a <strong>trailing stop</strong> or a mix of them on the Sell tab. They run on their own, even with
            the page closed, and keep running through site updates. A buy order funds a fresh Vision wallet from the pool, not from your
            wallet, and makes all of its buys from that one wallet; a sell order watches tokens you already hold in a Vision wallet.
          </p>
          <p>
            <strong>How the permission works.</strong> Each order has its own single-purpose key, derived from your account. The Vision
            wallet gives that key permission, on-chain, over exactly the amount the order sets aside: those tokens for a sell, or that SOL
            (held as wrapped SOL) for a buy. The token program caps it at that amount; VisionSwap's order service trades only for that
            order and sends the result back to the same Vision wallet. The permission covers the whole amount for the order's whole life
            (for a DCA, its full budget), and while it lasts the order service holds the key that uses it. The order service keeps order
            details encrypted at rest and deletes an order's key from its records the moment the order ends. Cancelling removes the
            permission on-chain.
          </p>
          <p>
            <strong>How a trade runs.</strong> The order service watches prices from Jupiter: every few seconds when the price is close to
            your trigger, less often when it's far away (a trailing stop at least every 30 seconds, any stop-loss at least every 2 minutes).
            When the order fires, the service moves the order's amount into a temporary account of the order key and swaps it through
            Jupiter in the same transaction, then sends the result to your Vision wallet. If any part fails, nothing moves. Every trade is
            written down before it is sent and confirmed from the chain, so nothing is ever bought or sold twice. Our relayer pays the
            network fee for order trades.
          </p>
          <p>
            <strong>Where the proceeds go.</strong> A buy's tokens land in its Vision wallet. A sale's SOL waits in the Vision wallet and
            moves into your private balance by itself the next time VisionSwap is open on the device that placed the order; on any other
            device, tap <strong>Move back to private balance</strong> in the Wallets tab.
          </p>
          <p>
            <strong>Sizes.</strong> Sell orders start at about ${lim.minSellUsd} worth of tokens, limit buys at {sol(lim.minBuyLamports)} SOL,
            and each DCA buy at {sol(lim.minDcaBuyLamports)} SOL. A limit buy or a sell order stays open for 1 day, 1 week, 30 days or 90
            days, as you choose. The app checks all of this before it moves any funds.
          </p>

          <h2 id="limit">Limit buys and DCA</h2>
          <p>
            A <strong>limit buy</strong> buys when the price is at or below yours. The -5% to -30% chips beside the price box set it from
            today's price in one tap. When the price gets there, the trade's own quote is checked: each token must cost no more than your
            limit, counting any transfer tax the token takes on arrival. The least the trade must deliver is written into the transaction,
            so a limit buy <strong>never pays more than your price</strong>. If the market can't meet it, the order simply keeps waiting.
          </p>
          <p>
            A <strong>DCA</strong> spends a total in equal buys: {lim.dcaCount[0]} to {lim.dcaCount[1]} of them (the app offers 4, 7, 14 or
            30), every {span(lim.minDcaEverySec)} to every {span(lim.maxDcaEverySec)} (the app offers every hour, 4 hours, day or week). The
            first buy goes within a couple of minutes. DCA buys at the market, within your price room. <strong>Timing</strong> is Varied by
            default: each buy moves by up to 10% of the interval, at most 30 minutes either way, so your buys keep no fixed rhythm. Choose
            Exact to buy right on time. Pause and resume a DCA whenever you like; paused time is added to its end date. A DCA ends a week
            after its last buy is due, or if it stays paused for 90 days.
          </p>

          <h2 id="tpsl">Take-profit, stop-loss and trailing stops</h2>
          <ul>
            <li>
              <strong>Take-profit</strong> sells at or above your price. Choose one price for the whole amount, or{" "}
              <strong>sell in steps</strong>: up to {lim.maxLegs} steps, each selling its share (25%, 50% and so on) at its own price. Like
              a limit buy, each step checks the trade's own quote and writes the least SOL it must bring back into the transaction, so a step
              <strong> never sells for less than its price</strong> per token traded. On a token that taxes transfers, that price is measured
              after the extra tax the order's own move pays. If the route can't meet it, it waits and tries again.
            </li>
            <li>
              <strong>Stop-loss</strong> sells at or below your price. It <strong>arms</strong> on one price and sells on a{" "}
              <strong>newer</strong> one that confirms the drop, so a single odd tick can't set it off. If the price comes back above the
              stop first, it starts over. Stop-losses go to the front of the queue and pay a higher network priority, so they land first.
              Even when a token stops getting prices, a stop-loss keeps protecting you: after a few minutes without one, it checks a real
              sell quote every 2 minutes and sells if that quote is at or below the stop.
            </li>
            <li>
              <strong>Trailing stop</strong> follows the highest price it has seen since the order started (or since you last changed it) and sells
              if the price falls a set percentage below it: {lim.trailPct[0]}% to {lim.trailPct[1]}% (the app offers 5% to 30%). It only
              ever moves up. Each order uses a fixed stop or a trailing stop, as you choose.
            </li>
          </ul>
          <p>
            A take-profit (or its steps) and a stop can sit on one order: whichever price comes first sells its part. The stop-loss always
            sells what is left. <strong>Price room</strong> for an order is 3% to 20% (3% to 10% for DCA; 10% by default for sells, 5% for buys). The stop-loss can
            have its <strong>own price room</strong>, 5% to 25%, so it still sells in a fast drop; Same uses the order's. A stop-loss sells
            at the market within that room, so in a sharp fall it can sell below its price.
          </p>
          <p>
            Tokens that tax transfers pay that tax one extra time when a sell order runs, because the tokens move once more; the order form
            shows the token's rate.
          </p>

          <h2 id="managing">Editing, pausing and cancelling</h2>
          <ul>
            <li>
              <strong>Edit</strong> a live order under Orders: move or add take-profit steps, set or remove a stop or a trailing stop,
              change either price room, keep it open longer, or lower the amount, with <strong>no new approval</strong>. New prices are
              checked against today's first, and the new terms apply from the next price check: a trade waiting its turn is looked at
              again under them, and a stop-loss starts its confirmation afresh. While a trade is going through, try the edit again in a
              minute. The amount can only go down. The on-chain permission stays at the amount you first set aside, and the order service
              trades only the new amount; to shrink the permission itself, or to add more, cancel and place a new order.
            </li>
            <li>
              <strong>Pause</strong> and <strong>Resume</strong> a DCA at any time; its <strong>Settings</strong> change the price room
              and the timing. A DCA's total can't change: cancel it and start a new one.
            </li>
            <li>
              <strong>Cancel</strong> removes the permission on-chain. A sell order's tokens stay in the Vision wallet. A buy order's
              SOL goes back into the pool through the waiting room, with the usual pool fee, or stays in the Vision wallet if it's below
              the smallest deposit (Send to an address in the Wallets tab moves it). If a trade was already on its way, it settles first, and the order shows as filled if
              it lands.
            </li>
            <li>
              When an order ends any other way, its key is already deleted, and the app removes any permission left on-chain (and brings a
              buy's SOL home) by itself the next time it's open on the device that placed the order. If it can't, for example when the
              wallet lacks SOL for the fee, the row offers <strong>Remove its permission</strong> or <strong>Get SOL back</strong>.
              Removing a permission is a small transaction paid from that Vision wallet.
            </li>
            <li>
              A new sell order on the same holding replaces the old one. To keep an order and change its prices, use Edit.
            </li>
          </ul>

          <h2 id="status">What an order's status means</h2>
          <dl className="proof">
            <div>
              <dt>Starting</dt>
              <dd>Placed, with its permission on the way. It goes live by itself in a moment.</dd>
            </div>
            <div>
              <dt>Live</dt>
              <dd>
                Watching the price, or waiting for its next DCA buy. A note may add more: the stop price was crossed and it's checking once
                more, it's buying or selling now, or it's waiting for a better price.
              </dd>
            </div>
            <div>
              <dt>Paused</dt>
              <dd>A DCA you paused. Resume it any time.</dd>
            </div>
            <div>
              <dt>Filled</dt>
              <dd>Done: everything traded, every step or DCA buy made, or the limit buy bought. Each fill is listed with its price.</dd>
            </div>
            <div>
              <dt>Cancelled</dt>
              <dd>
                You cancelled it, a newer order on the same tokens replaced it, or the tokens or SOL moved out of the Vision wallet.
              </dd>
            </div>
            <div>
              <dt>Expired</dt>
              <dd>It reached its end date without filling.</dd>
            </div>
            <div>
              <dt>Stopped</dt>
              <dd>
                The token can't be traded this way (the note says why), its permission didn't go through, or no market could take its trade
                for a long while. The tokens or SOL stay in the Vision wallet; a buy's SOL comes home by itself the next time VisionSwap is
                open.
              </dd>
            </div>
          </dl>
          <p>
            If the order service ever doesn't recognise an order, the app hands it back on its next visit, and a fill that happened in
            between still shows as filled.
          </p>

          <h2 id="waits">Why a trade might wait</h2>
          <p>
            VisionSwap shares its Jupiter allowance fairly. Trades, quotes, the order service's price checks and the prices on display
            each have a guaranteed share, and trades get the most, so order checks keep running even when the site is busy. Each visitor
            also gets a fair share, so nobody can crowd anyone
            out: if you check prices very quickly the app says how many seconds to wait, and the swap preview tries again by itself. Sending
            and confirming payments has network room set aside, so busy browsing can't hold them up.
          </p>
          <p>
            Orders wait their turn in a queue: stop-losses first, then take-profits, then limit buys, then DCA. A take-profit or limit buy
            whose route can't meet your price waits for a better one. A token whose trades keep failing on-chain pauses for a few minutes
            before trying again, and if the relayer is being topped up, order trades and scheduled payments wait for it and then
            carry on. "Prices are busy right now" when placing an order means: try again in a few seconds.
          </p>

          <h2 id="fromwallet">Paying straight from your wallet</h2>
          <p>
            With a wallet connected, the Send tab can pay any Solana address straight from your wallet. Pick{" "}
            <strong>Pay from: Your wallet</strong>, type the address and the amount they receive, and approve once. Your wallet makes
            one deposit of a standard size (0.01, 0.02, 0.03, 0.05, 0.1 SOL, and so on up through 1, 2, 3, 5, 10 SOL and beyond): the
            smallest one that covers the payment and its fees with a little to spare, plus the pool fee on the deposit. The form shows
            the deposit, what stays in your private balance and the total before you approve. The deposit waits in the public waiting
            room{info ? waitFor : ""} while it is screened, then joins your private balance; your browser then proves the payment and
            the relayer sends it from the pool as a standard SOL transfer. The recipient gets exactly the amount you typed, the payment
            itself comes from the pool, not from your wallet, and the rest of the deposit stays in your private balance as change, free
            to spend as soon as the payment has gone out. <strong>Max</strong> leaves a small random amount of change too.
          </p>
          <p>
            You choose when it goes out: <strong>As soon as it's ready</strong>, or later, at a random moment within{" "}
            <strong>15 minutes</strong>, <strong>1 hour</strong> or <strong>24 hours</strong> of joining your private balance. Later is
            the more private choice: a payment that goes out right after its deposit is easier to pair with it by timing, and a random
            moment later makes that much harder. 15 minutes is the default, and your last choice is remembered on this device. Paying
            from a balance you shielded earlier hides it best.
          </p>
          <p>
            Keep the page open until the payment says <strong>Handed to the relayer</strong> under Payments on their way. If you close
            it sooner, nothing is lost: the deposit still joins your private balance, and the payment picks up by itself the next time
            you open VisionSwap on the same device. Which deposit pays whom is kept on that device only, never on our servers; on
            another device the SOL simply shows in your private balance, ready to send. A payment more than a day old asks you before
            it goes. Until it is handed over, <strong>Stop and keep it private</strong> keeps the SOL in your private balance, and while
            it is in the waiting room, <strong>Take it back</strong> returns it to your wallet.
          </p>
          <p>
            A payment from the wallet goes to one address; several recipients at once go from your private balance, which also sends
            instantly. Buys always spend your private balance: when a buy, limit buy or DCA needs more, <strong>Add SOL from my
            wallet</strong> shields just the difference and keeps the form as you filled it.
          </p>

          <h2 id="later">Sending later</h2>
          <p>
            A payment that leaves right after a deposit is easy to match to it by timing. Choose <strong>15 min</strong>,{" "}
            <strong>1 hour</strong> or <strong>24 hours</strong> on the Send tab and your browser makes the proof straight away; the
            relayer sends it at a <strong>random moment inside that window</strong>, even with the page closed, so it doesn't land right
            after your deposit and is much harder to match to it by timing. Keep VisionSwap open near the send time and it makes a fresh
            proof, which hides the timing best. When the SOL for it arrived or was set aside only moments before, the proof waits until
            up to 33 more notes have joined the pool (so it doesn't point back to them), or until its own random moment inside the window
            comes, if that is sooner, and then goes like a payment sent now: keep VisionSwap open until it shows Scheduled.
          </p>
          <p>
            The proof binds the recipient, the amount, the relayer's fee and the highest pool fee, so the relayer can send that exact payment or nothing. Only what you're
            sending is held until it goes out, and you can cancel it under Scheduled payments until it does. When no note of the right
            size exists, the app cuts one off with a transfer inside the pool, which costs one relayer fee; the form shows it before you
            confirm. That transfer is visible on-chain as a pool transaction that pays only the relayer, though not whose it is. When
            several such cuts or joins are needed, the app spaces them out, a random 15 to 60 seconds apart, and the payments themselves
            go later, so none of them runs back to back with a payment. Sent now instead, a payment from a balance in several pieces
            joins them right before it goes. A proof
            names a recent state of the pool, which shows roughly when it was made; if the pool gets
            busy, a payment may go out a little early, still inside your window, rather than let its proof go stale. With the app open,
            it also makes a fresh proof shortly before the payment goes. Scheduled payments keep running through site updates.
          </p>
          <p>
            A payment shows as sent only once it confirms. If the network can't say in time, it shows <strong>Check activity</strong>{" "}
            instead of guessing. If you try to spend SOL that a payment scheduled on another of your devices is holding, the app sets that
            SOL aside, says so, and offers to cancel that payment.
          </p>

          <h2 id="split">Paying several people</h2>
          <p>
            Add up to 20 recipients on the Send tab, including fresh wallets of your own. Each gets its own private payment from the pool.
            Sent <strong>Now</strong>, they go out one by one at random moments over about two minutes, so they don't land together. Sent
            later, each has its own random moment and its own note. Paid or scheduled rows leave the form as they go, so pressing again
            never pays anyone twice; if a split stops partway, the message names who was paid, who is scheduled and which payment didn't
            go. Recipients are checked up front, and again as each payment goes out. Spreading payments out may first need a transfer inside the
            pool to cut notes to size, which costs one relayer fee; the form shows it before you confirm. Payments that follow each other
            closely, from the same notes, can sometimes be grouped on-chain as coming from one sender.
          </p>

          <h2 id="links">Payment links</h2>
          <p>
            On the Shield tab, <strong>Payment link</strong> makes a link anyone can pay: a fresh deposit address of your account, with
            an amount and a note if you like. The note and the request sit after the <code>#</code> in the link, so they aren't sent to
            any server; like any payment made on the site, the transfer itself goes through VisionSwap's chain gateway. The
            payer can scan its QR code, pay from a browser wallet, send from any exchange, or pay from their own VisionSwap balance.
          </p>
          <p>
            Make <strong>one link per payer</strong>: every payer then gets an address of their own, and nobody's payment sits next to
            anyone else's. What arrives moves into your private balance like any QR deposit, and Payment requests, kept on the device that made
            the link, shows what each link received. When several links are paid, they move in one at a time while VisionSwap is open, in
            random order and a random few minutes apart, so payers are much harder to group by when their payments moved in; tap{" "}
            <strong>Move into the pool</strong> to send one now. A brief hiccup doesn't stop a deposit: it quietly tries again, and if it
            keeps failing the row offers <strong>Try again</strong>.
          </p>

          <h2 id="backup">Sending it yourself</h2>
          <p>
            The relayer submits private payments so your wallet never appears. If it is ever unavailable, open{" "}
            <strong>Relayer down? Send it yourself</strong> on the Send tab: a fee wallet of your account, or a Vision wallet, submits the
            payment instead. By default each payment uses a <strong>new fee wallet</strong> of its own. The proof names that payer, and
            the payment pays its costs back, so it only needs a little SOL up front. If an amount is too big to send this way in one go, the app says the most it can send,
            and you send the rest as a second payment. Fund
            the fee wallet with a withdrawal from an exchange, or with <strong>Fund it from my private balance</strong> while the relayer
            still works. The money still comes from the pool; only the fee payer shows in the transaction, and it is public, so a Vision
            wallet as fee payer ties that payment to the wallet's trades. A fresh fee wallet keeps them apart.
          </p>

          <h2 id="exchanges">Sending to an exchange</h2>
          <p>
            Every private payment to another wallet or an exchange arrives as a standard SOL transfer from a one-time sending address, so
            exchanges and wallets credit it like any other deposit. Paste the address from the exchange's SOL deposit page. The sending address is made for that one
            payment from your own notes, only your app holds its key, and the proof seals it in, so nobody can send that SOL anywhere else.
          </p>
          <p>
            Your activity shows each payment's <strong>Transaction ID</strong>, the one to give an exchange if it asks, and its sending
            address. If an exchange asks you to show that you control the address a deposit came from, use{" "}
            <strong>Sign a message from the sending address</strong> under that payment. Should an exchange ever send a deposit back, it
            shows under <strong>Deliveries</strong>, ready to move into your private balance or send somewhere else. If a payment is
            ever held up on its way, the app finishes it the next time it is open, on any of your devices.
          </p>
          <p>
            The smallest private send to another wallet or an exchange is about 0.0009 SOL (the network's minimum balance for an
            account, 0.00089088 SOL today). Split payments arrive as one
            deposit per part; exchanges usually credit deposits of 0.1 SOL or more. The app checks every recipient first: a token
            account, a program or a durable nonce account can't receive SOL here, an address managed by a program (such as a multisig
            vault) goes once you confirm it, and an address that only looks like one you paid before is shown next to it in full.
          </p>

          <h2 id="fees">Fees and limits</h2>
          <ul>
            <li>
              Shielding costs {fee} of the amount, paid on top of it. If you take a deposit back before it joins the pool, the fee
              comes back with it.
            </li>
            <li>
              Sending privately, buying privately and withdrawing cost {fee} of the amount leaving the pool. The program itself enforces
              this fee, and it can never be set above 1%.
            </li>
            <li>
              A payment to an address outside your own VisionSwap wallets also carries its delivery's network fee, 0.000012 SOL, so the
              recipient gets exactly the amount you entered.
            </li>
            <li>Selling from a Vision wallet costs {fee}, taken as the SOL goes back into the pool.</li>
            <li>
              The relayer fee covers what the network charges the relayer, mostly the rent for two small accounts that record spent
              notes, plus a small margin for running it: about{" "}
              {info?.relayerFee ? `${(Number(info.relayerFee) / 1e9).toFixed(4)} SOL right now` : "0.002 SOL at today's rates"}.
            </li>
            <li>
              Orders: a buy order's funding costs the same as a private buy, plus a little SOL kept in its Vision wallet for its own
              fees (about 0.006, or 0.01 for Token-2022 tokens), shown before you confirm. Order trades pay no network fee: our relayer
              covers it. Jupiter and some tokens take their own fees, as when you trade yourself. A sale's SOL pays{" "}
              {fee} as it goes back into the pool.
            </li>
            <li>Fast and Turbo add a network priority fee of at most 0.0015 SOL and 0.005 SOL. Jupiter and some tokens take their own fees.</li>
            {info && <li>{limitsText(info)}</li>}
          </ul>

          <h2 id="keys">Your keys</h2>
          <p>
            When you open your account, your wallet signs one fixed message. VisionSwap hashes that signature into a spending key and a
            viewing key, entirely in your browser. Ed25519 signatures are deterministic, so signing again on any device gives the same
            keys: there is no new seed phrase. The first time, the app asks for the signature twice to make sure your wallet behaves this
            way. Vision wallets, deposit addresses, fee wallets and order keys all come from the same account, each through its own
            one-way derivation, so none of them reveals your spending or viewing key.
          </p>
          <p>
            Because the signature is the key, <strong>only ever sign that message inside VisionSwap</strong>, and check that your wallet
            names visionswap.net as the site asking. The message itself doesn't name the site, so a site that tricks you into signing it
            could spend your private balance. Some hardware wallets cannot sign messages; use a software wallet for VisionSwap.
          </p>
          <p>
            You can also open an account with no wallet at all. The app then creates a private key in your browser: 32 random bytes,
            written as a line of text that starts with <code>vsk1</code> and ends in a checksum that catches typos. That key is the
            account, so keep it somewhere safe and private. Paste it on any device to open the same account. Nobody, including us, can
            recover it, and anyone who has it can spend your private balance. Shield by QR code; sending, buying and selling work the same.
            "Keep me signed in" is off unless you turn it on. Then this browser keeps the key sealed with a key the browser itself made and
            can't export, so it opens only here, and one tap opens the account: best on a device only you use.
          </p>

          <h2 id="passkeys">Passkeys</h2>
          <p>
            Or use a <strong>passkey</strong> (Face ID, a fingerprint, your phone or a security key) and there is nothing to copy. The
            passkey's PRF extension turns a fixed value into 32 secret bytes that only that passkey can produce, the same on every device
            it syncs to; those bytes become the account key, on your device. Nothing is sent to us and the key is never kept in the browser:
            each visit, one tap of the passkey makes it again.
          </p>
          <p>
            Creating one takes two taps: the second, <strong>Confirm my passkey</strong>, checks it signs in again before any SOL goes in.
            Then the app asks you to save a <strong>backup key</strong> (copy or download it, then type its last four characters) before
            the account opens: if the passkey is ever deleted or lost, it's the way back in. The passkey is named "VisionSwap private
            account" and a short tag (the app asks your device to use your account's tag, which also shows on screen and in the backup
            file). Your device or password manager needs to support passkey PRF. Passkeys work on visionswap.net.
          </p>

          <h2 id="android">The Android app</h2>
          <p>
            VisionSwap for Android opens the website full screen from your home screen: the same app, with the same accounts, wallets
            and forms. Download it straight from the <a href="/#get-app">homepage</a>, open the file and tap Install (the first time,
            Android asks you to allow installs from Chrome: Settings, then Allow from this source). It always shows the live website, so it stays up to date by itself.
          </p>
          <ul>
            <li>
              <strong>Wallet apps on your phone</strong> connect through the Mobile Wallet Adapter. The first time, the app asks you to
              allow connections to apps on this device: tap Allow. A new account then asks your wallet to sign twice, with one tap on{" "}
              <strong>Sign again</strong> in between. With several wallet apps on the phone, Android asks which one to open each time:
              pick the wallet you connected.
            </li>
            <li>
              <strong>Links</strong> to visionswap.net, payment links included, open in the app. Links to other sites open in your
              browser.
            </li>
            <li>
              <strong>Its signature</strong>: the app's signing certificate has the SHA-256 fingerprint shown under the download button,
              which is also listed in{" "}
              <a href="/.well-known/assetlinks.json" target="_blank" rel="noreferrer noopener">
                /.well-known/assetlinks.json
              </a>
              . Android installs an update only if it is signed with this same key.
            </li>
            <li>
              <strong>Your data</strong> stays in your phone's browser storage for visionswap.net, as on the website. The app asks Android
              for no permissions (see the <a href="/privacy">Privacy policy</a>).
            </li>
            <li>
              <strong>Tip: turn off Touch to Search.</strong> Chrome on Android can send words you tap or select, with the text around
              them, to Google to look them up. VisionSwap's app pages keep a tap from opening it; text you select with a long press can still
              open it. To switch it off, in Chrome tap ⋮, then Settings, Google services, Touch to Search (older versions have it under
              Sync and Google services, or Privacy). The app uses Chrome's settings, so this covers it as well.
            </li>
          </ul>

          <h2 id="security">Security and trust</h2>
          <ul>
            <li>
              Funds sit in a program-owned vault. They can only leave against a valid proof, or back to the original depositor while still
              in the waiting room. No admin setting can move or redirect them; an upgrade to the program could change those rules, as the{" "}
              <a href="/security">Security</a> page explains.
            </li>
            <li>
              The VisionSwap team manages the pool's settings: the pool fee (never above 1%), the deposit limits and pool cap, the waiting
              room, the screening key, the fee wallet and a pause for new deposits. Changes take effect when they are made. A change of pool
              fee can hold up payments already proved under the old fee until the sender's app proves them again.
            </li>
            <li>
              The program can be upgraded by the VisionSwap team so it can keep improving, and an upgrade can change its rules. The live
              code's fingerprint and the upgrade key's address are below, so anyone can see when it changes.
            </li>
            <li>
              Orders are the one place our service holds a key over your funds, and only as far as you choose: an order's key can move
              only the amount you set aside for it (for a DCA, its whole budget), only from its own Vision wallet, and only until it ends
              or you cancel it.
            </li>
            <li>
              Your keys are made by the app's code, which your browser loads from visionswap.net each time you open it, so that code is
              part of what you trust. The Chrome extension carries its own copy of the app, published through the Chrome Web Store.
            </li>
            <li>
              The code has been tested extensively but has <strong>not yet had an independent audit</strong>. Treat it as new software.
            </li>
            <li>
              The proving keys come from a two-phase trusted setup that builds on the public Privacy &amp; Scaling Explorations
              "perpetual powers of tau" (61 public contributions and a random beacon). Phase two was completed by the VisionSwap team and
              sealed with a final random beacon from Bitcoin block 969,748. Its record, every contribution's hash and the beacon, is part
              of the public proving key the app downloads. As with any trusted setup, the proofs are sound as long as
              the randomness used in phase two was discarded; your payments' privacy doesn't depend on it.
            </li>
            <li>
              Your browser downloads every note in the pool, and the whole waiting room, and finds its own entries locally, so finding your
              notes never tells the server which are yours. Other requests do carry your addresses: screening a deposit names the wallet
              making it, the app reads your own addresses' balances through our server, and a payment you ask the relayer to send names its
              recipient. The site loads nothing from third parties, and a strict content security policy lets the page run only its own
              code: chain data, prices and token icons all come through VisionSwap's server, which writes no IP or wallet addresses to its
              logs. Like any website, though, the server sees the connections it receives, including the payments you ask it to relay and
              the orders you place; the <a href="/privacy">Privacy policy</a> lists what each service sees and how long anything is kept.
              For the strongest privacy, use a VPN or Tor, and shield and spend in different sittings. VPNs and Tor are for privacy, never for
              getting around the places where VisionSwap isn't offered (<a href="/terms#eligibility">Terms of use, section 2</a>).
            </li>
          </ul>
          <p>
            The <a href="/security">Security</a> page covers all of this in one place, with how to report a security problem.
          </p>

          <h2 id="onchain">Check it on-chain</h2>
          <p>
            Everything VisionSwap does happens in public, on Solana {info?.network ?? "mainnet"}. These links open Solscan, a public
            block explorer, in a new tab. Nothing here says anything about the people who use VisionSwap.
          </p>
          {info ? (
            <dl className="proof">
              <Proof label="Program" address={info.programId} network={info.network}>
                The code that holds the pool and checks every proof.
              </Proof>
              {info.accounts && (
                <>
                  <Proof label="Vault" address={info.accounts.vault} network={info.network}>
                    Holds the shielded SOL. Its balance is the size of the pool.
                  </Proof>
                  <Proof label="Note tree" address={info.accounts.tree} network={info.network}>
                    Every note in the pool, as a Merkle tree, with its recent roots.
                  </Proof>
                  <Proof label="Settings" address={info.accounts.config} network={info.network}>
                    The fee, limits, waiting room and screening rules, exactly as the program reads them.
                  </Proof>
                </>
              )}
              {info.program && (
                <>
                  {info.program.upgradeAuthority ? (
                    <Proof label="Upgrade key" address={info.program.upgradeAuthority} network={info.network}>
                      Can upgrade the program while it is young (see Security and trust). The plan is to move it to a multisig, then
                      remove it for good.
                    </Proof>
                  ) : (
                    <div>
                      <dt>Upgrade key</dt>
                      <dd>None. The program's code is permanent and can never be changed (the admin settings in Security and trust remain).</dd>
                    </div>
                  )}
                  <div>
                    <dt>Deployed code</dt>
                    <dd>
                      <code className="proof-hash">sha256 {info.program.sha256}</code>
                      <span>
                        Last deployed at slot {info.program.deployedSlot.toLocaleString("en-US")}. To check it with the standard{" "}
                        <code>solana-verify</code> tool, run <code>solana-verify get-program-hash {info.programId}</code>: it prints this
                        fingerprint, so anyone can see whether the code has changed. Running{" "}
                        <code>solana-verify get-executable-hash vision_pool.so</code> on a build of the program prints its fingerprint
                        to compare.
                      </span>
                    </dd>
                  </div>
                </>
              )}
            </dl>
          ) : (
            <p className="muted">Loading the addresses…</p>
          )}

          <h2 id="compliance">Screening and the waiting room</h2>
          <p>
            VisionSwap is built for people protecting ordinary money. Before a deposit, the guard checks the depositing wallet, and the
            wallets that recently paid SOL into it, against the U.S. sanctions list (read from OFAC's own published list) and the addresses
            we refuse, then signs a short-lived pass that the program requires. Screening looks a short way back into a wallet's history, so it is a careful
            filter rather than proof of where every coin came from. Deposits then wait in a public waiting room. If a deposit is flagged
            during that time, the guard can send it back, and only to the wallet it came from. Depositors can also take a deposit back themselves at
            any time before it joins the pool. A deposit address that put everything into its deposit can sign the request instead, and
            the guard pays the network fee; the program still pays back only to the depositor. Recipients of private sends are checked
            against the same list, and VisionSwap's relayer won't pay a sanctioned address. In the app, Send all from a Vision wallet or a
            deposit address checks the recipient first, and transfers sent through VisionSwap's server are checked against the list;
            software other than VisionSwap's can skip those checks.
          </p>
          <p>
            You can download a statement of your notes from the app: whoever you give it to can check that each note exists on-chain and,
            for notes that came straight from a deposit, which wallet made it; it doesn't prove which notes are still unspent. Including your
            viewing key lets the holder see every note you've received, before and after, and can't be taken back. To show an exchange that
            an address is yours, the app signs the exchange's message with it, and the exchange can check it on the{" "}
            <a href="/verify">Check an ownership proof</a> page. VisionSwap is not offered to people on sanctions lists or in restricted
            places (<a href="/terms#eligibility">Terms of use, section 2</a>); while region checks are on, our server also refuses
            connections from those places. The <a href="/compliance">Compliance</a> page shows whether they are, and explains what is
            checked, our screening policy, what happens to flagged deposits and what data exists.
          </p>

          <h2 id="faq">Questions</h2>
          <div className="qa docs-qa">
            {FAQ.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
          </div>
          <p>
            More answers, from fees to checking the program yourself, are in the <a href="/faq">FAQ</a> and the{" "}
            <a href="/support">Support library</a>. For anything else, email <a href={mailto(SUPPORT_EMAIL)}>{SUPPORT_EMAIL}</a>;
            business, partnership and press enquiries go to <a href={mailto(BUSINESS_EMAIL)}>{BUSINESS_EMAIL}</a>.
          </p>

          <h2 id="developers">For developers</h2>
          <ul>
            <li>
              Program {info ? <code>{info.programId}</code> : "address shown once loaded"} on Solana {info?.network ?? "mainnet"}, written
              with Anchor. Groth16 over BN254 verified with Solana's alt_bn128 syscalls; Poseidon via the sol_poseidon syscall; a
              depth-26 Merkle tree with a 256-root history.
            </li>
            <li>Circuit: 2-in, 2-out, about 16,200 constraints. A proof takes a few seconds in a browser.</li>
            <li>
              Anyone can run a relayer: the program accepts any fee payer, and the relayer is bound into the proof so it cannot be swapped.
            </li>
            <li>
              Orders use standard SPL token delegation: the Vision wallet approves the order key for the order's amount, and the order
              service swaps through Jupiter as that delegate. <code>GET /api/orders/limits</code> returns the live floors and bounds.
            </li>
            <li>
              The pool's full history can be rebuilt from the chain alone, from the program's events. The SDK includes that path, so the
              pool's data does not depend on any one server.
            </li>
          </ul>
        </article>
      </main>
      <Footer />
    </div>
  );
}
