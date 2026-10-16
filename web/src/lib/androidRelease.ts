/**
 * The Android app's release moment. Until then the server answers 404 for the APK, and the site shows
 * when it opens ("Available October 15 at 12:00 PM PST") wherever it would offer the download: the
 * homepage's "Get the app" section, the hero's Android button and the footer's link. From the moment on,
 * the download is offered as before, without a rebuild or a reload.
 *
 * The moment is the server's setting (ANDROID_RELEASE_AT, published at /api/legal as "android"); until
 * /api/legal answers the default below stands, on the visitor's own clock. Once it answers, the server's
 * clock decides: the page counts down the seconds the server said were left.
 *
 * The pages as built always offer the download, whenever they are built: the same bytes from the same
 * source (the release manifest compares them with the live site), and correct for every reader from the
 * moment on, so they never go stale. Before the moment the browser shows when it opens instead, as soon
 * as it takes the page over (the server answers 404 for the APK meanwhile).
 *
 * Plain data and a small store, no React (GetApp.tsx holds the hook), so the node tests can run it.
 */

/** The server's default for ANDROID_RELEASE_AT: October 15, 2026 at 12:00 PM PST. */
export const ANDROID_RELEASE_DEFAULT = "2026-10-15T12:00:00-08:00";
export const ANDROID_RELEASE_DEFAULT_AT = Date.parse(ANDROID_RELEASE_DEFAULT);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "October 15 at 12:00 PM PST": the moment in Pacific Standard Time (UTC-8, as announced), the same in every browser. */
export function androidWhen(at: number): string {
  const d = new Date(at - 8 * 3_600_000);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} at ${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"} PST`;
}

/** "Available October 15 at 12:00 PM PST" */
export const availableLine = (at: number) => `Available ${androidWhen(at)}`;

/** /api/legal's "android", checked: the moment (null: nothing to wait for) and the seconds left by the server's clock. */
export type AndroidReleaseInfo = { releaseAt: number | null; startsIn: number };

/** /api/legal's "android"; null when missing or malformed (the default then stands). */
export function parseAndroidRelease(raw: unknown): AndroidReleaseInfo | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const startsIn = typeof r.startsIn === "number" && Number.isFinite(r.startsIn) && r.startsIn >= 0 ? Math.min(r.startsIn, 10 * 365 * 86_400) : null;
  if (startsIn == null) return null;
  if (r.releaseAt === null) return { releaseAt: null, startsIn: 0 };
  const at = typeof r.releaseAt === "string" ? Date.parse(r.releaseAt) : NaN;
  return Number.isFinite(at) ? { releaseAt: at, startsIn } : null;
}

/** What the page shows: whether the download is offered, and the moment (for the "Available …" line). */
export type AndroidReleaseState = { released: boolean; at: number };

/**
 * The state at `now`: `opensAt` is the moment on this browser's clock (null: open), `at` the moment as
 * announced (what the line says).
 */
export function releaseState(opensAt: number | null, at: number | null, now: number): AndroidReleaseState {
  return { released: opensAt == null || now >= opensAt, at: at ?? ANDROID_RELEASE_DEFAULT_AT };
}

/** The attribute each gated part carries in the page as built, so the browser takes the page over without a difference. */
export const RELEASE_ATTR = "data-android-release";
export const releaseAttr = (s: AndroidReleaseState) => (s.released ? "open" : "soon");

// ─── the store (one per page) ───

/** the moment on this browser's clock (null: open) */
let opensAt: number | null = ANDROID_RELEASE_DEFAULT_AT;
/** the moment as announced */
let announced: number | null = ANDROID_RELEASE_DEFAULT_AT;
let state: AndroidReleaseState = releaseState(opensAt, announced, Date.now());
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** what the page as built showed (read once, while the browser takes it over) */
let built: AndroidReleaseState | undefined;

/** The state now, the same object while nothing changed (as useSyncExternalStore needs). */
export function androidReleaseSnapshot(now = Date.now()): AndroidReleaseState {
  const next = releaseState(opensAt, announced, now);
  if (next.released !== state.released || next.at !== state.at) state = next;
  return state;
}

function refresh() {
  const before = state;
  androidReleaseSnapshot();
  if (state !== before) for (const l of [...listeners]) l();
  arm();
}

/** A look again at the moment itself (and every minute meanwhile: a computer that slept or a clock that moved). */
function arm() {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (!listeners.size || state.released || opensAt == null) return;
  timer = setTimeout(refresh, Math.max(50, Math.min(opensAt - Date.now() + 50, 60_000)));
}

/** Follows the moment: listeners hear when the download opens (or the server moves the moment). */
export function subscribeAndroidRelease(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
  }
  arm();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", refresh);
        window.removeEventListener("focus", refresh);
      }
    }
  };
}

/** What the pages as built show: the download (see above). */
export const PRERENDERED: AndroidReleaseState = { released: true, at: ANDROID_RELEASE_DEFAULT_AT };

/**
 * What the page as built shows. While prerendering (no document): PRERENDERED, whatever the build's clock
 * says. In the browser, while it takes a built page over: what that page says (its data-android-release),
 * so the first render matches the HTML exactly; the real state follows right after.
 */
export function androidReleaseBuiltSnapshot(): AndroidReleaseState {
  if (built) return built;
  if (typeof document === "undefined") return (built = PRERENDERED);
  const shown = document.querySelector(`[${RELEASE_ATTR}]`)?.getAttribute(RELEASE_ATTR);
  return (built = { released: shown === "open", at: ANDROID_RELEASE_DEFAULT_AT });
}

/** The server's answer (from /api/legal): its moment, counted down on the server's clock from here. */
export function setAndroidRelease(info: AndroidReleaseInfo | null, now = Date.now()) {
  if (!info) return;
  announced = info.releaseAt;
  opensAt = info.releaseAt == null ? null : now + info.startsIn * 1000;
  refresh();
}

/** For tests only: back to the default moment and a fresh page (`page`: what a page being taken over shows). */
export function resetAndroidReleaseForTests(page?: AndroidReleaseState) {
  opensAt = announced = ANDROID_RELEASE_DEFAULT_AT;
  state = releaseState(opensAt, announced, Date.now());
  built = page;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  listeners.clear();
}
