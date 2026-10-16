import { useEffect, useSyncExternalStore } from "react";
import { API } from "../lib/config";
import { creditsGeoDatabase, region, REGION_UNKNOWN, type RegionInfo } from "../lib/region";
import { contactHref, contactText } from "../legal/settings";
import { shownLegal, useLegal } from "../legal/useLegal";
import { GEO_ATTRIBUTION, placeName } from "../legal/places";

/**
 * Whether VisionSwap is offered where this connection comes from: /api/region, asked once per page
 * load, and any money request refused with HTTP 451 since (see lib/region.ts).
 */
export function useRegion(): RegionInfo {
  useEffect(() => {
    void region.load(API);
  }, []);
  return useSyncExternalStore(region.subscribe, () => region.get(), () => REGION_UNKNOWN);
}

/**
 * The restricted-region screen: shown instead of the app, the payment page and the extension's panel
 * when the server says VisionSwap isn't offered where this connection comes from. The same notice the
 * server sends with HTTP 451 for /app, /pay and the Android download. It says what is true and where
 * the list is, and nothing about other ways in.
 */
export function Restricted({ info, heading = "h2", alwaysCredit = false }: { info: RegionInfo; heading?: "h1" | "h2"; alwaysCredit?: boolean }) {
  const legal = shownLegal(useLegal());
  // LEGAL_CONTACT: support@visionswap.net unless the owner names another, none when it is "off"
  const raw = legal.legal.contact ?? legal.contact;
  const href = contactHref(raw);
  const H = heading;
  const place = info.where ? placeName(info.where) : null;
  return (
    <section className="restricted" aria-labelledby="restricted-title">
      <span className="restricted-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M3.5 9h17M3.5 15h17M12 3c2.5 2.6 3.6 5.6 3.6 9s-1.1 6.4-3.6 9c-2.5-2.6-3.6-5.6-3.6-9S9.5 5.6 12 3z" />
        </svg>
      </span>
      <H id="restricted-title" tabIndex={-1}>
        VisionSwap isn't available in your region
      </H>
      <p>
        {place
          ? `This connection appears to come from ${place}, where VisionSwap isn't offered.`
          : "This connection appears to come from a place where VisionSwap isn't offered."}{" "}
        The places are listed in the <a href="/terms#eligibility">Terms of use, section 2</a>, and on the{" "}
        <a href="/compliance#places">Compliance</a> page.
      </p>
      {href && (
        <p className="small">
          Questions:{" "}
          <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer noopener">
            {contactText(raw)}
          </a>
        </p>
      )}
      {(alwaysCredit || creditsGeoDatabase(info.source)) && (
        <p className="tiny restricted-credit">
          <a href={GEO_ATTRIBUTION.href} target="_blank" rel="noreferrer noopener">
            {GEO_ATTRIBUTION.text}
          </a>
        </p>
      )}
    </section>
  );
}
