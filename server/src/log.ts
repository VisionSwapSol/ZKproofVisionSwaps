/**
 * Operational log. It never receives IP addresses, wallet addresses, amounts
 * or anything else that could tie a person to a payment, and as a safety net
 * it blanks out anything that looks like an address, a transaction id or an
 * IP before writing.
 */
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,90}\b/g;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;

export function scrub(s: string): string {
  return s.replace(BASE58, "[id]").replace(IPV4, "[ip]").replace(IPV6, "[ip]");
}

export function log(...parts: unknown[]) {
  console.log(new Date().toISOString(), ...parts.map((p) => (typeof p === "string" ? scrub(p) : p)));
}
