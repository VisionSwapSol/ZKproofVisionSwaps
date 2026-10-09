import { useEffect, useState } from "react";
import { API } from "../lib/config";

export type Stats = {
  network?: string;
  solUsd: number | null;
  shieldedSol: number | null;
  notes: number | null;
  exits24h: number | null;
};

const fmt = (n: number | null | undefined, d = 2) =>
  n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });

export function LiveStats({ onStats }: { onStats?: (s: Stats) => void }) {
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const r = await fetch(`${API}/api/stats`);
        if (r.ok && !dead) {
          const j = (await r.json()) as Stats;
          setS(j);
          onStats?.(j);
        }
      } catch {
        /* keep the dashes */
      }
    };
    load();
    // background tabs stay quiet
    const t = setInterval(() => !document.hidden && load(), 30_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="wrap">
      <dl className="stats rise">
        <div>
          <dt>SOL price (USD)</dt>
          <dd className="mono">${fmt(s?.solUsd)}</dd>
        </div>
        <div>
          <dt>Shielded SOL</dt>
          <dd className="mono">{fmt(s?.shieldedSol, 2)}</dd>
        </div>
        <div>
          <dt>Notes in the pool</dt>
          <dd className="mono">{fmt(s?.notes, 0)}</dd>
        </div>
        <div>
          <dt>Private exits, 24h</dt>
          <dd className="mono">{fmt(s?.exits24h, 0)}</dd>
        </div>
      </dl>
    </div>
  );
}
