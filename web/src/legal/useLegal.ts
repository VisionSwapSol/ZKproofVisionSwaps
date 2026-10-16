import { useEffect, useState } from "react";
import { API } from "../lib/config";
import { terms } from "../lib/terms";
import { setAndroidRelease } from "../lib/androidRelease";
import { legalRev } from "./settings";
import { DEFAULT_LEGAL_INFO, parseLegalInfo, type LegalInfo } from "./info";

export { DEFAULT_LEGAL_INFO, parseLegalInfo, parseScreening, refusedPlaces, shownLegal, type LegalInfo, type Screening } from "./info";

let cache: Promise<LegalInfo> | null = null;

/**
 * /api/legal, asked once per page load (shared by the footer, the Terms window and the legal pages).
 * Once it answers, the live legal settings' fingerprint goes to the Terms acceptance (lib/terms.ts),
 * so a change to who we are, the law, the courts or arbitration asks people to accept again. A failed
 * request is asked again the next time something needs it.
 */
export function loadLegal(): Promise<LegalInfo> {
  cache ??= fetch(`${API}/api/legal`)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j) => {
      const info = parseLegalInfo(j);
      terms.setLiveRev(legalRev(info.legal));
      // when the Android app's download opens, by the server's clock (GetApp.tsx shows it)
      setAndroidRelease(info.android);
      return info;
    })
    .catch(() => {
      cache = null;
      return DEFAULT_LEGAL_INFO;
    });
  return cache;
}

/**
 * The legal information, once it has been asked for (null until then: the page shows its neutral wording
 * and the default contacts meanwhile, see shownLegal).
 */
export function useLegal(): LegalInfo | null {
  const [info, setInfo] = useState<LegalInfo | null>(null);
  useEffect(() => {
    let live = true;
    void loadLegal().then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, []);
  return info;
}

