import { useState } from "react";
import { engine, type State } from "../../web/src/lib/engine";
import { formatUnits } from "../../web/src/lib/net";
import { sellFromVision } from "../../web/src/lib/buyfrom";
import { TokenIcon } from "../../web/src/components/app/TokenPicker";
import { Sheet } from "../../web/src/components/app/Sheet";
import { usePortfolio } from "../../web/src/lib/portfolio-hook";
import { assetSub, assetTitle, centsText, flightText, type Asset, type Cents, type Flight } from "../../web/src/lib/portfolio";
import { useMasked } from "../../web/src/lib/masked";
import { MASK, fmtUsd, maskText, solStr } from "../../web/src/lib/money";
import { walletName } from "../../web/src/lib/vwallets";
import { Glyph, type GlyphName } from "./Glyph";
import { NetBadge, type Screen } from "./parts";

const clock = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString("en-US", today ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
};

const ago = (t: number) => {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const tokensWord = (k: number) => `${k} token${k === 1 ? "" : "s"}`;
/** A token's price in words: "$0.52", "$0.0000221" (three figures, never a power of ten). */
const priceText = (p: number) => `$${p >= 1 ? p.toLocaleString("en-US", { maximumFractionDigits: 2 }) : p.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;

const ACTIONS: [Screen, string, GlyphName][] = [
  ["receive", "Receive", "receive"],
  ["send", "Send", "send"],
  ["swap", "Swap", "swap"],
  ["wallets", "Wallets", "wallets"],
];

const KIND_GLYPH: Record<State["activity"][number]["kind"], GlyphName> = {
  shield: "shield",
  sweep: "shield",
  merge: "shield",
  refund: "shield",
  send: "send",
  buy: "swap",
  sell: "swap",
};

/**
 * Home: the total value of everything the account holds (never a bare 0 while money is on its way),
 * what's on its way, the four main actions, the assets behind the total, and the latest activity.
 */
export function Home({ st, go }: { st: State; go: (s: Screen) => void }) {
  const p = usePortfolio(st, { fetch: true });
  const [masked, setMasked] = useMasked();
  const [mint, setMint] = useState<string | null>(null);
  const token = mint ? (p.assets.find((a) => a.key === "token" && a.mint === mint) as Extract<Asset, { key: "token" }> | undefined) : undefined;
  // the rows' dollar figures, rounded once for every screen so they add up to the total shown above them (to the cent,
  // while the total shows cents: from $10,000 it shows whole dollars, and each row is simply rounded)
  const cents = p.cents.rows;
  const big = masked ? (p.usd != null ? `$${MASK}` : `${MASK} SOL`) : p.cents.total != null ? fmtUsd(p.cents.total / 100) : `${solStr(p.sol)} SOL`;
  const size = big.length <= 8 ? "" : big.length <= 11 ? " l2" : " l3";
  const kinds = p.assets.filter((a) => a.key === "token").length;
  // (an empty account: the start card says what to do; no "≈ 0 SOL" under the 0)
  const second = p.empty
    ? ""
    : p.usd != null
      ? `≈ ${masked ? MASK : solStr(p.solEq ?? 0)} SOL${p.unpriced ? ` · ${tokensWord(p.unpriced)} without a price` : ""}`
      : kinds
        ? `+ ${tokensWord(kinds)}`
        : "";
  const pct = st.total > 0 ? Math.min(99, Math.floor((st.synced / st.total) * 100)) : null;
  const show = (s: string) => (masked ? maskText(s) : s);
  return (
    <>
      <NetBadge st={st} />
      <section className="ext-hero" aria-label="Total value">
        <div className="ext-hero-top">
          <span className="ext-eyebrow">Total value</span>
          <button type="button" className="ext-eye" aria-label="Hide amounts" aria-pressed={masked} onClick={() => setMasked(!masked)}>
            <Glyph name={masked ? "eyeOff" : "eye"} />
          </button>
        </div>
        {p.loading ? (
          <>
            <span className="skel ext-bal-skel" aria-hidden="true" />
            <span className="skel ext-usd-skel" aria-hidden="true" />
          </>
        ) : (
          <>
            <strong className={`ext-bal num${size}`}>{big}</strong>
            <span className="ext-usd">{second || " "}</span>
          </>
        )}
        <ul className="ext-under small">
          {p.loading ? (
            <li>
              Reading your private balance…{pct != null ? ` ${pct}%` : ""}
            </li>
          ) : p.flights.length ? (
            <>
              {p.flights.slice(0, 2).map((f) => (
                <FlightLine key={f.kind} f={f} text={show(flightText(f, clock))} go={go} />
              ))}
              {p.flights.length > 2 && (
                <li>
                  <button type="button" className="link-btn" onClick={() => go("activity")}>
                    + {p.flights.length - 2} more in Activity
                  </button>
                </li>
              )}
            </>
          ) : (
            <li>Only you can see your private balance.</li>
          )}
        </ul>
      </section>
      {p.empty && (
        <div className="ext-empty-card">
          <strong>Add SOL to get started</strong>
          <p className="small muted">Receive SOL by QR code from any wallet or exchange. It joins your private balance in about {engine.waitLabel()}.</p>
          <button type="button" className="btn violet wide" onClick={() => go("receive")}>
            Receive SOL
          </button>
        </div>
      )}
      <div className="ext-actions">
        {ACTIONS.map(([s, label, icon]) => (
          <button key={s} type="button" className="ext-act" onClick={() => go(s)}>
            <span className="ext-ring">
              <Glyph name={icon} />
            </span>
            <span>{label}</span>
          </button>
        ))}
      </div>
      {!p.empty && !p.loading && (
        <section className="ext-list" aria-label="Assets">
          <h3 className="ext-h3">Assets</h3>
          {p.assets.map((a, k) => (
            <AssetRow
              key={a.key === "token" ? a.mint : a.key}
              a={a}
              usd={centsText(cents[k], a.usd)}
              masked={masked}
              test={p.usd == null && st.pool?.network !== "mainnet"}
              go={go}
              openToken={setMint}
            />
          ))}
        </section>
      )}
      {!p.empty && <Recent st={st} go={go} masked={masked} />}
      {token && <TokenSheet t={token} cents={cents[p.assets.indexOf(token)] ?? null} held={p.cents.held} masked={masked} onClose={() => setMint(null)} go={go} />}
    </>
  );
}

function FlightLine({ f, text, go }: { f: Flight; text: string; go: (s: Screen) => void }) {
  const body = (
    <>
      <Glyph name="clock" size={14} className="ext-under-ico" />
      <span>{text}</span>
    </>
  );
  // money joining, or moving in from a deposit address: its progress is under Activity
  return f.kind === "joining" || f.kind === "address" ? (
    <li>
      <button type="button" className="ext-flight" onClick={() => go("activity")}>
        {body}
      </button>
    </li>
  ) : (
    <li className="ext-flight">{body}</li>
  );
}

const ROW_GLYPH: Record<Exclude<Asset["key"], "token">, GlyphName> = {
  private: "shield",
  joining: "clock",
  address: "receive",
  landing: "wallets",
  vision: "wallets",
  held: "alert",
};

/** One line of the assets list: what it is and where, then its value (or amount, with no price). */
function AssetRow({
  a,
  usd,
  masked,
  test,
  go,
  openToken,
}: {
  a: Asset;
  /** its dollar figure as shown (null: no price, or a test network) */
  usd: string | null;
  masked: boolean;
  /** a test network: no dollar values at all */
  test: boolean;
  go: (s: Screen) => void;
  openToken: (mint: string) => void;
}) {
  const sub = masked ? maskText(assetSub(a)) : assetSub(a);
  const amount = a.key === "token" ? `${masked ? MASK : formatUnits(a.amount, a.decimals, 4)} ${a.symbol ?? ""}`.trim() : `${masked ? MASK : solStr(a.sol)} SOL`;
  const value = usd != null ? (masked ? MASK : `≈ ${usd}`) : null;
  const top = value ?? amount;
  const bottom = value ? amount : a.key === "token" && !test ? "No price yet" : "";
  const tap =
    a.key === "token"
      ? () => openToken(a.mint)
      : a.key === "joining" || a.key === "address" || a.key === "held"
        ? () => go("activity")
        : a.key === "landing" || a.key === "vision"
          ? () => go("wallets")
          : null;
  const inner = (
    <>
      {a.key === "token" ? (
        <TokenIcon t={{ icon: a.icon, symbol: a.symbol ?? a.mint.slice(0, 3) }} size={36} />
      ) : (
        <span className={`ext-coin${a.key === "held" ? " warn" : ""}`} aria-hidden="true">
          <Glyph name={ROW_GLYPH[a.key]} size={20} />
        </span>
      )}
      <span className="ext-item-main">
        <strong>{assetTitle(a)}</strong>
        <span className="ext-item-sub">{sub}</span>
      </span>
      <span className="ext-item-side">
        <strong className="num">{top}</strong>
        {bottom && <span className="ext-item-sub">{bottom}</span>}
      </span>
      {tap && <Glyph name="chevron" size={16} className="ext-item-chev" />}
      {a.key === "joining" && (
        <span className="ext-item-bar" aria-hidden="true">
          <i style={{ width: `${Math.round(a.progress * 100)}%` }} />
        </span>
      )}
    </>
  );
  return tap ? (
    <button type="button" className={`ext-item ext-asset ${a.key}`} onClick={tap}>
      {inner}
    </button>
  ) : (
    <div className={`ext-item ext-asset ${a.key}`}>{inner}</div>
  );
}

/** A token held across the Vision wallets: how much, its price, and each wallet holding it with Sell. */
function TokenSheet({
  t,
  cents: rowCents,
  held,
  masked,
  onClose,
  go,
}: {
  t: Extract<Asset, { key: "token" }>;
  /** its dollar figure in cents, as the assets list shows it */
  cents: number | null;
  /** each wallet's share, as every screen shows it (adding up to the figure above) */
  held: Cents["held"];
  masked: boolean;
  onClose: () => void;
  go: (s: Screen) => void;
}) {
  const sym = t.symbol ?? `${t.mint.slice(0, 4)}…`;
  const names = engine.visionNames();
  const usd = centsText(rowCents, t.usd);
  return (
    <Sheet
      title={sym}
      icon={<TokenIcon t={{ icon: t.icon, symbol: t.symbol ?? t.mint.slice(0, 3) }} size={28} />}
      onClose={onClose}
      className="ext-token-sheet"
      footer={
        <button
          type="button"
          className="btn ghost wide"
          onClick={() => {
            onClose();
            go("wallets");
          }}
        >
          Open Wallets
        </button>
      }
    >
      <p className="ext-tok-total">
        <strong className="num">
          {masked ? MASK : formatUnits(t.amount, t.decimals, 4)} {sym}
        </strong>
        {usd != null && <span className="muted"> {masked ? MASK : `≈ ${usd}`}</span>}
      </p>
      <p className="small muted">{t.price != null ? `Price ≈ ${priceText(t.price)} (from the last price check)` : "No price yet"}</p>
      <h4 className="ext-tok-h">Held in</h4>
      <ul className="ext-tok-list">
        {t.wallets.map((w) => (
          <li key={w.index}>
            <span className="ext-tok-who">
              <strong>{walletName(w.index)}</strong>
              {names[w.index] && <span className="muted small"> · {names[w.index]}</span>}
              <span className="small muted ext-tok-amt">
                {masked ? MASK : formatUnits(w.amount, t.decimals, 4)}
                {w.usd != null && (masked ? "" : ` · ≈ ${centsText(held.get(`${w.index}:${t.mint}`) ?? null, w.usd)}`)}
              </span>
            </span>
            <button
              type="button"
              className="btn ghost small-btn"
              aria-label={`Sell ${sym} from ${walletName(w.index)}`}
              onClick={() => {
                onClose();
                sellFromVision(w.index, t.mint);
              }}
            >
              Sell
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function Recent({ st, go, masked }: { st: State; go: (s: Screen) => void; masked: boolean }) {
  const items = st.activity.slice(0, 3);
  if (!items.length) return null;
  return (
    <section className="ext-list" aria-label="Recent activity">
      <div className="ext-list-top">
        <h3 className="ext-h3">Recent activity</h3>
        <button type="button" className="link-btn" onClick={() => go("activity")}>
          See all
        </button>
      </div>
      <ul className="ext-recent">
        {items.map((a) => (
          <li key={a.t + a.text}>
            <span className="a-ico" aria-hidden="true">
              <Glyph name={KIND_GLYPH[a.kind]} size={18} />
            </span>
            <span className="ext-recent-text">{masked ? maskText(a.text) : a.text}</span>
            <span className="ext-recent-when">{ago(a.t)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
