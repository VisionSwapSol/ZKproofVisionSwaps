// The extension's manifest, for the published build and for the development build.
//
// Published: talks to https://visionswap.net only, takes account links from that site only, and
// carries no "key" (the Chrome Web Store gives the extension its ID). Development: adds the local
// server and the local copy of the site, and may pin a test ID with a public key.

export const NAME = "VisionSwap";
export const DESCRIPTION = "Private SOL sends and private trading on Solana from a non-custodial privacy pool, in Chrome's side panel.";
export const SITE = "https://visionswap.net";
export const DEV = { api: "http://127.0.0.1:8787", site: "http://localhost:5196", siteAlt: "http://127.0.0.1:5196" };

/**
 * The extension pages' content security policy: only the extension's own code (and its proof's WebAssembly)
 * runs, it talks only to `api`, and everything else it shows (styles, fonts, images) comes from the package
 * itself (token icons arrive through `api` and show from local copies).
 */
export function csp(api) {
  return [
    "script-src 'self' 'wasm-unsafe-eval'",
    "object-src 'self'",
    "default-src 'self'",
    `connect-src 'self' ${api}`,
    "img-src 'self' data: blob:",
    "style-src 'self'",
  ].join("; ");
}

/** @param {{ dev?: boolean, version: string, key?: string | null }} o */
export function manifest({ dev = false, version, key = null }) {
  const api = dev ? DEV.api : SITE;
  const sites = dev ? [SITE, DEV.site, DEV.siteAlt] : [SITE];
  const m = {
    manifest_version: 3,
    name: dev ? `${NAME} (dev)` : NAME,
    short_name: NAME,
    description: DESCRIPTION,
    version,
    minimum_chrome_version: "116",
    icons: { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" },
    action: { default_title: "Open VisionSwap", default_icon: { 16: "icons/icon-16.png", 32: "icons/icon-32.png" } },
    side_panel: { default_path: "sidepanel.html" },
    background: { service_worker: "background.js", type: "module" },
    permissions: ["sidePanel", "storage"],
    host_permissions: dev ? [`${SITE}/*`, `${DEV.site}/*`, `${DEV.api}/*`] : [`${SITE}/*`],
    externally_connectable: { matches: sites.map((s) => `${s}/*`) },
    content_security_policy: { extension_pages: csp(api) },
  };
  if (dev && key) m.key = key;
  return m;
}
