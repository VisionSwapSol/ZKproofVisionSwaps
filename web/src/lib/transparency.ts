/**
 * The monthly figures /compliance publishes (P1-4, owner decision D10): GET /api/transparency answers
 * { months: [{ month: "YYYY-MM", depositsScreened, depositsReturned, recipientsRefused, regionRefusals }],
 * since: "YYYY-MM" }. Counts only: no addresses, no amounts, nothing about any one person. A count from
 * 1 to 4 is shown as "fewer than 5", so no single attempt can be picked out.
 *
 * Plain data only, so the node tests can run it.
 */

export type MonthFigures = {
  month: string;
  depositsScreened: number | null;
  depositsReturned: number | null;
  recipientsRefused: number | null;
  regionRefusals: number | null;
};

export type Transparency = { months: MonthFigures[]; since: string | null };

export const FIGURE_COLUMNS: readonly [keyof Omit<MonthFigures, "month">, string][] = [
  ["depositsScreened", "Deposits screened"],
  ["depositsReturned", "Deposits sent back"],
  ["recipientsRefused", "Recipients refused"],
  ["regionRefusals", "Requests refused by region"],
];

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** A count as the server sends it: a whole number from 0, or "fewer than 5" said its own way (kept as 1); null otherwise. */
function count(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e12) return v;
  if (typeof v === "string" && /^(?:<\s*5|fewer than 5)$/i.test(v.trim())) return 1;
  return null;
}

/** /api/transparency's answer, checked; null when it isn't one. At most 24 months, newest first. */
export function parseTransparency(raw: unknown): Transparency | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.months)) return null;
  const months: MonthFigures[] = [];
  for (const m of r.months) {
    if (!m || typeof m !== "object") continue;
    const x = m as Record<string, unknown>;
    if (typeof x.month !== "string" || !MONTH.test(x.month)) continue;
    months.push({
      month: x.month,
      depositsScreened: count(x.depositsScreened),
      depositsReturned: count(x.depositsReturned),
      recipientsRefused: count(x.recipientsRefused),
      regionRefusals: count(x.regionRefusals),
    });
  }
  const seen = new Set<string>();
  const unique = months.filter((m) => !seen.has(m.month) && !!seen.add(m.month));
  unique.sort((a, b) => (a.month < b.month ? 1 : -1));
  const since = typeof r.since === "string" && MONTH.test(r.since) ? r.since : null;
  return { months: unique.slice(0, 24), since };
}

/** A count as the page shows it: "fewer than 5" from 1 to 4, "–" when not given. */
export function countText(n: number | null): string {
  if (n == null) return "–";
  if (n >= 1 && n <= 4) return "fewer than 5";
  return n.toLocaleString("en-US");
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 2026" from "2026-10". */
export function monthName(ym: string): string {
  const m = MONTH.exec(ym);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ym;
}
