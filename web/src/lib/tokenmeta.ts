import { useEffect, useState } from "react";
import { api } from "./net";
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

async function ask(mints: string[]) {
  const q = mints.join(",");
  let p = asking.get(q);
  if (!p) {
    p = api<Token[]>(`/api/tokens/search?q=${encodeURIComponent(q)}`)
      .then((list) => {
        const now = Date.now();
        // a token the search doesn't know is remembered as unknown too, so it isn't asked for again at once
        for (const m of mints) known.set(m, { at: now, t: list.find((t) => t.mint === m) ?? null });
      })
      .catch(() => {})
      .finally(() => asking.delete(q));
    asking.set(q, p);
  }
  return p;
}

function snapshot(mints: string[]): Record<string, Token> {
  const out: Record<string, Token> = {};
  for (const m of mints) {
    const t = known.get(m)?.t;
    if (t) out[m] = t;
  }
  return out;
}

/** Token details by mint for the given mints (missing until known). */
export function useTokenMeta(mints: string[]): Record<string, Token> {
  const key = [...new Set(mints)].sort().join(",");
  const [meta, setMeta] = useState<Record<string, Token>>(() => snapshot(key ? key.split(",") : []));
  useEffect(() => {
    if (!key) return;
    const all = key.split(",");
    setMeta(snapshot(all));
    const stale = all.filter((m) => Date.now() - (known.get(m)?.at ?? 0) > KEEP_MS);
    if (!stale.length) return;
    let dead = false;
    void Promise.all(askGroups(stale).map(ask)).then(() => !dead && setMeta(snapshot(all)));
    return () => {
      dead = true;
    };
  }, [key]);
  return meta;
}
