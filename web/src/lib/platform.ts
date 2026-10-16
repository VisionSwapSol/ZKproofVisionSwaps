/**
 * Where this copy of the app runs. The website and the VisionSwap Chrome extension are built from
 * the same code; the extension build sets VITE_EXTENSION=1. Everything the extension does
 * differently is behind IS_EXTENSION, so the website itself never changes because of it.
 */
export const IS_EXTENSION = import.meta.env.VITE_EXTENSION === "1";

/** The website. Inside the extension, payment links and links to the site's pages point here. */
export const SITE = ((import.meta.env.VITE_SITE_URL as string | undefined) || "https://visionswap.net").replace(/\/$/, "");

/** The origin a link to one of the site's pages starts with: this page's own on the website, SITE in the extension. */
export const siteOrigin = (): string => (IS_EXTENSION ? SITE : location.origin);
