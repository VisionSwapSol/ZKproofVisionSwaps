/**
 * The statement "Your records" downloads (P0-8): the account's notes, with what the file does and
 * doesn't show written into it, so whoever receives it reads the same limits the app shows.
 *
 * What it shows: each note exists on-chain with its amount (anyone can recompute its leaf and find it
 * in the pool program's events), and for a note that came straight from a deposit, the deposit's event
 * names the wallet that made it. What it doesn't: whether a note is still unspent (it holds no
 * nullifiers), that the list is complete (the activity list is kept on the device and can be edited),
 * or that whoever presents it controls the account. With the viewing key included, the holder can see
 * every note the account has received or will receive, and that can't be taken back.
 *
 * Plain data only, so the node tests can run it.
 */

export const STATEMENT_KIND = "visionswap-statement";
export const STATEMENT_VERSION = 2;

/** What the file says it does and doesn't show, every time. */
export const STATEMENT_LIMITS: readonly string[] = [
  "Each note listed exists on-chain at its index: anyone can recompute its leaf from the values here and find it in the pool program's events.",
  "For a note that came straight from a deposit, that deposit's event names the wallet that made it.",
  "It doesn't show whether a note is still unspent: spending a note reveals its nullifier, and this statement holds none.",
  "It doesn't prove that the list of notes is complete, or that whoever presents it controls the account.",
  "The activity list is a record kept on the device that made this statement. It is self-reported and can be edited.",
  "It can't be used to spend anything.",
];

/** Added when the viewing key is included. */
export const VIEW_KEY_LIMIT =
  "It includes the account's viewing key: whoever holds it can see every note this account has received or will receive, with amounts. That can't be taken back.";

export const HOW_TO_VERIFY =
  "Each note is a leaf of the pool's Merkle tree: leaf = Poseidon(amount, Poseidon(pubKey, blinding)) on BN254. " +
  "Recompute it from the values above and find it at its index in the pool program's DepositSettled or Spent events. " +
  "For a leaf from a DepositSettled event, the DepositQueued event with the same inner value names the depositing wallet. " +
  "This shows that the notes exist and their amounts; it doesn't show which are unspent, that the list is complete, or that the presenter controls the account. " +
  "Activity lists the Solana transactions the device recorded as moving funds in and out; it is self-reported.";

export type StatementNote = { index: number; amountLamports: string; leaf: string; nonce: string; blinding: string };

export type StatementInput = {
  network: string;
  programId: string;
  fingerprint: string | null;
  /** the account's public key (hex) */
  pubKey: string;
  /** the viewing key (hex); used only when it is asked for */
  viewKey: string;
  balanceLamports: string;
  notes: StatementNote[];
  activity: unknown[];
};

/** The statement as an object (JSON.stringify it to save). The viewing key is in it only when `includeViewKey`. */
export function buildStatement(s: StatementInput, includeViewKey: boolean, now: Date = new Date()) {
  return {
    kind: STATEMENT_KIND,
    version: STATEMENT_VERSION,
    createdAt: now.toISOString(),
    network: s.network,
    programId: s.programId,
    account: {
      fingerprint: s.fingerprint,
      pubKey: s.pubKey,
      ...(includeViewKey ? { viewKey: s.viewKey } : {}),
    },
    balanceLamports: s.balanceLamports,
    notes: s.notes,
    activity: s.activity,
    activityIsSelfReported: true,
    limits: includeViewKey ? [...STATEMENT_LIMITS, VIEW_KEY_LIMIT] : [...STATEMENT_LIMITS],
    howToVerify: HOW_TO_VERIFY,
  };
}
