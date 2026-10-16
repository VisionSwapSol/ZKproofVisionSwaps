/**
 * The build-time prerender's entry (vite build --ssr, then scripts/prerender.mjs): it writes each
 * public page's words into its HTML, so every visitor and every crawler gets the same readable page
 * before any script runs. The browser then takes the page over (main.tsx).
 */
import { StrictMode } from "react";
import { prerenderToNodeStream } from "react-dom/static";
import { setServerPath } from "./lib/router";
import { Root } from "./App";

export { PAGES, ROUTES, ORIGIN, routeOf, cleanPath, pageOf } from "./seo/pages";
export { pageHtml, pageText } from "./seo/html";
export { jsonLdFor } from "./seo/jsonld";
export { robotsTxt, sitemapXml, llmsTxt, llmsFullTxt } from "./seo/files";

/** The page's markup for `path`, with every lazy page resolved. Errors go to `onError` (a part that fails falls back to the browser). */
export async function renderPage(path: string, onError: (e: unknown) => void = () => {}): Promise<string> {
  setServerPath(path);
  const { prelude } = await prerenderToNodeStream(
    <StrictMode>
      <Root />
    </StrictMode>,
    { onError },
  );
  let html = "";
  for await (const chunk of prelude) html += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  return html;
}
