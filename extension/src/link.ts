// The link from visionswap.net to the extension: the website sends an open account's private key
// once, on the person's click, and the extension offers to open it. Pure rules, shared by the
// background worker and the side panel, and tested on their own.
import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha2.js";

/** The one message the website sends: { type: "vs-link", key: "vsk1…" }. */
export const LINK_TYPE = "vs-link";
/** How long a link waits for the person to open it in the extension. */
export const LINK_TTL_MS = 2 * 60_000;
/** Where the background worker keeps the link meanwhile, in chrome.storage.session (memory only, extension pages only). */
export const PENDING_KEY = "pendingLink";
/** The website, the only sender the published extension listens to. */
export const SITE_ORIGIN = "https://visionswap.net";
/** The local copy of the website the development build also listens to. */
export const DEV_ORIGINS = ["http://localhost:5196", "http://127.0.0.1:5196"];

const PREFIX = "vsk1";
const enc = new TextEncoder();

/**
 * Whether `text` is a VisionSwap private key exactly as the website writes one: "vsk1" + base58 of
 * the 32-byte account secret and its 4-byte checksum. The same test as the sdk's decodePrivateKey
 * (the side panel runs that one too, when it opens the account), without loading the rest of the sdk
 * into the background worker.
 */
export function isAccountKey(text: unknown): text is string {
  if (typeof text !== "string" || text.length > 80 || !text.startsWith(PREFIX)) return false;
  let raw: Uint8Array;
  try {
    raw = bs58.decode(text.slice(PREFIX.length));
  } catch {
    return false;
  }
  if (raw.length !== 36) return false;
  const label = enc.encode("vs:key-check");
  const data = new Uint8Array(label.length + 32);
  data.set(label);
  data.set(raw.subarray(0, 32), label.length);
  const check = sha256(data);
  for (let i = 0; i < 4; i++) if (raw[32 + i] !== check[i]) return false;
  return true;
}

/**
 * The account key in a link message, or null for anything else: a sender that isn't one of
 * `origins`, any other shape (extra fields included), or a key that doesn't check out.
 */
export function linkKey(msg: unknown, origin: string | undefined, origins: readonly string[]): string | null {
  if (!origin || !origins.includes(origin)) return null;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const fields = Object.keys(msg).sort();
  if (fields.length !== 2 || fields[0] !== "key" || fields[1] !== "type") return null;
  const m = msg as { type: unknown; key: unknown };
  if (m.type !== LINK_TYPE || !isAccountKey(m.key)) return null;
  return m.key;
}

export type Pending = { key: string; at: number };

/** A link still waiting to be opened: well formed, and sent within the last two minutes. */
export function freshPending(p: unknown, now: number): p is Pending {
  if (!p || typeof p !== "object") return false;
  const { key, at } = p as { key?: unknown; at?: unknown };
  return typeof at === "number" && Number.isFinite(at) && at <= now + 5_000 && now - at < LINK_TTL_MS && isAccountKey(key);
}
