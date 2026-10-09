import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../lib/net";

export type Token = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  icon: string | null;
  price: number | null;
  verified: boolean;
  organic: string | null;
  mcap?: number | null;
  liquidity?: number | null;
  program?: string | null;
};

const SOL_MINT = "So11111111111111111111111111111111111111112";

export function TokenIcon({ t, size = 28 }: { t: Pick<Token, "icon" | "symbol"> | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!t) return <span className="tok-icon empty" style={{ width: size, height: size }} />;
  if (!t.icon || broken)
    return (
      <span className="tok-icon mono" style={{ width: size, height: size, fontSize: size * 0.38 }}>
        {t.symbol.slice(0, 3)}
      </span>
    );
  return <img className="tok-icon" src={t.icon} alt="" width={size} height={size} onError={() => setBroken(true)} loading="lazy" />;
}

export function TokenPicker({ value, onChange }: { value: Token | null; onChange: (t: Token) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // the list on screen and the search it answers: Enter only picks from an answer to what's typed now
  const [list, setList] = useState<{ forQ: string; items: Token[] }>({ forQ: "", items: [] });
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const listId = `${id}-list`;
  const optId = (i: number) => `${id}-opt-${i}`;

  const close = (refocus: boolean) => {
    setOpen(false);
    setQ("");
    if (refocus) trigger.current?.focus();
  };
  const choose = (t: Token) => {
    onChange(t);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    setList({ forQ: " ", items: [] }); // (a trimmed search never starts with a space)
    input.current?.focus();
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let dead = false;
    const asked = q.trim();
    const t = setTimeout(async () => {
      setLoading(true);
      setErr(null);
      try {
        const r = asked ? await api<Token[]>(`/api/tokens/search?q=${encodeURIComponent(asked)}`) : await api<Token[]>("/api/tokens/top");
        if (!dead) {
          setList({ forQ: asked, items: r.filter((x) => x.mint !== SOL_MINT).slice(0, 40) });
          setActive(0);
        }
      } catch (e) {
        if (!dead) setErr((e as Error).message);
      } finally {
        if (!dead) setLoading(false);
      }
    }, q ? 250 : 0);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [q, open]);

  // the highlighted row stays in view while moving with the arrow keys (only then: a resting pointer
  // never scrolls the list, and the page itself never moves)
  const byKey = useRef(false);
  useEffect(() => {
    if (!open || !byKey.current) return;
    byKey.current = false;
    const row = document.getElementById(optId(active));
    const lst = row?.closest(".tok-list") as HTMLElement | null;
    if (!row || !lst) return;
    const top = row.offsetTop - lst.offsetTop;
    if (top < lst.scrollTop) lst.scrollTop = top;
    else if (top + row.offsetHeight > lst.scrollTop + lst.clientHeight) lst.scrollTop = top + row.offsetHeight - lst.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  const current = !loading && list.forQ === q.trim();
  const items = list.items;
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      // never the form's own Enter: that would trade the token chosen before
      e.preventDefault();
      if (current && items.length) choose(items[Math.min(active, items.length - 1)]);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      byKey.current = true;
      if (items.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  return (
    <div className="tok-picker" ref={box}>
      <button ref={trigger} type="button" className={`tok-btn ${value ? "" : "empty"}`} onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <TokenIcon t={value} />
        <span className="tok-btn-sym">{value ? value.symbol : "Choose a token"}</span>
        <i className="chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="tok-pop">
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search by name, symbol or address"
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="search"
            role="combobox"
            aria-label="Search for a token"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items.length ? optId(Math.min(active, items.length - 1)) : undefined}
          />
          <div className="tok-list">
            <div role="status" aria-live="polite">
              {loading && <p className="tok-note">Looking…</p>}
              {err && <p className="tok-note bad">{err}</p>}
              {!loading && !err && current && items.length === 0 && <p className="tok-note">Nothing found. Paste the token's address to be sure.</p>}
            </div>
            <div id={listId} role="listbox" aria-label="Tokens">
              {items.map((t, i) => (
                <div
                  key={t.mint}
                  id={optId(i)}
                  role="option"
                  aria-selected={i === active}
                  className={`tok-row${i === active ? " on" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(t)}
                >
                  <TokenIcon t={t} size={32} />
                  <span className="tok-names">
                    <strong>
                      {t.symbol}
                      {t.verified && <em className="verified" title="Verified by Jupiter" />}
                    </strong>
                    <small>{t.name}</small>
                  </span>
                  <span className="tok-mint mono">
                    {t.mint.slice(0, 4)}…{t.mint.slice(-4)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
