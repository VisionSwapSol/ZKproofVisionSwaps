/**
 * Turns the network's refusals into plain words. A swap's logs name many programs (Jupiter, the
 * markets on its route, the token programs), and their error numbers overlap with the pool's, so
 * each table is only read for the program it belongs to.
 */

// Anchor numbers the pool's errors from 6000 (0x1770); the names also show up in the logs.
const POOL_ERRORS: [RegExp, string][] = [
  [/DepositsPaused|0x1770\b/, "Deposits are paused right now. Withdrawals still work."],
  [/FeeAboveLimit|0x1778\b/, "The pool fee just changed. Refresh the page to see the new total, then try again."],
  [/AmountOutOfRange|0x1771\b/, "That amount is outside what a single deposit allows."],
  [/PoolFull|0x1773\b/, "The pool is at its deposit limit for now. Try a smaller amount or come back later."],
  [/StillWaiting|0x1774\b/, "That deposit is still in the waiting room."],
  [/Attestation|0x177f\b|0x178[01]\b/, "The screening pass ran out before the deposit went through. Please try again."],
  [/AccountNotInitialized|0xbc4\b/, "That deposit has already left the waiting room."],
];

/** Whatever program failed, these say the same thing. */
const GENERIC_ERRORS: [RegExp, string][] = [
  [/insufficient (funds|lamports)|no record of a prior credit/i, "This wallet doesn't have enough SOL for that, including the network fee."],
  [/blockhash not found|block height exceeded/i, "The network was busy and the transaction expired. Please try again."],
];

// Jupiter's own errors (its numbers also start at 6000, so the same hex code means something else there)
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const PRICE_MOVED =
  "The price moved more than your price tolerance allows before the trade could land. Your funds stayed where they were. Try again, or choose a higher tolerance.";
const JUPITER_ERRORS: Record<string, string> = {
  "0x1771": PRICE_MOVED,
  "0x1788": "This wallet doesn't have enough for that trade, including the network fee.",
  "0x1789": "Jupiter couldn't use this wallet's token account for that trade. Try again in a moment.",
};
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
/** Raydium's older pools report their own slippage check as a plain number */
const RAYDIUM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
/** How the markets on a route name "the price moved past the limit" */
const MARKET_SLIPPAGE =
  /SlippageToleranceExceeded|ExceededSlippage|SlippageExceeded|TooLittleSolReceived|TooMuchSolRequired|AmountOutBelowMinimum|AmountInAboveMaximum|TooLittleOutputReceived|TooMuchInputPaid|Exceed(ed)?AmountSlippageTolerance|Error Code: \w*Slippage\w*/i;

let poolProgram: string | null = null;
/** The pool's program id, so its error numbers are only read when it is the program that failed. */
export function setPoolProgram(id: string | null) {
  poolProgram = id;
}

/** Which program failed, and with which code, from the transaction's logs. */
export function failedProgram(text: string): { program: string; code: string | null } | null {
  const m = /Program (\w{32,44}) failed: (?:custom program error: (0x[0-9a-f]+)|(.+?))(?:\s|$|")/i.exec(text);
  return m ? { program: m[1], code: m[2]?.toLowerCase() ?? null } : null;
}

export function chainError(e: unknown): Error {
  const err = e as { message?: string; logs?: string[] };
  const text = `${err?.message ?? ""} ${(err?.logs ?? []).join(" ")}`;
  // the original logs stay on the error, so later checks can still read them
  const out = (msg: string) => Object.assign(new Error(msg), { logs: err?.logs ?? [] });
  const failed = failedProgram(text);
  const tokenFailed = !!failed && TOKEN_PROGRAMS.includes(failed.program);
  if (text.includes(JUPITER)) {
    // a swap: the pool's numbers never apply, whichever program on the route said no
    if (failed?.program === JUPITER) {
      const msg = failed.code ? JUPITER_ERRORS[failed.code] : null;
      if (msg) return out(msg);
    }
    if (MARKET_SLIPPAGE.test(text) || (failed?.program === RAYDIUM_V4 && failed.code === "0x1e")) return out(PRICE_MOVED);
    if (/insufficient (funds|lamports)/i.test(text) && !tokenFailed) return out("This wallet doesn't have enough for that trade, including the network fee.");
    if (/blockhash not found|block height exceeded/i.test(text)) return out("The network was busy and the swap expired. Your funds stayed where they were. Please try again.");
    if (failed?.program === JUPITER) return out(`The swap was refused by Jupiter${failed.code ? ` (${failed.code})` : ""}. Your funds stayed where they were. Please try again.`);
    if (failed && !tokenFailed) {
      const name = /Error Code: (\w+)/.exec(text)?.[1] ?? failed.code;
      return out(`One of the markets on this route refused the trade${name ? ` (${name})` : ""}. Your funds stayed where they were. Please try again.`);
    }
  }
  if (tokenFailed) {
    if (/insufficient funds|error: 0x1(?![0-9a-f])/i.test(text)) return out("This wallet doesn't hold enough of that token for this.");
    return out(`The token program refused this transaction${failed!.code ? ` (${failed!.code})` : ""}. Nothing was sent.`);
  }
  // the pool's own errors: only when the pool (or nothing more specific) failed; before the pool's id is
  // known, any program outside a swap is taken to be the pool (the app's other transactions call nothing else)
  if (!failed || poolProgram == null || failed.program === poolProgram) {
    for (const [re, msg] of POOL_ERRORS) if (re.test(text)) return out(msg);
  }
  for (const [re, msg] of GENERIC_ERRORS) if (re.test(text)) return out(msg);
  if (/simulation failed|custom program error/i.test(text)) {
    const code = /Error Code: (\w+)/.exec(text)?.[1] ?? /custom program error: (0x[0-9a-f]+)/i.exec(text)?.[1];
    return out(`The network refused this transaction${code ? ` (${code})` : ""}. Nothing was sent.`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
