import { useEffect, useState } from "react";
import { API } from "../lib/config";

export type Finding = { level: "high" | "med" | "low"; text: string };
export type ExposureReport = {
  address: string;
  balanceSol: number;
  solUsd: number | null;
  tokens: { mint: string; symbol: string | null; name: string | null; amount: number; usd: number | null }[];
  tokenCount: number;
  txCount: number;
  txCountCapped: boolean;
  firstSeen: number | null;
  lastSeen: number | null;
  funder: { address: string; amountSol: number; at: number | null; busy: boolean } | null;
  counterparties: { address: string; count: number }[];
  activeHoursUtc: number[];
  domain: string | null;
  score: number;
  findings: Finding[];
};

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const date = (t: number | null) =>
  t ? new Date(t * 1000).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "unknown";

export function ExposureBox({ initial = "", big = false }: { initial?: string; big?: boolean }) {
  const [addr, setAddr] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rep, setRep] = useState<ExposureReport | null>(null);

  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const a = addr.trim();
    if (!B58.test(a)) {
      setErr("That doesn't look like a Solana address.");
      return;
    }
    setErr(null);
    setBusy(true);
    setRep(null);
    try {
      // the address goes in the body, never in a URL the host logs (a server from before is asked the old way)
      let r = await fetch(`${API}/api/exposure`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: a }) });
      if (r.status === 404 || r.status === 405) r = await fetch(`${API}/api/exposure/${a}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Lookup failed");
      setRep(j);
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  };

  // arriving with ?a=<address> runs the check straight away
  useEffect(() => {
    if (initial && B58.test(initial.trim())) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const total = rep
    ? (rep.solUsd ? rep.balanceSol * rep.solUsd : 0) + rep.tokens.reduce((s, t) => s + (t.usd ?? 0), 0)
    : 0;
  const maxH = rep ? Math.max(1, ...rep.activeHoursUtc) : 1;
  const tzOff = -new Date().getTimezoneOffset() / 60;

  return (
    <div className={`xbox ${big ? "big" : ""}`}>
      <form onSubmit={run} className="xbox-form">
        <label htmlFor="xaddr" className="sr-only">
          Solana address
        </label>
        <input
          id="xaddr"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="Paste any Solana address"
          spellCheck={false}
          autoComplete="off"
          className="mono"
        />
        <button className="btn" disabled={busy || !addr.trim()}>
          {busy ? "Looking…" : "Look inside"}
        </button>
      </form>
      {err && <p className="xbox-err">{err}</p>}
      {!rep && !busy && !err && (
        <ul className="xbox-what">
          <li>What it holds, and roughly what that's worth</li>
          <li>Who paid it first, and whether that looks like an exchange</li>
          <li>The wallets it keeps dealing with</li>
          <li>The hours its owner is awake</li>
        </ul>
      )}
      {busy && (
        <div className="xbox-wait" aria-live="polite">
          <span />
          Reading the public record. Busy wallets can take up to half a minute.
        </div>
      )}
      {rep && (
        <div className="xbox-out" aria-live="polite">
          <div className="xbox-score">
            <div className="meter" style={{ ["--v" as string]: rep.score / 100 }}>
              <i />
            </div>
            <p>
              <strong>{rep.score >= 60 ? "Very exposed" : rep.score >= 30 ? "Exposed" : "Fairly quiet"}</strong>
              <span className="mono">
                {short(rep.address)}
                {rep.domain ? ` · ${rep.domain}` : ""}
              </span>
            </p>
          </div>
          <ul className="xbox-findings">
            {rep.findings.map((f, i) => (
              <li key={i} className={f.level}>
                {f.text}
              </li>
            ))}
          </ul>
          <dl className="xbox-facts">
            <div>
              <dt>Visible holdings</dt>
              <dd>
                {total ? usd(total) : `${rep.balanceSol.toFixed(3)} SOL`}
                {rep.tokenCount ? ` across ${rep.tokenCount + 1} assets` : ""}
              </dd>
            </div>
            <div>
              <dt>Transactions</dt>
              <dd>
                {rep.txCount.toLocaleString("en-US")}
                {rep.txCountCapped ? "+" : ""}
              </dd>
            </div>
            <div>
              <dt>First seen</dt>
              <dd>{rep.txCountCapped ? "too busy to trace" : date(rep.firstSeen)}</dd>
            </div>
            <div>
              <dt>First funded by</dt>
              <dd className="mono">
                {rep.funder ? `${short(rep.funder.address)}${rep.funder.busy ? " (exchange-like)" : ""}` : "—"}
              </dd>
            </div>
          </dl>
          {rep.tokens.length > 0 && (
            <div className="xbox-tokens">
              {rep.tokens.slice(0, 5).map((t) => (
                <span key={t.mint} className="chip">
                  {t.symbol ?? short(t.mint)}
                  {t.usd != null ? <em>{usd(t.usd)}</em> : null}
                </span>
              ))}
            </div>
          )}
          {rep.activeHoursUtc.some((h) => h > 0) && (
            <figure className="xbox-hours">
              <div className="bars">
                {rep.activeHoursUtc.map((_, i) => {
                  const utc = (((i - tzOff) % 24) + 24) % 24;
                  const v = rep.activeHoursUtc[Math.round(utc) % 24];
                  return <i key={i} style={{ height: `${Math.max(3, (v / maxH) * 100)}%` }} title={`${i}:00`} />;
                })}
              </div>
              <figcaption>
                <span>Activity by hour of day, your time. The gap is usually sleep.</span>
                <span className="mono">00 · 06 · 12 · 18 · 24</span>
              </figcaption>
            </figure>
          )}
          <p className="xbox-cta">
            <a className="btn violet" href="/app">
              Start fresh, privately
            </a>
          </p>
        </div>
      )}
    </div>
  );
}
