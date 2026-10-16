/**
 * How long a Solana slot really takes. The waiting room and the screening pass are set in slots, and
 * slots are no longer 400 ms (they run at about 200 ms since the network shortened them), so every
 * "about N minutes" the app says is worked out from a measured slot time: the server's figure when it
 * gives one, else the network's own recent performance samples, else this page's own readings of the
 * slot over time. 400 ms is used only while none of those is known, and never for a duration put in
 * words on a page (slotsToText says nothing then).
 */

/** Used only until a measured slot time is known. */
export const FALLBACK_MS_PER_SLOT = 400;

/** A measured slot time outside this range is taken as a bad reading. */
const MIN_MS = 100;
const MAX_MS = 1000;

const sane = (ms: number | null | undefined): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS;

/** The slot time from the network's recent performance samples (getRecentPerformanceSamples), or null when they don't say. */
export function msPerSlotFromSamples(samples: { numSlots: number; samplePeriodSecs: number }[] | null | undefined): number | null {
  if (!Array.isArray(samples)) return null;
  let slots = 0;
  let secs = 0;
  for (const s of samples) {
    if (!(s?.numSlots > 0) || !(s.samplePeriodSecs > 0)) continue;
    slots += s.numSlots;
    secs += s.samplePeriodSecs;
  }
  if (!slots) return null;
  const ms = (secs * 1000) / slots;
  return sane(ms) ? ms : null;
}

/**
 * The slot time from this page's own readings of the current slot (as the server reports it now and
 * then), once they span at least `minSpanMs`: from the first reading to the latest.
 */
export class SlotClock {
  private first: { slot: number; at: number } | null = null;
  constructor(private minSpanMs = 60_000) {}

  /** Takes one reading; returns the slot time once the readings span long enough (null until then). */
  observe(slot: number, at: number): number | null {
    if (!(slot > 0) || !Number.isFinite(at)) return null;
    // a reading that goes backwards (another node behind the last) starts over
    if (!this.first || slot < this.first.slot || at < this.first.at) {
      this.first = { slot, at };
      return null;
    }
    const span = at - this.first.at;
    const slots = slot - this.first.slot;
    if (span < this.minSpanMs || slots <= 0) return null;
    const ms = span / slots;
    return sane(ms) ? ms : null;
  }
}

/** Minutes for `slots` at `msPerSlot`, never less than one: rounded, or rounded up (`ceil`) for time left. */
export function slotMinutes(slots: number, msPerSlot: number, ceil = false): number {
  const m = (Math.max(0, slots) * (sane(msPerSlot) ? msPerSlot : FALLBACK_MS_PER_SLOT)) / 60_000;
  return Math.max(1, ceil ? Math.ceil(m) : Math.round(m));
}

const KEY = "vs:msPerSlot";
/** How long a measured slot time is kept on this device. */
const KEEP_MS = 12 * 3_600_000;

/** The slot time last measured on this device (within the last 12 hours), or null. */
export function cachedMsPerSlot(now = Date.now()): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as { ms?: number; at?: number } | null;
    return v && sane(v.ms) && typeof v.at === "number" && now - v.at < KEEP_MS ? v.ms : null;
  } catch {
    return null;
  }
}

/** Keeps a measured slot time on this device for next time. */
export function saveMsPerSlot(ms: number, now = Date.now()) {
  if (!sane(ms)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ms: Math.round(ms * 10) / 10, at: now }));
  } catch {
    /* kept in memory only */
  }
}

/** The measured slot time known: the server's, then a measured one, then the cached one; null when none is. */
export function measuredMsPerSlot(server: number | null | undefined, measured: number | null | undefined, cached: number | null | undefined = cachedMsPerSlot()): number | null {
  if (sane(server)) return server;
  if (sane(measured)) return measured;
  if (sane(cached)) return cached;
  return null;
}

/** The best slot time known: the server's, then a measured one, then the cached one, then 400 ms. */
export function bestMsPerSlot(server: number | null | undefined, measured: number | null | undefined, cached: number | null | undefined = cachedMsPerSlot()): number {
  return measuredMsPerSlot(server, measured, cached) ?? FALLBACK_MS_PER_SLOT;
}

/** "about 95 seconds", "about 3 minutes", "about 5 hours", "about 3.5 days". */
export function durationText(seconds: number): string {
  const s = Math.max(1, seconds);
  if (s < 120) {
    const n = s < 15 ? Math.round(s) : Math.round(s / 5) * 5;
    return `about ${n} second${n === 1 ? "" : "s"}`;
  }
  const min = s / 60;
  if (min < 90) {
    const n = Math.round(min);
    return `about ${n} minute${n === 1 ? "" : "s"}`;
  }
  const h = min / 60;
  if (h < 36) {
    const n = h < 10 ? Math.round(h * 2) / 2 : Math.round(h);
    return `about ${n} hour${n === 1 ? "" : "s"}`;
  }
  const d = Math.round((h / 24) * 2) / 2;
  return `about ${d} day${d === 1 ? "" : "s"}`;
}

/**
 * How long `slots` slots take at a measured `msPerSlot`, in words; null when no slot time is known (or
 * it is a bad reading), so a page says it without a figure rather than guess with 400 ms.
 */
export function slotsToText(slots: number | bigint | string, msPerSlot: number | null | undefined): string | null {
  const n = Number(slots);
  if (!sane(msPerSlot) || !Number.isFinite(n) || n < 0) return null;
  return durationText((n * msPerSlot) / 1000);
}
