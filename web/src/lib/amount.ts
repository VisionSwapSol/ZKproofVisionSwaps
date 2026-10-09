/**
 * Typed amounts, the same way in every amount box. Phones in much of the world show ","
 * as the decimal key, so "0,5" means 0.5. Text that could be read two ways (a thousands
 * separator next to a decimal point, or several commas) is refused rather than guessed:
 * guessing wrong would ask for, or send, 1000 times the amount.
 */

/** "0,5" -> "0.5", " 1.25 SOL" -> "1.25"; null when the text isn't one plain number. */
export function normAmount(raw: string): string | null {
  // spaces anywhere, and a unit or currency sign around the number ("$0.5", "0.5 SOL")
  const t = raw.replace(/[\s  ]/g, "").replace(/^[^\d.,]+|[^\d.,]+$/g, "");
  if (t.includes(",") && t.includes(".")) return null;
  if ((t.match(/,/g) ?? []).length > 1) return null;
  const out = t.replace(",", ".");
  return /^\d*\.?\d*$/.test(out) ? out : null;
}

/** For an amount box: the new text, cleaned, or null to keep what was there (the keystroke or paste is ignored). */
export function cleanAmount(next: string): string | null {
  return next === "" ? "" : normAmount(next);
}

/** The hint shown when typed text was refused. */
export const AMOUNT_HINT = "Use one dot or comma for the decimals, with no thousands separators.";
