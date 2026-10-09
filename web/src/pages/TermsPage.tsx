import { useEffect, useState, type ReactNode } from "react";
import { Header } from "../components/Header";
import { api } from "../lib/net";
import { SOCIAL } from "../lib/config";
import { Footer } from "../components/Footer";

/** One numbered clause: "5.6 Title. Text". */
function C({ n, t, children }: { n: string; t: string; children: ReactNode }) {
  return (
    <p className="clause">
      <b>
        {n} {t}.
      </b>{" "}
      {children}
    </p>
  );
}

export default function TermsPage() {
  const [contact, setContact] = useState<string | null>(null);
  useEffect(() => {
    document.title = "VisionSwap · Terms";
    api<{ contact: string | null }>("/api/legal")
      .then((r) => setContact(r.contact))
      .catch(() => {});
  }, []);
  const reach = contact ? (
    <a href={`mailto:${contact}`}>{contact}</a>
  ) : (
    <a href={SOCIAL.x} target="_blank" rel="noreferrer noopener">
      @VisionSwapSol on X
    </a>
  );
  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap prose terms">
        <h1>Terms of use</h1>
        <p className="muted">Last updated October 8, 2026.</p>

        <div className="keypoints">
          <p>The main points</p>
          <ul>
            <li>
              VisionSwap breaks the public link between the wallet you deposit from and where your money goes. Your spending and viewing
              keys are made in your browser, from a signature by your own wallet, a passkey or a private key, and we never receive them.
            </li>
            <li>
              Only your wallet (through the signature it makes for VisionSwap), your passkey or your VisionSwap private key can spend your
              private balance. Nobody can recover it for you.
            </li>
            <li>
              If you place an order, our order service can trade the amount you set aside for it, from that order's Vision wallet, until
              the order ends or you cancel it (section 6.11).
            </li>
            <li>Every deposit is screened and waits in a public waiting room. It can be refused, or sent back to the address it came from.</li>
            <li>
              The program is new, has not been independently audited and, for now, can be upgraded by its operator. You can lose
              everything you deposit.
            </li>
            <li>Our liability to you is limited (section 16), and claims can only be brought individually (section 19).</li>
          </ul>
          <p className="tiny">This box is a summary. The numbered sections below are the agreement.</p>
        </div>

        <h2>1. About these terms</h2>
        <C n="1.1" t="The agreement">
          These terms form a legally binding contract between you and the operator of VisionSwap ("we" or "us"). Using the website,
          connecting a wallet to it, or opening or unlocking a VisionSwap account means you agree to them. If you don't, please don't
          use VisionSwap.
        </C>
        <C n="1.2" t="What they cover">
          "VisionSwap" or the "Services" means the website at visionswap.net, the app and documentation on it, the Exposure check, and
          the servers we run for them, including the relayer, the screening service and the service that moves deposits out of the
          waiting room. The "Pool" is the VisionSwap program on Solana mainnet and the accounts it controls; its address is in the{" "}
          <a href="/docs#onchain">Docs</a>.
        </C>
        <C n="1.3" t="Acting for someone else">
          Using VisionSwap on behalf of a company or another person means you have the authority to accept these terms for them, and
          they are bound by them too.
        </C>

        <h2>2. Who may use VisionSwap</h2>
        <C n="2.1" t="Age">
          You must be 18 or older, with the legal capacity to make this contract.
        </C>
        <C n="2.2" t="Sanctions">
          You may not use VisionSwap if you, or anyone who owns or controls you, appear on a sanctions list maintained by the United
          Nations, the United States, the European Union or the United Kingdom.
        </C>
        <C n="2.3" t="Restricted places">
          VisionSwap is not for anyone who is in, lives in, or is a company formed in Cuba, Iran, North Korea or Syria; the Crimea,
          Donetsk or Luhansk regions of Ukraine; the United Arab Emirates; any other country or region under comprehensive sanctions
          of the bodies named in 2.2; or any place where using a privacy tool like VisionSwap is against the law. We may change this
          list at any time.
        </C>
        <C n="2.4" t="Your local laws">
          Some countries restrict privacy tools. It's up to you to know and obey the laws that apply to you.
        </C>
        <C n="2.5" t="No way around this section">
          VPNs and Tor are welcome for privacy, but not as a way around this section: don't use them, or anything else, to disguise
          where you are so that you can use VisionSwap from a restricted place.
        </C>
        <C n="2.6" t="Your confirmation">
          We don't verify who or where you are, so we rely on you: every time you use VisionSwap, you are telling us that this section
          applies to you. We can block any address, device, network or region whenever we choose.
        </C>

        <h2>3. What VisionSwap is, and what it isn't</h2>
        <C n="3.1" t="What you can do">
          With VisionSwap you can move SOL into the Pool from your own wallet or, by QR code or payment link, from any wallet or
          exchange; hold a private balance; send SOL privately from the Pool to any Solana address, now or later, to one or several
          recipients; buy and sell tokens through Vision wallets, now or with orders; check how much a wallet's public history gives
          away; and download statements of your own activity.
        </C>
        <C n="3.2" t="Where your SOL is">
          SOL in the Pool is held by the Pool program together with everyone else's. It is not in an account with us, and we never
          hold your wallet's keys or your VisionSwap keys. Tokens bought through a Vision wallet sit in that Vision wallet, an ordinary
          Solana address that only your keys control. SOL sent to one of your deposit addresses sits at that address, which only your
          keys control, until it moves into the Pool.
        </C>
        <C n="3.3" t="What we are not">
          We are not a bank, exchange, broker, custodian, payment institution, investment adviser or trustee. Nothing you hold through
          VisionSwap is covered by deposit insurance or any investor compensation scheme.
        </C>
        <C n="3.4" t="Final transactions">
          VisionSwap works through transactions on a public blockchain, and a confirmed transaction is permanent: neither you nor we
          can undo it.
        </C>
        <C n="3.5" t="New software">
          VisionSwap launched recently and is still changing. Its features, fees, limits and the tokens you can trade may change, and
          parts of it may be down from time to time.
        </C>

        <h2>4. Your wallet and your keys</h2>
        <C n="4.1" t="Your wallet or private key">
          You open an account with a self-custody Solana wallet that can sign messages, or with a VisionSwap private key. Some
          wallets, including multisig, MPC and some hardware wallets, can't open an account; a private key works instead.
        </C>
        <C n="4.2" t="Where your keys come from">
          With a wallet, it signs a fixed message and your browser turns that signature into the keys for your private balance, your
          Vision wallets and your deposit addresses. With a private key or a passkey, those keys come from that key instead. Your
          spending and viewing keys stay in your browser: we never receive them, and our servers cannot spend your private balance.
          Orders use separate order keys, also derived from your account, as section 6.11 describes.
        </C>
        <C n="4.3" t="Guard your signature and your private key">
          Anyone who obtains that signature or your private key can spend your private balance. Only ever sign the message, or enter
          your private key, on visionswap.net. If you choose to stay signed in, your private key is kept in that browser, sealed so
          that only that browser can open it, so only do that on a device you trust.
        </C>
        <C n="4.4" t="Same wallet, same account">
          Always open your account with the same wallet. Some wallets, including some hardware wallets, sign the message differently
          and would open a different, empty account.
        </C>
        <C n="4.5" t="No recovery">
          If you lose access to your wallet or your private key, nobody, including us, can recover your private balance, your Vision
          wallets or your deposit addresses.
        </C>
        <C n="4.6" t="Your devices">
          Keeping your wallet, devices and browser secure is up to you, and you are responsible for whatever your wallet signs.
        </C>
        <C n="4.7" t="Passkeys">
          You can open an account without a wallet with a passkey (for example Face ID, a fingerprint or a security key). Your passkey
          produces the account's key on your device; we never receive it. The same passkey opens the same account wherever it syncs; a
          different passkey opens a different account. Before a new passkey account opens, the app checks that the passkey signs in
          again and asks you to save a backup private key. If the passkey is deleted or lost and you didn't keep that backup key,
          nobody, including us, can recover the account.
        </C>

        <h2>5. Deposits, screening and the waiting room</h2>
        <C n="5.1" t="Depositing">
          You deposit from your own wallet, or by sending SOL to one of your deposit addresses, and you pay the amount, the deposit fee
          and Solana's network fee. By QR code these come out of what arrives, together with a small account deposit that returns to
          the deposit address when the deposit joins the Pool. The program enforces a minimum deposit. We may set, change or remove a largest deposit and a cap on the size of the Pool at any time; the current
          limits are in the <a href="/docs#fees">Docs</a>.
        </C>
        <C n="5.2" t="Screening">
          Before a deposit, the depositing address is checked against sanctions lists, and possibly against public blockchain data and
          outside risk services. For a deposit address, the wallets that recently paid into it are checked too. Screening looks only at
          addresses: we never ask for your name or ID.
        </C>
        <C n="5.3" t="The waiting room">
          Each deposit then waits in a public waiting room, for a time shown in the app, before it joins the Pool. We can change that
          time; the program allows up to about seven days. A waiting deposit is not yet part of your private balance.
        </C>
        <C n="5.4" t="Outcomes">
          Screening can stop a deposit before you send it, send it back to the address it came from while it waits, or hold it in the
          waiting room until it can join the Pool. These are our decisions to make, and we may be unable to explain them for legal or
          security reasons.
        </C>
        <C n="5.5" t="Taking a deposit back">
          Until it joins the Pool, you can take a deposit back at any time, deposit fee included. It goes back only to the address it
          came from. You pay the network fee, unless a deposit address has nothing left to pay it with; then our guard pays it.
        </C>
        <C n="5.6" t="Returns go to the depositing address">
          A deposit can only ever be returned to the address that made it, so deposit from a wallet you control. When you shield by QR
          code, that address is your own deposit address: anything returned waits there for you, and you can send it on to any wallet.
          SOL that fails screening is not moved into the Pool and stays at the deposit address.
        </C>
        <C n="5.7" t="Later refusals">
          An address that fails screening once may be refused again, both as a depositor and as a recipient.
        </C>
        <C n="5.8" t="No guarantee">
          Screening makes it harder for unlawful money to get into the Pool, but it can't prove that everything in the Pool came from a
          lawful source.
        </C>
        <C n="5.9" t="Reviews">
          Think we got a screening decision wrong? Contact us (section 22) with the depositing address and the transaction. We'll review
          it, but we can't promise a different outcome or a reply by any particular time.
        </C>

        <h2>6. Private sends, buys and sells</h2>
        <C n="6.1" t="How they work">
          Your browser builds a zero-knowledge proof that the payment is yours to make. A relayer, normally ours, submits it to Solana
          and pays the network fee, which is repaid from the payment. The recipient, the amount and the fees are sealed into the proof,
          so the relayer can't change them.
        </C>
        <C n="6.2" t="This website needs our servers">
          The website relies on our servers for relaying, screening and chain data. The Pool program doesn't depend on them, but we
          don't promise any other way to use it.
        </C>
        <C n="6.3" t="Refusals and delays">
          Our relayer can turn down, hold back or queue a payment, for instance when it is rate-limited or busy, when fees change, after
          a screening result, or for legal or security reasons.
        </C>
        <C n="6.4" t="Private sends">
          A private send pays SOL out of the Pool to the address you enter. A send to an address outside your own VisionSwap wallets
          goes through a one-time sending address made for that payment, which only your app holds the key to, and reaches the
          recipient as a standard SOL transfer from it. Anyone can see that address, the amount, the fees and when it happened. The
          recipient is screened too, and we may decline to pay it.
        </C>
        <C n="6.5" t="Buys and sells">
          A private buy moves SOL from the Pool to one of your Vision wallets, which then trades through Jupiter, a third-party
          aggregator that routes through other exchanges. Prices can move before a trade completes, within the slippage you accept, and
          trades can fail. Before you confirm, the app shows the minimum you will receive, and the trade is built to fail rather than
          deliver less. A faster speed setting adds a network priority fee, up to the cap the app shows. A sale swaps back to SOL and
          deposits it into the Pool, which pays the deposit fee; a sale too small for a deposit leaves its SOL in the Vision wallet.
          Vision wallets and what they hold are public on-chain; VisionSwap only avoids linking them to you.
        </C>
        <C n="6.6" t="Tokens">
          We don't create, review, list or endorse tokens: the app can show any token Jupiter can trade. Many tokens are worthless or
          fraudulent, and some let their issuer freeze, tax or block transfers. You buy any token at your own risk.
        </C>
        <C n="6.7" t="Check before you confirm">
          Double-check every address, token and amount before you confirm. Anything sent to the wrong address is gone for good.
        </C>
        <C n="6.8" t="Sending later, and several payments at once">
          If you choose to send later, your browser makes the proof straight away and our relayer submits it at a random moment within
          the window you chose. When the Pool is busy, it may submit the payment earlier than planned, still within that window, so that
          its proof does not expire, and while the app is open it may make a fresh proof shortly before the payment goes out. The
          relayer can only send that exact payment, or not send it. Until it goes out, the notes it spends are set aside and VisionSwap
          won't spend them elsewhere; you can cancel it until then. If they are spent another way first, the scheduled payment fails
          and nothing is sent. If it isn't sent, those funds remain yours. A payment that still needs a fresh
          proof (for example when the Pool has changed a lot) waits until the app makes one, the next time you open it. While our relayer
          is being topped up, scheduled payments wait. To hold back only what it sends, a later payment usually first sets aside a note
          of its own size within your private balance, which costs a relayer fee. Sending to several recipients makes one payment each,
          each with its own fees; several payments sent "now" go out one by one at random moments over about two minutes. Every
          private payment to another wallet or an exchange arrives as a standard SOL transfer from a one-time sending address, so
          exchanges and wallets credit it like any other deposit.
        </C>
        <C n="6.9" t="Sending it yourself">
          If our relayer is unavailable, you can submit a private send with a fee payer of your own: one of your account's fee wallets
          (by default a new one for each payment) or a Vision wallet. That fee payer is visible in the transaction and pays the network
          costs up front; the payment repays them. This way sends one payment at a time. Every private payment to another wallet or an
          exchange arrives as a standard SOL transfer from a one-time sending address, so exchanges and wallets credit it like any other
          deposit.
        </C>
        <C n="6.10" t="Payment links">
          A payment link points to a fresh deposit address of your account, and is meant for one payer. What is paid to it is screened
          and moves into your private balance like any deposit, with the same fees and rules, when your account is open in the app;
          several paid links move in one at a time, a few minutes apart. The payer and the amount they send to that address are visible
          on-chain.
        </C>
        <C n="6.11" t="Orders">
          Limit buys, DCA, take-profit, stop-loss and trailing-stop orders are run by our order service. Each order has its own key,
          derived from your account. When you place one, the Vision wallet holding the tokens or SOL gives that key on-chain
          permission to move up to exactly the amount the order sets aside; the token program enforces that amount, and our order
          service sends the proceeds back to the same Vision wallet. While the order is live, that key, which our service holds, can
          move those tokens or that SOL; nothing else in the wallet or the Pool. Our service keeps order details encrypted when stored
          and deletes an order's key when the order ends. Cancelling the order revokes that permission on-chain, with a network fee paid
          from the Vision wallet. If an order ends another way, the app removes any permission left on-chain when it is next open on the device that placed the order, or offers you a way to remove it.
        </C>
        <C n="6.12" t="How orders run">
          Orders watch market prices from Jupiter and trade through Jupiter when the price you set is reached, within the price room you
          chose. A limit buy or a take-profit step trades only if the trade's own quote meets your price, and the least it must deliver
          is set in the transaction, so, measured with Jupiter's prices at the time of the trade, it doesn't fill at a worse price than
          yours (on a sale, a token's own transfer tax comes on top); when the market can't meet it, it keeps waiting. A stop-loss
          normally sells only after a second, newer price confirms the first; if the token has no market price for a few minutes, a
          live sell quote at or below the stop can trigger it. It then sells at the market within its own price room, so it can sell
          below its price; it does not sell if the price has clearly recovered above the stop. A trailing stop follows the
          highest price seen since the order started or was last changed. DCA buys are made at the market, and unless you choose exact
          timing each one is moved by a random amount of up to 10% of the interval, at most 30 minutes. Trades wait their turn in a
          queue that puts stop-losses first. Changes you make to a running order apply from the next price check without a new approval; an
          order's amount can only be lowered, and the on-chain permission stays at the amount first set aside until the order ends or
          is cancelled. Our relayer pays the network fees of order trades. The proceeds of a sale stay in the
          Vision wallet until the app moves them into the Pool, the next time it is open. We don't guarantee that an order fills, fills
          at any particular time, or fills at all: prices can move fast, routes can be missing, and our service or Jupiter can be
          unavailable or delayed. Tokens that tax transfers pay that tax one extra time when an order runs. Orders end when they fill,
          expire or are cancelled, or when the tokens or SOL leave the Vision wallet, and we may cancel an order at any time. You remain
          responsible for your orders and their results.
        </C>
        <C n="6.13" t="Paying from your wallet">
          When you pay from your connected wallet on the Send tab, your wallet makes one deposit into the Pool, sized to the payment and
          its fees, and the deposit goes through screening and the waiting room like any other. The payment's details (the recipient,
          the amount, the timing you chose, and which deposit pays for it) are kept on that device only, and are never sent to our
          servers ahead of the payment. Once the deposit joins your private balance, the app proves the payment and hands it to our
          relayer automatically, sent at once or at a random moment within the window you chose. The app has to be open, or opened
          again on the same device, for that to happen; until it does, the SOL stays in your private balance. On another device it shows
          as private balance, not as a payment. You can stop the payment until it is handed over, and the SOL then stays in your private
          balance, or take the deposit back to your wallet while it is in the waiting room. A payment more than a day old, or one whose
          fees rose above what its deposit covers, waits for you to decide. If the payment can't be made (for example because its
          recipient is refused), nothing is sent and the SOL stays in your private balance.
        </C>
        <C n="6.14" t="Actions across several Vision wallets">
          When you buy, sell, move back or send with several Vision wallets at once, the app in your browser runs each wallet's action
          in turn, with the gap you chose, as if you had started each one yourself. The list of wallets and where each one got to are
          kept on that device only. Keep the page open while it runs: if it closes, the wallets that haven't had their turn keep what
          they hold, and the app offers to continue or stop the next time it is open on the same device, after checking where an
          interrupted wallet got to. Each wallet's action can fail on its own (for example when a route is missing or the price moves
          past your price room); the others still run. Spacing the wallets out and varying their amounts makes them harder to link to
          each other, not impossible.
        </C>

        <h2>7. Fees</h2>
        <C n="7.1" t="Pool fee">
          The Pool charges a fee on every deposit, paid on top of the amount, and on every amount that leaves the Pool. It was 0.8% when
          these terms were last updated, and the program never allows more than 1%. The fee is shown before you confirm.
        </C>
        <C n="7.2" t="When the deposit fee is taken">
          The deposit fee is paid with the deposit, waits with it in the waiting room and goes to the fee wallet when the deposit joins
          the Pool. If the deposit is taken back or sent back, its fee goes back with it.
        </C>
        <C n="7.3" t="Relayer fee">
          Private sends and buys also include a relayer fee for the network costs the relayer pays on your behalf. You see it before
          you confirm. It can be a little more than the relayer's real cost, and any excess is kept.
        </C>
        <C n="7.4" t="Other costs">
          Transactions sent from your own wallet cost Solana network fees, which you pay. Jupiter, the exchanges it uses and some token
          issuers take their own fees as well.
        </C>
        <C n="7.5" t="Changes">
          We may change the pool fee, within the 1% limit, and how the relayer fee is worked out, at any time and without notice. The
          program never charges more than the fee you approved: if the fee rises before your payment lands, the payment fails and you
          can try again.
        </C>
        <C n="7.6" t="No refunds">
          Except where these terms say otherwise, fees paid are not refunded.
        </C>
        <C n="7.7" t="Taxes">
          You are responsible for working out and paying any tax on your use of VisionSwap.
        </C>

        <h2>8. Our control over the Pool</h2>
        <C n="8.1" t="Upgrades">
          For now, the Pool program can be upgraded with a key that the operator holds. We plan to move that key to a multisig and,
          once the code has been audited, to make the program permanent. Until that happens, an upgrade could rewrite any rule of the
          Pool, even the rules about who may move funds, and could do so at once, with no advance notice.
        </C>
        <C n="8.2" t="Settings">
          Without an upgrade, we can change the pool fee (up to 1%), the deposit limits and pool cap, the waiting time (up to about
          seven days), the screening rules and the key that signs screening passes, and the fee wallet; pause new deposits; and hand
          these powers to someone else.
        </C>
        <C n="8.3" t="What the current program doesn't allow">
          As the program stands, nobody, including us, can move, freeze or redirect SOL in the Pool, or pause private sends and
          withdrawals. Section 8.1 still applies.
        </C>
        <C n="8.4" t="Changes to the Services">
          The website, the relayer and the rest of the Services may change, pause or close at any time. If we plan to shut them down,
          we'll try to announce it on the website beforehand where the law and circumstances allow. Either way, the Pool program keeps
          running on Solana.
        </C>

        <h2>9. What's private and what isn't</h2>
        <C n="9.1" t="Public on Solana, permanently">
          Each deposit (the depositing wallet, the amount and the time); deposits taken back or sent back; each private send and
          withdrawal (the recipient, the amount, the fees and the time); and the activity and holdings of every Vision wallet.
        </C>
        <C n="9.2" t="Hidden from everyone, including us">
          Which deposit paid for which payment, your private balance and which notes are yours. Your browser finds your notes itself.
        </C>
        <C n="9.3" t="What our servers see">
          Like any website, our servers and our hosting provider see the connections they receive, such as IP addresses and browser
          details, and the requests you send, including the payments you ask us to relay or schedule, the orders you place and the
          addresses you check. Scheduled payments and orders are stored encrypted while they run. The website loads
          no third-party scripts, fonts or trackers, and VisionSwap's software keeps no logs of IP addresses or wallet addresses. For
          the strongest privacy, use a VPN or Tor.
        </C>
        <C n="9.4" t="How people can still link you">
          Observers may connect your activity through amounts, timing, address reuse, what you do after a payment and how busy the Pool
          is. Large or unusual amounts stand out. Wait between steps, use amounts that differ from your deposit, and never send back to
          the wallet you deposited from.
        </C>
        <C n="9.5" t="No promise of anonymity">
          Exposure checks, tips and estimates help you judge your privacy; they are not guarantees. Nobody can promise that your
          activity will never be traced, and we don't.
        </C>

        <h2>10. Risks you accept</h2>
        <p>By using VisionSwap you accept the risks below. Any of them could cost you some or all of what you put in.</p>
        <ul>
          <li>
            <strong>Unaudited software.</strong> No independent firm has audited the program or its zero-knowledge circuit yet, and
            even a future audit couldn't rule out every error.
          </li>
          <li>
            <strong>Technology.</strong> Bugs or attacks can hit the program, the zero-knowledge proofs and their trusted setup, or the
            code running in your browser.
          </li>
          <li>
            <strong>The upgrade key.</strong> Whoever holds the upgrade key can change the program. If that key is lost, stolen or
            misused, the Pool and its funds could suffer.
          </li>
          <li>
            <strong>Amounts at stake.</strong> Deposit limits may be high or absent, so a single error could affect large amounts,
            including yours.
          </li>
          <li>
            <strong>Your wallet and keys.</strong> Losing your wallet or private key, or having your VisionSwap signature, private key,
            or a Vision wallet's or deposit address's key stolen, can mean losing your funds.
          </li>
          <li>
            <strong>Our servers.</strong> If they are down, you may not be able to use the website, and orders and scheduled payments
            may be delayed. If they are breached, the connection data they see could be exposed, and the amounts approved for live
            orders could be at risk.
          </li>
          <li>
            <strong>Screening.</strong> Screening can wrongly delay, refuse or return a deposit or payment.
          </li>
          <li>
            <strong>Third parties.</strong> VisionSwap relies on Solana, RPC providers, Jupiter and the exchanges it uses, wallets,
            screening providers, token issuers and our hosting provider, none of which we control.
          </li>
          <li>
            <strong>Tokens.</strong> A token's price can collapse, it can become impossible to sell, and its issuer may be able to freeze,
            tax or block it.
          </li>
          <li>
            <strong>The network.</strong> Solana can be congested or stop, fees change, and transactions can fail or expire.
          </li>
          <li>
            <strong>Other platforms.</strong> An exchange or other service may ask questions about, hold or turn away funds that have
            been through a privacy tool.
          </li>
          <li>
            <strong>Law and regulation.</strong> Regulators and courts are paying close attention to privacy tools. A new law, ruling or
            enforcement action could limit VisionSwap or stop you from using it.
          </li>
          <li>
            <strong>Market.</strong> SOL and every token can lose value quickly, including while your money waits or sits in the Pool.
          </li>
        </ul>

        <h2>11. Prohibited use</h2>
        <p>You must not use VisionSwap, or help anyone else use it, to:</p>
        <ul>
          <li>hide or launder the proceeds of crime, fund terrorism, or get around sanctions;</li>
          <li>move money taken in a hack, theft, fraud, scam or ransomware attack, or obtained through any other crime;</li>
          <li>use funds that aren't lawfully yours to use;</li>
          <li>break any law that applies to you or to us;</li>
          <li>act on behalf of someone that section 2 excludes;</li>
          <li>dodge screening or any other restriction in these terms;</li>
          <li>attack, probe, overload or disrupt VisionSwap or the Pool, or take advantage of a bug (tell us about it instead);</li>
          <li>harass, stalk or expose other people with the Exposure check or any other part of VisionSwap;</li>
          <li>run bots or scripts against VisionSwap in a way that puts an unreasonable load on it; or</li>
          <li>lie to us or pretend to be someone else.</li>
        </ul>

        <h2>12. Third-party services</h2>
        <C n="12.1" t="What we don't control">
          VisionSwap works with things we don't control: your wallet, the Solana network, Jupiter and the exchanges it routes through,
          RPC and data providers, screening providers, token issuers and our hosting provider.
        </C>
        <C n="12.2" t="Not our responsibility">
          We can't answer for them: not for whether they work or are secure, nor for any loss they cause. Each has its own terms, which
          apply when you use it.
        </C>
        <C n="12.3" t="Links">
          A link to another website is a convenience, not a recommendation.
        </C>

        <h2>13. No advice, and $VSWAP</h2>
        <C n="13.1" t="No advice">
          VisionSwap gives no financial, investment, legal, tax or compliance advice, and that includes Exposure checks and statements.
          Decisions about using it are yours alone.
        </C>
        <C n="13.2" t="No fiduciary duty">
          We are not your fiduciary. We owe you only what these terms say.
        </C>
        <C n="13.3" t="$VSWAP">
          $VSWAP is VisionSwap's community token on Solana. Its contract address is the one published on visionswap.net; any other
          token using our name is not ours. Our buyback, burn and holder-reward program is described on the Tokenomics page, and we
          may change, pause or end it. You don't need $VSWAP to use VisionSwap. Holding it doesn't make you an owner of VisionSwap, or
          give you any claim on the Pool, on anyone's funds or to any particular payment. Tokens can lose their value, and these
          terms don't govern trading any token.
        </C>

        <h2>14. Intellectual property</h2>
        <C n="14.1" t="Ownership">
          The VisionSwap name, logo, website design and text belong to us or our licensors. Where we publish VisionSwap's source code
          under an open-source licence, that licence governs the code.
        </C>
        <C n="14.2" t="Your permission to use the site">
          As long as you keep to these terms, you have a personal, non-exclusive and revocable permission to use the website as
          intended.
        </C>
        <C n="14.3" t="Feedback">
          Suggestions you send us are ours to use however we like, without paying you.
        </C>

        <h2>15. Disclaimers</h2>
        <C n="15.1" t="As is">
          VisionSwap is provided "as is" and "as available". As far as the law allows, we make no warranties of any kind, express or
          implied, including of merchantability, satisfactory quality, fitness for a particular purpose or non-infringement.
        </C>
        <C n="15.2" t="No promises about results">
          In particular, VisionSwap may go down, have bugs or be breached; screening can get things wrong; and your privacy is not
          assured.
        </C>
        <C n="15.3" t="Everything else we publish">
          The Docs, our posts on X and anything else we publish are there to inform you. They may be incomplete or out of date, they
          are not part of these terms, and where they disagree with these terms, these terms take priority.
        </C>

        <h2>16. Limitation of liability</h2>
        <C n="16.1" t="Losses we don't cover">
          As far as the law allows, we won't be liable to you for losses that are indirect, incidental, special or consequential, or
          for punitive damages; for lost profits, revenue, business, opportunities, goodwill or data; for digital assets that are lost
          or fall in value; or for losses that come from a risk listed in section 10, from a third party, or from your own breach of
          these terms. It makes no difference how a claim is framed, whether in contract, negligence, breach of statutory duty or
          otherwise, or whether we knew such a loss could happen.
        </C>
        <C n="16.2" t="Cap">
          As far as the law allows, our total liability to you for all claims connected with VisionSwap or these terms is limited to
          the greater of US$100 and the fees you paid through VisionSwap in the 12 months before the claim arose.
        </C>
        <C n="16.3" t="Who this protects">
          Our affiliates, contributors, contractors and service providers, and the people who work for any of them, get the same
          protection from sections 15 to 17 as we do.
        </C>
        <C n="16.4" t="What isn't limited">
          Nothing in these terms limits any liability that the law does not allow to be limited, such as liability for fraud.
        </C>
        <C n="16.5" t="Why">
          We can only offer VisionSwap on these terms, and the limits in this section are a fundamental part of them.
        </C>

        <h2>17. Indemnity</h2>
        <p>
          As far as the law allows, you will defend and reimburse us, and the people in section 16.3, against any claim, loss, fine or
          cost (reasonable legal fees included) that results from your breaking these terms or any law, from your infringing someone
          else's rights, or from the funds you deposit and the payments you make.
        </p>

        <h2>18. Suspension and ending</h2>
        <C n="18.1" t="By you">
          You may stop using VisionSwap at any time.
        </C>
        <C n="18.2" t="By us">
          We can limit or cut off your access to VisionSwap whenever we need to, without warning: for instance if you break these
          terms, fail screening, or pose a legal or security risk to us, other users or the Pool, or if the law requires it.
        </C>
        <C n="18.3" t="Your funds">
          Ending your access to our website or relayer doesn't change what the Pool holds for you. That is controlled by the Pool
          program, not by us.
        </C>
        <C n="18.4" t="What continues">
          Sections 9, 10 and 13 to 21 still apply after your use of VisionSwap ends.
        </C>

        <h2>19. Disputes</h2>
        <C n="19.1" t="Talk to us first">
          If something goes wrong, tell us first (section 22) and explain the problem. Neither side may start a legal claim until we
          have both spent 30 days trying, in good faith, to settle it.
        </C>
        <C n="19.2" t="Individual claims only">
          As far as the law allows, you may only bring claims against us on your own behalf, and not as part of any class, collective
          or representative action.
        </C>
        <C n="19.3" t="Time limit">
          As far as the law allows, a claim brought more than one year after the events behind it is barred.
        </C>
        <C n="19.4" t="Consumers">
          If you are a consumer, nothing in these terms takes away a protection that the law of your home country does not allow a
          contract to override.
        </C>

        <h2>20. Changes to these terms</h2>
        <C n="20.1" t="New versions">
          These terms will change from time to time. The latest version is always on this page with its date, and we'll try to flag
          important changes in the app too.
        </C>
        <C n="20.2" t="When they apply">
          Using VisionSwap after a new version's date means you accept it. If you don't, stop using VisionSwap.
        </C>

        <h2>21. General</h2>
        <C n="21.1" t="Whole agreement">
          These terms set out everything agreed between you and us about VisionSwap.
        </C>
        <C n="21.2" t="Severability">
          If a court or other authority finds part of these terms invalid or unenforceable, the remaining parts still stand.
        </C>
        <C n="21.3" t="No waiver">
          Not enforcing a right now doesn't stop us enforcing it later.
        </C>
        <C n="21.4" t="Transfer">
          If someone else takes over VisionSwap, or we move it to an affiliate, these terms can go with it. You need our written
          agreement to pass your side of them to anyone.
        </C>
        <C n="21.5" t="Who else has rights">
          Apart from the people protected by section 16.3, who can enforce sections 15 to 17, no one other than you and us has rights
          under these terms.
        </C>
        <C n="21.6" t="Events beyond our control">
          We aren't responsible when something beyond our reasonable control, such as an outage of Solana or of a provider, an attack
          or a government action, stops or delays VisionSwap.
        </C>
        <C n="21.7" t="Language">
          The English version of these terms is the one that counts, whatever any translation says.
        </C>
        <C n="21.8" t="Notices">
          We'll give you any notice by publishing it on the website or in the app.
        </C>

        <h2>22. Contact</h2>
        <p>Legal notices, law-enforcement requests, screening reviews and privacy questions: {reach}.</p>
      </main>
      <Footer />
    </div>
  );
}
