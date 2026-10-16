/** Wording the site, the guides and the comments never use, shared by the claims and prerender checks. */

/** Where to find the accurate wording instead. */
const USE_INSTEAD = "say it as the Docs, Security and Privacy pages do";

/** Phrases that must not appear, each with where the accurate wording is. */
export const RETRACTED: [RegExp, string][] = [
  [/untraceable|unlinkable/i, USE_INSTEAD],
  [/nothing on-chain ties|nothing links it to/i, USE_INSTEAD],
  [/no trail|without a trail/i, USE_INSTEAD],
  [/fully anonymous/i, USE_INSTEAD],
  [/can(?:'|’)t be paused|can never be paused|withdrawals can never be paused/i, USE_INSTEAD],
  [/move, freeze or redirect/i, USE_INSTEAD],
  [/pause spending/i, USE_INSTEAD],
  [/three independent contributions|independent contributions/i, USE_INSTEAD],
  [/80 (?:public )?contributions/i, USE_INSTEAD],
  [/ships with the source/i, USE_INSTEAD],
  [/toolchain it lists/i, USE_INSTEAD],
  [/(?:never|doesn(?:'|’)t) learns? which notes or deposits/i, USE_INSTEAD],
  [/\bno logs\b|keeps no logs/i, USE_INSTEAD],
  [/nothing leaks to third parties/i, USE_INSTEAD],
  [/the shape every wallet and exchange withdrawal has/i, USE_INSTEAD],
  [/allows up to about seven days|longer than about a week/i, USE_INSTEAD],
  [/after that nobody can change it/i, USE_INSTEAD],
  [/every private buy comes from a brand-new|fresh wallet for every trade/i, USE_INSTEAD],
  [/nobody can see how much (?:of the pool is yours|you hold)/i, USE_INSTEAD],
  [/address ends at exactly zero|ending the address at exactly zero/i, USE_INSTEAD],
  [/never depend on our servers/i, USE_INSTEAD],
  [/(?:ceremony|phase[- ]two)[^.]{0,80}\b(?:is|are) (?:planned|next)|limits what is at risk/i, USE_INSTEAD],
  [/published for anyone to check/i, USE_INSTEAD],
  [/amount,? and (?:the |every )?fees?,? (?:are )?(?:sealed|bound)|binds the recipient, the amount and the fees|recipient, amount and fees/i, USE_INSTEAD],
  [/our servers never receive your keys|they never leave it\b/i, USE_INSTEAD],
  // compliance wording
  [/clean pool/i, USE_INSTEAD],
  [/refreshed every 6 hours/i, USE_INSTEAD],
  [/and nothing more/i, USE_INSTEAD],
  [/OFAC[- ]compliant|AML[- ]compliant/i, USE_INSTEAD],
  [/can check it against the chain/i, USE_INSTEAD],
  [/shows where your (?:money|funds) came from|prove where (?:your )?funds came from|proof of funds/i, USE_INSTEAD],
];
