/**
 * The U.S. sanctions list's Solana addresses, checked in this browser (P1-8).
 *
 * GET /api/sanctions/list is the same download for everyone: the addresses on the official list,
 * with when the list was last updated and where the server got it ("ofac", "mirror" or "seed"). The
 * app checks the connected wallet against it before any account opens, and each recipient as it is
 * typed, without telling the server which address it is looking at. It is a courtesy, not the gate:
 * the server still screens every deposit and payment, with its own list of refused addresses too
 * (which is never published).
 *
 * Fetched once per page load and kept in memory only. A server that can't be asked leaves the list
 * unknown, and nothing is refused here because of that.
 *
 * Plain data only (no React, no build-time settings), so the node tests can run it.
 */

export type SanctionsList = {
  /** the listed Solana addresses */
  addresses: ReadonlySet<string>;
  /** when the list was last updated (ISO 8601), when the server says */
  updatedAt: string | null;
  /** where the server's copy came from */
  source: "ofac" | "mirror" | "seed" | null;
};

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX = 10_000;

/** The server's answer, checked: addresses only (whatever the field is called), at most 10,000. */
export function parseSanctionsList(raw: unknown): SanctionsList | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const arr = [r.addresses, r.sol, r.list].find(Array.isArray) as unknown[] | undefined;
  if (!arr) return null;
  const addresses = new Set(arr.filter((a): a is string => typeof a === "string" && ADDRESS.test(a)).slice(0, MAX));
  const updatedAt = typeof r.updatedAt === "string" && !Number.isNaN(Date.parse(r.updatedAt)) ? r.updatedAt : null;
  const source = r.source === "ofac" || r.source === "mirror" || r.source === "seed" ? r.source : null;
  return { addresses, updatedAt, source };
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** The list for one page load. */
export class ScreenList {
  private list: SanctionsList | null = null;
  private loading: Promise<SanctionsList | null> | null = null;
  private listeners = new Set<() => void>();

  constructor(private fetcher: () => Fetcher | null = () => (typeof fetch === "undefined" ? null : fetch)) {}

  /** The list, once loaded (null until then, or when it couldn't be). */
  get(): SanctionsList | null {
    return this.list;
  }

  /** Downloads the list from `api` ("" for this site), once per page load; a failed download is tried again next time. */
  load(api = ""): Promise<SanctionsList | null> {
    if (this.list) return Promise.resolve(this.list);
    if (this.loading) return this.loading;
    const f = this.fetcher();
    if (!f) return Promise.resolve(null);
    // no credentials, no headers that say who is asking: the same request from everyone
    this.loading = f(`${api}/api/sanctions/list`, { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        this.list = parseSanctionsList(j);
        this.loading = null;
        for (const fn of [...this.listeners]) fn();
        return this.list;
      })
      .catch(() => {
        this.loading = null;
        return null;
      });
    return this.loading;
  }

  /** Whether `address` is on the list: true or false once the list is here, null while it isn't. */
  listed(address: string | null | undefined): boolean | null {
    if (!this.list) return null;
    return !!address && this.list.addresses.has(address.trim());
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

/** This page's copy of the list. */
export const screenList = new ScreenList();

/** What a listed address is told (the same words the server uses for a refused recipient). */
export const LISTED_RECIPIENT = "This address can't receive from VisionSwap. Nothing was sent.";
