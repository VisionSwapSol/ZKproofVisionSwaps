import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { engine, fmt, fmtUp, WHEN_LABEL, type State, type VisionView, type When } from "../../lib/engine";
import { formatUnits, parseSol, short } from "../../lib/net";
import { buyFromVision, sellFromVision } from "../../lib/buyfrom";
import { useTokenMeta } from "../../lib/tokenmeta";
import { FUND_MAX, FUND_MIN, STATUS_CHIP, fundAmounts, walletName, walletStatus } from "../../lib/vwallets";
import type { Token } from "./TokenPicker";
import { TokenIcon } from "./TokenPicker";
import { ConfirmButton, Copy, CopyLink, looksLikeAddress } from "./Panels";
import { AmountField, Rows } from "./Forms";
import { BatchCard, PacingControl, batchLive, usePacing } from "./Batch";
import { BATCH_MAX, plainReason, type BatchItem } from "../../lib/batch";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const usd = (n: number) => `≈ $${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: n < 100 ? 2 : 0 })}`;
const clock = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-US", today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};
const solUsd = (st: State, lamports: bigint) => (st.solUsd != null ? (Number(lamports) / 1e9) * st.solUsd : null);

/** A link to the Wallets tab: one already open scrolls its card into view instead. */
export function goWallets(e?: { preventDefault: () => void }) {
  if (location.hash !== "#wallets") return;
  e?.preventDefault();
  document.querySelector(".main-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

type Panel = "send" | "key" | "rename" | "more" | null;
type Arriving = { amount: bigint; by: number };

/**
 * The Wallets tab: every Vision wallet in a fixed order by number, each with its own actions and a
 * status line that fills in place, so nothing on the page moves while one of them works. Actions
 * run in the background, one at a time; a second one waits its turn ("Next in line"). A wallet
 * emptied during this visit stays where it was, as a short "done" row, until hidden.
 */
export function WalletsTab({ st }: { st: State }) {
  const meta = useTokenMeta(st.vision.flatMap((v) => v.tokens.map((t) => t.mint)));
  const sweepMin = engine.sweepMin();
  // SOL on its way to a wallet, by wallet
  const arriving = new Map<number, Arriving>();
  for (const a of engine.visionArriving()) {
    const had = arriving.get(a.index);
    arriving.set(a.index, { amount: (had?.amount ?? 0n) + a.amount, by: Math.max(had?.by ?? 0, a.by) });
  }
  // every wallet shown this visit keeps its place (a new account starts over)
  const seen = useRef<{ fp: string | null; rows: Set<number> }>({ fp: null, rows: new Set() });
  if (seen.current.fp !== st.fingerprint) seen.current = { fp: st.fingerprint, rows: new Set() };
  for (const v of st.vision) seen.current.rows.add(v.index);
  for (const i of arriving.keys()) seen.current.rows.add(i);
  const [hidden, setHidden] = useState<number[]>([]);
  const order = [...seen.current.rows].filter((i) => !hidden.includes(i)).sort((a, b) => a - b);
  const emptied = engine.emptiedVision().filter((i) => !order.includes(i));
  const [names, setNames] = useState<Record<number, string>>(() => engine.visionNames());
  const [fund, setFund] = useState(false);
  // the height of the bar a batch was started from: its card keeps at least that room
  const [cardMin, setCardMin] = useState(0);
  const [open, setOpen] = useState<Record<number, Panel>>({});

  const live = st.vision.filter((v) => v.lamports > 0n || v.tokens.length > 0);
  const total = live.reduce((s, v) => s + v.lamports, 0n);
  const totalUsd = solUsd(st, total);
  const coming = [...arriving.keys()].filter((i) => !st.vision.some((v) => v.index === i)).length;
  // ticks show once two or more wallets can act together
  const actable = live.filter((v) => v.lamports > 0n).map((v) => v.index);
  const selectable = actable.length >= 2;
  const [selRaw, setSel] = useState<number[]>([]);
  const sel = selectable ? selRaw.filter((i) => actable.includes(i)) : [];
  const toggle = (i: number) => setSel(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i]);
  // the wallets an unfinished batch still has to do: their rows say so, and wait with it
  const inBatch = new Map<number, BatchItem>();
  if (batchLive(st.batch)) for (const x of st.batch.items) if (x.index != null && (x.status === "waiting" || x.status === "running")) inBatch.set(x.index, x);

  return (
    <div className="wallets">
      <div className="vw-head">
        <div className="vw-head-text">
          <h3>Vision wallets</h3>
          <p className="muted small">
            {live.length
              ? `${live.length} wallet${live.length === 1 ? "" : "s"} · ${fmt(total)} SOL${totalUsd != null && total > 0n ? ` ${usd(totalUsd)}` : ""}`
              : "None yet"}
            {coming ? ` · ${coming} arriving` : ""}
          </p>
        </div>
        <button type="button" className="btn ghost small-btn" aria-expanded={fund} onClick={() => setFund(!fund)}>
          {fund ? "Close" : "+ Fund new wallets"}
        </button>
      </div>
      <p className="tiny vw-intro">
        Wallets only you control, funded privately from the pool. Buy with them, move the SOL back to your private balance, or send it anywhere.
      </p>
      {fund && <FundWallets st={st} onClose={() => setFund(false)} />}
      {!order.length && !fund && (
        <div className="empty-state">
          <p>No Vision wallets yet.</p>
          <p className="muted">Fund a few with + Fund new wallets above, or make a private buy: each one opens a new wallet.</p>
        </div>
      )}
      {/* its room is always kept once wallets are listed (ticks work from two wallets on), so the list never moves when that changes */}
      {order.length > 0 && (
        <label className={`check vw-all${selectable ? "" : " off"}`} aria-hidden={!selectable}>
          <input
            type="checkbox"
            disabled={!selectable}
            checked={selectable && sel.length === actable.length}
            onChange={(e) => setSel(e.target.checked ? actable : [])}
          />
          <span>Select all</span>
        </label>
      )}
      <ul className="vw-list">
        {order.map((i) => (
          <WalletRow
            key={i}
            st={st}
            index={i}
            v={st.vision.find((x) => x.index === i && (x.lamports > 0n || x.tokens.length > 0)) ?? null}
            arriving={arriving.get(i) ?? null}
            meta={meta}
            sweepMin={sweepMin}
            name={names[i] ?? ""}
            onRename={(n) => {
              engine.nameVision(i, n);
              setNames(engine.visionNames());
            }}
            panel={open[i] ?? null}
            setPanel={(p) => setOpen((o) => ({ ...o, [i]: p }))}
            hold={Object.entries(open).some(([k, p]) => !!p && Number(k) !== i)}
            selectable={selectable && actable.includes(i)}
            selected={sel.includes(i)}
            onSelect={() => toggle(i)}
            onHide={() => setHidden((h) => [...h, i])}
            batchItem={inBatch.get(i) ?? null}
          />
        ))}
      </ul>
      {/* below the list, so starting or ending a batch never pushes the wallets down */}
      <div className="vw-batch" style={cardMin && st.batch ? { minHeight: cardMin } : undefined}>
        <BatchCard st={st} />
      </div>
      {sel.length > 0 && <BulkBar st={st} sel={sel} onClear={() => setSel([])} onStart={setCardMin} />}
      {emptied.length > 0 && (
        <details className="vw-emptied">
          <summary>Emptied wallets ({emptied.length})</summary>
          <ul>
            {emptied.map((i) => (
              <li key={i}>
                <span className="vw-name">{walletName(i)}</span>
                {names[i] && <span className="muted small">{names[i]}</span>}
                <span className="mono muted">{short(engine.visionAddress(i), 4)}</span>
                <Copy text={engine.visionAddress(i)} />
                <span className="muted small vw-empty-tag">Empty</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <FindMore busy={!!st.busy} />
    </div>
  );
}

/** What a wallet row's status line says while idle. */
function idleLine(st: State, s: ReturnType<typeof walletStatus>, v: VisionView | null, arriving: Arriving | null): string {
  const coming = arriving ? `${fmt(arriving.amount)} SOL arriving by ${clock(arriving.by)}` : "";
  if (s === "arriving") return `${fmt(arriving!.amount)} SOL by ${clock(arriving!.by)}. Ready to use once it lands.`;
  if (s === "finish") return "Its swap didn't finish. The SOL is still here: finish the buy, or move it back.";
  if (s === "small" && v) {
    return st.rent && v.lamports <= st.rent.pending + 200_000n && v.lamports + 200_000n >= st.rent.pending
      ? "The waiting-room rent of a deposit came back here. It's too little to move into the pool again; send it to an address instead."
      : "Less than the smallest deposit, so it can't move into the pool on its own. Send it to an address instead.";
  }
  return coming ? `+ ${coming}` : "";
}

function WalletRow({
  st,
  index,
  v,
  arriving,
  meta,
  sweepMin,
  name,
  onRename,
  panel,
  setPanel,
  hold,
  selectable,
  selected,
  onSelect,
  onHide,
  batchItem,
}: {
  st: State;
  index: number;
  v: VisionView | null;
  arriving: Arriving | null;
  meta: Record<string, Token>;
  sweepMin: bigint | null;
  name: string;
  onRename: (n: string) => void;
  panel: Panel;
  setPanel: (p: Panel) => void;
  /** another row has a form open: this one keeps its height meanwhile */
  hold: boolean;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
  onHide: () => void;
  batchItem: BatchItem | null;
}) {
  const spot = `v${index}`;
  const n = index + 1;
  // while the person is at work on another row (its form open), this row never gets shorter by itself (its
  // form closing as its action starts, a result, a wallet emptied, fewer buttons), so the rows below, maybe the
  // one being typed into, never move up; otherwise it simply takes its own height, leaving no empty space
  const me = useRef<HTMLLIElement | null>(null);
  const tallest = useRef(0);
  useLayoutEffect(() => {
    const h = me.current?.offsetHeight ?? 0;
    tallest.current = hold ? Math.max(tallest.current, h) : h;
  });
  const open = (p: Panel) => {
    tallest.current = 0;
    setPanel(p);
  };
  const [to, setTo] = useState("");
  const [toDone, setToDone] = useState(false);
  const [rename, setRename] = useState(name);
  const address = engine.visionAddress(index);
  const job = st.spots.find((j) => j.spot === spot);
  const running = !!job?.running && st.busy?.spot === spot;
  const said = st.said[spot];
  const it = v ? engine.finishable(v) : null;
  const status = walletStatus({ lamports: v?.lamports ?? 0n, tokens: v?.tokens.length ?? 0, finishable: !!it, arriving: !!arriving, sweepMin });
  // (an emptied wallet stays a live row while its own action is still at work)
  const done = status === "empty" && !job && !batchItem;
  const lamports = v?.lamports ?? 0n;
  const usdNow = solUsd(st, lamports);
  const held = v?.tokens.filter((t) => t.mint !== SOL_MINT) ?? [];
  // its own action is running or waiting its turn (alone, or in a batch): the row's buttons wait with it
  const waits = !!job || !!batchItem;
  const batchNow = !!batchItem && batchItem.status === "running" && st.busy?.spot === "batch";
  const [chip, tone] = running || batchNow ? ["Working", "wait"] : job ? ["Next in line", "wait"] : batchItem ? ["In the batch", "wait"] : STATUS_CHIP[status];
  const canBuy = !!v && engine.buyable(v);
  const canMove = !!v && (v.tokens.length > 0 || sweepMin == null || v.lamports >= sweepMin);
  const canSend = !!v && !v.tokens.length && v.lamports > 0n;
  const go = (step: string, run: () => Promise<unknown>) => {
    setPanel(null);
    engine.queueSpot(spot, step, run);
  };
  const badTo = !!to && (to.length >= 32 || toDone) && !looksLikeAddress(to);

  let line: React.ReactNode;
  if (batchNow) {
    line = (
      <span className="vw-work">
        <span className="spinner small" aria-hidden="true" />
        <span>{st.busy!.step}</span>
      </span>
    );
  } else if (batchItem) {
    line = <span className="muted">{st.batch?.paused ? "Part of a batch waiting for you to continue (see below)." : "Part of the batch below: it waits its turn."}</span>;
  } else if (running) {
    line = (
      <span className="vw-work">
        <span className="spinner small" aria-hidden="true" />
        <span>{st.busy!.step}</span>
      </span>
    );
  } else if (job) {
    line = (
      <span>
        <span className="muted">It starts as soon as the current one ends.</span>{" "}
        <button type="button" className="link-btn" onClick={() => engine.cancelSpot(job.id)}>
          Cancel
        </button>
      </span>
    );
  } else if (said) {
    line = (
      <span className={said.ok ? "vw-ok" : "vw-bad"}>
        {/* (the row already names its wallet) */}
        {said.ok ? said.text.replace(/ from Vision wallet #\d+/, "") : `Didn't go through: ${plainReason(said.text)}`}
        {said.sig && st.pool && (
          <>
            {" "}
            <CopyLink sig={said.sig} network={st.pool.network} />
          </>
        )}
      </span>
    );
  } else line = <span className="muted">{idleLine(st, status, v, arriving)}</span>;

  return (
    <li
      ref={me}
      className={`vw${done ? " done" : ""}${selected ? " picked" : ""}`}
      data-live={done ? "0" : "1"}
      style={hold && tallest.current ? { minHeight: tallest.current } : undefined}
    >
      {selectable && !done ? (
        <label className="vw-hit">
          <input type="checkbox" className="vw-check" checked={selected} onChange={onSelect} aria-label={`Select ${walletName(index)}`} />
        </label>
      ) : (
        <span className="vw-check" aria-hidden="true" />
      )}
      <div className="vw-id">
        <span className="vw-name">
          {walletName(index)}
          {name && <span className="vw-label"> · {name}</span>}
        </span>
        <span className="vw-addr">
          <span className="mono muted">{short(address, 4)}</span> <Copy text={address} />
        </span>
      </div>
      <div className="vw-bal">
        <strong className="num">{fmt(lamports)} SOL</strong>
        {usdNow != null && lamports > 0n && <span className="muted small">{usd(usdNow)}</span>}
      </div>
      {held.length > 0 && (
        <div className="vw-tags">
          {held.map((t) => {
            const m = meta[t.mint];
            const value = m?.price != null ? (Number(t.amount) / 10 ** t.decimals) * m.price : null;
            return (
              <span key={t.mint} className="chip">
                <TokenIcon t={m ?? { icon: null, symbol: "?" }} size={18} />
                {m ? (
                  <>
                    <strong>{m.symbol}</strong> {formatUnits(t.amount, t.decimals, 4)}
                    {value != null && <span className="muted"> · {usd(value)}</span>}
                  </>
                ) : (
                  <>
                    Unknown token <span className="mono">{short(t.mint, 4)}</span> · {formatUnits(t.amount, t.decimals, 4)}
                  </>
                )}
              </span>
            );
          })}
        </div>
      )}
      <p className="vw-line small" aria-live="polite">
        <span className={`job-chip ${tone}`}>{chip}</span> {line}
      </p>
      {done ? (
        <div className="vw-acts">
          <button type="button" className="link-btn" onClick={onHide}>
            Hide
          </button>
        </div>
      ) : (
        <div className="vw-acts">
          {status === "finish" && it ? (
            <button
              type="button"
              className="btn small-btn"
              disabled={waits}
              onClick={() => go(`Finishing the buy in ${walletName(index)}`, () => engine.finishBuy(index))}
            >
              Finish the buy
            </button>
          ) : held.length > 0 && !canBuy ? (
            <button type="button" className="btn small-btn" onClick={() => sellFromVision(index, held[0].mint)}>
              Sell
            </button>
          ) : (
            (canBuy || !v) && (
              <button type="button" className="btn small-btn" disabled={!canBuy || waits} onClick={() => buyFromVision([index])}>
                Buy a token
              </button>
            )
          )}
          {status === "finish" && it?.why === "price" && (
            <button
              type="button"
              className="link-btn"
              disabled={waits}
              onClick={() => go(`Finishing the buy in ${walletName(index)}`, () => engine.finishBuy(index, true))}
            >
              With {engine.finishSlippage(it) / 100}% room
            </button>
          )}
          {(canMove || !v) && (
            <button
              type="button"
              className="link-btn"
              disabled={!v || waits}
              onClick={() => go("Moving back to your private balance", () => engine.sweep(index))}
            >
              Move back to private balance
            </button>
          )}
          {(canSend || !v) && (
            <button
              type="button"
              className="link-btn"
              aria-expanded={panel === "send"}
              disabled={!v || waits}
              onClick={() => open(panel === "send" ? null : "send")}
            >
              Send to an address
            </button>
          )}
          <button
            type="button"
            className="link-btn"
            aria-expanded={panel === "more" || panel === "key" || panel === "rename"}
            onClick={() => open(panel ? null : "more")}
          >
            {panel && panel !== "send" ? "Close" : "More"}
          </button>
        </div>
      )}
      {!done && panel === "more" && (
        <div className="vw-panel vw-more">
          <button type="button" className="link-btn" onClick={() => open("key")}>
            Show private key
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setRename(name);
              open("rename");
            }}
          >
            {name ? "Rename" : "Add a name"}
          </button>
        </div>
      )}
      {!done && panel === "key" && (
        <div className="vw-panel secret">
          <p className="warn">
            Anyone with this key controls {walletName(index)}. Import it into another Solana wallet app only if you want to use the wallet there.
          </p>
          <code className="mono">{engine.exportVision(index)}</code>
          <span>
            <Copy text={engine.exportVision(index)} label="Copy key" />
          </span>
        </div>
      )}
      {!done && panel === "rename" && (
        <form
          className="vw-panel vw-rename"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(rename);
            open(null);
          }}
        >
          <input
            className="text-in"
            value={rename}
            maxLength={32}
            onChange={(e) => setRename(e.target.value)}
            placeholder="A name only you see"
            aria-label={`Name for ${walletName(index)}`}
            autoFocus
          />
          <button className="btn ghost small-btn">Save</button>
          <p className="tiny">Kept on this device only.</p>
        </form>
      )}
      {!done && panel === "send" && v && (
        <div className="vw-panel send-out">
          <input
            className="addr mono"
            value={to}
            onChange={(e) => {
              setTo(e.target.value.trim());
              setToDone(false);
            }}
            onBlur={() => setToDone(true)}
            placeholder="Address to send it to"
            aria-label={`Address to send ${walletName(index)}'s SOL to`}
            spellCheck={false}
            autoComplete="off"
          />
          {badTo && <p className="small warn">That doesn't look like a Solana address.</p>}
          {to === address && <p className="small warn">That's this wallet's own address.</p>}
          <ConfirmButton
            className="btn ghost small-btn"
            label={`Send all (about ${fmt(v.lamports, 6)} SOL)`}
            ask={`Send all the SOL in Vision wallet #${n} to ${short(to, 5)}? This is an ordinary transfer and can't be undone.`}
            yes="Yes, send it"
            no="Don't send"
            disabled={!to || !looksLikeAddress(to) || to === address || waits}
            onYes={() => go(`Sending from Vision wallet #${n}`, () => engine.sendFromVision(index, to))}
          />
          <p className="tiny">An ordinary transfer from this Vision wallet, not a private one. The network fee comes out of it.</p>
        </div>
      )}
    </li>
  );
}

/**
 * What to do with the ticked wallets together. "Buy a token" opens Buy with them; moving back or
 * sending from two or more runs as one batch, one wallet after another with the gap picked here.
 */
function BulkBar({ st, sel, onClear, onStart }: { st: State; sel: number[]; onClear: () => void; onStart: (h: number) => void }) {
  const [act, setAct] = useState<"move" | "send" | null>(null);
  const [to, setTo] = useState("");
  const [pacing, setPacing] = usePacing();
  const sweepMin = engine.sweepMin();
  const picked = sel.map((i) => st.vision.find((v) => v.index === i)).filter((v): v is VisionView => !!v);
  const sum = picked.reduce((s, v) => s + v.lamports, 0n);
  const buy = picked.filter((v) => engine.buyable(v)).map((v) => v.index);
  const move = picked.filter((v) => v.tokens.length > 0 || sweepMin == null || v.lamports >= sweepMin);
  const send = picked.filter((v) => !v.tokens.length && v.lamports > 0n);
  const part = (list: unknown[]) => (list.length && list.length < picked.length ? ` (${list.length})` : "");
  // one batch at a time: these wait until the one running ends
  const running = batchLive(st.batch);
  const list = act === "send" ? send : move;
  const done = () => {
    setAct(null);
    setTo("");
    onClear();
  };
  const run = () => {
    if (list.length === 1) {
      // one wallet: on its own row, as always
      const v = list[0];
      if (act === "send") engine.queueSpot(`v${v.index}`, `Sending from Vision wallet #${v.index + 1}`, () => engine.sendFromVision(v.index, to));
      else engine.queueSpot(`v${v.index}`, "Moving back to your private balance", () => engine.sweep(v.index));
      return done();
    }
    // (the bar with its top margin, measured before it gives way to the card)
    const bar = document.querySelector<HTMLElement>(".vw-bulk");
    const h = bar ? bar.offsetHeight + parseFloat(getComputedStyle(bar).marginTop || "0") : 0;
    const ok = engine.startBatch({
      kind: act === "send" ? "send" : "move",
      pacing,
      ...(act === "send" ? { to } : {}),
      items: list.map((v) => ({ index: v.index, amount: v.lamports.toString(), status: "waiting" as const })),
    });
    // (its card takes the bar's place, below the list, where the person is looking: nothing scrolls)
    if (ok) {
      onStart(h);
      done();
    }
  };
  const badTo = to.length >= 32 && !looksLikeAddress(to);
  // one batch takes up to BATCH_MAX wallets
  const over = list.length > BATCH_MAX ? list.length - BATCH_MAX : 0;
  const pick = (a: "move" | "send" | null) => {
    setAct(a);
    // the open form sits in the page (not over the list): brought into view
    if (a) requestAnimationFrame(() => document.querySelector(".vw-bulk")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  return (
    <div className={`vw-bulk${act && !running ? " open" : ""}`} role="region" aria-label="Selected wallets">
      <div className="vw-bulk-top">
        <span className="vw-bulk-sum">
          <strong>{picked.length} selected</strong> · {fmt(sum)} SOL
        </span>
        <button type="button" className="link-btn" onClick={onClear}>
          Clear
        </button>
      </div>
      {/* (once one is picked, the bar shows just that, so it stays small on a phone) */}
      <div className="vw-bulk-acts" hidden={!!act && !running}>
        <button type="button" className="btn violet small-btn" disabled={!buy.length || running} onClick={() => buyFromVision(buy)}>
          Buy a token{part(buy)}
        </button>
        <button
          type="button"
          className="btn ghost small-btn"
          disabled={!move.length || running}
          aria-expanded={act === "move"}
          onClick={() => pick(act === "move" ? null : "move")}
        >
          Move back to private balance{part(move)}
        </button>
        <button type="button" className="btn ghost small-btn" disabled={!send.length || running} aria-expanded={act === "send"} onClick={() => pick(act === "send" ? null : "send")}>
          Send to an address{part(send)}
        </button>
      </div>
      {running && <p className="tiny vw-bulk-note">A batch is running (see above). These wait until it ends.</p>}
      {act && !running && (
        <div className="send-out vw-bulk-go">
          <p className="vw-bulk-what">
            {act === "send" ? "Send all their SOL to one address" : "Move their SOL back to your private balance"}
            {list.length < picked.length ? ` (${list.length} of ${picked.length} can)` : ""}
          </p>
          {act === "send" && (
            <>
              <input
                className="addr mono"
                value={to}
                onChange={(e) => setTo(e.target.value.trim())}
                placeholder="Address to send it all to"
                aria-label="Address to send it all to"
                spellCheck={false}
                autoComplete="off"
              />
              {badTo && <p className="small warn">That doesn't look like a Solana address.</p>}
            </>
          )}
          {list.length > 1 && <PacingControl pacing={pacing} setPacing={setPacing} />}
          {over > 0 && (
            <p className="small warn">
              Up to {BATCH_MAX} wallets in one go: untick {over}.
            </p>
          )}
          {act === "send" ? (
            <ConfirmButton
              className="btn ghost small-btn"
              label={`Send all from ${list.length} wallet${list.length === 1 ? "" : "s"}`}
              ask={`Send all the SOL in ${list.length} wallet${list.length === 1 ? "" : "s"} to ${short(to, 5)}? These are ordinary transfers and can't be undone. Paying one address from several wallets shows on the chain that they belong together.`}
              yes="Yes, send it"
              no="Don't send"
              disabled={!to || !looksLikeAddress(to) || over > 0}
              onYes={run}
            />
          ) : (
            <button type="button" className="btn ghost small-btn" disabled={over > 0} onClick={run}>
              Move {list.length} wallet{list.length === 1 ? "" : "s"} back
            </button>
          )}
          <button type="button" className="link-btn" onClick={() => setAct(null)}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}

const WHENS: { v: When; label: string }[] = [
  { v: "now", label: "Now" },
  { v: "15m", label: "15 min" },
  { v: "1h", label: "1 hour" },
  { v: "24h", label: "24 hours" },
];
const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

/**
 * "+ Fund new wallets": several fresh Vision wallets paid from the private balance in one go, each
 * its own private payment (the Send tab's "+ A fresh wallet of mine", N times). They're listed as
 * arriving at once. Runs in the background; what it says shows here.
 */
function FundWallets({ st, onClose }: { st: State; onClose: () => void }) {
  const [count, setCount] = useState(3);
  const [amt, setAmt] = useState("");
  const [vary, setVary] = useState(true);
  const [when, setWhen] = useState<When>("now");
  const offered = st.pool?.sendLater ?? [];
  const each = parseSol(amt);
  // the amounts are picked once for what's typed, so the figures shown are the ones sent
  const amounts = useMemo(() => (each && each > 0n ? fundAmounts(each, count, vary, Math.random, FUND_MIN) : []), [each, count, vary]);
  const quotes = amounts.map((a) => engine.quoteSend(a));
  const later = when !== "now";
  const spread = !later && offered.includes("2m");
  const prep =
    amounts.length && (later || spread)
      ? engine.prepCost(
          quotes.map((q) => q.withdraw),
          later,
        )
      : 0n;
  const total = quotes.reduce((s, q) => s + q.withdraw, 0n) + prep;
  const small = !!each && each > 0n && each < FUND_MIN;
  const tooMuch = amounts.length > 0 && total > engine.spendable();
  const job = st.spots.find((j) => j.spot === "fund");
  const said = st.said.fund;
  const ready = amounts.length > 0 && !small && !tooMuch && !st.update;

  if (job || said) {
    return (
      <div className="vw-fund" role="status">
        {job?.running && st.busy?.spot === "fund" ? (
          <p className="vw-work small">
            <span className="spinner small" aria-hidden="true" />
            <span>{st.busy.step}</span>
          </p>
        ) : job ? (
          <p className="small">
            <span className="job-chip wait">Next in line</span> <span className="muted">It starts as soon as the current one ends.</span>{" "}
            <button type="button" className="link-btn" onClick={() => engine.cancelSpot(job.id)}>
              Cancel
            </button>
          </p>
        ) : (
          said && (
            <>
              <p className={`small ${said.ok ? "vw-ok" : "vw-bad"}`}>
                <strong>{said.ok ? said.title : "Didn't go through"}.</strong> {said.text}
              </p>
              <button
                type="button"
                className="btn ghost small-btn"
                onClick={() => {
                  engine.clearSaid("fund");
                  if (said.ok) onClose();
                }}
              >
                {said.ok ? "Done" : "Back to the form"}
              </button>
            </>
          )
        )}
      </div>
    );
  }
  return (
    <form
      className="vw-fund form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        // fresh wallets, each never used, taken for these payments before anything goes
        const picks: number[] = [];
        for (let i = engine.nextVisionIndex(); picks.length < amounts.length; i++) if (engine.visionFree(i)) picks.push(i);
        picks.forEach((i) => engine.claimVision(i));
        const parts = picks.map((i, k) => ({ to: engine.visionAddress(i), amount: amounts[k], fresh: true }));
        engine.queueSpot("fund", "Checking the pool", () => engine.sendMany(parts, when));
        setAmt("");
        // the form gives way to a short status box: that box into view, where the form was
        requestAnimationFrame(() => document.querySelector(".vw-fund")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      }}
    >
      <div className="vw-fund-row">
        <span className="field-top">
          <span>How many new wallets</span>
        </span>
        <div className="stepper" role="group" aria-label="How many new wallets">
          <button type="button" aria-label="One fewer" disabled={count <= 2} onClick={() => setCount(count - 1)}>
            −
          </button>
          <span className="num" aria-live="polite">
            {count}
          </span>
          <button type="button" aria-label="One more" disabled={count >= FUND_MAX} onClick={() => setCount(count + 1)}>
            +
          </button>
        </div>
      </div>
      <AmountField label="SOL in each" value={amt} onChange={setAmt} hint={`Private: ${fmt(engine.spendable())} SOL`} />
      <label className="check">
        <input type="checkbox" checked={vary} onChange={(e) => setVary(e.target.checked)} />
        <span>
          Vary each amount a little
          <span className="check-hint">Up to 3% more or less in each, so the payments don't look alike.</span>
        </span>
      </label>
      <div className="when">
        <span className="when-title">When they go out</span>
        <div className="seg when-seg" role="radiogroup" aria-label="When they go out">
          {WHENS.map(({ v, label }) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={when === v}
              className={when === v ? "on" : ""}
              disabled={v !== "now" && !offered.includes(v)}
              onClick={() => setWhen(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="tiny when-note">
          {later
            ? `Each goes out at a random moment within ${WHEN_LABEL[when]}. They show here as arriving until then.`
            : spread
              ? "They go out one by one at random moments over the next 2 minutes, so they don't land together."
              : "They go out one after another, now."}
        </p>
      </div>
      {amounts.length > 0 && !small && (
        <Rows
          rows={[
            ["New Vision wallets", `${count} · about ${fmt(each!, 4)} SOL each`, "txt"],
            [
              `Pool fee (${pct(engine.feeBps())})`,
              `${fmt(
                quotes.reduce((s, q) => s + q.protocolFee, 0n),
                6,
              )} SOL`,
            ],
            [
              `Relayer and network (${count} payments)`,
              `${fmt(
                quotes.reduce((s, q) => s + q.relayerFee, 0n),
                6,
              )} SOL`,
            ],
            ...(prep > 0n ? ([[later ? "Setting aside the exact amounts" : "Preparing separate notes", `${fmt(prep, 6)} SOL`]] as [string, string][]) : []),
            ["Taken from your private balance", `${fmt(total, 6)} SOL`, "total"],
          ]}
        />
      )}
      {small && <p className="warn">Each new wallet needs at least {fmtUp(FUND_MIN, 2)} SOL, so it can buy or move back later.</p>}
      {tooMuch && <p className="warn">Not enough private balance for that, including fees.</p>}
      <button className="btn violet wide" disabled={!ready}>
        Fund {count} new wallets
      </button>
      <p className="tiny">Each wallet is paid straight from the pool, in its own transaction. Your wallet is in none of them.</p>
      <button type="button" className="link-btn" onClick={onClose}>
        Not now
      </button>
    </form>
  );
}

/** For an account used on more than one device: looks on-chain for wallets and addresses opened on the other one. */
function FindMore({ busy }: { busy: boolean }) {
  const [state, setState] = useState<"idle" | "looking" | "done">("idle");
  if (state === "done") return <p className="small muted vw-foot">All up to date.</p>;
  return (
    <p className="small muted vw-foot">
      Using this account on another device too?{" "}
      <button
        type="button"
        className="link-btn"
        disabled={busy || state === "looking"}
        onClick={() => {
          setState("looking");
          engine.findMore().then(
            () => setState("done"),
            (e) => {
              setState("idle");
              engine.reportError((e as Error).message);
            },
          );
        }}
      >
        {state === "looking" ? "Looking…" : "Check for more"}
      </button>
    </p>
  );
}

/** The side column's short version: how many wallets, what they hold, and the way to the Wallets tab. */
export function WalletsSummary({ st }: { st: State }) {
  const live = st.vision.filter((v) => v.lamports > 0n || v.tokens.length > 0);
  const total = live.reduce((s, v) => s + v.lamports, 0n);
  const coming = new Set(
    engine
      .visionArriving()
      .map((a) => a.index)
      .filter((i) => !live.some((v) => v.index === i)),
  ).size;
  return (
    <section className="panel vw-summary">
      <header>
        <h3>Vision wallets</h3>
        <span className="muted">
          {live.length ? `${live.length} wallet${live.length === 1 ? "" : "s"} · ${fmt(total)} SOL` : "None yet"}
          {coming ? ` · ${coming} arriving` : ""}
        </span>
      </header>
      <p className="small muted">Wallets only you control, funded privately from the pool.</p>
      <a className="btn ghost small-btn" href="#wallets" onClick={goWallets}>
        Open Wallets
      </a>
    </section>
  );
}
