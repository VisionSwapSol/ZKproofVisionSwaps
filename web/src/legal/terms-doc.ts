/**
 * The Terms of use, version 2, as data: the Terms page, the Terms window's full text, the published
 * archive (web/public/legal) and the fingerprint people accept all come from this one source.
 *
 * Every sentence has to stay true to the code and to how VisionSwap runs today (the VisionSwap
 * service, web/src, program/); web/test/claims.test.ts scans this file for the wording listed in
 * web/test/retracted.ts. The clauses that depend on the operator's legal settings (who we are, the
 * governing law, the courts, arbitration) appear only once those are set (legal/settings.ts); nothing
 * here invents them. The legal contact is the owner's support address, support@visionswap.net, unless
 * the owner names another (DEFAULT_LEGAL_SETTINGS). This text was drafted for review by a qualified
 * lawyer and is not legal advice.
 *
 * Inline markup: [label](href) is a link. Nothing else is interpreted.
 *
 * Changing any word changes the fingerprint: web/test/terms.test.ts then asks for the archive to be
 * written again (npm run terms:archive -w web) and for a deliberate version decision in lib/terms.ts
 * (a new major number when the change is material, so people accept again).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { TERMS_EFFECTIVE, TERMS_VERSION } from "../lib/terms";
import { TOKEN_LAUNCH_ENABLED } from "../lib/token-launch";
import { longDate } from "../seo/pages";
import { contactHref, contactText, type LegalSettings } from "./settings";

export type Clause = { t: string; text: string };
export type Block =
  | { k: "p"; text: string }
  | { k: "clauses"; items: Clause[] }
  | { k: "list"; items: string[] }
  | { k: "risks"; items: Clause[] };
export type Section = { n: number; id: string; title: string; blocks: Block[] };
export type TermsDoc = {
  version: string;
  effective: string;
  /** read this first: what the Terms do that a reader most needs to know */
  notice: string;
  /** "The main points": a summary, which the Terms themselves say is not the agreement */
  summary: string[];
  sections: Section[];
};

const X = "[@VisionSwapSol on X](https://x.com/VisionSwapSol)";

/** "the operator of VisionSwap", or the entity the owner named, with its registration and address when set. */
function party(s: LegalSettings): string {
  if (!s.entity) return "the operator of VisionSwap";
  const reg = s.registration ? `, ${s.registration}` : "";
  const addr = s.address ? `, whose registered address is ${s.address}` : "";
  return `${s.entity}${reg}${addr}`;
}

/** Where legal notices go: the legal contact (support@visionswap.net by default), or the official X account if the owner turned it off. */
function noticesTo(s: LegalSettings): string {
  const href = contactHref(s.contact);
  const c = contactText(s.contact);
  return href && c ? `[${c}](${href})` : X;
}

const clauses = (...items: (Clause | null | false)[]): Block => ({ k: "clauses", items: items.filter((c): c is Clause => !!c) });

/** The Terms in force, with the operator's legal settings `s`. */
export function termsDoc(s: LegalSettings): TermsDoc {
  const arb = s.arbitration;
  const token = TOKEN_LAUNCH_ENABLED;
  const sections: Section[] = [
    {
      n: 1,
      id: "about",
      title: "About these Terms",
      blocks: [
        clauses(
          {
            t: "The agreement",
            text: `These Terms of use (the "Terms") are a legally binding agreement between you and ${party(s)} ("we", "us" or "our"). They apply whenever you use VisionSwap. If you don't agree to them, please don't use VisionSwap.`,
          },
          {
            t: "How you accept them",
            text: `Before you connect a wallet, open, create or unlock an account, or pay a payment link from a connected wallet, VisionSwap shows these Terms in a window on the website, in the Android app and in the Chrome extension whenever the browser or extension you are using holds no record of your accepting them (section 1.6), or they have changed materially since (section 22.2). You accept them by ticking each box in that window and selecting "Agree and continue". The window shows the version you are accepting. If you use the website without opening an account, for example to read its pages or run an Exposure check, these Terms apply to that use as well.`,
          },
          {
            t: "What they cover",
            text: `"VisionSwap" or the "Services" means the website at visionswap.net, the app and documentation on it, the VisionSwap app for Android (which opens the website full screen), the VisionSwap extension for Chrome, the Exposure check, and the servers we run for them, including the relayer, the screening service, the service that moves deposits out of the waiting room, the order service and the service that delivers payments to outside addresses. The "Pool" is the VisionSwap program on Solana mainnet and the accounts it controls; its address is in the [Docs](/docs#onchain).`,
          },
          {
            t: "Other pages",
            text: `Our [Privacy policy](/privacy) explains what data VisionSwap handles; it is a notice, not part of this agreement. The [Docs](/docs), the [Security](/security) and [Compliance](/compliance) pages, the FAQ and our posts explain how VisionSwap works. They are information only, and where they differ from these Terms, these Terms take priority.`,
          },
          {
            t: "Acting for someone else",
            text: "If you use VisionSwap on behalf of a company or another person, you confirm that you have the authority to accept these Terms for them, and they are bound by them too.",
          },
          {
            t: "Your record of acceptance",
            text: "When you accept, your browser (or the extension) keeps a record on your device of the version you accepted, when you accepted it and a fingerprint of the exact text you were shown. We don't receive that record. You can see the record your browser keeps, save it or remove it at the end of this page, which also lists every version of these Terms with its fingerprint; the extension's record is removed with the extension. Removing it doesn't affect your funds; VisionSwap simply asks you to accept the Terms again.",
          },
        ),
      ],
    },
    {
      n: 2,
      id: "eligibility",
      title: "Who may use VisionSwap",
      blocks: [
        clauses(
          { t: "Age and capacity", text: "You must be at least 18 years old, or the age of majority where you live if that is higher, and legally able to make this agreement." },
          {
            t: "Sanctions",
            text: "You may not use VisionSwap if you, anyone who owns or controls you, or anyone you act for, is named on a sanctions list maintained by the United Nations, the United States, the European Union or the United Kingdom, or is owned or controlled by someone who is. You may not use VisionSwap to deal with, or for the benefit of, any such person.",
          },
          {
            t: "Restricted places",
            text: "VisionSwap is not for anyone who is in, lives in, or is a company formed in Cuba, Iran, North Korea, Syria, Russia, Belarus or the United Arab Emirates; the Crimea (including Sevastopol), Donetsk or Luhansk regions of Ukraine; any other country or region under comprehensive sanctions of the bodies named in 2.2; or any place where using a privacy tool like VisionSwap is against the law. We may change this list at any time.",
          },
          {
            t: "Your local laws",
            text: "Some countries restrict privacy tools, or the digital assets people may hold or trade. It's up to you to know and obey the laws that apply to you, including tax and reporting rules.",
          },
          {
            t: "No way around this section",
            text: "VPNs and Tor are welcome for privacy, but not as a way around this section: don't use them, or anything else, to disguise where you are so that you can use VisionSwap from a restricted place.",
          },
          {
            t: "Your confirmation",
            text: "We don't ask for your name or identity documents, so we rely on you: every time you use VisionSwap, you confirm that this section applies to you. If it stops applying, you must stop using VisionSwap.",
          },
          {
            t: "Our checks",
            text: "We may check where a connection comes from and refuse connections from the places in 2.3, and we can block any address, device, network or region whenever we choose. Not being blocked doesn't mean that you may use VisionSwap.",
          },
        ),
      ],
    },
    {
      n: 3,
      id: "what",
      title: "What VisionSwap is, and what it isn't",
      blocks: [
        clauses(
          {
            t: "What you can do",
            text: "With VisionSwap you can move SOL into the Pool from your own wallet or, by QR code or payment link, from any wallet or exchange; hold a private balance; send SOL privately from the Pool to any Solana address, now or later, to one or several recipients; buy and sell tokens through Vision wallets, now or with orders; check how much a wallet's public history gives away; and download statements of your own activity.",
          },
          {
            t: "Self-custody",
            text: "VisionSwap is self-custody software: your funds stay under the control of keys that only you hold, except as section 6.11 describes for orders. SOL in the Pool is held by the Pool program together with everyone else's, under the program's rules and subject to section 8. It is not in an account with us, and we never hold your wallet's keys or your spending and viewing keys. Tokens bought through a Vision wallet sit in that Vision wallet, an ordinary Solana address that only your keys control, apart from any amount you set aside for a live order (section 6.11). SOL sent to one of your deposit addresses sits at that address, which only your keys control, until it moves into the Pool.",
          },
          {
            t: "What we are not",
            text: "We are not a bank, exchange, broker, custodian, payment institution, investment adviser or trustee. Nothing you hold through VisionSwap is a deposit with us, and nothing is covered by deposit insurance or any investor compensation scheme.",
          },
          {
            t: "Final transactions",
            text: "VisionSwap works through transactions on a public blockchain, and a confirmed transaction is permanent: neither you nor we can undo it.",
          },
          {
            t: "New software",
            text: "VisionSwap launched recently and is still changing. Its features, fees, limits and the tokens you can trade may change, and parts of it may be down from time to time.",
          },
          {
            t: "Availability",
            text: "We don't promise that VisionSwap, or any feature, token or trading route, will be available at any particular time, in any particular place, or at all.",
          },
        ),
      ],
    },
    {
      n: 4,
      id: "keys",
      title: "Your wallet, your keys and your devices",
      blocks: [
        clauses(
          {
            t: "Your wallet or private key",
            text: "You open an account with a self-custody Solana wallet that can sign messages, with a passkey, or with a VisionSwap private key. Some wallets, including multisig, MPC and some hardware wallets, can't open an account; a private key works instead.",
          },
          {
            t: "Where your keys come from",
            text: "With a wallet, it signs a fixed message and your browser turns that signature into the keys for your private balance, your Vision wallets and your deposit addresses. With a private key or a passkey, those keys come from that key instead. Your spending and viewing keys stay in your browser: we never receive them, and our servers cannot spend your private balance. Orders use separate order keys, also derived from your account, as section 6.11 describes.",
          },
          {
            t: "Guard your signature and your private key",
            text: "Anyone who obtains that signature or your private key can spend your private balance. Only ever sign the message, or enter your private key, on visionswap.net, and check that your wallet names visionswap.net when it asks you to sign. If you choose to stay signed in, your private key is kept in that browser, sealed so that only that browser can open it, so only do that on a device you trust.",
          },
          {
            t: "Same wallet, same account",
            text: "Always open your account with the same wallet. Some wallets, including some hardware wallets, sign the message differently and would open a different, empty account.",
          },
          {
            t: "No recovery",
            text: "If you lose access to your wallet, your passkey and its backup key, or your private key, nobody, including us, can recover your private balance, your Vision wallets or your deposit addresses.",
          },
          {
            t: "Passkeys",
            text: "You can open an account without a wallet with a passkey (for example Face ID, a fingerprint or a security key). Your passkey produces the account's key on your device; we never receive it. The same passkey opens the same account wherever it syncs; a different passkey opens a different account. Before a new passkey account opens, the app checks that the passkey signs in again and asks you to save a backup private key. If the passkey is deleted or lost and you didn't keep that backup key, nobody, including us, can recover the account.",
          },
          {
            t: "Your devices",
            text: "Keeping your wallet, devices, browser and backups secure is up to you, and you are responsible for whatever your wallet signs and for everything done with your keys.",
          },
          {
            t: "Records kept only on your device",
            text: "Some things are kept only in your browser or in the extension: payments from your wallet that are waiting to go (6.13), the progress of actions across several Vision wallets (6.14), the payment links you made, the names you gave Vision wallets, your activity list and your record of accepting these Terms. Clearing the site's data, removing the extension or losing the device deletes them, and we can't restore them. Your private balance is on Solana, and your keys open it again on any device.",
          },
          {
            t: "Official places only",
            text: "Use VisionSwap only at visionswap.net, through the VisionSwap app for Android downloaded from visionswap.net, or through the VisionSwap extension published in the Chrome Web Store. Never share your wallet's recovery phrase or secret key, your VisionSwap private key or backup key, or the signature your wallet makes for VisionSwap, with anyone, whatever they tell you.",
          },
        ),
      ],
    },
    {
      n: 5,
      id: "deposits",
      title: "Deposits, screening and the waiting room",
      blocks: [
        clauses(
          {
            t: "Depositing",
            text: "You deposit from your own wallet, or by sending SOL to one of your deposit addresses, and you pay the amount, the deposit fee and Solana's network fee. By QR code these come out of what arrives, together with a small account deposit that returns to the deposit address when the deposit joins the Pool. The program enforces a minimum deposit.",
          },
          {
            t: "Deposit limits",
            text: "The program's settings also set a largest single deposit and a cap on how much the Pool may hold. When these Terms were last updated, they were 300 SOL per deposit and 30,000 SOL for the whole Pool. The VisionSwap team can change or remove them (section 8.2); the [Docs](/docs#fees) show the limits in force.",
          },
          {
            t: "Screening",
            text: "Before a deposit, the depositing address and the wallets that recently paid SOL into it are checked against the U.S. sanctions list (OFAC's list of Specially Designated Nationals) and the addresses we refuse. We may add other sources, such as an outside risk service; the [Compliance](/compliance#policy) page says which are in use. For a deposit address, the wallets that paid into it are checked. A deposit whose funds can't be traced back far enough may be refused. Screening looks only at addresses and their public history: we never ask for your name or ID.",
          },
          {
            t: "The waiting room",
            text: "Each deposit then waits in a public waiting room, for a time shown in the app, before it joins the Pool. We can change that time; the program caps it at 1,512,000 Solana slots, about three and a half days at Solana's slot time when these Terms were last updated. A waiting deposit is not yet part of your private balance.",
          },
          {
            t: "Outcomes",
            text: "Screening can stop a deposit before you send it, check it again while it waits, send it back to the address it came from, or keep our app and servers from adding it to the Pool while it is reviewed. These are our decisions to make, and we may be unable to explain them for legal or security reasons.",
          },
          {
            t: "Taking a deposit back",
            text: "Until it joins the Pool, you can take a deposit back at any time, deposit fee included. It goes back only to the address it came from. You pay the network fee, unless a deposit address has nothing left to pay it with; then our guard pays it, up to a daily limit.",
          },
          {
            t: "Returns go to the depositing address",
            text: "A deposit can only ever be returned to the address that made it, so deposit from a wallet you control. When you shield by QR code, that address is your own deposit address: anything returned waits there for you, and you can send it on to any wallet. SOL that fails screening is not moved into the Pool and stays at the deposit address.",
          },
          { t: "Later refusals", text: "An address that fails screening once may be refused again, both as a depositor and as a recipient." },
          {
            t: "No guarantee",
            text: "Screening makes it harder for unlawful money to get into the Pool, but it can't prove that everything in the Pool came from a lawful source, and it can wrongly flag lawful funds.",
          },
          {
            t: "Reviews",
            text: "Think we got a screening decision wrong? Contact us (section 24) with the depositing address and the transaction. We'll review it, but we can't promise a different outcome or a reply by any particular time.",
          },
        ),
      ],
    },
    {
      n: 6,
      id: "payments",
      title: "Private sends, buys, sells and orders",
      blocks: [
        clauses(
          {
            t: "How they work",
            text: "Your browser builds a zero-knowledge proof that the payment is yours to make. A relayer, normally ours, submits it to Solana and pays the network fee, which is repaid from the payment. The recipient, the amount, the relayer fee and the highest pool fee you accept are bound into the proof, so the relayer can't change them.",
          },
          {
            t: "This website needs our servers",
            text: "The website relies on our servers for relaying, screening and chain data. The Pool program doesn't depend on them, but we don't promise any other way to use it.",
          },
          {
            t: "Refusals and delays",
            text: "Our relayer can turn down, hold back or queue a payment, for instance when it is rate-limited or busy, when fees change, after a screening result, or for legal or security reasons.",
          },
          {
            t: "Private sends",
            text: "A private send pays SOL out of the Pool to the address you enter. A send to an address outside your own VisionSwap wallets goes through a one-time sending address made for that payment, which only your app holds the key to, and reaches the recipient as a standard SOL transfer from it. Anyone can see that address, the amount, the fees and when it happened. The recipient is screened too, and we may decline to pay it.",
          },
          {
            t: "Buys and sells",
            text: "A private buy moves SOL from the Pool to one of your Vision wallets, which then trades through Jupiter, a third-party aggregator that routes through other exchanges. Prices can move before a trade completes, within the slippage you accept, and trades can fail. Before you confirm, the app shows the minimum you will receive, and the trade is built to fail rather than deliver less. A faster speed setting adds a network priority fee, up to the cap the app shows. A sale swaps back to SOL and deposits it into the Pool, which pays the deposit fee; a sale too small for a deposit leaves its SOL in the Vision wallet. Vision wallets, what they hold and everything they do, including being funded from the Pool, are public on-chain; VisionSwap only avoids funding them from your own wallet.",
          },
          {
            t: "Tokens",
            text: "We don't create, review, list or endorse tokens: the app can show any token Jupiter can trade. Many tokens are worthless or fraudulent, and some let their issuer freeze, tax or block transfers. You buy any token at your own risk.",
          },
          { t: "Check before you confirm", text: "Double-check every address, token and amount before you confirm. Anything sent to the wrong address is gone for good." },
          {
            t: "Sending later, and several payments at once",
            text: 'If you choose to send later, your browser makes the proof straight away and our relayer submits it at a random moment within the window you chose. When the Pool is busy, it may submit the payment earlier than planned, still within that window, so that its proof does not expire, and while the app is open it may make a fresh proof shortly before the payment goes out. The relayer can only send that exact payment, or not send it. Until it goes out, the notes it spends are set aside and VisionSwap won\'t spend them elsewhere; you can cancel it until then. If they are spent another way first, the scheduled payment fails and nothing is sent. If it isn\'t sent, those funds remain yours. A payment that still needs a fresh proof (for example when the Pool has changed a lot) waits until the app makes one, the next time you open it. While our relayer is being topped up, scheduled payments wait. To hold back only what it sends, a later payment usually first sets aside a note of its own size within your private balance, which costs a relayer fee. Sending to several recipients makes one payment each, each with its own fees; several payments sent "now" go out one by one at random moments over about two minutes. Every private payment to another wallet or an exchange arrives as a standard SOL transfer from a one-time sending address, so exchanges and wallets credit it like any other deposit.',
          },
          {
            t: "Sending it yourself",
            text: "If our relayer is unavailable, you can submit a private send with a fee payer of your own: one of your account's fee wallets (by default a new one for each payment) or a Vision wallet. That fee payer is visible in the transaction and pays the network costs up front; the payment repays them. This way sends one payment at a time.",
          },
          {
            t: "Payment links",
            text: "A payment link points to a fresh deposit address of your account, and is meant for one payer. What is paid to it is screened and moves into your private balance like any deposit, with the same fees and rules, when your account is open in the app; several paid links move in one at a time, a few minutes apart. The payer and the amount they send to that address are visible on-chain. If you pay someone else's link, you make a standard, final SOL transfer to their address: we don't check or vouch for the person asking, and if what you pay fails screening, it stays at their address and we don't send it back to you.",
          },
          {
            t: "Orders",
            text: "Limit buys, DCA, take-profit, stop-loss and trailing-stop orders are run by our order service. Each order has its own key, derived from your account. When you place one, the Vision wallet holding the tokens or SOL gives that key on-chain permission to move up to exactly the amount the order sets aside; the token program enforces that amount, and our order service sends the proceeds back to the same Vision wallet. While the order is live, that key, which our service holds, can move those tokens or that SOL; nothing else in the wallet or the Pool. For a DCA, that is its whole budget, for as long as the DCA runs. Our service keeps order details encrypted when stored and deletes an order's key from its records when the order ends. Cancelling the order revokes that permission on-chain, with a network fee paid from the Vision wallet. If an order ends another way, the app removes any permission left on-chain when it is next open on the device that placed the order, or offers you a way to remove it.",
          },
          {
            t: "How orders run",
            text: "Orders watch market prices from Jupiter and trade through Jupiter when the price you set is reached, within the price room you chose. A limit buy or a take-profit step trades only if the trade's own quote meets your price, and the least it must deliver is set in the transaction, so, measured with Jupiter's prices at the time of the trade, it doesn't fill at a worse price than yours (on a sale, a token's own transfer tax comes on top); when the market can't meet it, it keeps waiting. A stop-loss normally sells only after a second, newer price confirms the first; if the token has no market price for a few minutes, a live sell quote at or below the stop can trigger it. It then sells at the market within its own price room, so it can sell below its price; it does not sell if the price has clearly recovered above the stop. A trailing stop follows the highest price seen since the order started or was last changed. DCA buys are made at the market, and unless you choose exact timing each one is moved by a random amount of up to 10% of the interval, at most 30 minutes. Trades wait their turn in a queue that puts stop-losses first. Changes you make to a running order apply from the next price check without a new approval; an order's amount can only be lowered, and the on-chain permission stays at the amount first set aside until the order ends or is cancelled. Our relayer pays the network fees of order trades. The proceeds of a sale stay in the Vision wallet until the app moves them into the Pool, the next time it is open. We don't guarantee that an order fills, fills at any particular time, or fills at all: prices can move fast, routes can be missing, and our service or Jupiter can be unavailable or delayed. Tokens that tax transfers pay that tax one extra time when an order runs. Orders end when they fill, expire or are cancelled, or when the tokens or SOL leave the Vision wallet, and we may cancel an order at any time. You remain responsible for your orders and their results.",
          },
          {
            t: "Paying from your wallet",
            text: "When you pay from your connected wallet on the Send tab, your wallet makes one deposit into the Pool of a standard size that covers the payment and its fees, and the deposit goes through screening and the waiting room like any other. What the payment doesn't use stays in your private balance as change. The payment's details (the recipient, the amount, the timing you chose, and which deposit pays for it) are kept on that device only, and are never sent to our servers ahead of the payment. Once the deposit joins your private balance, the app proves the payment and hands it to our relayer automatically, sent at once or at a random moment within the window you chose. The app has to be open, or opened again on the same device, for that to happen; until it does, the SOL stays in your private balance. On another device it shows as private balance, not as a payment. You can stop the payment until it is handed over, and the SOL then stays in your private balance, or take the deposit back to your wallet while it is in the waiting room. A payment more than a day old, or one whose fees rose above what its deposit covers, waits for you to decide. If the payment can't be made (for example because its recipient is refused), nothing is sent and the SOL stays in your private balance.",
          },
          {
            t: "Actions across several Vision wallets",
            text: "When you buy, sell, move back or send with several Vision wallets at once, the app in your browser runs each wallet's action in turn, with the gap you chose, as if you had started each one yourself. The list of wallets and where each one got to are kept on that device only. Keep the page open while it runs: if it closes, the wallets that haven't had their turn keep what they hold, and the app offers to continue or stop the next time it is open on the same device, after checking where an interrupted wallet got to. Each wallet's action can fail on its own (for example when a route is missing or the price moves past your price room); the others still run. Spacing the wallets out and varying their amounts makes them harder to link to each other, not impossible.",
          },
        ),
      ],
    },
    {
      n: 7,
      id: "fees",
      title: "Fees",
      blocks: [
        clauses(
          {
            t: "Pool fee",
            text: "The Pool charges a fee on every deposit, paid on top of the amount, and on every amount that leaves the Pool. It was 0.8% when these Terms were last updated, and the program never allows more than 1%. The fee is shown before you confirm.",
          },
          {
            t: "When the deposit fee is taken",
            text: "The deposit fee is paid with the deposit, waits with it in the waiting room and goes to the fee wallet when the deposit joins the Pool. If the deposit is taken back or sent back, its fee goes back with it.",
          },
          {
            t: "Relayer fee",
            text: "Private sends and buys also include a relayer fee for the network costs the relayer pays on your behalf. You see it before you confirm. It can be a little more than the relayer's real cost, and any excess is kept.",
          },
          {
            t: "Other costs",
            text: "Transactions sent from your own wallet cost Solana network fees, which you pay. Jupiter, the exchanges it uses and some token issuers take their own fees as well.",
          },
          {
            t: "Changes",
            text: "We may change the pool fee, within the 1% limit, and how the relayer fee is worked out, at any time and without notice. The program never charges more than the fee you approved: if the fee rises before your payment lands, the payment fails and you can try again.",
          },
          { t: "No refunds", text: "Except where these Terms say otherwise, fees paid are not refunded." },
          { t: "Taxes", text: "You are responsible for working out, reporting and paying any tax on your use of VisionSwap." },
        ),
      ],
    },
    {
      n: 8,
      id: "control",
      title: "The VisionSwap team's control over the Pool",
      blocks: [
        clauses(
          {
            t: "Upgrades",
            text: "For now, the Pool program is upgradeable, and the VisionSwap team holds the key that upgrades it. An upgrade can change any rule of the Pool, even the rules about who may move funds, and can take effect at once, with no advance notice. We plan to move that key to a multisig and, once the code has been audited, to make the program permanent; that is a plan, not a promise, and we can't say when it will happen. The [Docs](/docs#onchain) show the current upgrade key and the deployed code's fingerprint, so anyone can see when the program changes.",
          },
          {
            t: "Settings",
            text: "Without an upgrade, the VisionSwap team can change the pool fee (up to 1%), the deposit limits and pool cap, the waiting time (up to the cap in 5.4), the screening rules and the key that signs screening passes, and the fee wallet; pause new deposits; and hand these powers to someone else. A change takes effect at once, with no advance notice, including for deposits already waiting. Making the program permanent (8.1) would not remove these powers.",
          },
          {
            t: "What the current program doesn't allow",
            text: "As the program stands, no setting lets anyone, including us, move or redirect SOL in the Pool. There is no setting that pauses private sends and withdrawals, but they, and deposits joining the Pool, need the fee wallet to be an address the program can pay: if it were set to one of a few special Solana addresses that can't receive payments, they would stop until it was changed back. Section 8.1 and the risks in section 10 still apply.",
          },
          {
            t: "Changes to the Services",
            text: "The website, the relayer and the rest of the Services may change, pause or close at any time. If we plan to shut them down, we'll try to announce it on the website beforehand where the law and circumstances allow. Either way, the Pool program keeps running on Solana, but spending from it needs the app's code and its proving files, and we don't promise to provide another way to use it.",
          },
        ),
      ],
    },
    {
      n: 9,
      id: "privacy",
      title: "What's private and what isn't",
      blocks: [
        clauses(
          {
            t: "Public on Solana, permanently",
            text: "Each deposit (the depositing wallet, the amount and the time); deposits taken back or sent back; each private send and withdrawal (the recipient, the amount, the fees and the time); transfers inside the Pool that join or cut notes (recognisable as such); how much the Pool holds; and the activity and holdings of every Vision wallet.",
          },
          {
            t: "Not shown on-chain",
            text: "Which deposit paid for which payment, your private balance and which notes are yours. No transaction says, and your browser finds your notes itself. Our servers never receive your spending or viewing keys, but they do see the requests described in 9.3, which can include your deposits, your own addresses and the payments you send.",
          },
          {
            t: "What our servers see",
            text: "Like any website, our servers and our hosting provider see the connections they receive, such as IP addresses and browser details, and the requests you send, including the payments you ask us to relay or schedule, the orders you place and the addresses you check. Scheduled payments and orders are stored encrypted while they run. The website loads no third-party scripts, fonts or trackers, and VisionSwap's software writes no IP addresses or wallet addresses to its logs. For the strongest privacy, use a VPN or Tor. Our [Privacy policy](/privacy) lists what is kept, for how long, and what each service we use receives.",
          },
          {
            t: "How people can still link you",
            text: "Observers may connect your activity through amounts, timing, address reuse, what you do after a payment and how busy the Pool is. Large or unusual amounts stand out. Wait between steps, use amounts that differ from your deposit, and never send back to the wallet you deposited from.",
          },
          {
            t: "No promise of anonymity",
            text: "Exposure checks, tips and estimates help you judge your privacy; they are not guarantees. Nobody can promise that your activity will never be traced, and we don't.",
          },
        ),
      ],
    },
    {
      n: 10,
      id: "risks",
      title: "Risks you accept",
      blocks: [
        {
          k: "p",
          text: "Using VisionSwap involves serious risks. By using it, you confirm that you understand the risks below, that you have decided for yourself to take them, and that you can afford to lose what you put in. Any of them could cost you some or all of it.",
        },
        {
          k: "risks",
          items: [
            {
              t: "Unaudited software",
              text: "No independent firm has audited the program or its zero-knowledge circuit yet, and even a future audit couldn't rule out every error.",
            },
            {
              t: "Technology",
              text: "Bugs or attacks can hit the program, the zero-knowledge proofs and their trusted setup, our servers, or the code running in your browser. The app's code is loaded from visionswap.net each time you open it (the Chrome extension carries its own copy), so that code is part of what you trust.",
            },
            {
              t: "The trusted setup",
              text: "The proofs' trusted setup builds on the public Powers of Tau; its second phase was completed by the VisionSwap team and sealed with a Bitcoin block beacon, and its record is part of the public proving key the app downloads. Like any trusted setup, it relies on the randomness used in that phase having been discarded: anyone who kept it could make proofs that the program accepts and take SOL from the Pool.",
            },
            {
              t: "Advances in cryptography",
              text: "New mathematical techniques or computers, including quantum computers, could one day weaken the signatures, hashes and proofs that VisionSwap and Solana rely on.",
            },
            {
              t: "Upgrades and settings",
              text: "The VisionSwap team can upgrade the program and change its settings (section 8). A mistake, a misuse, or the loss or theft of the keys that control them could harm the Pool and the funds in it, including yours.",
            },
            {
              t: "Amounts at stake",
              text: "The Pool holds everyone's deposits together, up to the limits in section 5.2, so a single error could affect large amounts, including yours.",
            },
            {
              t: "Your wallet and keys",
              text: "Losing your wallet, passkey, backup key or private key, or having your VisionSwap signature, private key, or a Vision wallet's or deposit address's key stolen, can mean losing your funds.",
            },
            {
              t: "Your device and browser",
              text: "Malware, a compromised browser extension or someone with access to your device could take your keys or change what you sign. Records kept only on your device are lost if its data is cleared (section 4.8).",
            },
            {
              t: "Look-alike sites and messages",
              text: "Fake websites, apps, extensions, tokens and accounts may pretend to be VisionSwap to get your signature, keys or funds.",
            },
            {
              t: "Our servers",
              text: "If they are down, you may not be able to use the website, and orders and scheduled payments may be delayed. If they are breached, the connection data they see could be exposed, and the amounts approved for live orders could be at risk.",
            },
            { t: "Screening", text: "Screening can wrongly delay, refuse or return a deposit or payment." },
            {
              t: "Third parties",
              text: "VisionSwap relies on Solana, RPC providers, Jupiter and the exchanges it uses, wallets, screening providers, token issuers and our hosting provider, none of which we control.",
            },
            { t: "Tokens", text: "A token's price can collapse, it can become impossible to sell, and its issuer may be able to freeze, tax or block it." },
            { t: "The network", text: "Solana can be congested or stop, fees change, and transactions can fail, expire or be reordered." },
            {
              t: "Other platforms",
              text: "An exchange or other service may ask questions about, hold or turn away funds that have been through a privacy tool.",
            },
            {
              t: "Law and regulation",
              text: "Regulators and courts are paying close attention to privacy tools. A new law, ruling or enforcement action could limit VisionSwap, make us change or close it, or stop you from using it.",
            },
            { t: "Privacy", text: "Your activity may be easier to link than you expect (section 9)." },
            { t: "Market", text: "SOL and every token can lose value quickly, including while your money waits or sits in the Pool." },
          ],
        },
      ],
    },
    {
      n: 11,
      id: "prohibited",
      title: "Prohibited use",
      blocks: [
        { k: "p", text: "You must not use VisionSwap, or help anyone else use it, to:" },
        {
          k: "list",
          items: [
            "hide or launder the proceeds of crime, finance terrorism or weapons proliferation, or get around sanctions;",
            "move money taken in a hack, theft, fraud, scam, extortion or ransomware attack, or obtained through any other crime;",
            "use funds that aren't lawfully yours to use;",
            "break any law that applies to you or to us, including sanctions, export-control and tax laws;",
            "act on behalf of someone that section 2 excludes;",
            "dodge screening, region checks or any other restriction in these Terms, for instance by splitting deposits or using other people's wallets;",
            "attack, overload or disrupt VisionSwap or the Pool, probe it for weaknesses other than through good-faith security research that follows the guidelines on the [Security](/security) page, or take advantage of a bug instead of reporting it as that page explains;",
            "manipulate a market, for example by wash trading or spoofing;",
            "pretend to be VisionSwap or its team, or make look-alike websites, apps, extensions or tokens;",
            "trick anyone into revealing their signature, private key or backup key, or into signing something;",
            "harass, stalk or expose other people with the Exposure check or any other part of VisionSwap;",
            "run bots, scripts or scrapers against VisionSwap in a way that puts an unreasonable load on it; or",
            "lie to us or pretend to be someone else.",
          ],
        },
        {
          k: "p",
          text: "We may refuse or hold any deposit or payment, and send a deposit back (only ever to the address that made it), that we reasonably believe breaks this section, and we may respond to lawful requests from authorities, as the [Compliance](/compliance) page explains.",
        },
      ],
    },
    {
      n: 12,
      id: "third-parties",
      title: "Third-party services",
      blocks: [
        clauses(
          {
            t: "What we don't control",
            text: "VisionSwap works with things we don't control: your wallet, the Solana network, Jupiter and the exchanges it routes through, RPC and data providers, screening providers, token issuers, block explorers and our hosting provider.",
          },
          {
            t: "Not our responsibility",
            text: "We can't answer for them: not for whether they work or are secure, nor for any loss they cause. Each has its own terms, which apply when you use it.",
          },
          { t: "Links", text: "A link to another website is a convenience, not a recommendation." },
        ),
      ],
    },
    {
      n: 13,
      id: "advice",
      title: token ? "No advice, no fiduciary duty, and $VSWAP" : "No advice and no fiduciary duty",
      blocks: [
        clauses(
          {
            t: "No advice",
            text: "VisionSwap gives no financial, investment, legal, tax or compliance advice, and that includes Exposure checks and statements. Decisions about using it are yours alone.",
          },
          {
            t: "No fiduciary duty",
            text: "We are not your fiduciary, agent, broker or adviser, and these Terms create no partnership or joint venture between us. We owe you only the duties these Terms set out and those the law imposes and doesn't allow a contract to exclude.",
          },
          {
            t: "Information only",
            text: "Prices, quotes, fees, estimates, exposure results and anything else VisionSwap shows are for information. They may be wrong or out of date, so check what matters to you before you rely on it.",
          },
          token && {
            t: "$VSWAP",
            text: "$VSWAP is VisionSwap's community token on Solana. Its contract address is the one published on visionswap.net; any other token using our name is not ours. Our buyback, burn and holder-reward program is described on the Tokenomics page, and we may change, pause or end it. You don't need $VSWAP to use VisionSwap. Holding it doesn't make you an owner of VisionSwap, or give you any claim on the Pool, on anyone's funds or to any particular payment. Tokens can lose their value, and these Terms don't govern trading any token.",
          },
        ),
      ],
    },
    {
      n: 14,
      id: "ip",
      title: "Intellectual property",
      blocks: [
        clauses(
          {
            t: "Ownership",
            text: "The VisionSwap name, logo, website design and text belong to us or our licensors. Where we publish VisionSwap's source code under an open-source licence, that licence governs the code.",
          },
          {
            t: "Your permission to use the site",
            text: "As long as you keep to these Terms, you have a personal, non-exclusive and revocable permission to use the website as intended.",
          },
          { t: "Feedback", text: "Suggestions you send us are ours to use however we like, without paying you." },
        ),
      ],
    },
    {
      n: 15,
      id: "disclaimers",
      title: "Disclaimers",
      blocks: [
        clauses(
          {
            t: "As is",
            text: 'Subject to section 18, VisionSwap is provided "as is" and "as available", with all its faults, and we make no promises or warranties of any kind, whether express, implied or statutory, including of merchantability, satisfactory quality, fitness for a particular purpose, title, non-infringement, accuracy, or that VisionSwap will be uninterrupted, secure or free of errors.',
          },
          {
            t: "No promises about results",
            text: "In particular, VisionSwap may go down, have bugs or be breached; screening can get things wrong; and your privacy is not assured.",
          },
          {
            t: "Everything else we publish",
            text: "The Docs, the Security and Compliance pages, our posts on X and anything else we publish are there to inform you. They may be incomplete or out of date, they are not part of these Terms, and where they disagree with these Terms, these Terms take priority.",
          },
        ),
      ],
    },
    {
      n: 16,
      id: "release",
      title: "Your decisions, and claims you release",
      blocks: [
        clauses(
          {
            t: "Your decisions",
            text: "You decide whether and how to use VisionSwap, after considering the risks in section 10, and you use it at your own risk.",
          },
          {
            t: "Release",
            text: "Subject to section 18, you release us, and the people in section 17.3, from claims and losses that arise from the risks in section 10, from what a third party does or fails to do, or from your own mistakes, such as a wrong address, a lost key or backup, or a signature or key given to someone else.",
          },
          {
            t: "Unknown claims",
            text: 'This release covers claims you don\'t know about yet. If you live in California, you waive California Civil Code section 1542, which says: "A general release does not extend to claims that the creditor or releasing party does not know or suspect to exist in his or her favor at the time of executing the release and that, if known by him or her, would have materially affected his or her settlement with the debtor or released party." You waive any similar rule where you live, as far as that rule allows.',
          },
        ),
      ],
    },
    {
      n: 17,
      id: "liability",
      title: "Limitation of liability",
      blocks: [
        clauses(
          {
            t: "Losses we don't cover",
            text: "Subject to section 18, we won't be liable to you for losses that are indirect, incidental, special or consequential, or for punitive damages; for lost profits, revenue, business, opportunities, goodwill or data; for digital assets that are lost or fall in value; or for losses that come from a risk listed in section 10, from a third party, from someone getting into your device, wallet or keys, or from your own breach of these Terms. It makes no difference how a claim is framed, whether in contract, negligence, breach of statutory duty or otherwise, or whether we knew such a loss could happen.",
          },
          {
            t: "Cap",
            text: "Subject to section 18, our total liability to you for all claims connected with VisionSwap or these Terms is limited to the greater of US$100 and the pool and relayer fees you paid through VisionSwap in the 12 months before the event that gave rise to the claim.",
          },
          {
            t: "Who this protects",
            text: "Our affiliates, contributors, contractors and service providers, anyone who runs a relayer for VisionSwap, and the people who work for any of them, get the same protection from sections 15 to 19 and section 21 as we do.",
          },
          { t: "Why", text: "We can only offer VisionSwap on these Terms, and the limits in sections 15 to 17 are a fundamental part of them." },
        ),
      ],
    },
    {
      n: 18,
      id: "never-limited",
      title: "What these Terms never limit",
      blocks: [
        { k: "p", text: "Nothing in these Terms excludes or limits:" },
        {
          k: "list",
          items: [
            "liability for fraud or fraudulent misrepresentation;",
            "liability for death or personal injury caused by negligence;",
            "liability for wilful misconduct, or for gross negligence where the law doesn't allow it to be limited; or",
            "any other liability, or any right you have as a consumer, that the law that applies to you does not allow a contract to exclude or limit, such as, in the United Kingdom, your right to services provided with reasonable care and skill.",
          ],
        },
        {
          k: "p",
          text: "Where such a law limits how far a disclaimer, release, limitation or indemnity can go, it applies only as far as that law allows, and the rest of these Terms still applies.",
        },
      ],
    },
    {
      n: 19,
      id: "indemnity",
      title: "Indemnity",
      blocks: [
        {
          k: "p",
          text: "Subject to section 18, you will reimburse us, and the people in section 17.3, for any claim made by someone else or by an authority, and for the losses, fines and reasonable costs (legal fees included) that result from it, to the extent it arises from your breach of these Terms, your breaking any law or anyone else's rights, or your use of VisionSwap with funds that weren't lawfully yours to use. Where we are allowed to, we'll tell you promptly about such a claim; we may take charge of defending it, and you'll cooperate with us and won't settle it without our agreement. If you are a consumer, this section applies only to losses you caused by breaking these Terms or the law.",
        },
      ],
    },
    {
      n: 20,
      id: "ending",
      title: "Suspension and ending",
      blocks: [
        clauses(
          { t: "By you", text: "You may stop using VisionSwap at any time." },
          {
            t: "By us",
            text: "We can limit or cut off your access to VisionSwap whenever we need to, without warning: for instance if you break these Terms, fail screening, or pose a legal or security risk to us, other users or the Pool, or if the law requires it.",
          },
          {
            t: "Your funds",
            text: "Ending your access to our website or relayer doesn't change what the Pool holds for you, which stays under the program's rules, subject to section 8. Using it without our website or relayer may not be possible for you (section 8.4).",
          },
          { t: "What continues", text: "Sections 4.5, 9, 10 and 13 to 23 still apply after your use of VisionSwap ends." },
        ),
      ],
    },
    {
      n: 21,
      id: "disputes",
      title: "Disputes",
      blocks: [
        clauses(
          {
            t: "Talk to us first",
            text: "If something goes wrong, tell us first (section 24): describe the problem and what you would like us to do. Neither side may start a claim, in court or in arbitration, until 30 days after the other side received that notice, and we'll both use that time to try, in good faith, to settle it. Either side may still ask a court for an urgent order at any time.",
          },
          !!s.governingLaw && {
            t: "Governing law",
            text: `These Terms, and any dispute arising out of or in connection with them or VisionSwap (including non-contractual disputes), are governed by ${s.governingLaw}. If you are a consumer, this choice doesn't take away the protection of the mandatory rules of the law of the country where you live.`,
          },
          !!s.forum && {
            t: "Courts",
            text: `${arb ? "Except where the agreement to arbitrate below applies, the" : "The"} courts of ${s.forum} have exclusive jurisdiction over any dispute arising out of or in connection with these Terms or VisionSwap. If you are a consumer and the law of the country where you live gives you the right to bring proceedings in its courts, or to be sued only there, this clause doesn't take that right away.`,
          },
          !!arb && {
            t: "Agreement to arbitrate",
            text: `Except as the next clauses say, you and we agree that any dispute arising out of or in connection with these Terms or VisionSwap will be resolved by final and binding arbitration on an individual basis, administered by ${arb.provider}${arb.rules ? ` under ${arb.rules}` : " under its rules in force when the arbitration starts"}${arb.seat ? `, with its seat in ${arb.seat}` : ""}. An arbitrator, not a judge or jury, decides the dispute, and a court can review the decision only in limited ways.`,
          },
          !!arb && {
            t: "Opting out of arbitration",
            text: `You may opt out of the agreement to arbitrate within ${arb.optOutDays} days after you first accept a version of these Terms that includes it, by writing to ${noticesTo(s)} with the subject "Arbitration opt-out", saying that you opt out and the date you first accepted. You don't need to give a wallet address. Opting out doesn't change anything else in these Terms.`,
          },
          !!arb && {
            t: "What isn't arbitrated",
            text: "Either side may bring an individual claim in a small-claims court that has jurisdiction, and either side may ask a court for an urgent order to protect intellectual property or to stop unauthorised access to, or abuse of, VisionSwap. A claim for public injunctive relief that the law doesn't allow to be waived or arbitrated is decided by a court, after everything else has been arbitrated.",
          },
          !!arb && {
            t: "Many similar claims",
            text: `If 25 or more similar demands for arbitration are brought against us by or with the help of the same lawyers or organisation, they are administered under ${arb.provider}'s procedures for mass arbitration, where it has them.`,
          },
          !!arb && {
            t: "Consumers in the United Kingdom and the European Union",
            text: "The agreement to arbitrate doesn't apply to you if you are a consumer living in the United Kingdom or the European Union: you may bring claims in the courts where you live.",
          },
          {
            t: "Individual claims only",
            text: "You may bring claims against us only on your own behalf, not as a claimant or member in any class, collective or representative action, unless the law that applies to you gives you a right to take part in one that a contract can't remove.",
          },
          {
            t: "Time limit",
            text: "Subject to section 18 and the law that applies to you, a claim must be started within one year after the events behind it, or it is barred.",
          },
          {
            t: "Consumers",
            text: "If you are a consumer, nothing in these Terms takes away a protection that the law of your home country does not allow a contract to override, including your right to bring proceedings there where that law gives you one.",
          },
        ),
      ],
    },
    {
      n: 22,
      id: "changes",
      title: "Changes to these Terms",
      blocks: [
        clauses(
          {
            t: "New versions",
            text: "We may change these Terms, for example when VisionSwap, the law or how we run it changes. Each version has a number and a date. This page always shows the version in force and lists the earlier ones.",
          },
          {
            t: "Material changes",
            text: "When a change materially affects your rights or obligations, it gets a new major version number, and the app asks you to accept it before you can open your account there again. We'll try to announce material changes in advance where we reasonably can, so that you can decide before they take effect whether to keep using VisionSwap or move your funds out, unless a change is needed sooner for legal, regulatory or security reasons. If you don't accept a new version, stop using VisionSwap; what you hold in the Pool stays under the program's rules, subject to section 8.",
          },
          {
            t: "Other changes",
            text: "Corrections, clarifications and changes that don't reduce your rights take effect when they are published, without asking you again.",
          },
          {
            t: "Earlier disputes",
            text: "A new version doesn't apply to a dispute that arose before it took effect: the version you had accepted at that time applies to it.",
          },
        ),
      ],
    },
    {
      n: 23,
      id: "general",
      title: "General",
      blocks: [
        clauses(
          {
            t: "Whole agreement",
            text: "These Terms are the whole agreement between you and us about VisionSwap and, except as section 22.4 says, replace any earlier agreement about it.",
          },
          {
            t: "Severability",
            text: "If a court or other authority finds part of these Terms invalid or unenforceable, that part is changed as little as needed to make it valid or, where the law doesn't allow that, is set aside, and the remaining parts still stand.",
          },
          { t: "No waiver", text: "Not enforcing a right now doesn't stop us enforcing it later." },
          {
            t: "Transfer",
            text: "If someone else takes over VisionSwap, or we move it to an affiliate, these Terms can go with it. You need our written agreement to pass your side of them to anyone.",
          },
          {
            t: "Who else has rights",
            text: "Apart from the people protected by section 17.3, who can enforce sections 15 to 19 and section 21, no one other than you and us has rights under these Terms.",
          },
          {
            t: "Events beyond our control",
            text: "We aren't responsible when something beyond our reasonable control, such as an outage of Solana or of a provider, an attack or a government action, stops or delays VisionSwap.",
          },
          {
            t: "Electronic agreement and notices",
            text: 'You agree to make this agreement, and to receive notices about it, electronically. Ticking the boxes and selecting "Agree and continue" is your signature. We give you notices by publishing them on the website or in the app.',
          },
          {
            t: "Reading these Terms",
            text: '"Including" and "for example" don\'t limit what comes before them. Headings, the box of main points and the summary in the Terms window are there to help you read; they don\'t change what the numbered sections say.',
          },
          { t: "Language", text: "The English version of these Terms is the one that counts, whatever any translation says." },
        ),
      ],
    },
    {
      n: 24,
      id: "contact",
      title: "Contact",
      blocks: [
        {
          k: "p",
          text: `Legal notices, notices of a dispute${arb ? ", arbitration opt-outs" : ""}, law-enforcement requests, reports of stolen funds and screening reviews: ${noticesTo(s)}. Security problems: see the [Security](/security) page. Privacy questions: see the [Privacy policy](/privacy).`,
        },
      ],
    },
  ];

  return {
    version: TERMS_VERSION,
    effective: TERMS_EFFECTIVE,
    notice: `Please read these Terms carefully. They ask you to accept the risks of using VisionSwap and release certain claims (section 16), limit our liability to you (section 17), ask you to cover certain claims and costs that your own conduct causes us (section 19), and say that claims can only be brought individually and within one year (section 21)${arb ? ", generally by binding arbitration unless you opt out" : ""}. Section 18 lists what they never limit.`,
    summary: [
      "VisionSwap is self-custody software. Your spending and viewing keys are made in your browser, from your own wallet's signature, a passkey or a VisionSwap private key. We never receive them, and nobody can recover them for you.",
      "Transactions on Solana are final. Check every address and amount before you confirm.",
      "If you place an order, our order service can trade the amount you set aside for it, from that order's Vision wallet, until the order ends or you cancel it (section 6.11).",
      "Every deposit is screened and waits in a public waiting room. It can be refused, kept out of the Pool by our app and servers, or sent back to the address it came from.",
      "The program is new and has not been independently audited, and the VisionSwap team can upgrade it and change its settings. You can lose some or all of what you deposit.",
      "Privacy has limits: amounts, timing and address reuse can still link your activity (section 9).",
      `You take on the risks in section 10 and release claims that arise from them (section 16). Our liability is limited (section 17), and claims can only be brought individually and within one year (section 21)${arb ? ", generally by arbitration" : ""}.`,
    ],
    sections,
  };
}

/** A clause's number: "5.2". */
export const clauseNo = (section: number, i: number) => `${section}.${i + 1}`;

/** Text without its link markup: "[Docs](/docs)" reads "Docs". */
export const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1");

/**
 * The Terms as plain text: what the fingerprint covers and what the archive keeps. One paragraph per
 * line, a blank line between them, "\n" line ends, a final newline.
 */
export function termsText(doc: TermsDoc): string {
  const out: string[] = [];
  out.push("VisionSwap Terms of Use");
  out.push(`Version ${doc.version}, effective ${longDate(doc.effective)}`);
  out.push(plain(doc.notice));
  out.push(`The main points (a summary; the numbered sections are the agreement):\n${doc.summary.map((s) => `- ${plain(s)}`).join("\n")}`);
  for (const sec of doc.sections) {
    out.push(`${sec.n}. ${sec.title}`);
    for (const b of sec.blocks) {
      if (b.k === "p") out.push(plain(b.text));
      else if (b.k === "list") out.push(b.items.map((i) => `- ${plain(i)}`).join("\n"));
      else if (b.k === "risks") out.push(b.items.map((i) => `- ${i.t}. ${plain(i.text)}`).join("\n"));
      else b.items.forEach((c, i) => out.push(`${clauseNo(sec.n, i)} ${c.t}. ${plain(c.text)}`));
    }
  }
  return out.join("\n\n") + "\n";
}

/** SHA-256 (hex) of the Terms' plain text: the fingerprint people accept and the archive lists. */
export function termsHash(doc: TermsDoc): string {
  return bytesToHex(sha256(new TextEncoder().encode(termsText(doc))));
}
