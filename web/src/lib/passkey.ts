// Passkey sign-in (Face ID, fingerprint, Windows Hello, a security key) for accounts without a wallet.
//
// The passkey's PRF extension turns a fixed, public salt into 32 secret bytes that only that
// passkey can produce, the same on every device it syncs to. Those bytes (through HKDF) ARE the
// account's master secret: nothing is sent to us and the key is never kept in the browser; each
// visit, the passkey makes it again. The same passkey always opens the same account; a different
// passkey opens a different one.
//
// Everything that shapes the secret is pinned for good: the relying-party id, the salt and the
// HKDF strings. Changing any of them would open different accounts.
import { encodePrivateKey } from "@visionswap/sdk";

const enc = new TextEncoder();
const SALT_LABEL = "VisionSwap passkey PRF salt v1";
const HKDF_SALT = "VisionSwap";
const HKDF_INFO = "VisionSwap passkey master v1";

/** The one site passkey accounts belong to. */
const HOME = "visionswap.net";

/**
 * The relying party: exactly visionswap.net, the host the app is served from (www is the same
 * site), or the host itself on a local copy.
 *
 * Why it matters: PRF output depends only on the passkey and the salt, not on the page asking, and
 * any page on a *.visionswap.net host may ask for the visionswap.net passkeys. So no other host
 * under visionswap.net may ever serve someone else's pages or scripts (no subdomain pointed at
 * outside hosting, no leftover DNS records). Other addresses of the same server (the hosting
 * provider's own URL) would get passkeys of their own that open nothing on visionswap.net, so new
 * passkeys are only made on visionswap.net (see passkeyHome).
 */
export function rpId(): string {
  const h = location.hostname;
  return h === HOME || h === `www.${HOME}` ? HOME : h;
}

/** Whether new passkey accounts are made here: on visionswap.net, or on a local copy for testing. */
export function passkeyHome(): boolean {
  const h = location.hostname;
  return (
    !import.meta.env.PROD ||
    h === HOME ||
    h === `www.${HOME}` ||
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "[::1]" ||
    h.endsWith(".localhost")
  );
}

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(n)));
const b64url = (u: Uint8Array) => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const copy = (b: BufferSource): Uint8Array<ArrayBuffer> => {
  // copy exactly the bytes given (a view may sit inside a bigger buffer)
  const src = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
};
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The name a passkey shows in the device's passkey list, with a short tag to tell accounts apart. */
export const passkeyLabel = (tag: string) => `VisionSwap private account ${tag}`;

/**
 * Whether the passkey provider backs this passkey up, so it follows the person to their other
 * devices: the BS flag (0x10) of the authenticator data's flags byte.
 */
export function backedUp(authData: Uint8Array | null): boolean {
  return !!authData && authData.length > 32 && (authData[32] & 0x10) !== 0;
}

/** Whether this browser can (probably) make passkeys with PRF: true, false, or null when it won't say. */
export async function passkeySupport(): Promise<boolean | null> {
  if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) return false;
  const pkc = window.PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
  try {
    const caps = await pkc.getClientCapabilities?.();
    if (caps && "extension:prf" in caps) return !!caps["extension:prf"];
  } catch {
    /* not able to say */
  }
  return null;
}

export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly kind: "cancelled" | "no-prf" | "unsupported" | "failed",
  ) {
    super(message);
  }
}

const NO_PRF =
  "This passkey can't make an account key. Some password managers (and older Windows) don't support it yet. Try your phone or your device's own passkeys, or use a private key instead.";

/** What the check after creating says when the new passkey couldn't open the account again. */
export const CANT_REOPEN =
  "Your passkey didn't open the account. If you closed the prompt, try again. If it keeps happening, this password manager can't sign in to VisionSwap yet, so use a private key instead.";

function prfFirst(cred: PublicKeyCredential | null): Uint8Array<ArrayBuffer> | null {
  const ext = cred?.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: BufferSource } } } | undefined;
  const first = ext?.prf?.results?.first;
  return first ? copy(first) : null;
}

function why(e: unknown): PasskeyError {
  const err = e as DOMException;
  if (err?.name === "NotAllowedError" || err?.name === "AbortError") return new PasskeyError("Cancelled.", "cancelled");
  if (err?.name === "NotSupportedError") return new PasskeyError("This browser can't use passkeys here.", "unsupported");
  if (err instanceof PasskeyError) return err;
  return new PasskeyError(err?.message || "The passkey didn't work.", "failed");
}

/** 32 bytes from the passkey's PRF output, through HKDF-SHA256. */
async function masterFrom(prf: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(prf), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(HKDF_SALT), info: enc.encode(HKDF_INFO) }, key, 256);
  return new Uint8Array(bits);
}

/** A passkey just made, waiting for its check (confirmPasskey) before it opens anything. */
export type NewPasskey = {
  id: Uint8Array<ArrayBuffer>;
  transports: AuthenticatorTransport[];
  userId: Uint8Array<ArrayBuffer>;
  /** the name it was saved under */
  label: string;
  /** PRF output given at creation, when the authenticator gives it then */
  prf: Uint8Array | null;
  /** backed up by the passkey provider, so it's on the person's other devices too */
  synced: boolean;
};

type Got = { prf: Uint8Array; id: Uint8Array; userId: Uint8Array | null };

/**
 * Asks a passkey for its PRF output: exactly `only` when given, otherwise any passkey of this site
 * (the browser lets the person pick).
 */
async function evaluate(salt: Uint8Array, only?: NewPasskey): Promise<Got> {
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(32),
        rpId: rpId(),
        userVerification: "required",
        timeout: 120_000,
        ...(only && { allowCredentials: [{ type: "public-key", id: only.id, transports: only.transports }] }),
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw why(e);
  }
  const out = prfFirst(cred);
  if (!cred || !out) throw new PasskeyError(NO_PRF, "no-prf");
  const handle = (cred.response as AuthenticatorAssertionResponse).userHandle;
  return { prf: out, id: copy(cred.rawId), userId: handle ? copy(handle) : null };
}

type Signals = {
  signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void>;
  signalCurrentUserDetails?: (o: { rpId: string; userId: string; name: string; displayName: string }) => Promise<void>;
};
const signals = () => (typeof window !== "undefined" ? (window.PublicKeyCredential as unknown as Signals | undefined) : undefined);

/** Whether this browser can ask the passkey provider to remove a passkey by itself. */
export const canDropPasskeys = () => !!signals()?.signalUnknownCredential;

/**
 * Asks the passkey provider to remove a passkey that can't open anything. Returns false when the
 * browser can't, so the person is asked to delete it themselves.
 */
export function dropPasskey(made: NewPasskey): boolean {
  const s = signals();
  if (!s?.signalUnknownCredential) return false;
  s.signalUnknownCredential({ rpId: rpId(), credentialId: b64url(made.id) }).catch(() => {});
  return true;
}

/** Renames a passkey to show its account's tag. Returns false when the browser can't. */
export function labelPasskey(userId: Uint8Array, tag: string): boolean {
  const s = signals();
  if (!s?.signalCurrentUserDetails) return false;
  const name = passkeyLabel(tag);
  s.signalCurrentUserDetails({ rpId: rpId(), userId: b64url(userId), name, displayName: name }).catch(() => {});
  return true;
}

const deleteHint = (made: NewPasskey) => ` You can delete the passkey “${made.label}” in your device's passkey settings.`;

/** Step 1 of a passkey account: makes the passkey. Nothing is opened until confirmPasskey has checked it. */
export async function createPasskey(): Promise<NewPasskey> {
  if (!passkeyHome()) throw new PasskeyError(`Passkeys are made on ${HOME}.`, "unsupported");
  const salt = await sha256(SALT_LABEL);
  const userId = randomBytes(16);
  // a short random tag, so two passkeys never look the same (it becomes the account's own tag once it's known)
  const label = passkeyLabel(
    Array.from(userId.subarray(0, 2), (x) => x.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase(),
  );
  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId(), name: "VisionSwap" },
        user: { id: userId, name: label, displayName: label },
        challenge: randomBytes(32),
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
        timeout: 120_000,
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (e) {
    throw why(e);
  }
  if (!cred) throw new PasskeyError("The passkey didn't work.", "failed");
  const res = cred.response as AuthenticatorAttestationResponse;
  const made: NewPasskey = {
    id: copy(cred.rawId),
    transports: (res.getTransports?.() ?? []) as AuthenticatorTransport[],
    userId,
    label,
    prf: prfFirst(cred),
    synced: backedUp(res.getAuthenticatorData ? new Uint8Array(res.getAuthenticatorData()) : null),
  };
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean } };
  if (ext.prf?.enabled === false) throw new PasskeyError(NO_PRF + (dropPasskey(made) ? "" : deleteHint(made)), "no-prf");
  return made;
}

/**
 * Step 2, on a fresh tap: asks exactly the new passkey again and checks it gives the same secret
 * as at creation. Only a passkey that has proven it can sign in again opens an account, so no one
 * adds SOL to an account their password manager can't reopen. Returns the account's private key.
 */
export async function confirmPasskey(made: NewPasskey): Promise<string> {
  const salt = await sha256(SALT_LABEL);
  let got: Got;
  try {
    got = await evaluate(salt, made);
  } catch (e) {
    // a cancel looks the same as a password manager that can't answer: say so either way, never stay silent
    const pe = why(e);
    throw new PasskeyError(pe.kind === "no-prf" ? NO_PRF : CANT_REOPEN, pe.kind);
  }
  if (!sameBytes(got.id, made.id) || (made.prf && !sameBytes(got.prf, made.prf))) throw new PasskeyError(CANT_REOPEN, "failed");
  return encodePrivateKey(await masterFrom(got.prf));
}

/** Signs in with an existing passkey: the private key (vsk1…) of its account, and the passkey's user id. */
export async function passkeySignIn(): Promise<{ key: string; userId: Uint8Array | null }> {
  const salt = await sha256(SALT_LABEL);
  const got = await evaluate(salt);
  return { key: encodePrivateKey(await masterFrom(got.prf)), userId: got.userId };
}
