import { useCallback, useEffect, useRef, useState } from "react";
import { engine, fmt, orderName, visionReserve, type Order, type OrderPatch, type State } from "../../lib/engine";
import { explorer, formatUnits, lookup, parseSol, parseUnits, short } from "../../lib/net";
import { copyText } from "../../lib/copy";
import { normAmount } from "../../lib/amount";
import { onBuyFrom, onSellFrom } from "../../lib/buyfrom";
import { ago, fillStats, inTime, leftOf, legsFor, metNow, parsePrice, priceEntry, priceStale, priceText, shareOf, shrinkLegs, stageText, stepsKept, usd } from "../../lib/orders";
import { useTokenMeta } from "../../lib/tokenmeta";
import { bucketAmount } from "../../lib/tokenfacts";
import { useTabActive } from "./TabActive";
import { TokenPicker, TokenIcon, type Token } from "./TokenPicker";
import { AddSol, AmountField, BuyForm, Rows, SellForm, shortText } from "./Forms";
import { BatchCard, batchOnTab } from "./Batch";
import { ConfirmButton } from "./Panels";

export { usd };

const SOL_MINT = "So11111111111111111111111111111111111111112";
const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const raw = (amount: bigint, decimals: number) => formatUnits(amount, decimals, decimals).replace(/,/g, "");

/** A choice of how to buy or sell: pressed buttons inside the tab (like Add SOL's), not a second set of tabs. */
function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className={`seg seg-${options.length}`} role="group" aria-label={label}>
      {options.map(([k, l]) => (
        <button key={k} type="button" aria-pressed={value === k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Chips<T extends string | number | boolean | null>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="slip chips" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      {options.map(([v, l]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/**
 * Today's price of a token, asked for when the form opens and every 15 s while it's on screen, with
 * when the price service fetched it. `judge` is the price to check "would trigger straight away"
 * against: none when the price is too old to say (the server checks again when the order is placed).
 */
function useLivePrice(mint: string | null | undefined, fallback: number | null) {
  const [got, setGot] = useState<{ mint: string; usd: number | null; at: number } | null>(null);
  const [, tick] = useState(0);
  const active = useTabActive();
  const refresh = useCallback(async (): Promise<number | null> => {
    if (!mint) return null;
    try {
      const r = await lookup<Record<string, unknown>>("/api/price", { ids: mint, at: 1 });
      const e = priceEntry(r[mint]);
      setGot({ mint, usd: e?.usd ?? null, at: e?.at ?? Date.now() });
      return e && !priceStale(e.at) ? e.usd : null;
    } catch {
      return null;
    }
  }, [mint]);
  useEffect(() => {
    // asked again on coming back to the tab; a form kept on a hidden tab doesn't poll
    if (!mint || !active) return;
    void refresh();
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), 15_000);
    const u = setInterval(() => tick((x) => x + 1), 5_000);
    return () => {
      clearInterval(t);
      clearInterval(u);
    };
  }, [mint, refresh, active]);
  const mine = got && got.mint === mint && got.usd != null ? got : null;
  const now = mine?.usd ?? fallback;
  const at = mine?.at ?? null;
  return { now, at, judge: priceStale(at) ? null : now, refresh };
}

const nowHint = (now: number | null, at: number | null) =>
  `Now ${usd(now)}${at ? ` · updated ${ago(at)}${priceStale(at) ? ", may be out of date" : ""}` : ""}`;

/** A price box with the current price (and how fresh it is) beside it, and quick moves from it. */
function PriceField({ label, value, onChange, now, at, moves }: { label: string; value: string; onChange: (v: string) => void; now: number | null; at: number | null; moves: number[] }) {
  return (
    <div className="price-field">
      <AmountField label={label} hint={nowHint(now, at)} pre="$" unit="per token" value={value} onChange={onChange} />
      {now != null && !priceStale(at) && moves.length > 0 && (
        <div className="move-chips">
          {moves.map((m) => (
            <button key={m} type="button" className="chip-btn small" onClick={() => onChange(priceText(now * (1 + m / 100)))}>
              {m > 0 ? `+${m}%` : `${m}%`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const DAYS: [number, string][] = [
  [1, "1 day"],
  [7, "1 week"],
  [30, "30 days"],
  [90, "90 days"],
];
const daysLabel = (d: number | null) => DAYS.find(([v]) => v === d)?.[1] ?? `${d} days`;
const ROOM: [number, string][] = [
  [300, "3%"],
  [500, "5%"],
  [1000, "10%"],
  [2000, "20%"],
];
const SL_ROOM: [number | null, string][] = [
  [null, "Same"],
  [500, "5%"],
  [1000, "10%"],
  [2000, "20%"],
  [2500, "25%"],
];
const TRAIL: [number, string][] = [
  [5, "5%"],
  [10, "10%"],
  [15, "15%"],
  [20, "20%"],
  [30, "30%"],
];

/** Price room and how long it stays open: tucked into one row that opens. */
function OrderMore({
  slip,
  setSlip,
  slSlip,
  setSlSlip,
  days,
  setDays,
  keep,
}: {
  slip: number;
  setSlip: (v: number) => void;
  slSlip?: number | null;
  setSlSlip?: (v: number | null) => void;
  days?: number | null;
  setDays?: (v: number | null) => void;
  /** in the edit form: "Keep" leaves the end date as it is */
  keep?: string;
}) {
  return (
    <details className="trade-set order-more">
      <summary>
        <span>
          Price room <strong>{pct(slip)}</strong>
          {setSlSlip && (
            <>
              {" "}
              · stop <strong>{slSlip == null ? "same" : pct(slSlip)}</strong>
            </>
          )}
        </span>
        {setDays && (
          <span>
            Open <strong>{days == null ? (keep ?? "as is") : daysLabel(days)}</strong>
          </span>
        )}
      </summary>
      <div className="trade-set-body">
        <Chips label="Price room" value={slip} onChange={setSlip} options={ROOM} />
        {setSlSlip && <Chips label="Stop-loss room" value={slSlip ?? null} onChange={setSlSlip} options={SL_ROOM} />}
        {setDays && <Chips label={keep ? "Open for" : "Keep it open"} value={days ?? null} onChange={setDays} options={keep ? [[null, "As is"], ...DAYS] : DAYS} />}
        <p className="muted small">
          Price room is how far the price may move while the order trades. A stop-loss can have more, so it still sells in a fast drop.
        </p>
      </div>
    </details>
  );
}

const TRUST =
  "While it's live, VisionSwap's order keeper may trade only what this order sets aside, and only into this same Vision wallet. Cancel any time to take that permission away.";

// ─────────────── buy: now, limit, DCA ───────────────

export function BuyTab({ st }: { st: State }) {
  const [mode, setMode] = useState<"now" | "limit" | "dca">("now");
  const offered = !!st.pool?.orders;
  // "Buy a token" on Vision wallets is a buy now
  useEffect(() => onBuyFrom((i) => i.length > 0 && setMode("now")), []);
  return (
    <>
      {batchOnTab(st.batch, "buy") && <BatchCard st={st} />}
      {offered && (
        <Seg
          label="How to buy"
          value={mode}
          onChange={setMode}
          options={[
            ["now", "Buy now"],
            ["limit", "Limit"],
            ["dca", "DCA"],
          ]}
        />
      )}
      {mode === "now" || !offered ? <BuyForm st={st} /> : mode === "limit" ? <LimitBuy st={st} /> : <Dca st={st} />}
    </>
  );
}

/** What an order's Vision wallet costs to fund from the private balance, merges included, and the most it can spend. */
function useFunding(sol: bigint | null, program?: string | null) {
  const reserve = visionReserve(program);
  const q = sol ? engine.quoteSend(sol + reserve) : null;
  // a balance in many pieces is joined first, and each join costs a relayer fee: counted before anything is paid
  const plan = q ? engine.mergePlan(q.withdraw) : null;
  const tooMuch = !!q && !!plan && (!plan.ok || q.withdraw + plan.cost > engine.spendable());
  const most = engine.maxSpend(reserve);
  return { reserve, q, plan, tooMuch, most, max: most >= 1_000n ? formatUnits(most, 9, 6) : null };
}

function FundingRows({ f }: { f: ReturnType<typeof useFunding> }) {
  if (!f.q) return null;
  const merge = f.plan && f.plan.ok && f.plan.merges > 0 ? f.plan : null;
  return (
    <Rows
      rows={[
        [`Pool fee (${pct(engine.feeBps())})`, `${fmt(f.q.protocolFee, 6)} SOL`],
        ["Relayer and network", `${fmt(f.q.relayerFee, 6)} SOL`],
        ...(merge ? ([[`Joining your balance first (${merge.merges} step${merge.merges === 1 ? "" : "s"})`, `${fmt(merge.cost, 6)} SOL`]] as [string, string][]) : []),
        ["Kept in the Vision wallet for its fees", `${fmt(f.reserve, 4)} SOL`],
        ["Taken from your private balance", `${fmt(f.q.withdraw + (merge?.cost ?? 0n), 6)} SOL`, "total"],
      ]}
    />
  );
}

const tooMuchText = (f: ReturnType<typeof useFunding>, st: State) =>
  shortText(st, `Not enough private balance for that, including fees.${f.max ? ` The most you can spend is ${f.max} SOL.` : ""}`);

/** The "not enough" warning, with the shortfall one tap away (see AddSol). */
function TooMuch({ f, st }: { f: ReturnType<typeof useFunding>; st: State }) {
  return (
    <p className="warn">
      {tooMuchText(f, st)}
      {f.q && (
        <>
          {" "}
          <AddSol st={st} need={f.q.withdraw + (f.plan?.ok ? f.plan.cost : 0n)} />
        </>
      )}
    </p>
  );
}

function TokenField({ token, setToken }: { token: Token | null; setToken: (t: Token | null) => void }) {
  return (
    <div className="field">
      <span className="field-top">
        <span>Token</span>
      </span>
      <TokenPicker value={token} onChange={setToken} />
    </div>
  );
}

function LimitBuy({ st }: { st: State }) {
  const [token, setToken] = useState<Token | null>(null);
  const [amt, setAmt] = useState("");
  const [price, setPrice] = useState("");
  const [slip, setSlip] = useState(500);
  const [days, setDays] = useState<number | null>(30);
  const [refused, setRefused] = useState<string | null>(null);
  const lim = engine.orderLimits();
  const sol = parseSol(amt);
  const p = parsePrice(price);
  const f = useFunding(sol, token?.program);
  const { now, at, judge, refresh } = useLivePrice(token?.mint, token?.price ?? null);
  const small = !!sol && sol < BigInt(lim.minBuyLamports);
  const met = metNow("buy", { buyBelow: p }, judge);
  const ok = !!token && !!token.program && !!sol && !small && !!p && !met && !f.tooMuch && !st.busy;
  return (
    <form
      className="form order-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        // checked against the price right now, before anything is funded
        const fresh = await refresh();
        const m = metNow("buy", { buyBelow: p }, fresh ?? judge);
        setRefused(m);
        if (m) return;
        await engine
          .placeBuyOrder({ mint: token!.mint, symbol: token!.symbol, decimals: token!.decimals, program: token!.program!, sol: sol!, buyBelowUsd: p!, slippageBps: slip, days: days ?? 30 })
          .then((placed) => {
            if (!placed) return;
            setAmt("");
            setPrice("");
          })
          .catch(() => {});
      }}
    >
      <TokenField token={token} setToken={setToken} />
      <AmountField label="Spend from your private balance" value={amt} onChange={setAmt} hint={`Available: ${fmt(engine.spendable())} SOL`} max={f.max} />
      <PriceField label="Buy when the price is at or below" value={price} onChange={(v) => (setPrice(v), setRefused(null))} now={now} at={at} moves={[-5, -10, -20, -30]} />
      {(met ?? refused) && <p className="warn">{met ?? refused}</p>}
      {token && now == null && <p className="muted small">No live price for this token right now, so a limit buy can't watch it yet.</p>}
      {token && !token.program && <p className="muted small">Loading this token's details…</p>}
      <OrderMore slip={slip} setSlip={setSlip} days={days} setDays={setDays} />
      <FundingRows f={f} />
      {small && <p className="warn">Orders start at {fmt(BigInt(lim.minBuyLamports))} SOL.</p>}
      {f.tooMuch && <TooMuch f={f} st={st} />}
      <button className="btn violet wide" disabled={!ok}>
        {token ? `Place limit buy for ${token.symbol}` : "Place limit buy"}
      </button>
      <p className="tiny">
        A fresh Vision wallet, funded from the pool once the order is accepted, holds the SOL and buys when the price reaches yours, even with this page closed. {TRUST}
      </p>
    </form>
  );
}

const EVERY: [number, string][] = [
  [3600, "1 hour"],
  [4 * 3600, "4 hours"],
  [86_400, "1 day"],
  [7 * 86_400, "1 week"],
];
const everyLabel = (s: number) => EVERY.find(([v]) => v === s)?.[1] ?? (s % 86_400 === 0 ? `${s / 86_400} days` : `${Math.round(s / 3600)} hours`);

function Dca({ st }: { st: State }) {
  const [token, setToken] = useState<Token | null>(null);
  const [amt, setAmt] = useState("");
  const [count, setCount] = useState(7);
  const [every, setEvery] = useState(86_400);
  const [slip, setSlip] = useState(500);
  const [exact, setExact] = useState(false);
  const lim = engine.orderLimits();
  const sol = parseSol(amt);
  const f = useFunding(sol, token?.program);
  const per = sol ? sol / BigInt(count) : null;
  const small = !!per && per < BigInt(lim.minDcaBuyLamports);
  const everyOk = EVERY.filter(([v]) => v >= lim.minDcaEverySec && v <= lim.maxDcaEverySec);
  const ok = !!token && !!token.program && !!sol && !small && !f.tooMuch && !st.busy;
  return (
    <form
      className="form order-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        await engine
          .placeBuyOrder({ mint: token!.mint, symbol: token!.symbol, decimals: token!.decimals, program: token!.program!, sol: sol!, dca: { count, every, exact }, slippageBps: slip, days: 0 })
          .then((placed) => placed && setAmt(""))
          .catch(() => {});
      }}
    >
      <TokenField token={token} setToken={setToken} />
      <AmountField label="Total to spend" value={amt} onChange={setAmt} hint={`Available: ${fmt(engine.spendable())} SOL`} max={f.max} />
      <Chips label="Buys" value={count} onChange={setCount} options={[[4, "4"], [7, "7"], [14, "14"], [30, "30"]]} />
      <Chips label="Every" value={every} onChange={setEvery} options={everyOk.length ? everyOk : EVERY} />
      {per && !small && (
        <p className="order-sum">
          <strong>{fmt(per, 6)} SOL</strong> of {token?.symbol ?? "the token"} every {everyLabel(every)}, {count} times, starting in about two minutes.
        </p>
      )}
      <details className="trade-set order-more">
        <summary>
          <span>
            Price room <strong>{pct(slip)}</strong>
          </span>
          <span>
            Timing <strong>{exact ? "Exact" : "Varied"}</strong>
          </span>
        </summary>
        <div className="trade-set-body">
          <Chips label="Price room" value={slip} onChange={setSlip} options={ROOM.slice(0, 3)} />
          <Chips
            label="Timing"
            value={exact}
            onChange={setExact}
            options={[
              [false, "Varied"],
              [true, "Exact"],
            ]}
          />
          <p className="muted small">Varied moves each buy a little, up to 30 minutes, so the buys don't keep a fixed rhythm. Exact buys right on time.</p>
        </div>
      </details>
      <FundingRows f={f} />
      {small && <p className="warn">Each buy needs at least {fmt(BigInt(lim.minDcaBuyLamports))} SOL: spend more, or make fewer buys.</p>}
      {f.tooMuch && <TooMuch f={f} st={st} />}
      <button className="btn violet wide" disabled={!ok}>
        {token ? `Start DCA into ${token.symbol}` : "Start DCA"}
      </button>
      <p className="tiny">Buying a little at a time smooths out the price you pay. It runs on its own from a fresh Vision wallet; pause it any time under Orders. {TRUST}</p>
    </form>
  );
}

// ─────────────── sell: now, or take profit / stop loss ───────────────

export function SellTab({ st }: { st: State }) {
  const [mode, setMode] = useState<"now" | "order">("now");
  const offered = !!st.pool?.orders;
  // "Sell" on a holding in the Wallets tab is a sale now
  useEffect(() => onSellFrom(() => setMode("now")), []);
  return (
    <>
      {batchOnTab(st.batch, "sell") && <BatchCard st={st} />}
      {offered && (
        <Seg
          label="How to sell"
          value={mode}
          onChange={setMode}
          options={[
            ["now", "Sell now"],
            ["order", "Take profit / Stop loss"],
          ]}
        />
      )}
      {mode === "now" || !offered ? <SellForm st={st} /> : <SellOrder st={st} />}
    </>
  );
}

type Step = { price: string; pct: string };

/** Take-profit: one price, or up to 4 steps, each selling a share of the order at its own price. */
function TakeProfit({ steps, setSteps, now, at, total, decimals, symbol, max }: { steps: Step[]; setSteps: (s: Step[]) => void; now: number | null; at: number | null; total: bigint | null; decimals: number; symbol: string; max: number }) {
  const set = (i: number, patch: Partial<Step>) => setSteps(steps.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const even = (n: number) => Array.from({ length: n }, (_, k) => String(k === n - 1 ? 100 - Math.floor(100 / n) * (n - 1) : Math.floor(100 / n)));
  const add = () => {
    // a first step left empty starts 25% above today's price; each new one 50% above the last
    const first = steps.length === 1 && !parsePrice(steps[0].price) && now != null ? priceText(now * 1.25) : null;
    const listed = first ? [{ ...steps[0], price: first }] : steps;
    const last = parsePrice(listed[listed.length - 1].price);
    const shares = even(listed.length + 1);
    setSteps([...listed.map((s, k) => ({ ...s, pct: shares[k] })), { price: last != null ? priceText(last * 1.5) : "", pct: shares[listed.length] }]);
  };
  const remove = (i: number) => {
    const rest = steps.filter((_, k) => k !== i);
    if (!rest.length) return setSteps([{ price: "", pct: "100" }]);
    const shares = even(rest.length);
    setSteps(rest.map((s, k) => ({ ...s, pct: rest.length === 1 ? "100" : shares[k] })));
  };
  // one price for all of it (a single step for part of it shows as a step)
  if (steps.length === 1 && Number(steps[0].pct) >= 100) {
    const p = parsePrice(steps[0].price);
    return (
      <>
        <PriceField label="Take profit: sell at or above" value={steps[0].price} onChange={(v) => set(0, { price: v })} now={now} at={at} moves={[25, 50, 100, 200]} />
        {p && total ? <p className="order-sum small">About {usd((Number(total) / 10 ** decimals) * p)} if it sells at {usd(p)}.</p> : null}
        {max > 1 && (
          <button type="button" className="link-btn add-step" onClick={add}>
            Sell in steps instead
          </button>
        )}
      </>
    );
  }
  return (
    <div className="tp-steps">
      <span className="field-top">
        <span>Take profit in steps</span>
        <span className="muted">{nowHint(now, at)}</span>
      </span>
      {steps.map((s, i) => {
        const p = parsePrice(s.price);
        const share = Number(normAmount(s.pct) || 0);
        const part = total && share > 0 ? shareOf(total, share) : null;
        return (
          <div className="tp-step" key={i}>
            <span className="tp-n" aria-hidden="true">
              {i + 1}
            </span>
            <label className="amount tp-price">
              <span className="unit pre">$</span>
              <input
                inputMode="decimal"
                aria-label={`Step ${i + 1} price`}
                placeholder="Price"
                value={s.price}
                autoComplete="off"
                onChange={(e) => {
                  const v = normAmount(e.target.value);
                  if (v != null || e.target.value === "") set(i, { price: v ?? "" });
                }}
              />
            </label>
            <label className="amount tp-pct">
              <input
                inputMode="numeric"
                aria-label={`Step ${i + 1} share of the amount`}
                value={s.pct}
                autoComplete="off"
                onChange={(e) => /^\d{0,3}$/.test(e.target.value) && set(i, { pct: e.target.value })}
              />
              <span className="unit">%</span>
            </label>
            <button type="button" className="tp-del" aria-label={`Remove step ${i + 1}`} onClick={() => remove(i)}>
              ×
            </button>
            {p && part ? (
              <span className="tp-sum small muted">
                {formatUnits(part, decimals, 4)} {symbol} at {usd(p)} ≈ {usd((Number(part) / 10 ** decimals) * p)}
              </span>
            ) : null}
          </div>
        );
      })}
      {steps.length < max && (
        <button type="button" className="link-btn add-step" onClick={add}>
          Add a step
        </button>
      )}
    </div>
  );
}

/** The stop-loss: a fixed price, or one that trails the highest price by a set percentage. */
function StopLoss({
  mode,
  setMode,
  price,
  setPrice,
  trail,
  setTrail,
  now,
  at,
  total,
  decimals,
}: {
  mode: "price" | "trail";
  setMode: (m: "price" | "trail") => void;
  price: string;
  setPrice: (v: string) => void;
  trail: number | null;
  setTrail: (v: number | null) => void;
  now: number | null;
  at: number | null;
  total: bigint | null;
  decimals: number;
}) {
  const p = parsePrice(price);
  return (
    <div className="stop-field">
      <Chips
        label="Stop loss"
        value={mode}
        onChange={setMode}
        options={[
          ["price", "At a price"],
          ["trail", "Trailing"],
        ]}
      />
      {mode === "price" ? (
        <>
          <PriceField label="Sell at or below" value={price} onChange={setPrice} now={now} at={at} moves={[-10, -20, -30, -50]} />
          {p && total ? <p className="order-sum small">About {usd((Number(total) / 10 ** decimals) * p)} if it sells at {usd(p)}.</p> : null}
        </>
      ) : (
        <>
          <Chips label="Trail by" value={trail} onChange={setTrail} options={[[null, "Off"], ...TRAIL]} />
          {trail ? (
            <p className="order-sum small">
              Sells if the price drops {trail}% from its highest point since the order starts{now != null ? `: today that's ${usd(now * (1 - trail / 100))}, and it rises as the price does` : ""}.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Steps as the keeper takes them, or why they can't be. */
function stepsOf(steps: Step[], total: bigint | null): { legs: { tpUsd: number; amount: bigint }[]; problem: string | null } {
  if (steps.length === 1 && Number(steps[0].pct) >= 100) {
    const p = parsePrice(steps[0].price);
    return { legs: p && total ? [{ tpUsd: p, amount: total }] : [], problem: null };
  }
  const parts = steps.map((s) => ({ tpUsd: parsePrice(s.price), pct: Number(s.pct || 0) }));
  if (parts.some((x) => !x.tpUsd || !(x.pct >= 1 && x.pct <= 100))) return { legs: [], problem: "Each step needs a price and a share from 1% to 100%." };
  if (parts.reduce((s, x) => s + x.pct, 0) > 100) return { legs: [], problem: "The steps add up to more than 100%." };
  if (!total) return { legs: [], problem: null };
  return { legs: legsFor(total, parts as { tpUsd: number; pct: number }[]).map((l) => ({ tpUsd: l.tpUsd, amount: BigInt(l.amount) })), problem: null };
}

type Holding = { index: number; mint: string; amount: bigint; decimals: number; program: string };

function SellOrder({ st }: { st: State }) {
  const holdings: Holding[] = st.vision.flatMap((v) =>
    v.tokens.filter((t) => t.mint !== SOL_MINT).map((t) => ({ index: v.index, mint: t.mint, amount: t.amount, decimals: t.decimals, program: t.program })),
  );
  const meta = useTokenMeta(holdings.map((h) => h.mint));
  const [pick, setPick] = useState("");
  const [amt, setAmt] = useState("");
  const [steps, setSteps] = useState<Step[]>([{ price: "", pct: "100" }]);
  const [stopMode, setStopMode] = useState<"price" | "trail">("price");
  const [sl, setSl] = useState("");
  const [trail, setTrail] = useState<number | null>(null);
  const [slip, setSlip] = useState(1000);
  const [slSlip, setSlSlip] = useState<number | null>(null);
  const [days, setDays] = useState<number | null>(30);
  const [tax, setTax] = useState(0);
  const [refused, setRefused] = useState<string | null>(null);
  const lim = engine.orderLimits();
  const h = holdings.find((x) => `${x.index}:${x.mint}` === pick) ?? holdings[0];
  const t = h ? meta[h.mint] : undefined;
  const { now, at, judge, refresh } = useLivePrice(h?.mint, t?.price ?? null);
  const active = useTabActive();
  const taxFor = useRef("");
  const [taxTry, setTaxTry] = useState(0);
  useEffect(() => {
    const key = h ? `${h.mint}:${h.index}` : "";
    if (key !== taxFor.current) setTax(0);
    // the token's own transfer tax, so the note below can be exact; asked once per holding, and not while the tab is hidden
    if (!h || !active || key === taxFor.current) return;
    taxFor.current = key;
    let again: ReturnType<typeof setTimeout> | undefined;
    // (the tax doesn't depend on the amount: a rounded one is asked for, never the exact holding)
    lookup<{ transferFeeBps?: number }>("/api/swap/quote", { inputMint: h.mint, outputMint: SOL_MINT, amount: bucketAmount(h.amount).toString(), slippageBps: 500, side: "sell" })
      .then((q) => taxFor.current === key && setTax(q.transferFeeBps ?? 0))
      .catch(() => {
        // a busy moment: asked again shortly (and whenever the tab is shown again)
        if (taxFor.current !== key) return;
        taxFor.current = "";
        again = setTimeout(() => setTaxTry((n) => n + 1), 10_000);
      });
    return () => clearTimeout(again);
  }, [h?.mint, h?.index, active, taxTry]);
  if (!holdings.length) {
    return (
      <div className="form empty-state">
        <p>Nothing to protect yet.</p>
        <p className="muted">Buy a token privately first. Then set a take-profit, a stop-loss, or both, and they run on their own.</p>
      </div>
    );
  }
  const symbol = t?.symbol ?? short(h?.mint ?? "");
  const total = h ? (amt ? parseUnits(amt, h.decimals) : h.amount) : null;
  const { legs, problem: stepProblem } = stepsOf(steps, total);
  const slP = stopMode === "price" ? parsePrice(sl) : null;
  const trailPct = stopMode === "trail" ? trail : null;
  const lowest = legs.length ? Math.min(...legs.map((l) => l.tpUsd)) : null;
  const live = st.orders.find((o) => (o.status === "active" || o.status === "pending") && o.kind === "sell" && o.vision === h?.index && o.mint === h?.mint);
  const worth = total && h && now ? (Number(total) / 10 ** h.decimals) * now : null;
  const met = metNow("sell", { tp: legs.map((l) => l.tpUsd), sl: slP }, judge);
  const problem =
    stepProblem ??
    (!legs.length && !slP && !trailPct
      ? "Set a take-profit price, a stop-loss, or both."
      : lowest && slP && slP >= lowest
        ? "The stop-loss has to be below the take-profit."
        : total && h && total > h.amount
          ? "That's more than the Vision wallet holds."
          : worth != null && worth < lim.minSellUsd
            ? `Orders start at about $${lim.minSellUsd} worth of tokens; this is about ${usd(worth)}.`
            : met);
  const ok = !!h && !!total && total > 0n && !problem && !st.busy;
  const setShare = (share: bigint) => h && setAmt(raw((h.amount * share) / 100n, h.decimals));
  return (
    <form
      className="form order-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok || !h) return;
        // checked against the price right now, before anything is approved
        const fresh = await refresh();
        const m = metNow("sell", { tp: legs.map((l) => l.tpUsd), sl: slP }, fresh ?? judge);
        setRefused(m);
        if (m) return;
        await engine
          .placeSellOrder({
            vision: h.index,
            mint: h.mint,
            symbol,
            decimals: h.decimals,
            program: h.program,
            amount: total!,
            legs: legs.length ? legs : undefined,
            slUsd: slP ?? undefined,
            trailPct: trailPct ?? undefined,
            slippageBps: slip,
            slSlippageBps: slSlip ?? undefined,
            days: days ?? 30,
          })
          .then((placed) => {
            // kept as typed when the order wasn't placed, so nothing has to be typed again
            if (!placed) return;
            setSteps([{ price: "", pct: "100" }]);
            setSl("");
            setTrail(null);
            setAmt("");
          })
          .catch(() => {});
      }}
    >
      <label className="field">
        <span className="field-top">
          <span>Holding</span>
        </span>
        <select
          className="select"
          value={h ? `${h.index}:${h.mint}` : ""}
          onChange={(e) => {
            setPick(e.target.value);
            setAmt("");
          }}
        >
          {holdings.map((x) => (
            <option key={`${x.index}:${x.mint}`} value={`${x.index}:${x.mint}`}>
              Vision wallet #{x.index + 1} · {formatUnits(x.amount, x.decimals, 4)} {meta[x.mint]?.symbol ?? short(x.mint)}
            </option>
          ))}
        </select>
      </label>
      <div className="field-group">
        <AmountField label="Amount (all of it if empty)" unit={t?.symbol ?? "tokens"} value={amt} onChange={setAmt} max={h ? raw(h.amount, h.decimals) : null} />
        {h && (
          <div className="move-chips" role="group" aria-label="Part of the holding">
            {[25n, 50n, 75n, 100n].map((p) => (
              <button key={String(p)} type="button" className="chip-btn small" onClick={() => setShare(p)}>
                {String(p)}%
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tp-sl">
        <TakeProfit steps={steps} setSteps={(s) => (setSteps(s), setRefused(null))} now={now} at={at} total={total} decimals={h?.decimals ?? 0} symbol={symbol} max={lim.maxLegs} />
        <StopLoss
          mode={stopMode}
          setMode={setStopMode}
          price={sl}
          setPrice={(v) => (setSl(v), setRefused(null))}
          trail={trail}
          setTrail={setTrail}
          now={now}
          at={at}
          total={total}
          decimals={h?.decimals ?? 0}
        />
      </div>
      <OrderMore slip={slip} setSlip={setSlip} slSlip={slSlip} setSlSlip={setSlSlip} days={days} setDays={setDays} />
      {tax > 0 && (
        <p className="muted small tax-note">
          {symbol} charges a {pct(tax)} tax on every transfer. When the order runs it moves the tokens once more, so the tax is paid one extra time.
        </p>
      )}
      {live && <p className="warn">This holding already has a {orderName(live).toLowerCase()}. A new order replaces it; to keep it and change its prices, use Edit under Orders.</p>}
      {(problem || refused) && (steps.some((s) => s.price) || sl || trail || refused) && <p className="warn">{refused ?? problem}</p>}
      <button className="btn violet wide" disabled={!ok}>
        Place order
      </button>
      <p className="tiny">
        {legs.length > 1 ? "Each step sells its share when its price comes. " : slP || trailPct ? "Whichever price comes first sells. " : ""}Your tokens stay in Vision wallet #{(h?.index ?? 0) + 1} until then.
        When it sells, the SOL moves into your private balance by itself the next time VisionSwap is open. {TRUST}
      </p>
    </form>
  );
}

// ─────────────── changing a live order ───────────────

function OrderEdit({ o, st, onClose }: { o: Order; st: State; onClose: () => void }) {
  const left = leftOf(o);
  const open = (o.legs ?? []).filter((l) => !l.filled && l.tpUsd != null);
  const initSteps: Step[] = open.length
    ? open.map((l) => ({ price: priceText(l.tpUsd!), pct: String(left > 0n ? Number((BigInt(l.amount) * 100n + left / 2n) / left) : 100) }))
    : o.tpUsd
      ? [{ price: priceText(o.tpUsd), pct: "100" }]
      : [{ price: "", pct: "100" }];
  const [amt, setAmt] = useState("");
  const [steps, setSteps] = useState<Step[]>(initSteps);
  const [touched, setTouched] = useState(false);
  const [stopMode, setStopMode] = useState<"price" | "trail">(o.trailPct ? "trail" : "price");
  const [sl, setSl] = useState(o.slUsd ? priceText(o.slUsd) : "");
  const [trail, setTrail] = useState<number | null>(o.trailPct ?? null);
  const [buyAt, setBuyAt] = useState(o.buyBelowUsd ? priceText(o.buyBelowUsd) : "");
  const [slip, setSlip] = useState(o.slippageBps);
  const [slSlip, setSlSlip] = useState<number | null>(o.slSlippageBps != null && o.slSlippageBps !== o.slippageBps ? o.slSlippageBps : null);
  const [days, setDays] = useState<number | null>(null);
  const [exact, setExact] = useState(!!o.dca?.exact);
  const [refused, setRefused] = useState<string | null>(null);
  const { now, at, judge, refresh } = useLivePrice(o.kind === "dca" ? null : o.mint, o.lastPrice ?? null);
  const spent = BigInt(o.spent ?? "0");
  // a lower amount: what is left to trade, typed in the token (or SOL)
  const dec = o.kind === "sell" ? o.decimals : 9;
  const newLeft = amt ? parseUnits(amt, dec) : null;
  const tooBig = newLeft != null && newLeft > left;
  const total = newLeft ?? left;
  const { legs, problem: stepProblem } = o.kind === "sell" && touched ? stepsOf(steps, total) : { legs: open.map((l) => ({ tpUsd: l.tpUsd!, amount: BigInt(l.amount) })), problem: null };
  const slP = stopMode === "price" ? parsePrice(sl) : null;
  const trailPct = stopMode === "trail" ? trail : null;
  const buyP = parsePrice(buyAt);
  const patch: OrderPatch = {};
  if (newLeft != null && newLeft !== left) patch.amount = spent + newLeft;
  if (slip !== o.slippageBps) patch.slippageBps = slip;
  if (days != null) patch.days = days;
  if (o.kind === "sell") {
    if (touched) {
      if (legs.length > 1 || (legs.length === 1 && legs[0].amount < total)) patch.legs = legs;
      else if (legs.length === 1) patch.tpUsd = legs[0].tpUsd;
      else if (open.length) patch.legs = [];
    } else if (patch.amount != null) {
      // a lower amount: the steps keep their shares of it (one step for all of it needs nothing)
      const kept = open.map((l) => ({ tpUsd: l.tpUsd!, amount: l.amount }));
      if (stepsKept(kept, left)) patch.legs = shrinkLegs(kept, left, total).map((l) => ({ tpUsd: l.tpUsd, amount: BigInt(l.amount) }));
    }
    if ((slP ?? null) !== (o.slUsd ?? null)) patch.slUsd = slP;
    if ((trailPct ?? null) !== (o.trailPct ?? null)) patch.trailPct = trailPct;
    const curSl = o.slSlippageBps != null && o.slSlippageBps !== o.slippageBps ? o.slSlippageBps : null;
    if (slSlip !== curSl) patch.slSlippageBps = slSlip;
    // "Same" follows the price room: a new price room also clears any stop room the keeper still holds
    else if (slSlip == null && patch.slippageBps != null) patch.slSlippageBps = null;
  }
  if (o.kind === "buy" && buyP && buyP !== o.buyBelowUsd) patch.buyBelowUsd = buyP;
  if (o.kind === "dca" && exact !== !!o.dca?.exact) patch.exact = exact;
  const met =
    o.kind === "buy"
      ? patch.buyBelowUsd != null
        ? metNow("buy", { buyBelow: buyP }, judge)
        : null
      : o.kind === "sell"
        ? metNow("sell", { tp: patch.legs || patch.tpUsd != null ? legs.map((l) => l.tpUsd) : [], sl: patch.slUsd ?? null }, judge)
        : null;
  const lowest = legs.length ? Math.min(...legs.map((l) => l.tpUsd)) : null;
  const problem =
    tooBig
      ? "An order's amount can only go down: its approval covers no more."
      : newLeft === 0n
        ? "To stop it altogether, cancel it instead."
        : (stepProblem ??
          (o.kind === "sell" && !legs.length && !slP && !trailPct
            ? "Keep a take-profit, a stop-loss, or both."
            : lowest && slP && slP >= lowest
              ? "The stop-loss has to be below the take-profit."
              : o.kind === "buy" && !buyP
                ? "Set the price to buy at."
                : met));
  const changed = Object.keys(patch).length > 0;
  const ok = changed && !problem && !st.busy;
  return (
    <form
      className="order-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        if (patch.legs || patch.tpUsd != null || patch.slUsd != null || patch.buyBelowUsd != null) {
          const fresh = await refresh();
          const m =
            o.kind === "buy"
              ? metNow("buy", { buyBelow: buyP }, fresh ?? judge)
              : metNow("sell", { tp: patch.legs || patch.tpUsd != null ? legs.map((l) => l.tpUsd) : [], sl: patch.slUsd ?? null }, fresh ?? judge);
          setRefused(m);
          if (m) return;
        }
        const done = await engine.updateOrder(o.id, patch).catch(() => false);
        if (done) onClose();
      }}
    >
      {o.kind !== "dca" && (
        <AmountField
          label={`Amount left (now ${o.kind === "sell" ? formatUnits(left, o.decimals, 4) : fmt(left)}; lower only)`}
          unit={o.kind === "sell" ? o.symbol : "SOL"}
          value={amt}
          onChange={setAmt}
          placeholder={o.kind === "sell" ? raw(left, o.decimals) : raw(left, 9)}
        />
      )}
      {o.kind === "sell" && (
        <div className="tp-sl">
          <TakeProfit steps={steps} setSteps={(s) => (setSteps(s), setTouched(true), setRefused(null))} now={now} at={at} total={total} decimals={o.decimals} symbol={o.symbol} max={engine.orderLimits().maxLegs} />
          <StopLoss mode={stopMode} setMode={setStopMode} price={sl} setPrice={(v) => (setSl(v), setRefused(null))} trail={trail} setTrail={setTrail} now={now} at={at} total={total} decimals={o.decimals} />
        </div>
      )}
      {o.kind === "buy" && <PriceField label="Buy when the price is at or below" value={buyAt} onChange={(v) => (setBuyAt(v), setRefused(null))} now={now} at={at} moves={[-5, -10, -20, -30]} />}
      {o.kind === "dca" ? (
        <>
          <Chips label="Price room" value={slip} onChange={setSlip} options={ROOM.slice(0, 3)} />
          <Chips
            label="Timing"
            value={exact}
            onChange={setExact}
            options={[
              [false, "Varied"],
              [true, "Exact"],
            ]}
          />
        </>
      ) : (
        <OrderMore
          slip={slip}
          setSlip={setSlip}
          slSlip={o.kind === "sell" ? slSlip : undefined}
          setSlSlip={o.kind === "sell" ? setSlSlip : undefined}
          days={days}
          setDays={setDays}
          keep={`as is (${o.expires > Date.now() ? `ends ${inTime(o.expires)}` : "ending"})`}
        />
      )}
      {(problem || refused) && (changed || refused) && <p className="warn">{refused ?? problem}</p>}
      <div className="order-edit-actions">
        <button className="btn violet" disabled={!ok}>
          Save changes
        </button>
        <button type="button" className="link-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="tiny">Changes apply straight away, with no new approval. Prices are checked against today's.</p>
    </form>
  );
}

// ─────────────── the orders panel ───────────────

const ORDER_STATUS: Record<Order["status"], [string, string]> = {
  pending: ["Starting", "wait"],
  active: ["Live", "wait"],
  filled: ["Filled", "good"],
  cancelled: ["Cancelled", "mute"],
  expired: ["Expired", "mute"],
  failed: ["Stopped", "bad"],
  unknown: ["Unknown", "mute"],
};

const when = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A thin bar for how far an order has got. */
function Progress({ done, of }: { done: number; of: number }) {
  const w = of > 0 ? Math.min(100, Math.round((done / of) * 100)) : 0;
  return (
    <span className="order-bar" role="progressbar" aria-valuemin={0} aria-valuemax={of} aria-valuenow={done}>
      <i style={{ width: `${w}%` }} />
    </span>
  );
}

/** The facts of an order, a short line each. */
function facts(o: Order): string[] {
  const out: string[] = [];
  if (o.kind === "sell") {
    const legs = o.legs ?? [];
    // after a hand-back the keeper's steps count from what it took over, not the whole amount
    const before = o.base?.legs.length ?? 0;
    const took = BigInt(o.amount) - BigInt(o.base?.spent ?? "0");
    const single = legs.length === 1 && before === 0 && BigInt(legs[0].amount) >= took;
    if (legs.length > 1 || (legs.length === 1 && !single)) {
      const total = BigInt(o.amount);
      out.push(
        "Take profit " +
          legs
            .filter((l) => l.tpUsd != null)
            .map((l) => `${usd(l.tpUsd)} (${total > 0n ? Number((BigInt(l.amount) * 100n) / total) : 0}%)${l.filled ? " ✓" : ""}`)
            .join(" · "),
      );
    } else if (o.tpUsd) out.push(`Take profit at ${usd(o.tpUsd)}`);
    if (o.trailPct) out.push(`Trailing stop ${o.trailPct}%${o.stop ? ` · sells below ${usd(o.stop)}` : ""}`);
    if (o.slUsd) out.push(`Stop loss at ${usd(o.slUsd)}`);
    const sl = o.slSlippageBps != null && o.slSlippageBps !== o.slippageBps ? `, stop ${pct(o.slSlippageBps)}` : "";
    out.push(`Price room ${pct(o.slippageBps)}${sl}`);
  } else if (o.kind === "buy") {
    out.push(`Buys at or below ${usd(o.buyBelowUsd)} · price room ${pct(o.slippageBps)}`);
  } else if (o.dca) {
    out.push(`Every ${everyLabel(o.dca.every)} · price room ${pct(o.slippageBps)}${o.dca.exact ? " · exact times" : ""}`);
  }
  return out;
}

function OrderRow({ o, st, editing, setEditing }: { o: Order; st: State; editing: boolean; setEditing: (on: boolean) => void }) {
  const live = o.status === "active" || o.status === "pending";
  const paused = o.status === "active" && !!o.dca?.paused;
  const [label, tone] = paused ? ["Paused", "mute"] : ORDER_STATUS[o.status];
  const left = engine.orderLeft(o);
  // ended with its permission, or a buy's SOL, still in the Vision wallet: one tap cleans up
  const cleanup = !live && (left.permission || (o.kind !== "sell" && left.sol > 0n));
  const n = o.vision + 1;
  const amount = o.kind === "sell" ? `${formatUnits(BigInt(o.amount), o.decimals, 4)} ${o.symbol}` : `${fmt(BigInt(o.amount))} SOL`;
  const stats = fillStats(o);
  const legs = o.legs ?? [];
  const steps = legs.length > 1 ? { done: legs.filter((l) => l.filled).length, of: legs.length } : o.dca ? { done: o.dca.done, of: o.dca.count } : null;
  const priced = o.status === "active" && o.kind !== "dca";
  const side = priced
    ? o.noPriceSince
      ? `no price since ${ago(o.noPriceSince)}`
      : `now ${usd(o.lastPrice)}${o.priceAt ? ` · ${ago(o.priceAt)}` : ""}`
    : o.kind === "dca" && o.status === "active" && !paused && o.dca
      ? `next buy ${inTime(o.dca.next)}`
      : null;
  const stage = stageText(o);
  const note = o.settling
    ? "A trade was already on its way when it was cancelled. If it lands, this order shows as filled."
    : o.status === "pending"
      ? o.approveSig || o.base
        ? "Its approval is in. It starts by itself in a moment."
        : "Waiting for its approval to land. If it doesn't, cancel it."
      : o.error && o.status !== "filled"
        ? o.error
        : stage;
  const ends = live ? (o.expires > Date.now() ? `Ends ${inTime(o.expires)}` : "Ending now") : null;
  return (
    <li className={`job order-row ${tone}`}>
      <div className="job-main">
        <strong>
          {orderName(o)} · {o.symbol}
        </strong>
        <span className="small muted">
          {amount} · Vision wallet #{n}
        </span>
      </div>
      <div className="job-side">
        <span className={`job-chip ${tone}`}>{label}</span>
        {side && <span className="small muted">{side}</span>}
      </div>
      <div className="order-facts small muted">
        {facts(o).map((f) => (
          <span key={f}>{f}</span>
        ))}
        {steps && (
          <span className="order-progress">
            <Progress done={steps.done} of={steps.of} />
            {o.dca ? `${steps.done}/${steps.of} buys` : `${steps.done}/${steps.of} steps`}
          </span>
        )}
        {ends && <span>{ends}</span>}
      </div>
      {note && <p className="small muted job-note">{note}</p>}
      {o.fills.length > 0 && (
        <details className="order-fills">
          <summary className="small">
            {o.fills.length === 1 ? "1 fill" : `${o.fills.length} fills`}
            {stats.avgUsd != null ? ` · average ${usd(stats.avgUsd)}` : stats.avgSol != null ? ` · average ${stats.avgSol.toPrecision(3)} SOL each` : ""}
          </summary>
          <ul>
            {o.fills.map((f) => {
              const s = /^\d+$/.test(f.spent) ? BigInt(f.spent) : null;
              const g = /^\d+$/.test(f.got) ? BigInt(f.got) : null;
              const what =
                s == null || g == null
                  ? "Traded"
                  : o.kind === "sell"
                    ? `Sold ${formatUnits(s, o.decimals, 4)} ${o.symbol} for ${fmt(g, 6)} SOL`
                    : `Spent ${fmt(s, 6)} SOL for ${formatUnits(g, o.decimals, 4)} ${o.symbol}`;
              return (
                <li key={f.sig}>
                  <span>
                    {when(f.t)} · {what}
                    {f.priceUsd != null ? ` at ${usd(f.priceUsd)}` : ""}
                  </span>
                  {st.pool && <CopyFill sig={f.sig} network={st.pool.network} />}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <div className="job-actions">
        {o.status === "active" && !o.settling && (
          <button type="button" className="link-btn" disabled={!!st.busy} aria-expanded={editing} onClick={() => setEditing(!editing)}>
            {editing ? "Close" : o.kind === "dca" ? "Settings" : "Edit"}
          </button>
        )}
        {o.status === "active" && o.dca && (
          <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => engine.pauseOrder(o.id, !paused).catch(() => {})}>
            {paused ? "Resume" : "Pause"}
          </button>
        )}
        {live && (
          <ConfirmButton
            label="Cancel"
            ask={
              o.kind === "sell"
                ? `Cancel the ${orderName(o).toLowerCase()} on ${o.symbol}? Its permission is removed, and the tokens stay in Vision wallet #${n}.`
                : `Cancel the ${orderName(o).toLowerCase()} into ${o.symbol}? Its permission is removed, and its SOL goes back to your private balance.`
            }
            yes="Yes, cancel it"
            disabled={!!st.busy}
            onYes={() => void engine.cancelOrder(o.id, o.kind !== "sell").catch(() => {})}
          />
        )}
        {cleanup && (
          <button type="button" className="link-btn" disabled={!!st.busy} onClick={() => engine.cancelOrder(o.id, o.kind !== "sell").catch(() => {})}>
            {o.kind === "sell" ? "Remove its permission" : "Get SOL back"}
          </button>
        )}
        {/* a sale's SOL still to move home keeps its row until it has */}
        {!live && !cleanup && !o.settling && !o.sweep && (
          <button type="button" className="link-btn" onClick={() => engine.dismissOrder(o.id)}>
            Dismiss
          </button>
        )}
      </div>
      {editing && o.status === "active" && <OrderEdit o={o} st={st} onClose={() => setEditing(false)} />}
    </li>
  );
}

/** An order permission on one of this account's Vision wallets that no order on this device stands for. */
function PermissionRow({ p, st, symbol }: { p: ReturnType<typeof engine.orderPermissions>[number]; st: State; symbol: string }) {
  const sol = p.mint === SOL_MINT;
  const n = p.vision + 1;
  const what = sol ? `${fmt(p.amount)} SOL` : `${formatUnits(p.amount, p.decimals, 4)} ${symbol}`;
  return (
    <li className="job order-row wait">
      <div className="job-main">
        <strong>{p.ours ? (sol ? "Buy order from this account" : `Order from this account · ${symbol}`) : `Order permission · ${sol ? "SOL" : symbol}`}</strong>
        <span className="small muted">
          May trade {what} · Vision wallet #{n}
        </span>
      </div>
      <div className="job-side">
        <span className="job-chip wait">{p.ours ? "Live" : "Set"}</span>
      </div>
      <p className="small muted job-note">
        {p.ours
          ? "An order placed from this account on another device, or before this browser's data was cleared. You can cancel it here."
          : "An order permission this device has no record of. If no order of yours should be running here, remove it."}
      </p>
      <div className="job-actions">
        <ConfirmButton
          label={sol ? "Cancel and get SOL back" : p.ours ? "Cancel it" : "Remove its permission"}
          ask={
            sol
              ? `Cancel the order in Vision wallet #${n}? Its permission is removed, and its SOL goes back to your private balance.`
              : `Cancel the order on ${symbol} in Vision wallet #${n}? Its permission is removed, and the tokens stay there.`
          }
          yes="Yes, cancel it"
          disabled={!!st.busy}
          onYes={() => void engine.removePermission(p.vision, p.account, sol).catch(() => {})}
        />
      </div>
    </li>
  );
}

export function OrdersPanel({ st }: { st: State }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [, tick] = useState(0);
  const perms = st.unlocked ? engine.orderPermissions() : [];
  const meta = useTokenMeta(perms.map((p) => p.mint).filter((m) => m !== SOL_MINT));
  const live = st.orders.filter((o) => o.status === "active" || o.status === "pending").length;
  // "checked 8 s ago" and "next buy in 3 h" keep moving
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((x) => x + 1), 10_000);
    return () => clearInterval(t);
  }, [live]);
  if (!st.orders.length && !perms.length) return null;
  return (
    <section className="panel">
      <header>
        <h3>Orders</h3>
        <span className="muted">{live + perms.length ? `${live + perms.length} live` : "None live"}</span>
      </header>
      <ul className="jobs orders">
        {st.orders.map((o) => (
          <OrderRow key={o.id} o={o} st={st} editing={editing === o.id} setEditing={(on) => setEditing(on ? o.id : null)} />
        ))}
        {perms.map((p) => (
          <PermissionRow key={p.account} p={p} st={st} symbol={meta[p.mint]?.symbol ?? short(p.mint)} />
        ))}
      </ul>
      <p className="tiny">Orders run on their own, even with this page closed. Each one can only trade what it set aside, into its own Vision wallet. A sale's SOL moves into your private balance by itself whenever VisionSwap is open.</p>
    </section>
  );
}

function CopyFill({ sig, network }: { sig: string; network: string }) {
  const [shown, setShown] = useState<string | null>(null);
  return (
    <button
      type="button"
      className="link-btn"
      onClick={async () => {
        setShown((await copyText(explorer(sig, network))) ? "Copied" : "Couldn't copy");
        setTimeout(() => setShown(null), 1600);
      }}
    >
      {shown ?? "Copy fill link"}
    </button>
  );
}

export { TokenIcon };
