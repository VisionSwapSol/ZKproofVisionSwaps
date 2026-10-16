/** The homepage's questions (its "Questions" section, and the same words in its FAQPage data). */
export const LANDING_FAQ: { q: string; a: string }[] = [
  {
    q: "Does VisionSwap hold my money?",
    a: "No. Shielded SOL sits in a Solana program that only pays out against a valid proof made with your keys. We never see those keys, and nothing on our servers can spend your notes. Orders are the exception you choose: our order service holds a key that can trade exactly the amount you set aside, from that order's own Vision wallet, until the order ends or you cancel it. While the program can still be upgraded, its upgrade key could change those rules; the Docs explain the plan to retire it.",
  },
  {
    q: "Can I use limit orders and stop-losses privately?",
    a: "Yes. Limit buys, DCA, take-profit in up to four steps, stop-loss and trailing stops all run from Vision wallets funded from the pool instead of from your wallet, and they keep running with the page closed.",
  },
  {
    q: "What can people still see?",
    a: "That your wallet put SOL into VisionSwap, how much and when. That a withdrawal happened, how much, when, and where it went. The proof never draws the line between the two; matching amounts and timing can still hint at it, so vary both.",
  },
  {
    q: "How long should I wait before spending?",
    a: "There's no magic number. The longer you wait, and the more people deposit after you, the bigger the crowd your payment hides in. Round amounts that differ from your deposit help a lot.",
  },
  {
    q: "What if VisionSwap disappears?",
    a: "Your notes live on Solana, not on our servers. The program pays out to any valid proof, whoever sends it, and the pool's whole history can be rebuilt from the chain alone.",
  },
  {
    q: "Is this legal?",
    a: "Financial privacy is legal in most places, and it should be. VisionSwap screens every deposit against the U.S. sanctions (OFAC) list, and it isn't offered in restricted places. Check the rules where you live before you use it.",
  },
];
