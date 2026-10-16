/**
 * The places where VisionSwap isn't offered (owner decision D2, 2026-10-15): the Terms of use,
 * section 2.3, the Compliance page, the restricted-region screen and the server's default lists
 * (BLOCKED_COUNTRIES and BLOCKED_REGIONS) all name exactly these. web/test/compliance.test.ts checks
 * that they agree. Codes are ISO 3166-1 (countries) and ISO 3166-2 (regions of Ukraine).
 *
 * Plain data only, so the node tests and the prerender can read it.
 */

export type Place = { code: string; name: string };

/** Countries, in the order the Terms name them. */
export const RESTRICTED_COUNTRIES: readonly Place[] = [
  { code: "CU", name: "Cuba" },
  { code: "IR", name: "Iran" },
  { code: "KP", name: "North Korea" },
  { code: "SY", name: "Syria" },
  { code: "RU", name: "Russia" },
  { code: "BY", name: "Belarus" },
  { code: "AE", name: "the United Arab Emirates" },
];

/** Regions of Ukraine. */
export const RESTRICTED_REGIONS: readonly Place[] = [
  { code: "UA-43", name: "Crimea" },
  { code: "UA-40", name: "Sevastopol" },
  { code: "UA-14", name: "the Donetsk region" },
  { code: "UA-09", name: "the Luhansk region" },
];

export const RESTRICTED_PLACES: readonly Place[] = [...RESTRICTED_COUNTRIES, ...RESTRICTED_REGIONS];

/** Every restricted code: "CU", …, "UA-43", …. */
export const RESTRICTED_CODES: readonly string[] = RESTRICTED_PLACES.map((p) => p.code);

/** A list in plain English: "a, b and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * How a place reads in a sentence, from its code: "Iran", "Crimea (Ukraine)". A code this list doesn't
 * know (one the operator added) reads as the country's English name where the browser knows it.
 */
export function placeName(code: string): string {
  const c = code.trim().toUpperCase();
  const known = RESTRICTED_PLACES.find((p) => p.code === c);
  if (known) {
    const name = known.name.replace(/^the /, "");
    return c.startsWith("UA-") ? `${name[0].toUpperCase()}${name.slice(1)} (Ukraine)` : name[0].toUpperCase() + name.slice(1);
  }
  const country = c.slice(0, 2);
  try {
    const n = new Intl.DisplayNames(["en"], { type: "region" }).of(country);
    if (n && n !== country) return c.length > 2 ? `${n} (${c})` : n;
  } catch {
    /* no Intl.DisplayNames */
  }
  return c;
}

/** The sentence the Terms (2.3), the Compliance page and the restricted screen share. */
export const RESTRICTED_SENTENCE =
  "Cuba, Iran, North Korea, Syria, Russia, Belarus or the United Arab Emirates; the Crimea (including Sevastopol), Donetsk or Luhansk regions of Ukraine";

/** The attribution DB-IP's free licence (CC BY 4.0) asks for wherever its lookups are used. */
export const GEO_ATTRIBUTION = { text: "IP Geolocation by DB-IP", href: "https://db-ip.com" } as const;
