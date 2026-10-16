/**
 * The FAQ page (/faq): plain answers to the questions people ask about private SOL transfers on
 * Solana. The page shows these words and its FAQPage data repeats them, so both always agree.
 *
 * Every answer must stay true to the code and the Docs (web/test/claims.test.ts checks it for the
 * wording listed in web/test/retracted.ts). Text between `backticks` shows as code.
 */
import { FEES } from "./config";
import { BUSINESS_EMAIL, SUPPORT_EMAIL, mailto } from "./contacts";

/** VisionSwap's pool program on Solana mainnet (the SDK's MAINNET_PROGRAM_ID; a test keeps them equal). */
export const POOL_PROGRAM_ID = "VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6";

export type QA = {
  id: string;
  q: string;
  /** paragraphs before the steps */
  a: string[];
  /** numbered steps, when the answer is a how-to */
  steps?: string[];
  /** paragraphs after the steps */
  more?: string[];
  links?: { label: string; href: string }[];
};

export const FAQ_GROUPS: { id: string; title: string; items: QA[] }[] = [
  {
    id: "solana",
    title: "Privacy on Solana",
    items: [
      {
        id: "public",
        q: "Are Solana transactions public?",
        a: [
          "Yes. Solana records every transaction on a public ledger. Anyone with a block explorer can see which address paid which, how much and when, and a wallet's history stays readable for good.",
          "VisionSwap's free Exposure check shows what any wallet's public history already gives away: what it holds, who paid it first, who it deals with and when it is active. It needs no wallet connection and saves nothing.",
        ],
        links: [{ label: "Check a wallet", href: "/check" }],
      },
      {
        id: "send-privately",
        q: "How do I send SOL privately on Solana?",
        a: ["With VisionSwap, a private payment is paid from a shared pool instead of from your wallet:"],
        steps: [
          "Open the app and connect the Solana wallet you already use, or open an account with a private key or a passkey.",
          "Shield SOL into your private balance. The deposit is screened in a public waiting room, then joins the pool.",
          "Open Send, enter the recipient's address and the amount, and confirm. Your browser builds a zero-knowledge proof, and a relayer submits the payment.",
          "The recipient gets a standard SOL transfer from a one-time sending address, paid from the pool. No transaction says which deposit paid for it.",
        ],
        more: [
          "For more privacy, send an amount that differs from your deposit and let some time pass in between. You can also pay straight from your wallet in one step: your wallet makes one deposit of a standard size that covers the payment. Once the deposit joins your private balance, the payment goes out from the pool, straight away or at a random moment within a window you pick, and the rest of the deposit stays in your private balance.",
        ],
        links: [
          { label: "Open app", href: "/app" },
          { label: "How a private payment works", href: "/docs#how" },
        ],
      },
      {
        id: "shielded-pool",
        q: "What is a shielded pool?",
        a: [
          "A shielded pool is a shared on-chain vault where every deposit becomes a sealed note: a hash of the amount, the owner's key and a random value, which only the owner can open. VisionSwap keeps its notes in a Merkle tree with room for about 67 million of them, and every note looks like all the others.",
          "To spend, your browser makes a zero-knowledge proof that you own notes in the tree without saying which ones, and reveals a nullifier for each one so it can never be spent twice. The Solana program checks the proof before it pays out. Everyone can see deposits going in and payments coming out, but no transaction says which deposit paid for which payment.",
        ],
        links: [{ label: "The Docs, step by step", href: "/docs#how" }],
      },
      {
        id: "confidential-transfers",
        q: "How is a shielded pool different from confidential transfers?",
        a: [
          "They hide different things. Confidential transfers, an extension of Solana's token program, encrypt token amounts and balances, while the sending and receiving addresses stay public. A shielded pool like VisionSwap's hides which deposit paid for which payment, while the amounts going in and out stay public.",
          "VisionSwap's pool holds SOL: you shield SOL, send it privately, and buy or sell tokens from Vision wallets funded from the pool.",
        ],
      },
      {
        id: "what-is-visible",
        q: "What does VisionSwap hide, and what can people still see?",
        a: [
          "Hidden: which deposit paid for which payment, and your private balance. No transaction says which deposit paid, and no account shows how much of the pool is yours.",
          "Still public, as on any blockchain: that a wallet deposited into the pool, how much and when; that a payment left the pool, how much, when and where it went; and how much the pool holds in total. Matching amounts and timing can still hint at a link, so wait, use amounts that differ from your deposit, and never send back to the wallet you shielded from.",
        ],
        links: [{ label: "What stays hidden", href: "/docs#visible" }],
      },
    ],
  },
  {
    id: "using",
    title: "Using VisionSwap",
    items: [
      {
        id: "buy-privately",
        q: "How do I buy a token without using my main wallet?",
        a: [
          "Choose Buy in the app, pick the token and an amount from your private balance, and confirm. VisionSwap funds a brand-new Vision wallet straight from the pool and buys with it, so your main wallet never pays for the trade.",
          "A Vision wallet is a standard Solana wallet that only your account controls, and you can export it to another wallet app. From then on its own activity is public, so use a fresh one when you want a fresh start. Selling sends the SOL back into your private balance.",
        ],
        links: [{ label: "Vision wallets", href: "/docs#vision" }],
      },
      {
        id: "tokens",
        q: "Which tokens can I buy and sell?",
        a: [
          "Any Solana token with a swap route. Quotes are routed across Solana's markets, and before you confirm, the app shows the route, the fees and the minimum you'll receive. That minimum is written into the trade on-chain: if the price moves past it, the trade stops instead of filling lower.",
        ],
        links: [{ label: "Buying and selling", href: "/docs#trading" }],
      },
      {
        id: "sign-up",
        q: "Do I need to sign up?",
        a: [
          "No. There are no sign-ups, names or email addresses. Connect the Solana wallet you already use and sign one message, which becomes the key to your private balance, with no new seed phrase. Or open an account with a VisionSwap private key or a passkey, and add SOL by QR code from any wallet or exchange.",
        ],
        links: [{ label: "Your keys", href: "/docs#keys" }],
      },
      {
        id: "phones",
        q: "Does VisionSwap work on phones?",
        a: [
          "Yes. VisionSwap runs in the browser on desktop and mobile. There is an Android app you can download from the homepage, and on iPhone you can add the site to your Home Screen from Safari.",
        ],
        links: [{ label: "Get the app", href: "/#get-app" }],
      },
      {
        id: "contact",
        q: "How do I contact VisionSwap?",
        a: [
          `Email ${SUPPORT_EMAIL} for help with the app, your account or a payment, and for legal, compliance, security and privacy requests. Business, partnership and press enquiries go to ${BUSINESS_EMAIL}. News and announcements are posted on @VisionSwapSol, VisionSwap's official X account.`,
          "We never ask for your private key, your wallet's recovery phrase or the signature that opens your account, so leave them out of every message.",
        ],
        links: [
          { label: `Email ${SUPPORT_EMAIL}`, href: mailto(SUPPORT_EMAIL) },
          { label: "Support library", href: "/support" },
        ],
      },
      {
        id: "shield-time",
        q: "How long does shielding take?",
        a: [
          "A new deposit waits in a public waiting room while it is screened, and the app shows the time left. Then it joins the pool and your private balance. While it waits, you can take it back, pool fee included.",
          "Waiting longer before you spend makes a payment harder to match to your deposit: the more people deposit after you, the bigger the crowd it hides in.",
        ],
        links: [{ label: "Screening and the waiting room", href: "/docs#compliance" }],
      },
    ],
  },
  {
    id: "trust",
    title: "Fees and trust",
    items: [
      {
        id: "cost",
        q: "What does VisionSwap cost?",
        a: [
          `Shielding costs ${FEES.actionPct} of the amount. Each private send, buy or sell costs ${FEES.actionPct} of the amount leaving the pool or, for a sale, going back into it. The Solana program enforces the pool fee and caps it at 1%.`,
          "Network costs come on top. The relayer fee is about 0.002 SOL at today's rates, mostly rent for the records that stop a note being spent twice. A payment to an outside address adds 0.000012 SOL for its delivery, and Fast and Turbo trades add a priority fee of at most 0.0015 SOL and 0.005 SOL. Some tokens and swap routes take their own fees. The app shows every fee before you confirm.",
        ],
        links: [{ label: "Fees and limits", href: "/docs#fees" }],
      },
      {
        id: "custody",
        q: "Who holds my funds?",
        a: [
          "Your keys do. Shielded SOL sits in a vault owned by the Solana program, which pays out only against a valid proof made with your keys, or back to the depositor while a deposit is still in the waiting room. Your spending and viewing keys are made in your browser and never reach VisionSwap's servers, and your Vision wallets are standard Solana wallets that your keys control.",
          "Orders are the one exception you choose: an order's key can trade only the amount you set aside for it, from its own Vision wallet, until the order ends or you cancel it. The program itself can be upgraded by the VisionSwap team, as the Terms explain.",
        ],
        links: [{ label: "Security", href: "/security" }],
      },
      {
        id: "verify",
        q: "How can I check the VisionSwap program on-chain?",
        a: [
          `VisionSwap's pool program is \`${POOL_PROGRAM_ID}\` on Solana mainnet. It checks every proof in public, and it accepts a valid proof from any fee payer, so anyone can run a relayer.`,
          `To see the live code's fingerprint, run \`solana-verify get-program-hash ${POOL_PROGRAM_ID}\` with the standard solana-verify tool. The Docs show the same fingerprint, with links to the program, its vault, its note tree and its settings on a block explorer.`,
        ],
        links: [{ label: "Check it on-chain", href: "/docs#onchain" }],
      },
      {
        id: "statement",
        q: "Can I show where my funds came from?",
        a: [
          "Download a statement of your notes from the app, for an exchange or an accountant. Whoever you give it to can check that each note exists on-chain and, for notes that came straight from a deposit, which wallet made it. It can't spend anything, and it doesn't prove which notes are still unspent.",
          "You can include your viewing key, which lets the holder see every note you've received, before and after today. Once shared, it can't be taken back.",
        ],
        links: [{ label: "Records you can share", href: "/compliance#records" }],
      },
      {
        id: "prove-address",
        q: "How do I prove to an exchange that an address is mine?",
        a: [
          "In the app, sign the exchange's message with the address it asks about: a Vision wallet (Wallets, then More, then Prove control), a deposit address or your connected wallet (Your records, then Prove I control an address). The signed text starts with a VisionSwap line, so the signature can't be used for anything else, and nothing is sent to VisionSwap.",
          "The exchange can check the signature with any ed25519 tool, or on the Check an ownership proof page.",
        ],
        links: [{ label: "Check an ownership proof", href: "/verify" }],
      },
      {
        id: "legal",
        q: "Is it legal to use VisionSwap?",
        a: [
          "Keeping your finances private is legal in many places. VisionSwap screens every deposit, and the wallets that recently funded it, against the sanctions list, its relayer won't pay a sanctioned address, and it isn't offered in restricted places. Rules differ by country, so check the law where you live. Nothing here is legal advice.",
        ],
        links: [{ label: "Terms of use", href: "/terms" }],
      },
      {
        id: "restricted",
        q: "Why can't I use VisionSwap where I am?",
        a: [
          "VisionSwap isn't offered in some places: Cuba, Iran, North Korea, Syria, Russia, Belarus and the United Arab Emirates, and the Crimea (including Sevastopol), Donetsk and Luhansk regions of Ukraine, as well as anywhere using a privacy tool is against the law. The Terms of use, section 2, set this out. While region checks are on (the Compliance page shows when they are), our server also refuses deposits, payments and trades from connections in those places, and the app shows a notice instead.",
        ],
        links: [{ label: "Restricted places", href: "/compliance#places" }],
      },
    ],
  },
];

/** Every question on the page, in order. */
export const FAQ_ITEMS: QA[] = FAQ_GROUPS.flatMap((g) => g.items);

/** A paragraph's words with its code marks taken out. */
export const plain = (s: string) => s.replace(/`([^`]+)`/g, "$1");

/** An answer as plain text, as the page shows it (paragraphs, then numbered steps, then the rest). */
export function answerText(qa: QA): string {
  const steps = (qa.steps ?? []).map((s, i) => `${i + 1}. ${s}`);
  return [...qa.a, ...steps, ...(qa.more ?? [])].map(plain).join(" ");
}
