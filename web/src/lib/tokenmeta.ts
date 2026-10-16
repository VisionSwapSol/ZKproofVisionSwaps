import { useEffect, useState } from "react";
import { lookup } from "./net";
import { askGroups } from "./tokenfacts";
import type { Token } from "../components/app/TokenPicker";

/**
 * Names, icons and prices for the tokens someone holds. The token search takes a few addresses
 * per question, so a long list is asked for in small groups; each token is remembered for a few
 * minutes, so the holdings lists, Sell and Protect share one answer.
 */
const KEEP_MS = 5 * 60_000;
const known = new Map<string, { at: number; t: Token | null }>();
const asking = new Map<string, Promise<void>>();
/** Every screen showing token details hears about a new answer at the same moment (so none shows an older price). */
const heard = new Set<() => void>();

async function askFor(mints: string[]) {
  const q = mints.join(",");
  let p = asking.get(q);
  if (!p) {
    p = lookup<Token[]>("/api/tokens/search", { q })
      .then((list) => {
        const now = Date.now();
        // a token the search doesn't know is remembered as unknown too, so it isn't asked for again at once
        for (const m of mints) known.set(m, { at: now, t: list.find((t) => t.mint === m) ?? null });
        heard.forEach((f) => f());
      })
      .catch(() => {})
      .finally(() => asking.delete(q));
    asking.set(q, p);
  }
  return p;
}

/** The same snapshot as before (no re-render) when nothing new is known. */
const same = (a: Record<string, Token>, b: Record<string, Token>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]) ? a : b;
};

/**
 * Whether the token search has answered for every one of these mints on this page (with its details, or as a
 * token it doesn't know): until then a token missing from useTokenMeta may simply not have been asked about.
 */
export const tokensAnswered = (mints: string[]) => mints.every((m) => known.has(m));

function snapshot(mints: string[]): Record<string, Token> {
  const out: Record<string, Token> = {};
  for (const m of mints) {
    const t = known.get(m)?.t;
    if (t) out[m] = t;
  }
  return out;
}

/**
 * Token details by mint for the given mints (missing until known). With `fetch: false` it only reads
 * what another screen already asked for (it never sends the list of mints itself), so a part of the
 * page that shows on every visit can use what's known without asking about the tokens held.
 */
export function useTokenMeta(mints: string[], o: { fetch?: boolean } = {}): Record<string, Token> {
  const ask = o.fetch !== false;
  const key = [...new Set(mints)].sort().join(",");
  const [meta, setMeta] = useState<Record<string, Token>>(() => snapshot(key ? key.split(",") : []));
  // (an answer that names no token changes no details, but it does change tokensAnswered: shown at once too)
  const [, setHeard] = useState(0);
  useEffect(() => {
    if (!key) return;
    const all = key.split(",");
    setMeta(snapshot(all));
    // answers show here as soon as they come in, whichever screen asked (nothing is sent from here)
    const hear = () => {
      setMeta((m) => same(m, snapshot(all)));
      setHeard((n) => n + 1);
    };
    heard.add(hear);
    const stale = ask ? all.filter((m) => Date.now() - (known.get(m)?.at ?? 0) > KEEP_MS) : [];
    if (stale.length) void Promise.all(askGroups(stale).map(askFor));
    return () => void heard.delete(hear);
  }, [key, ask]);
  return meta;
}
