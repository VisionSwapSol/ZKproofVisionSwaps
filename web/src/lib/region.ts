/**
 * Whether VisionSwap is offered where this connection comes from, as the server tells it.
 *
 * GET /api/region answers { restricted, regionBlocking, source, where? }: the server looks the
 * connection up itself and never echoes the IP address; `where` (a country code such as "IR", or a
 * region such as "UA-43") comes back only when the place is restricted. It is asked once per page
 * load. A request to the server refused with HTTP 451 (a deposit, a payment, a trade) switches the
 * app to its restricted-region screen once /api/region confirms it (see noteRefusal: a deposit from a
 * connection the server can't place is refused too, with its own code, and isn't from a restricted place).
 *
 * Nothing is kept: no storage, nothing remembered for next time (another connection may be fine).
 * A server that can't be asked, or one from before /api/region, reads as "not restricted": the
 * server's own refusals are the control, and this screen only explains them.
 *
 * Plain data only (no React, no build-time settings), so the node tests can run it.
 */

export type RegionInfo = {
  /** the server refuses money requests from this connection */
  restricted: boolean;
  /** the server's region blocking right now ("degraded": wanted, but not trusted yet, so nothing is refused for its region); null when unknown */
  regionBlocking: "on" | "off" | "degraded" | null;
  /** where the server's answer comes from (its lookup database, or a trusted proxy), as it says; null when unknown */
  source: string | null;
  /** the restricted place, only when restricted ("IR", "UA-43") */
  where: string | null;
};

export const REGION_UNKNOWN: RegionInfo = { restricted: false, regionBlocking: null, source: null, where: null };

const PLACE = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/;

/** A place code as the server sends it, checked; null otherwise. */
export function placeCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return PLACE.test(c) ? c : null;
}

/** /api/region's answer, checked field by field. Anything malformed reads as unknown, never as restricted. */
export function parseRegion(raw: unknown): RegionInfo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return REGION_UNKNOWN;
  const r = raw as Record<string, unknown>;
  const restricted = r.restricted === true;
  const blocking = r.regionBlocking === "on" || r.regionBlocking === "off" || r.regionBlocking === "degraded" ? r.regionBlocking : null;
  const source = typeof r.source === "string" && r.source.length <= 80 && !/[<>]/.test(r.source) ? r.source : null;
  return { restricted, regionBlocking: blocking, source, where: restricted ? placeCode(r.where) : null };
}

/** Whether a refused request (its status and JSON body) means "not offered in this region". */
export function isRegionRefusal(status: number, body: unknown): boolean {
  if (status !== 451) return false;
  // a 451 without a code (an older server) is a region refusal; a body naming another code is not (say,
  // "region_unknown": a deposit from a connection the server can't place, which isn't a restricted place)
  const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  return code === undefined || code === "restricted_region";
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Whether the restricted screen credits DB-IP, whose free licence (CC BY 4.0) asks for a credit wherever
 * its lookups are used: whenever the server's answer came from its own lookup in that database (it says
 * "built-in lookup"), and when the source isn't known (crediting it then is harmless). Only a trusted
 * service in front of the server ("trusted proxy") is another source.
 */
export const creditsGeoDatabase = (source: string | null | undefined): boolean => !source || !/proxy/i.test(source);

/** The region state for one page load: asked once, and moved to "restricted" by a 451 the server confirms. */
export class RegionStore {
  private info: RegionInfo = REGION_UNKNOWN;
  private loaded: Promise<RegionInfo> | null = null;
  private confirming: Promise<void> | null = null;
  private api = "";
  private listeners = new Set<() => void>();

  constructor(private fetcher: () => Fetcher | null = () => (typeof fetch === "undefined" ? null : fetch)) {}

  get(): RegionInfo {
    return this.info;
  }

  /** Asks /api/region at `api` (the server's address, "" for this site), once per page load (a failed ask is tried again the next time). */
  load(api = ""): Promise<RegionInfo> {
    this.api = api;
    if (this.loaded) return this.loaded;
    const f = this.fetcher();
    if (!f) return Promise.resolve(this.info);
    this.loaded = f(`${api}/api/region`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const next = parseRegion(j);
        // a refusal seen meanwhile stands: an answer can't take the screen away again
        this.set(this.info.restricted ? { ...next, restricted: true, where: next.where ?? this.info.where } : next);
        return this.info;
      })
      .catch(() => {
        this.loaded = null;
        return this.info;
      });
    return this.loaded;
  }

  /**
   * A money request was refused with 451. When the refusal names the place, the restricted screen shows
   * from now on, for this page load. When it doesn't, /api/region is asked first: a refusal that names no
   * place may not come from a restricted place at all (the server also refuses a deposit whose connection
   * it can't place), so the screen (which says it does) shows only when the server says so, or when it
   * can't be asked (a server from before /api/region). `api`: the server's address ("" for this site).
   */
  noteRefusal(where?: unknown, api: string = this.api): Promise<void> {
    const code = placeCode(where);
    if (code) {
      this.restrict(code);
      return Promise.resolve();
    }
    if (this.info.restricted) return Promise.resolve();
    if (this.confirming) return this.confirming;
    const f = this.fetcher();
    if (!f) {
      this.restrict(null);
      return Promise.resolve();
    }
    this.confirming = f(`${api}/api/region`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const next = parseRegion(j);
        if (next.restricted) this.restrict(next.where, next);
        else if (!this.info.restricted) this.set(next);
      })
      .catch(() => this.restrict(null))
      .finally(() => {
        this.confirming = null;
      });
    return this.confirming;
  }

  /** The restricted screen shows from now on, for this page load (`from`: the server's own answer, when there is one). */
  private restrict(where: string | null, from: RegionInfo = this.info) {
    if (this.info.restricted && (this.info.where || !where)) return;
    this.set({ ...from, restricted: true, regionBlocking: from.regionBlocking ?? "on", where: where ?? this.info.where });
  }

  private set(next: RegionInfo) {
    this.info = next;
    for (const fn of [...this.listeners]) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

/** This page's region state. */
export const region = new RegionStore();

/** For api() and the chain gateway: a response refused for the region switches the screen (see noteRefusal). `api`: the server's address. */
export function noteRegionRefusal(status: number, body: unknown, api?: string) {
  if (!isRegionRefusal(status, body)) return;
  const where = body && typeof body === "object" ? (body as { where?: unknown }).where : undefined;
  void region.noteRefusal(where, api);
}
