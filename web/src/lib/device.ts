// What this browser keeps for a private account.
//
// "Keep me signed in" (private-key accounts only) saves the key sealed with AES-GCM under a key the
// browser itself made and keeps in IndexedDB, marked non-extractable: no script can read its bytes,
// so the saved data alone (a look in devtools, a copy of localStorage) shows nothing usable. This
// browser still opens the account with one tap, which is the point of the option, so it's meant for
// a device only the owner uses. Passkey accounts keep nothing: the passkey is the one-tap way back in.
import { idbGet, idbRead, idbSet, idbDel } from "./idb";

const WRAP = "vs:keywrap";

/** A private key sealed for this browser only. */
export type Sealed = { v: 1; iv: string; ct: string };

const b64 = (u: Uint8Array) => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function isSealed(v: unknown): v is Sealed {
  const s = v as Sealed | null;
  return !!s && typeof s === "object" && s.v === 1 && typeof s.iv === "string" && typeof s.ct === "string";
}

export async function sealWith(key: CryptoKey, text: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text)));
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

/** Throws when the seal was made by another key or was changed. */
export async function unsealWith(key: CryptoKey, s: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, key, unb64(s.ct));
  return new TextDecoder().decode(pt);
}

/**
 * This browser's sealing key, made on first use. Null when there is none (or storage is blocked, so
 * nothing is kept). Throws when storage couldn't be read just now, which is not the same as "none":
 * a passing hiccup must never make a saved sign-in look lost.
 */
export async function deviceKey(create: boolean): Promise<CryptoKey | null> {
  const have = await idbRead<CryptoKey>(WRAP);
  if (have) return have;
  if (!create) return null;
  // one maker at a time, so two saves at once can't each make (and seal with) a different key
  making ??= (async () => {
    const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await idbSet(WRAP, k);
    // read it back: a key that didn't stick must never seal anything, or the saved key would be lost
    return (await idbGet<CryptoKey>(WRAP)) ? k : null;
  })().finally(() => (making = null));
  return making;
}
let making: Promise<CryptoKey | null> | null = null;

export const dropDeviceKey = () => idbDel(WRAP);

/**
 * What "clear history" removes per account: activity, payment links, scheduled payments, orders,
 * buys in progress, payments from the wallet (walletpay), the saved list of Vision-wallet
 * holdings (vst), the names given to Vision wallets here (vname) and the last batch across Vision
 * wallets (batch). The holdings are read again from the chain on the next unlock.
 */
const HISTORY = ["act", "req", "jobs", "aside", "orders", "intent", "walletpay", "vst", "vname", "batch"];

/**
 * The storage keys holding an account's history on this device (fp = its fingerprint). These stay,
 * as plain numbers and flags with no addresses or amounts: the counters of used deposit addresses
 * and Vision wallets (dw, dq, vw: how far to look for funds), the indexes of deposit addresses that
 * held SOL (df: checked first on unlock, so SOL still waiting there shows straight away), the move
 * plan (dmove: keeps the random gap between moves), when addresses were last looked for (found),
 * the fee wallets already used (gas: so a self-send never reuses one), returned or refused deposits
 * waiting for the owner's choice (dh), and the "key was backed up" flag (bk).
 */
export function historyKeys(fp: string, keys: string[]): string[] {
  return keys.filter((k) => HISTORY.some((h) => k === `vs:${h}:${fp}` || k.startsWith(`vs:${h}:${fp}:`)));
}

/** The short tag that tells accounts apart ("Account 7F3A"), from the account fingerprint. */
export const accountTag = (fp: string) => fp.slice(0, 4).toUpperCase();

/**
 * Whether an open account holds anything yet: private notes, a deposit in the waiting room, or SOL or
 * tokens at a deposit address or in a Vision wallet. The "it's empty for now" hint goes once it does.
 */
export function holdsFunds(s: {
  notes: readonly unknown[];
  waiting: readonly unknown[];
  deposits: readonly { lamports: bigint; tokens: readonly unknown[] }[];
  vision: readonly { lamports: bigint; tokens: readonly unknown[] }[];
}): boolean {
  return s.notes.length > 0 || s.waiting.length > 0 || [...s.deposits, ...s.vision].some((a) => a.lamports > 0n || a.tokens.length > 0);
}
