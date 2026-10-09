import { useEffect, useState } from "react";
import {
  confirmPasskey,
  createPasskey,
  canDropPasskeys,
  dropPasskey,
  labelPasskey,
  passkeyHome,
  passkeyLabel,
  passkeySignIn,
  passkeySupport,
  PasskeyError,
  type NewPasskey,
} from "../../lib/passkey";
import { accountTag } from "../../lib/device";
import { Icon } from "../Icon";
import { engine, lockWaits, type State } from "../../lib/engine";
import { copyText } from "./Panels";

function downloadKey(key: string) {
  const tag = engine.tagOf(key);
  const text = [
    "VisionSwap private key",
    "",
    key,
    "",
    ...(tag ? [`Account ${tag}`, ""] : []),
    "This key opens your VisionSwap private account: your private balance, Vision wallets and deposit addresses.",
    "Anyone who has it can spend your private balance. Keep it somewhere safe and private, like a password manager.",
    "Nobody can recover it for you if it is lost.",
    "",
    "To open your account: go to visionswap.net/app?start=key and paste this key.",
    'Or open visionswap.net/app and tap "Open it" under "Already have a VisionSwap account without a wallet?".',
    'With a wallet connected: "Rather not sign? Use a private key instead" > "I have a private key".',
    `Saved ${new Date().toISOString().slice(0, 10)}`,
  ].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  a.download = tag ? `visionswap-private-key-${tag}.txt` : "visionswap-private-key.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/**
 * The key with Copy and Download. Neither proves a backup exists (a download can silently do
 * nothing in some in-app browsers), so callers confirm with TailCheck before counting it as saved.
 */
function KeyBox({ value, onUsed }: { value: string; onUsed?: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="key-box">
      <code className="mono" translate="no">
        {value}
      </code>
      <div className="key-actions">
        <button
          type="button"
          className="btn ghost small-btn"
          onClick={async () => {
            const ok = await copyText(value);
            setCopied(ok);
            if (ok) onUsed?.();
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? "Copied" : "Copy key"}
        </button>
        <button
          type="button"
          className="btn ghost small-btn"
          onClick={() => {
            downloadKey(value);
            onUsed?.();
          }}
        >
          Download backup
        </button>
      </div>
    </div>
  );
}

/** Typing back the last four characters, to be sure the key was really saved. */
function TailCheck({ value, check, onChange }: { value: string; check: string; onChange: (v: string) => void }) {
  const ok = check.trim() === value.slice(-4);
  return (
    <label className="field">
      <span className="field-top">
        <span>Type the last 4 characters of your key</span>
        <span className={ok ? "good-text" : "muted"}>{ok ? "Matches" : "To confirm you saved it"}</span>
      </span>
      <input
        className="input mono key-tail"
        value={check}
        onChange={(e) => onChange(e.target.value)}
        maxLength={8}
        placeholder="••••"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
      />
    </label>
  );
}

/** "Keep me signed in", saying plainly what it does. Off unless the person turns it on. */
function KeepSignedIn({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>
        Keep me signed in on this device
        <small className="check-hint">This browser keeps your key, sealed so it only opens here, and opens your account with one tap. Best on a device only you use.</small>
      </span>
    </label>
  );
}

/** For someone who already has an account, so they don't make a second, empty one. */
function OpenInstead({ onOpen }: { onOpen?: () => void }) {
  if (!onOpen) return null;
  return (
    <p className="small center">
      Already have a passkey or a private key?{" "}
      <button type="button" className="link-btn" onClick={onOpen}>
        Open your account
      </button>
    </p>
  );
}

const open = (key: string, keep: boolean, setErr: (e: string | null) => void, via: "key" | "passkey" = "key") => {
  setErr(null);
  return engine.openWithKey(key, keep, via).catch((e: Error) => setErr(e.message));
};

/**
 * A brand-new private account: the key is made on this device and shown once. To be sure it was
 * really saved, its last four characters are typed back before the account opens.
 */
export function KeyCreate({
  st,
  onBack,
  onOpen,
  title = "Save your private key",
  step,
}: {
  st: State;
  onBack?: () => void;
  onOpen?: () => void;
  title?: string;
  step?: string;
}) {
  const [fresh] = useState(() => engine.newPrivateKey());
  const [check, setCheck] = useState("");
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = check.trim() === fresh.slice(-4);
  return (
    <div className="key-start">
      {step && <span className="eyebrow">{step}</span>}
      <h3>{title}</h3>
      <p>
        This key is your private account: your private balance, your Vision wallets and your QR deposit addresses. Save it now, somewhere safe
        and private (a password manager is ideal). It's the only way back in, and nobody, including us, can recover it.
      </p>
      <KeyBox value={fresh} />
      <p className="warn">Anyone who has this key can spend your private balance. Never share it, and never type it anywhere but VisionSwap.</p>
      <TailCheck value={fresh} check={check} onChange={setCheck} />
      <KeepSignedIn on={remember} set={setRemember} />
      {err && <p className="warn">{err}</p>}
      <button
        className="btn violet wide"
        disabled={!ok || !!st.busy}
        onClick={() => {
          engine.markBackedUp(fresh);
          void open(fresh, remember, setErr);
        }}
      >
        Open my private account
      </button>
      <OpenInstead onOpen={onOpen} />
      {onBack && (
        <button type="button" className="link-btn" onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}

/** Whether to offer passkeys: anything but a clear "no" from the browser. */
function usePasskeys(): boolean {
  // the first answer is immediate (so the screen never swaps under the person); the browser can only take it back
  const [ok, setOk] = useState(() => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials);
  useEffect(() => {
    void passkeySupport().then((v) => v === false && setOk(false));
  }, []);
  return ok;
}

/**
 * Step 1 of an account without a wallet: secure it with a passkey (Face ID, fingerprint, a phone or
 * security key: nothing to copy) or with a private key the person saves.
 *
 * A passkey account opens only after the new passkey has signed in once more (so a password manager
 * that can't reopen accounts is caught before any SOL arrives) and its backup key has been saved.
 */
export function NewAccount({ st, onBack, onOpen, step }: { st: State; onBack?: () => void; onOpen?: () => void; step?: string }) {
  const supported = usePasskeys();
  const can = supported && passkeyHome();
  const [how, setHow] = useState<"choose" | "key" | "passkey">("choose");
  const [pk, setPk] = useState<NewPasskey | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const [renamed, setRenamed] = useState<string | null>(null);
  const [check, setCheck] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const restart = () => {
    setPk(null);
    setMade(null);
    setRenamed(null);
    setCheck("");
    setErr(null);
  };
  // a passkey that never opened an account is of no use: ask the password manager to remove it
  const giveUp = (to: "choose" | "key") => {
    if (pk && !made) dropPasskey(pk);
    restart();
    setHow(to);
  };
  if (how === "key") return <KeyCreate st={st} onBack={() => setHow("choose")} step={step} />;
  // no passkeys in this browser: straight to the private key, still pointing returning people to their account
  if (!supported && how === "choose") return <KeyCreate st={st} onBack={onBack} onOpen={onOpen} step={step} />;
  if (how === "passkey" && pk && made) {
    const tag = engine.tagOf(made);
    const ok = check.trim() === made.slice(-4);
    return (
      <div className="key-start">
        {step && <span className="eyebrow">{step}</span>}
        <div className="pk-ok">
          <span className="pk-badge">
            <Icon name="check" />
          </span>
          <div>
            <h3>Your passkey works</h3>
            <p className="small">
              {pk.synced
                ? `It opens account ${tag} on every device your passkeys sync to.`
                : `It opens account ${tag} with this passkey only. Your backup key opens it anywhere else.`}{" "}
              It's saved as “{pk.label}”{renamed && renamed !== pk.label ? ` (your device may show it as “${renamed}”)` : ""}.
            </p>
          </div>
        </div>
        <p>
          <strong>Now save your backup key.</strong> If this passkey is ever deleted or lost, it's the only way back in. Keep it somewhere safe and
          private, like a password manager.
        </p>
        <KeyBox value={made} />
        <TailCheck value={made} check={check} onChange={setCheck} />
        {err && <p className="warn">{err}</p>}
        <button
          className="btn violet wide"
          disabled={!ok || !!st.busy}
          onClick={() => {
            engine.markBackedUp(made);
            void open(made, false, setErr, "passkey");
          }}
        >
          Open my private account
        </button>
      </div>
    );
  }
  if (how === "passkey" && pk) {
    return (
      <div className="key-start">
        {step && <span className="eyebrow">{step}</span>}
        <h3>Confirm your passkey</h3>
        <p className="small muted">One more tap checks that your passkey opens your account, so it's ready before you add any SOL.</p>
        {err && <p className="warn">{err}</p>}
        <button
          type="button"
          className="btn violet wide pk-btn"
          disabled={busy}
          onClick={async () => {
            setErr(null);
            setBusy(true);
            try {
              const key = await confirmPasskey(pk);
              const tag = engine.tagOf(key);
              // ask for the account's own tag as the passkey's name; providers may or may not take it
              setRenamed(tag && labelPasskey(pk.userId, tag) ? passkeyLabel(tag) : null);
              setMade(key);
            } catch (e) {
              setErr((e as PasskeyError).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="key" size={18} /> {busy ? "Waiting for your passkey…" : err ? "Try again" : "Confirm my passkey"}
        </button>
        {err && (
          <button type="button" className="btn ghost wide" onClick={() => giveUp("key")}>
            Use a private key instead
          </button>
        )}
        <button type="button" className="link-btn" onClick={() => giveUp("choose")}>
          Back
        </button>
        {!canDropPasskeys() && <p className="small muted center">Not keeping this passkey? You can delete “{pk.label}” in your device's passkey settings.</p>}
      </div>
    );
  }
  return (
    <div className="key-start">
      {step && <span className="eyebrow">{step}</span>}
      <h3>Secure your private account</h3>
      <p className="small muted">Your account's secret is made on this device. Choose how you'll open it again.</p>
      <div className="ways compact" role="list">
        {can && (
          <button
            type="button"
            role="listitem"
            className="way qr"
            disabled={busy}
            onClick={async () => {
              setErr(null);
              setBusy(true);
              try {
                setPk(await createPasskey());
                setHow("passkey");
              } catch (e) {
                const pe = e as PasskeyError;
                if (pe.kind !== "cancelled") setErr(pe.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <span className="way-ico">
              <Icon name="key" />
            </span>
            <span className="way-txt">
              <strong>{busy ? "Waiting for your passkey…" : "Use a passkey"}</strong>
              <span>Face ID, fingerprint, your phone or a security key. Opens with one tap.</span>
            </span>
            <span className="way-go" aria-hidden="true">
              →
            </span>
          </button>
        )}
        <button type="button" role="listitem" className="way" onClick={() => setHow("key")}>
          <span className="way-ico">
            <Icon name="doc" />
          </span>
          <span className="way-txt">
            <strong>Save a private key</strong>
            <span>A code you keep somewhere safe, like a password manager. Works in any browser.</span>
          </span>
          <span className="way-go" aria-hidden="true">
            →
          </span>
        </button>
      </div>
      {!can && (
        <p className="small muted">
          Passkeys are made on{" "}
          <a className="link-btn" href="https://visionswap.net/app?start=qr">
            visionswap.net
          </a>
          .
        </p>
      )}
      {err && <p className="warn">{err}</p>}
      <OpenInstead onOpen={onOpen} />
      {onBack && (
        <button type="button" className="link-btn" onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}

/** Opening an existing private account with its passkey or its key. */
export function KeyRestore({ st, onBack }: { st: State; onBack?: () => void }) {
  const [text, setText] = useState("");
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const can = usePasskeys();
  const [busy, setBusy] = useState(false);
  return (
    <div className="key-start">
      <h3>Open your private account</h3>
      {can && (
        <>
          <button
            type="button"
            className="btn violet wide pk-btn"
            disabled={busy || !!st.busy}
            onClick={async () => {
              setErr(null);
              setHint(false);
              setBusy(true);
              try {
                const { key, userId } = await passkeySignIn();
                await open(key, false, setErr, "passkey");
                const tag = engine.tagOf(key);
                if (engine.get().unlocked && tag) {
                  // older passkeys carry a date in their name: give them the account's tag instead
                  if (userId) labelPasskey(userId, tag);
                  void engine.noticeIfEmpty();
                }
              } catch (e) {
                const pe = e as PasskeyError;
                // some password managers close the prompt without an answer: never leave the person guessing
                if (pe.kind === "cancelled") setHint(true);
                else setErr(pe.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="key" size={18} /> {busy ? "Waiting for your passkey…" : "Sign in with a passkey"}
          </button>
          {hint && <p className="small muted">Nothing opened? Some password managers can't sign in to VisionSwap yet. Your backup key below always works.</p>}
          <div className="or" aria-hidden="true">
            <span>or use your private key</span>
          </div>
        </>
      )}
      <label className="field">
        <span className="field-top">
          <span>Private key</span>
        </span>
        <textarea
          className="key-input mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="vsk1…"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>
      <KeepSignedIn on={remember} set={setRemember} />
      {err && <p className="warn">{err}</p>}
      <button
        className="btn violet wide"
        disabled={!text.trim() || !!st.busy}
        onClick={async () => {
          await open(text, remember, setErr);
          // they pasted it, so they have it saved: signing out won't ask for a backup
          if (engine.get().unlocked) engine.markBackedUp(text);
        }}
      >
        Open my private account
      </button>
      {onBack && (
        <button type="button" className="link-btn" onClick={onBack}>
          Back
        </button>
      )}
    </div>
  );
}

/** An account whose key is kept on this device ("Keep me signed in"): one tap opens it. */
export function SavedKey({ st }: { st: State }) {
  const [err, setErr] = useState<string | null>(null);
  if (!engine.hasSavedKey() && !err) return null;
  return (
    <div className="saved-key">
      {engine.hasSavedKey() && (
        <>
          <p className="small">Your private account is saved on this device.</p>
          <button
            className="btn violet wide"
            disabled={!!st.busy}
            onClick={() => {
              setErr(null);
              engine.openSavedKey().catch((e: Error) => setErr(e.message));
            }}
          >
            Open my private account
          </button>
        </>
      )}
      {err && <p className="warn">{err}</p>}
    </div>
  );
}

/** The private-key choices tucked under "Rather not sign?" for a connected wallet. */
export function KeyStart({ st }: { st: State }) {
  const [view, setView] = useState<"menu" | "create" | "restore">("menu");
  if (view === "create") return <KeyCreate st={st} onBack={() => setView("menu")} />;
  if (view === "restore") return <KeyRestore st={st} onBack={() => setView("menu")} />;
  return (
    <div className="key-start">
      <SavedKey st={st} />
      <div className="key-choices">
        <button type="button" className="btn ghost" onClick={() => setView("create")}>
          Create a private account
        </button>
        <button type="button" className="btn ghost" onClick={() => setView("restore")}>
          I have a private key
        </button>
      </div>
    </div>
  );
}

/** The key of an account opened without a wallet: back it up, lock, or sign out of this device. */
export function KeyPanel({ st }: { st: State }) {
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [backed, setBacked] = useState<string | null>(null);
  const [saidSaved, setSaidSaved] = useState(false);
  // decided when the sign-out step opens, so saving the key there can't make the step change under the person
  const [askSave, setAskSave] = useState(false);
  // copied or downloaded: then the last 4 characters confirm the backup really exists
  const [used, setUsed] = useState(false);
  const [check, setCheck] = useState("");
  const reset = () => {
    setConfirm(false);
    setSaidSaved(false);
    setAskSave(false);
  };
  // another account opened here starts over
  useEffect(() => {
    reset();
    setUsed(false);
    setCheck("");
  }, [st.fingerprint]);
  if (st.account !== "key") return null;
  const key = engine.privateKey();
  const isBacked = backed === st.fingerprint || engine.backedUp();
  const passkey = engine.openedWithPasskey();
  // a key account's only way back in is its key: be sure it's saved before this device lets go of it
  const needSave = askSave && !saidSaved;
  const { running, buys } = engine.unfinishedWork();
  // the same rule as the Lock beside the balance: only an action the person started holds these back
  const acting = lockWaits(st);
  const waitHint = acting ? "You can lock once this finishes" : undefined;
  const close = (clear: boolean) => {
    reset();
    engine.closeKeyAccount(true, clear);
  };
  const tail = (v: string) => {
    setCheck(v);
    if (key && v.trim() === key.slice(-4)) {
      engine.markBackedUp(key);
      setBacked(st.fingerprint);
    }
  };
  return (
    <section className="panel">
      <header>
        <h3>Your private key</h3>
        <span className="muted">{st.fingerprint ? `Account ${accountTag(st.fingerprint)}` : "Opens this account anywhere"}</span>
      </header>
      {show && key ? (
        <>
          <KeyBox value={key} onUsed={() => setUsed(true)} />
          <p className="small warn">Anyone with this key can spend your private balance.</p>
          {used && (!isBacked || check) && <TailCheck value={key} check={check} onChange={tail} />}
        </>
      ) : passkey && !isBacked ? (
        <p className="small">Save a backup of this account's key too: if your passkey is ever lost, it's the only way back in.</p>
      ) : (
        <p className="small muted">Keep a copy somewhere safe. It's the only way back into this account on another device.</p>
      )}
      <div className="v-actions">
        <button
          type="button"
          className="link-btn"
          onClick={() => {
            setShow((v) => !v);
            setUsed(false);
            setCheck("");
          }}
        >
          {show ? "Hide key" : "Show key"}
        </button>
        <button type="button" className="link-btn" disabled={acting} title={waitHint} onClick={() => engine.closeKeyAccount(false)}>
          Lock
        </button>
        {!confirm && (
          <button
            type="button"
            className="link-btn"
            disabled={acting}
            title={waitHint}
            onClick={() => {
              setAskSave(!passkey && !isBacked);
              setConfirm(true);
            }}
          >
            Sign out of this device
          </button>
        )}
      </div>
      {confirm && (
        <div className="signout">
          <p className="small">
            <strong>Sign out of this device?</strong> You'll open this account again with your {passkey ? "passkey or backup key" : "private key"}.
          </p>
          {askSave && key && (
            <>
              <p className="small">
                <strong>Saved your key?</strong> You'll need it to open this account again.
              </p>
              {!show && <KeyBox value={key} />}
              <label className="check">
                <input type="checkbox" checked={saidSaved} onChange={(e) => setSaidSaved(e.target.checked)} />
                <span>Yes, I saved my key</span>
              </label>
            </>
          )}
          <p className="small muted">You can also clear its activity, payment links, scheduled payments, orders and saved balances from this device.</p>
          {running > 0 && (
            <p className="small">
              {running === 1 ? "1 payment or order is" : `${running} payments or orders are`} still running. Keep the history to follow or cancel
              {running === 1 ? " it" : " them"} here.
            </p>
          )}
          {buys > 0 && (
            <p className="small">
              {buys === 1 ? "1 buy is" : `${buys} buys are`} waiting to finish. Keep the history to finish {buys === 1 ? "it" : "them"} here.
            </p>
          )}
          <div className="signout-actions">
            <button type="button" className="btn ghost small-btn" disabled={acting || needSave} onClick={() => close(true)}>
              Sign out and clear history
            </button>
            <button type="button" className="btn ghost small-btn" disabled={acting || needSave} onClick={() => close(false)}>
              Sign out, keep history
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={reset}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
