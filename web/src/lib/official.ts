/** VisionSwap's own site: the only one that runs the mainnet pool for this app. */
const OFFICIAL_HOSTS = ["visionswap.net", "www.visionswap.net"];

/**
 * Whether the server this page talks to (`api`, or the page's own `origin` when it talks to the site
 * it came from) is VisionSwap's own site. Then the app uses only the mainnet pool program it knows
 * (see poolProblems in the SDK), whatever network the server names. A local or test copy isn't.
 */
export function officialServer(api: string, origin: string): boolean {
  try {
    const u = new URL(api || origin);
    return u.protocol === "https:" && OFFICIAL_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
