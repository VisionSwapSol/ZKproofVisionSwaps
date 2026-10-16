import { useEffect, useSyncExternalStore } from "react";
import { API } from "../../lib/config";
import { LISTED_RECIPIENT, screenList, type SanctionsList } from "../../lib/screenlist";
import { contactHref, contactText } from "../../legal/settings";
import { shownLegal, useLegal } from "../../legal/useLegal";

/**
 * The U.S. sanctions list's Solana addresses, downloaded once per page load (the same download for
 * everyone) and checked here in the browser: the server never hears which address is looked at.
 */
export function useSanctionsList(): SanctionsList | null {
  useEffect(() => {
    void screenList.load(API);
  }, []);
  return useSyncExternalStore(screenList.subscribe, () => screenList.get(), () => null);
}

/** Whether `address` is on the list (false until the list is here, or when it can't be loaded). */
export function useListed(address: string | null | undefined): boolean {
  useSanctionsList();
  return screenList.listed(address) === true;
}

/**
 * Instead of "Sign to open": the connected wallet is on the U.S. sanctions list, so no account opens
 * with it. The check ran in this browser, and nothing about it was sent anywhere.
 */
export function ListedWallet({ onDisconnect }: { onDisconnect?: () => void }) {
  const raw = shownLegal(useLegal()).contact;
  const href = contactHref(raw);
  return (
    <div className="gate listed" role="status">
      <h2>This wallet can't open a VisionSwap account</h2>
      <p>
        The connected wallet's address is on the U.S. sanctions list, so VisionSwap isn't available to it. This check ran in your
        browser: nothing about it was sent to our server.
      </p>
      <p className="small">
        VisionSwap is not offered to people on sanctions lists (<a href="/terms#eligibility">Terms of use, section 2</a>).
        {href && (
          <>
            {" "}
            If you think this is a mistake, write to{" "}
            <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer noopener">
              {contactText(raw)}
            </a>
            .
          </>
        )}
      </p>
      {onDisconnect && (
        <button type="button" className="btn ghost" onClick={onDisconnect}>
          Disconnect this wallet
        </button>
      )}
    </div>
  );
}

/** Under an address field: the address is on the sanctions list, so VisionSwap won't send to it (checked in this browser). */
export function ListedWarning({ to }: { to: string | null | undefined }) {
  const listed = useListed(to);
  return listed ? <p className="small warn">{LISTED_RECIPIENT.replace(" Nothing was sent.", " It is on the U.S. sanctions list.")}</p> : null;
}
