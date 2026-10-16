import { useEffect, useState } from "react";
import { engine, type State } from "../../lib/engine";
import { api } from "../../lib/net";
import { accountTag } from "../../lib/device";
import { isMobile } from "../../lib/wallet";
import { extensionIdFrom } from "../../lib/extid";

let idAsk: Promise<string | null> | null = null;

/**
 * The Chrome Web Store ID of the VisionSwap extension, built into this page (VITE_EXTENSION_ID) once it
 * is known. The account's key is handed only to that ID: a server that names another one is not used.
 */
const PINNED_EXTENSION_ID = ((import.meta.env.VITE_EXTENSION_ID as string | undefined) ?? "").trim();

/** The VisionSwap extension's ID (see extensionIdFrom); null while there is none (then nothing here shows). */
function useExtensionId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    idAsk ??= api<{ extensionId?: string | null }>("/api/legal")
      .then((r) => extensionIdFrom(r.extensionId, PINNED_EXTENSION_ID))
      .catch(() => {
        idAsk = null;
        return null;
      });
    let dead = false;
    void idAsk.then((v) => !dead && setId(v));
    return () => {
      dead = true;
    };
  }, []);
  return id;
}

type Runtime = { sendMessage: (id: string, message: unknown, reply: (r: unknown) => void) => void; lastError?: unknown };
type Said = "sending" | "opened" | "click" | "missing" | "refused";

/**
 * Hands the open account to the VisionSwap extension: one message, on the person's click, addressed to
 * that extension's ID only (Chrome delivers it to no one else). The extension checks it came from
 * visionswap.net and offers to open the account in its side panel.
 */
function handOver(id: string, key: string): Promise<Said> {
  const rt = (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime;
  if (!rt?.sendMessage) return Promise.resolve("missing");
  return new Promise((done) => {
    try {
      rt.sendMessage(id, { type: "vs-link", key }, (reply) => {
        // reading lastError tells Chrome the failure was seen (not installed, or turned off)
        if (rt.lastError || !reply || typeof reply !== "object") return done("missing");
        const r = reply as { ok?: unknown; panel?: unknown };
        done(r.ok === true ? (r.panel === true ? "opened" : "click") : "refused");
      });
    } catch {
      done("missing");
    }
  });
}

/**
 * "Use in the Chrome extension": opens this account in the VisionSwap extension's side panel. As a card
 * at the top of the app when the extension sent the person here (/app#extension), and as a small panel
 * beside the account otherwise. Shown on computers once the server knows the extension's ID.
 */
export function ExtensionLink({ st, card = false, onClose }: { st: State; card?: boolean; onClose?: () => void }) {
  const id = useExtensionId();
  const [said, setSaid] = useState<Said | null>(null);
  // another account opened here starts over
  useEffect(() => setSaid(null), [st.fingerprint]);
  if (!st.unlocked || !st.fingerprint || isMobile()) return null;
  if (!id) {
    return card ? (
      <div className="banner info" role="status">
        <span>Linking an account to the VisionSwap extension isn't switched on yet. Please try again a little later.</span>
        {onClose && (
          <button type="button" aria-label="Dismiss" onClick={onClose}>
            ×
          </button>
        )}
      </div>
    ) : null;
  }
  const tag = accountTag(st.fingerprint);
  const go = async () => {
    const key = engine.linkKey();
    if (!key) return;
    setSaid("sending");
    setSaid(await handOver(id, key));
  };
  const result =
    said === "opened" ? (
      <p className="small good-text" role="status">
        Sent. Press Open in the extension's side panel to use account {tag} there.
      </p>
    ) : said === "click" ? (
      <p className="small good-text" role="status">
        Sent. Click the VisionSwap icon in your browser's toolbar, then press Open within 2 minutes.
      </p>
    ) : said === "missing" ? (
      <p className="small warn" role="status">
        The VisionSwap extension isn't installed in this browser, or it's turned off.{" "}
        <a href={`https://chromewebstore.google.com/detail/${id}`} target="_blank" rel="noreferrer noopener">
          Get it from the Chrome Web Store
        </a>
        , then try again.
      </p>
    ) : said === "refused" ? (
      <p className="small warn" role="status">
        The extension didn't take it. Open this page on visionswap.net, then try again.
      </p>
    ) : null;
  const button = (
    <button type="button" className={card ? "btn violet" : "btn ghost small-btn"} disabled={said === "sending"} onClick={() => void go()}>
      {said === "sending" ? "Sending…" : card ? "Link to extension" : "Use in the Chrome extension"}
    </button>
  );
  if (card) {
    return (
      <div className="xlink-card" role="group" aria-label="Use this account in the VisionSwap extension">
        <div className="xlink-top">
          <strong>Use this account in the VisionSwap extension</strong>
          {onClose && (
            <button type="button" className="xlink-x" aria-label="Not now" onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <p className="small">
          Account {tag} opens in the extension's side panel, with the same private balance and Vision wallets. Your key goes straight to the
          extension in this browser, never to a server.
        </p>
        {button}
        {result}
      </div>
    );
  }
  return (
    <section className="panel xlink">
      <header>
        <h3>VisionSwap for Chrome</h3>
        <span className="muted">Side panel</span>
      </header>
      <p className="small muted">Keep this account open beside any page in Chrome's side panel. One click links it; your key goes straight to the extension.</p>
      {button}
      {result}
    </section>
  );
}
