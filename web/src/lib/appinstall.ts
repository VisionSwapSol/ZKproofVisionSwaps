/**
 * The homepage's "Get the app" pieces: who sees the Android download, and when the visitor is
 * already inside the installed app (where download prompts make no sense).
 */
import { ANDROID_APP } from "./androidApp";

/** The Android app's package name. */
export const ANDROID_PACKAGE = "net.visionswap.app";

export type AppEnv = { ua: string; standalone: boolean; referrer: string; launchedFromApp: boolean };

/** An Android phone or tablet, from the browser's user agent. */
export function isAndroidUA(ua: string): boolean {
  return /\bAndroid\b/i.test(ua);
}

/** An iPhone or iPad (iPadOS reports itself as a Mac with touch, which counts too). */
export function isAppleMobileUA(ua: string, touchPoints = 0): boolean {
  return /\b(iPhone|iPad|iPod)\b/i.test(ua) || (/\bMacintosh\b/.test(ua) && touchPoints > 1);
}

/** The Android app opens pages with this referrer (only on the page it starts on). */
export function fromAndroidApp(referrer: string): boolean {
  return referrer.startsWith(`android-app://${ANDROID_PACKAGE}`);
}

/**
 * Inside the installed app: the Android app, or the site added to a home screen. Both show the
 * site in standalone display mode; the Android app's first page also carries its referrer.
 */
export function inInstalledApp(env: Pick<AppEnv, "standalone" | "referrer" | "launchedFromApp">): boolean {
  return env.standalone || env.launchedFromApp || fromAndroidApp(env.referrer);
}

const SEEN = "vs:in-app";

/** This visitor's browser, read once per page. */
export function appEnv(): AppEnv {
  if (typeof window === "undefined") return { ua: "", standalone: false, referrer: "", launchedFromApp: false };
  const referrer = document.referrer || "";
  let launchedFromApp = false;
  try {
    // remembered for this visit, so pages opened later in the app still know
    if (fromAndroidApp(referrer)) sessionStorage.setItem(SEEN, "1");
    launchedFromApp = sessionStorage.getItem(SEEN) === "1";
  } catch {
    launchedFromApp = fromAndroidApp(referrer);
  }
  const standalone = ["standalone", "fullscreen", "minimal-ui"].some((m) => window.matchMedia?.(`(display-mode: ${m})`).matches);
  return { ua: navigator.userAgent, standalone, referrer, launchedFromApp };
}

/** "1.8 MB" (one decimal, as phones show download sizes). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Version 1.0.0 · 1.8 MB" */
export function androidAppLine(app: { version: string; bytes: number } = ANDROID_APP): string {
  const size = formatBytes(app.bytes);
  return size ? `Version ${app.version} · ${size}` : `Version ${app.version}`;
}
