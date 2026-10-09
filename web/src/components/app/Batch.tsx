import { useEffect, useState } from "react";
import { engine, fmt, type State } from "../../lib/engine";
import { formatUnits } from "../../lib/net";
import { ls } from "../../lib/idb";
import { batchCounts, batchFinished, batchSummary, batchTitle, itemName, nextWaiting, plainReason, resumeLine, type Batch, type BatchItem, type Pacing } from "../../lib/batch";
import { CopyLink } from "./Panels";

const PACING = "vs:pacing";

/** "One after another" or "Back to back", as picked last time on this device. */
export function usePacing(): [Pacing, (p: Pacing) => void] {
  const [p, set] = useState<Pacing>(() => (ls.get<string>(PACING, "spaced") === "fast" ? "fast" : "spaced"));
  return [
    p,
    (v) => {
      ls.set(PACING, v);
      set(v);
    },
  ];
}

/** A batch that hasn't ended: its wallets are spoken for until it does. */
export const batchLive = (b: Batch | null): b is Batch => !!b && !batchFinished(b);

/** The wallets an unfinished batch still has to do (waiting or running): nothing else starts in them meanwhile. */
export function batchWallets(b: Batch | null): number[] {
  if (!batchLive(b)) return [];
  return b.items.filter((x) => (x.status === "waiting" || x.status === "running") && x.index != null).map((x) => x.index!);
}

/** Whether the batch card shows on this tab (the Wallets tab always; Buy or Sell for the batch started there). */
export function batchOnTab(b: Batch | null, tab: string): boolean {
  if (!b) return false;
  return tab === "wallets" || (tab === "buy" && (b.kind === "buyNew" || b.kind === "buyFrom")) || (tab === "sell" && b.kind === "sell");
}

/** After starting a batch: its card into view when it's off screen, where the progress shows (the person just asked for it). */
export function toBatchCard() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".tab-panel:not([hidden]) .batch");
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top < 64 || r.top > window.innerHeight - 120) el.scrollIntoView({ behavior: "smooth", block: r.top < 64 ? "start" : "nearest" });
  });
}

/** How several wallets take their turns: one after another with random gaps, or back to back. With `vary`, the amounts too. */
export function PacingControl({
  pacing,
  setPacing,
  vary,
  setVary,
  trade,
}: {
  pacing: Pacing;
  setPacing: (p: Pacing) => void;
  vary?: boolean;
  setVary?: (v: boolean) => void;
  /** buys or sells: say which price each wallet trades at */
  trade?: boolean;
}) {
  return (
    <div className="when pacing">
      <span className="when-title">Timing</span>
      <div className="seg seg-2" role="radiogroup" aria-label="Timing">
        {(
          [
            ["spaced", "One after another"],
            ["fast", "Back to back"],
          ] as [Pacing, string][]
        ).map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={pacing === v} className={pacing === v ? "on" : ""} onClick={() => setPacing(v)}>
            {label}
          </button>
        ))}
      </div>
      <p className="tiny when-note">
        {pacing === "spaced"
          ? `A random 10 to 60 seconds between wallets. Harder to link your wallets together.${trade ? " Each wallet trades at the price of its turn, within your price room." : ""}`
          : `Fastest: a few seconds apart. Easier to see the wallets belong together.${trade ? " Every wallet keeps to the price shown." : ""}`}
      </p>
      {setVary && (
        <label className="check">
          <input type="checkbox" checked={!!vary} onChange={(e) => setVary(e.target.checked)} />
          <span>
            Vary each amount a little
            <span className="check-hint">Up to 3% more or less in each, so they don't look alike.</span>
          </span>
        </label>
      )}
    </div>
  );
}

/** "about 40 s", "about 1 min" */
const inAbout = (ms: number) => {
  const s = Math.max(1, Math.ceil(ms / 5000) * 5);
  return s < 60 ? `about ${s} s` : `about ${Math.round(s / 60)} min`;
};

/**
 * A batch's progress, one row per wallet whose status changes in place (nothing is added or taken
 * away while it runs): waiting, its turn coming, working, done with its link, or didn't go
 * through with the reason. "Stop the rest" while it runs; at the end, what happened and "Try
 * those again". After a reload or an unlock it waits for "Continue".
 */
export function BatchCard({ st }: { st: State }) {
  const b = st.batch;
  const [, tick] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const running = !!b && !b.paused && !batchFinished(b);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!b) return null;
  const c = batchCounts(b);
  const finished = batchFinished(b);
  const checking = b.paused && c.running > 0;
  const queued = st.spots.find((j) => j.spot === "batch" && !j.running);
  const working = st.busy?.spot === "batch";
  const next = nextWaiting(b);
  const net = st.pool?.network;
  // run in another tab of this browser: shown here, touched only there
  const away = st.batchAway && !finished;
  const mode = away ? "away" : b.paused && !finished ? "paused" : finished ? "end" : "run";

  const status = (x: BatchItem, k: number): React.ReactNode => {
    if (x.status === "running") {
      if (away) return <span className="muted">Working, in your other tab</span>;
      if (working && !b.paused) {
        return (
          <span className="vw-work">
            <span className="spinner small" aria-hidden="true" />
            <span>{st.busy!.step}</span>
          </span>
        );
      }
      return <span className="muted">Checking where it got to…</span>;
    }
    if (x.status === "waiting") {
      if (away) return <span className="muted">Waiting</span>;
      if (b.paused) return <span className="muted">{x.finish ? "Waiting to finish its buy" : "Waiting"}</span>;
      if (k !== next) return <span className="muted">Waiting</span>;
      if (queued) return <span className="vw-next">Next in line, after the action running now</span>;
      // (the wallet before it is still at work: its gap starts once that one ends)
      if (c.running > 0) return <span className="vw-next">Next in line</span>;
      const left = b.nextAt - Date.now();
      return <span className="vw-next">{left > 1500 ? `Next in ${inAbout(left)}` : "Starting…"}</span>;
    }
    if (x.status === "done") {
      const text =
        b.kind === "sell"
          ? "Sold"
          : b.kind === "move"
            ? "Moved back · joins your balance soon"
            : b.kind === "send"
              ? "Sent"
              : x.got && b.decimals != null
                ? `Bought ${formatUnits(BigInt(x.got), b.decimals, 4)} ${b.symbol ?? ""}`.trim()
                : "Bought";
      return (
        <span className="vw-ok">
          {text}
          {x.sig && net && (
            <>
              {" · "}
              <CopyLink sig={x.sig} network={net} />
            </>
          )}
        </span>
      );
    }
    if (x.status === "failed") {
      const why = x.error ?? "no reason given";
      return (
        <button type="button" className={`batch-why${open === k ? " open" : ""}`} aria-expanded={open === k} onClick={() => setOpen(open === k ? null : k)}>
          <span className="vw-bad">Didn't go through: {plainReason(why)}</span>
        </button>
      );
    }
    return <span className="muted">Stopped: it keeps what it holds</span>;
  };

  const amount = (x: BatchItem) =>
    b.kind === "sell" && b.decimals != null ? `${formatUnits(BigInt(x.amount), b.decimals, 4)} ${b.symbol ?? ""}` : `${b.all ? "about " : ""}${fmt(BigInt(x.amount), 4)} SOL`;

  return (
    <section className="batch" aria-label="Several wallets at once">
      <div className="batch-head">
        <strong>{b.paused && !finished ? resumeLine(b) : batchTitle(b)}</strong>
        <span className="muted small">{b.pacing === "spaced" ? "One after another" : "Back to back"}</span>
      </div>
      <ul className="batch-list">
        {b.items.map((x, k) => (
          <li key={k} className={`batch-row ${x.status}`}>
            <span className="batch-name">{itemName(x)}</span>
            <span className="batch-amt num">{amount(x)}</span>
            <span className="batch-st small">{status(x, k)}</span>
          </li>
        ))}
      </ul>
      {/* the three things the foot can say share one place, as tall as the tallest, so the card never changes height as it goes */}
      <div className="batch-foot">
        <div className="batch-say">
          <p className={`small${mode === "paused" ? "" : " ghost"}`} aria-hidden={mode !== "paused"}>
            {checking ? "Checking where it got to before anything else happens…" : "Nothing more happens until you continue. Wallets that haven't had their turn keep what they hold."}
          </p>
          <p className={`tiny${mode === "run" ? "" : " ghost"}`} aria-hidden={mode !== "run"}>
            Keep this page open while it runs. If you close it, wallets that haven't gone yet simply keep their SOL, and you can continue next time.
          </p>
          <p className={`small batch-sum${mode === "end" ? "" : " ghost"}`} aria-hidden={mode !== "end"}>
            {batchSummary(b)}
          </p>
          <p className={`small${mode === "away" ? "" : " ghost"}`} aria-hidden={mode !== "away"}>
            This runs in another tab of this browser. Its progress shows here; to stop it, use that tab.
          </p>
        </div>
        {mode === "away" ? (
          <div className="batch-acts" />
        ) : mode === "paused" ? (
          <div className="batch-acts">
            <button type="button" className="btn violet small-btn" disabled={!!st.update} onClick={() => engine.continueBatch()}>
              Continue
            </button>
            <button type="button" className="link-btn" onClick={() => engine.stopBatch()}>
              Stop
            </button>
          </div>
        ) : mode === "run" ? (
          <div className="batch-acts">
            <button type="button" className="link-btn" disabled={next < 0} onClick={() => engine.stopBatch()}>
              Stop the rest
            </button>
          </div>
        ) : (
          <div className="batch-acts">
            {c.failed + c.skipped > 0 && (
              <button type="button" className="btn ghost small-btn" disabled={!!st.update} onClick={() => engine.retryBatch()}>
                {c.failed ? "Try those again" : "Run the rest"}
              </button>
            )}
            <button type="button" className="link-btn" onClick={() => engine.dismissBatch()}>
              Done
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
