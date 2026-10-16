import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { engine, fmt, fmtUp, WHEN_LABEL, type State, type VisionView, type When } from "../../lib/engine";
import { formatUnits, parseSol, short } from "../../lib/net";
import { buyFromVision, sellFromVision } from "../../lib/buyfrom";
import { useTokenMeta } from "../../lib/tokenmeta";
import {
  FUND_MAX,
  FUND_MIN,
  STATUS_CHIP,
  bulkCount,
  bulkPlan,
  bulkWhyText,
  fundAmounts,
  walletName,
  walletsName,
  walletStatus,
  walletsLine,
  type BulkPart,
  type BulkWallet,
} from "../../lib/vwallets";
import type { Token } from "./TokenPicker";
import { TokenIcon } from "./TokenPicker";
import { ConfirmButton, Copy, CopyLink, looksLikeAddress } from "./Panels";
import { AmountField, Rows } from "./Forms";
import { BatchCard, PacingControl, batchLive, toBatchCard, usePacing } from "./Batch";
import { BATCH_MAX, batchTitle, plainReason, type BatchItem } from "../../lib/batch";
import { secureRandom } from "../../lib/poll";
import { ListedWarning } from "./Listed";
import { ProveControl } from "./ProveControl";
import { Sheet } from "./Sheet";
import { useTabActive } from "./TabActive";
import { useMasked } from "../../lib/masked";
import { MASK, maskText } from "../../lib/money";
import { centsText, pricedEnough, tokenOrder, unpricedNote, walletValue, type Portfolio, type WalletValue } from "../../lib/portfolio";
import { usePortfolio } from "../../lib/portfolio-hook";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const clock = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-US", today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A link to the Wallets tab: one already open scrolls its card into view instead. */
export function goWallets(e?: { preventDefault: () => void }) {
  if (location.hash !== "#wallets") return;
  e?.preventDefault();
  document.querySelector(".main-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

type Panel = "send" | "key" | "rename" | "prove" | null;
type Arriving = { amount: bigint; by: number };

/**
 * The Wallets header's one line: "12 wallets · 0.3627 SOL + 3 tokens ≈ $106.07 · 10 arriving" (see
 * walletsLine). The dollar figure is the sum of the wallets' own figures (as their rows show them, and as
 * Home's rows add up to); tokens with no price yet are said beside it ("+ 1 without a price").
 */
export function walletsSummary(st: State, p: Portfolio, masked: boolean): string {
  const live = st.vision.filter((v) => v.lamports > 0n || v.tokens.length > 0);
  const total = live.reduce((s, v) => s + v.lamports, 0n);
  const coming = new Set(
    engine
      .visionArriving()
      .map((a) => a.index)
      .filter((i) => !live.some((v) => v.index === i)),
  ).size;
  const mints = [...new Set(live.flatMap((v) => v.tokens.filter((t) => t.amount > 0n).map((t) => t.mint)))];
  let cents: number | null = null;
  let value = 0;
  for (const v of live) {
    const w = walletValue(p, v);
    if (w.cents == null) continue;
    cents = (cents ?? 0) + w.cents;
    value += w.value ?? 0;
  }
  // (each kind of token without a price, once, however many wallets hold it)
  const unpriced = p.cents.total == null ? 0 : mints.filter((m) => p.assets.some((a) => a.key === "token" && a.mint === m && a.usd == null)).length;
  // (no dollar figure for it all until every token held has been looked up: see pricedEnough)
  const usd = cents != null && value > 0 && pricedEnough(p, unpriced) ? centsText(cents, value) : null;
  return walletsLine({ wallets: live.length, sol: fmt(total), tokens: mints.length, usd, unpriced: usd ? unpriced : 0, coming, masked });
}

/** A wallet's tokens in list order (see tokenOrder): by value, then those with a name, then the rest by amount. */
function inOrder<T extends { mint: string; amount: bigint; decimals: number }>(tokens: T[], meta: Record<string, Token>, val: WalletValue | null): T[] {
  const key = (t: T) => ({ ...t, symbol: meta[t.mint]?.symbol ?? null, usd: val?.values.get(t.mint) ?? null });
  return [...tokens].sort((a, b) => tokenOrder(key(a), key(b)));
}

/**
 * The Wallets tab: every Vision wallet in a fixed order by number, one short row each. A row opens a
 * sheet with its actions; ticked rows share the selection bar at the bottom. Actions run in the
 * background, one at a time; a second one waits its turn ("Next in line"). A wallet emptied during this
 * visit stays where it was, as a short "done" row, until hidden.
 */
export function WalletsTab({ st }: { st: State }) {
  const meta = useTokenMeta(st.vision.flatMap((v) => v.tokens.map((t) => t.mint)));
  // every dollar figure as Home shows it (rounded once per state); the prices are the ones asked for just above
  const p = usePortfolio(st, { fetch: false });
  const [masked] = useMasked();
  const active = useTabActive();
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
  const [fundOpen, setFundOpen] = useState(false);
  // which wallet's sheet is open (one at a time)
  const [sheet, setSheet] = useState<number | null>(null);

  const live = st.vision.filter((v) => v.lamports > 0n || v.tokens.length > 0);
  // ticks show once two or more wallets can act together
  const actable = live.filter((v) => v.lamports > 0n).map((v) => v.index);
  const selectable = actable.length >= 2;
  const [selRaw, setSel] = useState<number[]>([]);
  const sel = selectable ? selRaw.filter((i) => actable.includes(i)) : [];
  const toggle = (i: number) => setSel(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i]);
  // the keyboard's way between the list and the selection bar: "Skip to actions" at the top of the list, and
  // "Back to wallets" in the bar, which returns to where the keyboard was in the list
  const barId = useId();
  const listAt = useRef<HTMLElement | null>(null);
  const toBar = (e: React.MouseEvent) => {
    e.preventDefault();
    document.getElementById(barId)?.focus();
  };
  const toList = (host: Element | null) => {
    const at = listAt.current;
    const back = at?.isConnected && host?.contains(at) ? at : (host?.querySelector<HTMLElement>(".vw-skip-top") ?? host?.querySelector<HTMLElement>(".vw-all input"));
    back?.focus();
  };
  // leaving the tab (or the screen) clears the selection, so the bar never waits behind another screen
  useEffect(() => {
    if (!active) {
      setSel([]);
      setSheet(null);
      setFundOpen(false);
    }
  }, [active]);
  // the wallets an unfinished batch still has to do: their rows say so, and wait with it
  const inBatch = new Map<number, BatchItem>();
  if (batchLive(st.batch)) for (const x of st.batch.items) if (x.index != null && (x.status === "waiting" || x.status === "running")) inBatch.set(x.index, x);
  const fundJob = st.spots.find((j) => j.spot === "fund");
  const fundSaid = st.said.fund;
  const openFund = () => {
    // a result already shown gives way to a new form
    if (fundSaid && !fundJob) engine.clearSaid("fund");
    setFundOpen(true);
  };
  const b = st.batch;

  return (
    <div className="wallets">
      <div className="vw-head">
        <div className="vw-head-text">
          <h3>Vision wallets</h3>
          {/* while a batch runs, its progress takes the summary's place (the same room: nothing under it moves) */}
          {batchLive(b) ? (
            <p className="small vw-head-sum vw-head-batch">
              <span>{batchTitle(b)}</span>{" "}
              <button type="button" className="link-btn" onClick={toBatchCard}>
                View
              </button>
            </p>
          ) : (
            <p className="muted small vw-head-sum">{walletsSummary(st, p, masked)}</p>
          )}
        </div>
        <button type="button" className="btn ghost small-btn" aria-haspopup="dialog" aria-expanded={fundOpen} disabled={!!fundJob} onClick={openFund}>
          + Fund new wallets
        </button>
      </div>
      <p className="tiny vw-intro">Wallets only you control, funded privately from the pool.</p>
      {(fundJob || fundSaid) && <FundStatus st={st} onAgain={openFund} />}
      {fundOpen && (
        <Sheet title="Fund new wallets" onClose={() => setFundOpen(false)} className="vw-fund-sheet">
          <FundWallets st={st} onClose={() => setFundOpen(false)} />
        </Sheet>
      )}
      {!order.length && (
        <div className="empty-state">
          <p>No Vision wallets yet.</p>
          <p className="muted">Fund a few with + Fund new wallets above, or make a private buy: each one opens a new wallet.</p>
        </div>
      )}
      {/* its room is always kept once wallets are listed (ticks work from two wallets on), so the list never moves when that changes */}
      {order.length > 0 && (
        <div className="vw-list-top">
          {/* while the selection bar shows: straight to it, past every wallet (shown only while the keyboard is on it) */}
          {sel.length > 0 && (
            <a href={`#${barId}`} className="vw-skip vw-skip-top" onClick={toBar}>
              Skip to actions
            </a>
          )}
          <label className={`check vw-all${selectable ? "" : " off"}`} aria-hidden={!selectable}>
            <input
              type="checkbox"
              disabled={!selectable}
              checked={selectable && sel.length === actable.length}
              onChange={(e) => setSel(e.target.checked ? actable : [])}
            />
            <span>Select all</span>
          </label>
        </div>
      )}
      <ul className="vw-list" onFocus={(e) => (listAt.current = e.target as HTMLElement)}>
        {order.map((i) => (
          <WalletRow
            key={i}
            st={st}
            index={i}
            v={st.vision.find((x) => x.index === i && (x.lamports > 0n || x.tokens.length > 0)) ?? null}
            arriving={arriving.get(i) ?? null}
            meta={meta}
            p={p}
            masked={masked}
            sweepMin={sweepMin}
            name={names[i] ?? ""}
            onRename={(n) => {
              engine.nameVision(i, n);
              setNames(engine.visionNames());
            }}
            open={sheet === i}
            setOpen={(o) => setSheet(o ? i : null)}
            hold={sheet != null && sheet !== i}
            selectable={selectable && actable.includes(i)}
            selected={sel.includes(i)}
            selecting={sel.length > 0}
            onSelect={() => toggle(i)}
            onHide={() => setHidden((h) => [...h, i])}
            batchItem={inBatch.get(i) ?? null}
          />
        ))}
      </ul>
      {/* below the list, so starting or ending a batch never pushes the wallets down */}
      <div className="vw-batch">
        <BatchCard st={st} />
      </div>
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
      {sel.length > 0 && (
        <BulkBar st={st} id={barId} sel={sel} setSel={setSel} actable={actable} inBatch={inBatch} sweepMin={sweepMin} masked={masked} onBack={toList} />
      )}
    </div>
  );
}

/** What a wallet row's status line says while idle. */
function idleLine(st: State, s: ReturnType<typeof walletStatus>, v: VisionView | null, arriving: Arriving | null): string {
  const coming = arriving ? `${fmt(arriving.amount)} SOL arriving by ${clock(arriving.by)}` : "";
  if (s === "arriving") return `${fmt(arriving!.amount)} SOL by ${clock(arriving!.by)}. Ready to use once it lands.`;
  if (s === "finish") return "Its swap didn't finish. The SOL is still here: finish the buy, or move it back.";
  if (s === "small" && v) {
    // (never "send it somewhere": a public transfer from a pool-funded wallet links it to wherever it goes)
    return st.rent && v.lamports <= st.rent.pending + 200_000n && v.lamports + 200_000n >= st.rent.pending
      ? "The waiting-room rent of a deposit came back here. It's too little to move into the pool on its own, so it stays: it goes back with the rest if this wallet is funded again."
      : "Less than the smallest deposit, so it can't move into the pool on its own. It stays here, and goes back with the rest if this wallet is funded again.";
  }
  return coming ? `+ ${coming}` : "";
}

/** A warning triangle, for a result that didn't go through (never colour alone). */
const AlertMark = () => (
  <svg className="vw-mark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3l9.5 17h-19L12 3z M12 10v4 M12 17h.01" />
  </svg>
);

function WalletRow({
  st,
  index,
  v,
  arriving,
  meta,
  p,
  masked,
  sweepMin,
  name,
  onRename,
  open,
  setOpen,
  hold,
  selectable,
  selected,
  selecting,
  onSelect,
  onHide,
  batchItem,
}: {
  st: State;
  index: number;
  v: VisionView | null;
  arriving: Arriving | null;
  meta: Record<string, Token>;
  p: Portfolio;
  masked: boolean;
  sweepMin: bigint | null;
  name: string;
  onRename: (n: string) => void;
  /** its sheet is open */
  open: boolean;
  setOpen: (o: boolean) => void;
  /** another row's sheet is open: this one keeps its height meanwhile */
  hold: boolean;
  selectable: boolean;
  selected: boolean;
  /** some wallets are ticked: a tap on the row ticks it too */
  selecting: boolean;
  onSelect: () => void;
  onHide: () => void;
  batchItem: BatchItem | null;
}) {
  const spot = `v${index}`;
  const n = index + 1;
  // while the person is at work in another row's sheet, this row never gets shorter by itself (a result, a
  // wallet emptied), so the rows below never move up; otherwise it simply takes its own height
  const me = useRef<HTMLLIElement | null>(null);
  const tallest = useRef(0);
  useLayoutEffect(() => {
    const h = me.current?.offsetHeight ?? 0;
    tallest.current = hold ? Math.max(tallest.current, h) : h;
  });
  // the sheet's sub-panel and drafts live here: closing the sheet keeps them, so reopening shows the same
  const [panel, setPanel] = useState<Panel>(null);
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
  // its dollar figure and its parts, as every screen shows them (see walletValue)
  const val = v ? walletValue(p, v) : null;
  const held = inOrder(v?.tokens.filter((t) => t.mint !== SOL_MINT) ?? [], meta, val);
  const shownTokens = held.filter((t) => t.amount > 0n);
  // its own action is running or waiting its turn (alone, or in a batch): the sheet's buttons wait with it
  const waits = !!job || !!batchItem;
  const batchNow = !!batchItem && batchItem.status === "running" && st.busy?.spot === "batch";
  const [chip, tone] = running || batchNow ? ["Working", "wait"] : job ? ["Next in line", "wait"] : batchItem ? ["In the batch", "wait"] : STATUS_CHIP[status];
  const canBuy = !!v && engine.buyable(v);
  const canMove = !!v && (v.tokens.length > 0 || sweepMin == null || v.lamports >= sweepMin);
  const canSend = !!v && !v.tokens.length && v.lamports > 0n;
  // what's left in a wallet too small to move back (often a deposit's returned rent): sending it on is offered only
  // among the sheet's other actions, with a warning, since a public transfer from a pool-funded wallet ties it to wherever it goes
  const leftover = status === "small";
  const go = (step: string, run: () => Promise<unknown>) => {
    setPanel(null);
    setOpen(false);
    engine.queueSpot(spot, step, run);
  };
  const badTo = !!to && (to.length >= 32 || toDone) && !looksLikeAddress(to);
  const show = (s: string) => (masked ? maskText(s) : s);

  // the status line: one line on the row (its full text in the sheet)
  const work = running || batchNow ? st.busy!.step : null;
  const lineText = work
    ? work
    : batchItem
      ? st.batch?.paused
        ? "Part of a batch waiting for you to continue (see below)."
        : "Part of the batch below: it waits its turn."
      : job
        ? "It starts as soon as the current one ends."
        : said
          ? said.ok
            ? said.text.replace(/ from Vision wallet #\d+/, "")
            : `Didn't go through: ${plainReason(said.text)}`
          : idleLine(st, status, v, arriving);
  const shownLine = show(lineText);
  const mark = !work && !batchItem && !job && said ? (said.ok ? "ok" : "bad") : null;
  // a chip that says it all ("Too small to move", "Buy to finish"): on the row, its longer explanation would only
  // show a few letters, so it shows in the sheet (and the row's tooltip) instead
  const quiet = !work && !batchItem && !job && !said && (status === "small" || status === "finish");
  const lineBody = (
    <>
      <span className={`job-chip ${tone}`}>{chip}</span>{" "}
      {work && <span className="spinner small" aria-hidden="true" />}
      {mark === "ok" && (
        <span className="vw-mark ok" aria-hidden="true">
          ✓
        </span>
      )}
      {mark === "bad" && <AlertMark />}
      {shownLine && <span className={`${mark === "ok" ? "vw-ok" : mark === "bad" ? "vw-bad" : work ? "vw-next" : "muted"}${quiet ? " vw-quiet" : ""}`}>{shownLine}</span>}
    </>
  );
  // a wallet with nothing in it yet shows what's on its way to it (never a bare 0 while SOL is coming)
  const coming = !v && !!arriving;
  const balText = masked ? `${MASK} SOL` : `${fmt(coming ? arriving!.amount : lamports)} SOL`;
  const usdNow = val?.cents == null || !val.value || val.value <= 0 || !pricedEnough(p, val.unpriced) ? null : centsText(val.cents, val.value);
  const usdText = usdNow == null ? "" : masked ? MASK : `≈ ${usdNow}`;
  // tokens with no price yet are never left out silently: said beside the figure
  const noPrice = usdText ? unpricedNote(val!.unpriced) : "";
  // the row's token chips: two, or one and "+N more"; beside that note, one (the note names the rest, unless a token
  // with a price is among them: then "+N more" too), so a chip is never cut in half by the note
  const hidden = noPrice ? shownTokens.slice(1) : [];
  const chips = noPrice ? 1 : shownTokens.length > 2 ? 1 : 2;
  const more = noPrice ? (hidden.some((t) => val!.tokens.get(t.mint) != null) ? hidden.length : 0) : shownTokens.length > 2 ? shownTokens.length - 1 : 0;
  // in the sheet, the SOL and each token with its own dollar figure, adding up to the row's
  const solText = () => {
    const x = val ? centsText(val.sol, val.solValue) : null;
    return x == null || lamports === 0n ? "" : masked ? MASK : `≈ ${x}`;
  };
  const tokenText = (mint: string) => {
    if (!val || p.cents.total == null) return "";
    const x = centsText(val.tokens.get(mint) ?? null, val.values.get(mint) ?? null);
    return x == null ? "No price yet" : masked ? MASK : `≈ ${x}`;
  };
  const title = `${walletName(index)}${name ? ` · ${name}` : ""}`;
  const label = selecting && selectable ? `${selected ? "Deselect" : "Select"} ${walletName(index)}` : `${title}, ${balText}${usdText ? ` ${usdText}${noPrice ? ` ${noPrice}` : ""}` : ""}, ${chip}. Open its actions`;

  const primary =
    status === "finish" && it ? (
      <button type="button" className="btn violet wide" disabled={waits} onClick={() => go(`Finishing the buy in ${walletName(index)}`, () => engine.finishBuy(index))}>
        Finish the buy
      </button>
    ) : held.length > 0 && !canBuy ? (
      // (with two or more tokens each has its own Sell above, so a lone "Sell" here couldn't say which)
      held.length === 1 && (
        <button
          type="button"
          className="btn violet wide"
          onClick={() => {
            setOpen(false);
            sellFromVision(index, held[0].mint);
          }}
        >
          Sell
        </button>
      )
    ) : (
      (canBuy || !v) && (
        <button
          type="button"
          className="btn violet wide"
          disabled={!canBuy || waits}
          onClick={() => {
            setOpen(false);
            buyFromVision([index]);
          }}
        >
          Buy a token
        </button>
      )
    );

  const PANEL_TITLE: Record<Exclude<Panel, null>, string> = {
    send: `Send from ${walletName(index)}`,
    key: `${walletName(index)}: private key`,
    rename: name ? `Rename ${walletName(index)}` : `Name ${walletName(index)}`,
    prove: `Prove control of ${walletName(index)}`,
  };

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
        <span className="vw-avatar" aria-hidden="true">
          {n}
        </span>
      )}
      <button
        type="button"
        className={`vw-open${usdText ? "" : " no-usd"}`}
        aria-label={label}
        aria-haspopup={selecting && selectable ? undefined : "dialog"}
        title={shownLine || undefined}
        onClick={() => (selecting && selectable ? onSelect() : setOpen(true))}
      >
        <span className="vw-id">
          <span className="vw-name">{walletName(index)}</span>
          {name && <span className="vw-label"> · {name}</span>}
        </span>
        <span className="vw-bal">
          <strong className={`num${coming ? " coming" : ""}`}>{balText}</strong>
        </span>
        <span className="vw-line small" aria-live="polite">
          {lineBody}
        </span>
        {usdText && <span className="vw-usd small muted">{usdText}</span>}
        {shownTokens.length > 0 && (
          <span className="vw-tags">
            <span className="vw-chips">
              {shownTokens.slice(0, chips).map((t) => {
                const m = meta[t.mint];
                return (
                  <span key={t.mint} className="chip">
                    <TokenIcon t={m ?? { icon: null, symbol: "?" }} size={18} />
                    <strong>{m ? m.symbol : short(t.mint, 4)}</strong> {masked ? MASK : formatUnits(t.amount, t.decimals, 4)}
                  </span>
                );
              })}
              {more > 0 && <span className="chip">+{more} more</span>}
            </span>
            {/* (under the dollar figure it qualifies) */}
            {noPrice && <span className="vw-unpriced small muted">{noPrice}</span>}
          </span>
        )}
      </button>
      {done && (
        <div className="vw-acts">
          <button type="button" className="link-btn" onClick={onHide}>
            Hide
          </button>
        </div>
      )}
      {open && (
        <Sheet title={panel ? PANEL_TITLE[panel] : title} onClose={() => setOpen(false)} onBack={panel ? () => setPanel(null) : undefined} className="vw-sheet">
          {!panel && (
            <>
              <p className="vw-sheet-addr">
                <span className="mono">{short(address, 4)}</span> <Copy text={address} label="Copy address" />
              </p>
              <p className="vw-sheet-bal">
                <strong className="num">{balText}</strong>
                {solText() && <span className="muted"> {solText()}</span>}
              </p>
              {held.length > 0 && (
                <ul className="vw-sheet-tokens">
                  {held.map((t) => {
                    const m = meta[t.mint];
                    const value = tokenText(t.mint);
                    return (
                      <li key={t.mint}>
                        <TokenIcon t={m ?? { icon: null, symbol: "?" }} size={28} />
                        <span className="vw-sheet-tok">
                          {m ? <strong>{m.symbol}</strong> : <span>Unknown token <span className="mono">{short(t.mint, 4)}</span></span>}{" "}
                          <span className="num">{masked ? MASK : formatUnits(t.amount, t.decimals, 4)}</span>
                          {value && <span className="muted"> {value}</span>}
                        </span>
                        {held.length > 1 && t.amount > 0n && (
                          <button
                            type="button"
                            className="btn ghost small-btn"
                            aria-label={`Sell ${m?.symbol ?? "this token"}`}
                            onClick={() => {
                              setOpen(false);
                              sellFromVision(index, t.mint);
                            }}
                          >
                            Sell
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="vw-line-full small" aria-live="polite">
                {lineBody}
                {job && !running && (
                  <>
                    {" "}
                    <button type="button" className="link-btn" onClick={() => engine.cancelSpot(job.id)}>
                      Cancel
                    </button>
                  </>
                )}
                {said?.sig && st.pool && !job && !batchItem && (
                  <>
                    {" "}
                    <CopyLink sig={said.sig} network={st.pool.network} />
                  </>
                )}
              </p>
              {!done && status === "finish" && it?.why === "hold" && it.hold && <p className="small warn vw-hold">{it.hold.text}</p>}
              {!done && (
                <div className="vw-acts">
                  {primary}
                  {status === "finish" && it?.why === "price" && (
                    <button type="button" className="link-btn" disabled={waits} onClick={() => go(`Finishing the buy in ${walletName(index)}`, () => engine.finishBuy(index, true))}>
                      With {engine.finishSlippage(it) / 100}% room
                    </button>
                  )}
                  {status === "finish" && it?.why === "hold" && it.hold && it.hold.why !== "block" && (
                    <ConfirmButton
                      label="Finish at today's price"
                      ask={`${it.hold.text} Finish the buy at today's price?`}
                      yes="Yes, finish"
                      no="Not now"
                      disabled={waits}
                      onYes={() => go(`Finishing the buy in ${walletName(index)}`, () => engine.finishBuy(index, false, true))}
                    />
                  )}
                  {(canMove || !v) && (
                    <button type="button" className="btn ghost wide" disabled={!v || waits} onClick={() => go("Moving back to your private balance", () => engine.sweep(index))}>
                      Move back to private balance
                    </button>
                  )}
                  {((canSend && !leftover) || !v) && (
                    <button type="button" className="btn ghost wide" disabled={!v || waits} onClick={() => setPanel("send")}>
                      Send to an address
                    </button>
                  )}
                </div>
              )}
              <div className="vw-more">
                {canSend && leftover && !done && (
                  <button type="button" className="vw-more-row" disabled={waits} onClick={() => setPanel("send")}>
                    Send it to an address (public)
                  </button>
                )}
                <button
                  type="button"
                  className="vw-more-row"
                  onClick={() => {
                    setRename(name);
                    setPanel("rename");
                  }}
                >
                  {name ? "Rename" : "Add a name"}
                </button>
                <button type="button" className="vw-more-row" onClick={() => setPanel("key")}>
                  Show private key
                </button>
                <button type="button" className="vw-more-row" onClick={() => setPanel("prove")}>
                  Prove control
                </button>
              </div>
            </>
          )}
          {panel === "prove" && (
            <div className="vw-panel">
              <p className="small">For an exchange that asks you to show this wallet is yours: paste its message and sign it with this wallet's key.</p>
              <ProveControl st={st} fixed={{ kind: "vision", index, address }} onDone={() => setPanel(null)} />
            </div>
          )}
          {panel === "key" && (
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
          {panel === "rename" && (
            <form
              className="vw-panel vw-rename"
              onSubmit={(e) => {
                e.preventDefault();
                onRename(rename);
                setPanel(null);
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
          {panel === "send" && v && (
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
              {!badTo && <ListedWarning to={to} />}
              {to === address && <p className="small warn">That's this wallet's own address.</p>}
              {looksLikeAddress(to) && to !== address && engine.paidBefore(to, address) && (
                <p className="small warn">Another of your wallets already sent SOL to this address. Sending from this one too shows on the chain that both wallets belong to the same person.</p>
              )}
              {leftover && (
                <p className="small warn">Sending what's left to an address you use shows on the chain that this wallet and that address belong together. You can also leave it here.</p>
              )}
              <ConfirmButton
                className="btn violet wide"
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
        </Sheet>
      )}
    </li>
  );
}

type BulkAct = "buy" | "move" | "send";

/**
 * What to do with the ticked wallets together: a bar of fixed height at the bottom. "Buy" opens Buy
 * with them; moving back or sending opens a sheet to confirm, and runs as one batch, one wallet after
 * another with the gap picked there. Each button says how many it acts on; one that can act on none
 * says why when tapped.
 */
function BulkBar({
  st,
  id,
  sel,
  setSel,
  actable,
  inBatch,
  sweepMin,
  masked,
  onBack,
}: {
  st: State;
  /** the bar's id: "Skip to actions" at the top of the list moves the keyboard here */
  id: string;
  /** "Back to wallets": the keyboard returns to the list (given the Wallets tab) */
  onBack: (host: Element | null) => void;
  sel: number[];
  setSel: (s: number[]) => void;
  actable: number[];
  inBatch: Map<number, BatchItem>;
  sweepMin: bigint | null;
  masked: boolean;
}) {
  const [open, setOpen] = useState<{ act: BulkAct; why: boolean } | null>(null);
  const picked = sel.map((i) => st.vision.find((v) => v.index === i)).filter((v): v is VisionView => !!v);
  const sum = picked.reduce((s, v) => s + v.lamports, 0n);
  const ws: BulkWallet[] = picked.map((v) => ({
    index: v.index,
    lamports: v.lamports,
    tokens: v.tokens.length,
    buyable: engine.buyable(v),
    finish: !!engine.finishable(v),
    busy: inBatch.has(v.index) || st.spots.some((j) => j.spot === `v${v.index}`),
  }));
  const plan = bulkPlan(ws, sweepMin, BATCH_MAX);
  // one batch at a time: these wait until the one running ends
  const running = batchLive(st.batch) || st.batchAway;
  const all = sel.length === actable.length;
  const allBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (allBox.current) allBox.current.indeterminate = !all && sel.length > 0;
  });
  // clearing the selection takes the bar away: the keyboard lands on "Select all" (never lost to the page)
  const bar = useRef<HTMLDivElement>(null);
  const toAll = () => {
    const host = bar.current?.closest(".wallets");
    requestAnimationFrame(() => host?.querySelector<HTMLInputElement>(".vw-all input")?.focus({ preventScroll: true }));
  };
  const clear = () => {
    // (the keyboard on the bar, or on "Skip to actions", which goes with it)
    const at = document.activeElement;
    const had = !!bar.current?.contains(at) || !!at?.classList.contains("vw-skip-top");
    setSel([]);
    if (had) toAll();
  };
  const clearRef = useRef(clear);
  clearRef.current = clear;
  // Esc clears it too, unless something open over the page takes Esc first (a sheet, a menu, a question)
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(".sheet, .ext-menu, .tg-back, .sf-back, .confirm, .busy")) return;
      clearRef.current();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  // the button's name, and what a screen reader hears: the whole action and how many it acts on
  const NAMES: Record<BulkAct, [string, string, string]> = {
    buy: ["Buy", "Buy a token with", "Buy a token"],
    move: ["Move back", "Move back to private balance:", "Move back to private balance"],
    send: ["Send", "Send to an address:", "Send to an address"],
  };
  const act = (a: BulkAct) => {
    const p = plan[a];
    const count = bulkCount(p, picked.length);
    const none = !p.ok.length;
    const [label, lead, whole] = NAMES[a];
    const aria = none
      ? `${whole}: none of these can`
      : `${lead} ${p.ok.length === picked.length ? plural(p.ok.length, "wallet", "wallets") : `${p.ok.length} of the ${picked.length} selected wallets`}`;
    return (
      <button
        key={a}
        type="button"
        className={`vw-bulk-act${a === "buy" ? " primary" : ""}`}
        aria-disabled={none || undefined}
        aria-haspopup={none || a !== "buy" ? "dialog" : undefined}
        aria-label={aria}
        onClick={() => {
          if (none) setOpen({ act: a, why: true });
          else if (a === "buy") buyFromVision(p.now);
          else setOpen({ act: a, why: false });
        }}
      >
        <span className="l">{label}</span>
        <span className="c">{count}</span>
      </button>
    );
  };
  return (
    <>
      <div ref={bar} id={id} tabIndex={-1} className="vw-bulk" role="region" aria-label="Selected wallets">
        {/* shown only while the keyboard is on it: back to where it was in the list */}
        <a
          href="#"
          className="vw-skip vw-skip-back"
          onClick={(e) => {
            e.preventDefault();
            onBack(bar.current?.closest(".wallets") ?? null);
          }}
        >
          Back to wallets
        </a>
        <div className="vw-bulk-top">
          <button type="button" className="vw-bulk-x" aria-label="Clear selection" onClick={clear}>
            <span aria-hidden="true">×</span>
          </button>
          <span className="vw-bulk-sum" aria-live="polite">
            <strong>{picked.length} selected</strong> · {masked ? MASK : fmt(sum)} SOL
          </span>
          <label className="vw-bulk-all">
            <input ref={allBox} type="checkbox" checked={all} aria-label="Select all wallets" onChange={(e) => setSel(e.target.checked ? actable : [])} /> All
          </label>
        </div>
        {running ? (
          <p className="vw-bulk-wait small">
            <span>A batch is running. These can go when it ends.</span>{" "}
            <button type="button" className="link-btn" onClick={toBatchCard}>
              View
            </button>
          </p>
        ) : (
          <div className="vw-bulk-acts">{(["buy", "move", "send"] as const).map(act)}</div>
        )}
      </div>
      {open?.why && (
        <Sheet
          title={open.act === "buy" ? "None of these can buy" : open.act === "move" ? "None of these can move back" : "None of these can send"}
          onClose={() => setOpen(null)}
          footer={
            <button type="button" className="btn violet wide" onClick={() => setOpen(null)}>
              OK
            </button>
          }
        >
          {bulkWhyText(open.act, plan[open.act].left).map((t) => (
            <p key={t} className="vw-why">
              {t}
            </p>
          ))}
        </Sheet>
      )}
      {open && !open.why && open.act !== "buy" && (
        <BulkSheet
          act={open.act}
          part={plan[open.act]}
          picked={picked}
          onClose={() => setOpen(null)}
          setSel={(s) => {
            // (nothing left to do: the bar goes, and the keyboard lands on "Select all")
            if (!s.length) toAll();
            setSel(s);
          }}
        />
      )}
    </>
  );
}

/** Moving back, or sending all, from the ticked wallets: what goes, what's left out and why, the timing, and the confirm. */
function BulkSheet({
  act,
  part,
  picked,
  onClose,
  setSel,
}: {
  act: "move" | "send";
  part: BulkPart;
  picked: VisionView[];
  onClose: () => void;
  setSel: (s: number[]) => void;
}) {
  const [to, setTo] = useState("");
  const [pacing, setPacing] = usePacing();
  const [refused, setRefused] = useState(false);
  const list = part.now.map((i) => picked.find((v) => v.index === i)!).filter(Boolean);
  const n = list.length;
  const sum = list.reduce((s, v) => s + v.lamports, 0n);
  const withTokens = list.filter((v) => v.tokens.length > 0).map((v) => v.index);
  const wallets = plural(n, "wallet", "wallets");
  const badTo = to.length >= 32 && !looksLikeAddress(to);
  const run = () => {
    if (n === 1) {
      // one wallet: on its own row, as always
      const v = list[0];
      if (act === "send") engine.queueSpot(`v${v.index}`, `Sending from Vision wallet #${v.index + 1}`, () => engine.sendFromVision(v.index, to));
      else engine.queueSpot(`v${v.index}`, "Moving back to your private balance", () => engine.sweep(v.index));
      onClose();
      setSel(part.later);
      return;
    }
    const ok = engine.startBatch({
      kind: act,
      pacing,
      ...(act === "send" ? { to } : {}),
      items: list.map((v) => ({ index: v.index, amount: v.lamports.toString(), status: "waiting" as const })),
    });
    if (!ok) return setRefused(true);
    onClose();
    // what's left over stays ticked for the next run; anything not acted on is cleared
    setSel(part.later);
    toBatchCard();
  };
  const leftOut = bulkWhyText(act, part.left);
  const over =
    part.later.length > 0 ? (
      <p className="small warn">
        Up to {BATCH_MAX} at a time. {walletsName(part.now)} go now; {walletsName(part.later)} {part.later.length === 1 ? "stays" : "stay"} selected for the next run.
      </p>
    ) : null;
  // (a refusal shows beside the button pressed, never down in the body where it could be out of view)
  const busyNote = refused ? (
    <p className="warn small" role="status">
      A batch is running. These can go when it ends.
    </p>
  ) : null;
  const footer =
    act === "send" ? (
      <>
        {busyNote}
        <ConfirmButton
          className="btn violet wide"
          label={`Send all from ${wallets}`}
          ask={`Send all the SOL in ${wallets} to ${short(to, 5)}? These are ordinary transfers and can't be undone. Paying one address from several wallets shows on the chain that they belong together.`}
          yes="Yes, send it"
          no="Don't send"
          disabled={!n || !to || !looksLikeAddress(to)}
          onYes={run}
        />
        <button type="button" className="btn ghost wide" onClick={onClose}>
          Cancel
        </button>
      </>
    ) : (
      <>
        {busyNote}
        <button type="button" className="btn violet wide" disabled={!n} onClick={run}>
          Move {wallets} back
        </button>
        <button type="button" className="btn ghost wide" onClick={onClose}>
          Cancel
        </button>
      </>
    );
  return (
    <Sheet title={act === "send" ? "Send to an address" : "Move back to private balance"} onClose={onClose} footer={footer} className="vw-bulk-sheet">
      {act === "move" ? (
        <p>
          Moves the SOL in {wallets} back. Each joins your private balance about {engine.waitLabel()} after it lands.
        </p>
      ) : (
        <>
          <p>Sends all the SOL in {wallets} to one address, as ordinary transfers.</p>
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
          {looksLikeAddress(to) && <ListedWarning to={to} />}
          {looksLikeAddress(to) && engine.paidBefore(to) && <p className="small warn">Your wallets already sent SOL to this address before.</p>}
        </>
      )}
      <Rows
        rows={[
          ["Wallets", `${n} · ${n ? walletsName(part.now) : "none"}`, "txt"],
          [act === "send" ? "SOL" : "SOL in them", `${fmt(sum)} SOL`],
        ]}
      />
      {/* the choice comes right after what goes, so it's on screen as the sheet opens (the details follow) */}
      {n > 1 && <PacingControl pacing={pacing} setPacing={setPacing} />}
      {n > 1 && (
        <p className="tiny">
          {act === "send"
            ? "Paying one address from several wallets shows on the chain that they belong together, whatever the timing."
            : "Wallets moved back around the same time can be linked by someone watching the chain. The gaps between them help, but don't rule that out."}
        </p>
      )}
      <p className="tiny">
        Network fees come out of each.
        {act === "move" && withTokens.length > 0
          ? ` ${walletsName(withTokens)} ${withTokens.length === 1 ? "keeps its fee reserve because it holds tokens" : "keep their fee reserves because they hold tokens"}.`
          : ""}
      </p>
      {leftOut.length > 0 && (
        <div className="vw-left">
          <strong className="small">Left out</strong>
          {leftOut.map((t) => (
            <p key={t} className="small muted">
              {t}
            </p>
          ))}
        </div>
      )}
      {over}
    </Sheet>
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
 * Where "+ Fund new wallets" stands once sent: working, next in line, or how it went (two lines, the
 * rest a tap away), above the list, in place of the tall form.
 */
function FundStatus({ st, onAgain }: { st: State; onAgain: () => void }) {
  const job = st.spots.find((j) => j.spot === "fund");
  const said = st.said.fund;
  const [more, setMore] = useState(false);
  return (
    <div className="vw-fund vw-fund-status" role="status">
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
            <p className="small vw-fund-title">
              {/* (a mark, never colour alone; the title says the rest) */}
              {said.ok ? (
                <span className="vw-mark ok" aria-hidden="true">
                  ✓
                </span>
              ) : (
                <AlertMark />
              )}
              <strong>{said.ok ? said.title : "Didn't go through"}</strong>
            </p>
            <p className={`small vw-fund-text${more ? " open" : ""}`}>{said.text}</p>
            <div className="vw-fund-acts">
              <button type="button" className="link-btn" aria-expanded={more} onClick={() => setMore(!more)}>
                {more ? "Less" : "More"}
              </button>
              <button
                type="button"
                className="btn ghost small-btn"
                onClick={() => {
                  engine.clearSaid("fund");
                  if (!said.ok) onAgain();
                }}
              >
                {said.ok ? "Done" : "Back to the form"}
              </button>
            </div>
          </>
        )
      )}
    </div>
  );
}

/**
 * "+ Fund new wallets": several fresh Vision wallets paid from the private balance in one go, each
 * its own private payment (the Send tab's "+ A fresh wallet of mine", N times). They're listed as
 * arriving at once. Runs in the background; how it goes shows above the list.
 */
function FundWallets({ st, onClose }: { st: State; onClose: () => void }) {
  const [count, setCount] = useState(3);
  const [amt, setAmt] = useState("");
  const [vary, setVary] = useState(true);
  const [when, setWhen] = useState<When>("now");
  const offered = st.pool?.sendLater ?? [];
  const each = parseSol(amt);
  // the amounts are picked once for what's typed, so the figures shown are the ones sent
  const amounts = useMemo(() => (each && each > 0n ? fundAmounts(each, count, vary, secureRandom, FUND_MIN) : []), [each, count, vary]);
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
  const ready = amounts.length > 0 && !small && !tooMuch && !st.update && !job;

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
        onClose();
        // the sheet gives way to a short status box above the list: that box into view
        requestAnimationFrame(() => document.querySelector(".vw-fund-status")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
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
      <AmountField label="SOL in each" value={amt} onChange={setAmt} hint={`Available: ${fmt(engine.spendable())} SOL`} />
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
      {job && <p className="small muted">Your last funding is still going. This one can go once it ends.</p>}
      <button className="btn violet wide" disabled={!ready}>
        Fund {count} new wallets
      </button>
      <button type="button" className="btn ghost wide" onClick={onClose}>
        Cancel
      </button>
      <p className="tiny">
        Each wallet is paid straight from the pool, in its own transaction. Your wallet is in none of them. Wallets funded around the same time, with
        similar amounts, can still be linked by someone watching the chain: spreading them out over time helps.
      </p>
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
  // (only prices the Wallets, Buy or Sell tab already asked for: opening the page never sends the list of tokens held)
  const p = usePortfolio(st, { fetch: false });
  return (
    <section className="panel vw-summary">
      <header>
        <h3>Vision wallets</h3>
        <span className="muted">{walletsSummary(st, p, false)}</span>
      </header>
      <p className="small muted">Wallets only you control, funded privately from the pool.</p>
      <a className="btn ghost small-btn" href="#wallets" onClick={goWallets}>
        Open Wallets
      </a>
    </section>
  );
}
