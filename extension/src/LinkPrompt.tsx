import { useState } from "react";
import { engine, lockWaits, type State } from "../../web/src/lib/engine";
import { accountTag } from "../../web/src/lib/device";
import type { Pending } from "./link";
import { Glyph } from "./Glyph";

/**
 * An account sent from visionswap.net ("Link to extension"), offered once: open it here, or not.
 * The key stays in memory; it's kept on this device only if "Keep me signed in" is ticked.
 */
export function LinkPrompt({ st, link, clear }: { st: State; link: Pending; clear: () => void }) {
  const [keep, setKeep] = useState(false);
  const tag = engine.tagOf(link.key);
  const current = st.unlocked && st.fingerprint ? accountTag(st.fingerprint) : null;
  if (current && tag === current) {
    return (
      <div className="ext-linkcard" role="status">
        <p className="small">
          <strong>Account {tag} is open here already.</strong>
        </p>
        <button type="button" className="btn ghost small-btn" onClick={clear}>
          OK
        </button>
      </div>
    );
  }
  const open = async () => {
    const key = link.key;
    // the link is used once: it leaves the extension's storage before the account opens
    clear();
    try {
      await engine.openWithKey(key, keep);
      // it came from visionswap.net, where the person can open and link it again: signing out here won't ask for a backup first
      engine.markBackedUp(key);
    } catch {
      /* the reason shows in the panel (engine error) */
    }
  };
  return (
    <div className="ext-linkcard" role="dialog" aria-label={`Open account ${tag}`}>
      <span className="ext-linkcard-ico">
        <Glyph name="link" />
      </span>
      <div className="ext-linkcard-body">
        <strong>Open account {tag}?</strong>
        <p className="small">
          visionswap.net sent this account to the extension{current ? `. Account ${current} locks first` : ""}.
        </p>
        <label className="check">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>
            Keep me signed in on this device
            <small className="check-hint">This browser keeps your key, sealed so it only opens here, and opens your account with one tap. Best on a device only you use.</small>
          </span>
        </label>
        <div className="ext-linkcard-btns">
          <button type="button" className="btn violet" disabled={!!st.busy || lockWaits(st)} onClick={() => void open()}>
            Open
          </button>
          <button type="button" className="btn ghost" onClick={clear}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
