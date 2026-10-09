import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
  type ConfirmedSignatureInfo,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { jget, WAIT } from "./jupiter.ts";
import { prices as bookPrices } from "./pricebook.ts";

/**
 * "What can a stranger learn from this address?" Everything here comes from
 * public RPC data. Nothing is stored; results are cached in memory briefly.
 */

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SOL_MINT = "So11111111111111111111111111111111111111112";

export type Finding = { level: "high" | "med" | "low"; text: string };

export type ExposureReport = {
  address: string;
  checkedAt: number;
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

type TokenMeta = { symbol: string | null; name: string | null };

async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((res) => (t = setTimeout(() => res(fallback), ms)));
  try {
    return await Promise.race([p, timer]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function getJson<T>(url: string, ms = 6000): Promise<T | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    clearTimeout(t);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** USD prices from the shared price book; prices are decoration here, so a busy Jupiter just leaves them out. */
async function prices(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const got = await bookPrices(mints, { maxAgeMs: 5 * 60_000, lane: "background", maxWaitMs: WAIT.search });
  for (const [k, v] of Object.entries(got)) if (v) out[k] = v.usd;
  return out;
}

async function tokenMeta(mints: string[]): Promise<Record<string, TokenMeta>> {
  const out: Record<string, TokenMeta> = {};
  for (let i = 0; i < mints.length; i += 100) {
    const q = mints.slice(i, i + 100).join(",");
    try {
      const list = await jget<{ id: string; symbol?: string; name?: string }[]>(`/tokens/v2/search?query=${encodeURIComponent(q)}`, {
        lane: "background",
        maxWaitMs: WAIT.search,
      });
      for (const t of list) out[t.id] = { symbol: t.symbol ?? null, name: t.name ?? null };
    } catch {
      /* optional */
    }
  }
  return out;
}

function solTransfersInto(tx: ParsedTransactionWithMeta, to: string): { from: string; lamports: number }[] {
  const out: { from: string; lamports: number }[] = [];
  const all = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  for (const ix of all) {
    if (!("parsed" in ix) || ix.program !== "system") continue;
    const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
    if ((p.type === "transfer" || p.type === "transferWithSeed") && p.info?.destination === to) {
      out.push({ from: String(p.info.source), lamports: Number(p.info.lamports ?? 0) });
    }
    if (p.type === "createAccount" && p.info?.newAccount === to) {
      out.push({ from: String(p.info.source), lamports: Number(p.info.lamports ?? 0) });
    }
  }
  return out;
}

function counterpartiesOf(tx: ParsedTransactionWithMeta, me: string): string[] {
  const seen = new Set<string>();
  const all = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
  ];
  for (const ix of all) {
    if (!("parsed" in ix)) continue;
    const p = ix.parsed as { type?: string; info?: Record<string, unknown> };
    if (ix.program === "system" && p.type === "transfer") {
      const s = String(p.info?.source);
      const d = String(p.info?.destination);
      if (s === me && d !== me) seen.add(d);
      if (d === me && s !== me) seen.add(s);
    }
  }
  // token movements: owners whose balance moved the opposite way to ours
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const delta = new Map<string, number>();
  for (const b of post) {
    const before = pre.find((x) => x.accountIndex === b.accountIndex);
    const d = Number(b.uiTokenAmount.uiAmount ?? 0) - Number(before?.uiTokenAmount.uiAmount ?? 0);
    if (b.owner) delta.set(`${b.owner}:${b.mint}`, (delta.get(`${b.owner}:${b.mint}`) ?? 0) + d);
  }
  for (const [k, d] of delta) {
    const [owner, mint] = k.split(":");
    if (owner === me || d === 0) continue;
    const mine = delta.get(`${me}:${mint}`) ?? 0;
    if (mine !== 0 && Math.sign(mine) !== Math.sign(d)) seen.add(owner);
  }
  return [...seen];
}

const cache = new Map<string, { at: number; report: ExposureReport }>();
const inflight = new Map<string, Promise<ExposureReport>>();

export async function exposure(conn: Connection, address: string, opts: { programIgnore?: Set<string> } = {}): Promise<ExposureReport> {
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.report;
  // the same address checked twice at once is read once
  let p = inflight.get(address);
  if (!p) {
    p = check(conn, address, opts).finally(() => inflight.delete(address));
    inflight.set(address, p);
  }
  return p;
}

async function check(conn: Connection, address: string, opts: { programIgnore?: Set<string> }): Promise<ExposureReport> {

  const owner = new PublicKey(address);
  const [lamports, splAccts, t22Accts] = await Promise.all([
    conn.getBalance(owner),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM }),
    conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022 }).catch(() => ({ value: [] })),
  ]);

  const holdings = new Map<string, number>();
  for (const a of [...splAccts.value, ...t22Accts.value]) {
    const info = (a.account.data as { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } })
      .parsed.info;
    const amt = Number(info.tokenAmount.uiAmount ?? 0);
    if (amt > 0) holdings.set(info.mint, (holdings.get(info.mint) ?? 0) + amt);
  }
  const mints = [...holdings.keys()];
  const [px, meta] = await Promise.all([
    prices([SOL_MINT, ...mints.slice(0, 150)]),
    tokenMeta(mints.slice(0, 100)),
  ]);
  const tokens = mints
    .map((m) => {
      const amount = holdings.get(m)!;
      const usd = px[m] != null ? amount * px[m] : null;
      return { mint: m, symbol: meta[m]?.symbol ?? null, name: meta[m]?.name ?? null, amount, usd };
    })
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));

  // signatures, newest first; stop after 5 pages
  const sigs: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  let capped = false;
  for (let page = 0; page < 3; page++) {
    const batch = await conn.getSignaturesForAddress(owner, { limit: 1000, before });
    sigs.push(...batch);
    if (batch.length < 1000) break;
    before = batch[batch.length - 1].signature;
    if (page === 2) capped = true;
  }
  // a daily rhythm only means something across several days of activity
  const hours = new Array(24).fill(0);
  const timed = sigs.slice(0, 1000).filter((s) => s.blockTime);
  const spanDays = timed.length > 1 ? (timed[0].blockTime! - timed[timed.length - 1].blockTime!) / 86400 : 0;
  if (spanDays >= 5) for (const s of timed) hours[new Date(s.blockTime! * 1000).getUTCHours()]++;

  let funder: ExposureReport["funder"] = null;
  if (!capped && sigs.length) {
    const oldest = sigs[sigs.length - 1];
    const tx = await withTimeout(
      conn.getParsedTransaction(oldest.signature, { maxSupportedTransactionVersion: 1 }),
      8000,
      null,
    );
    if (tx) {
      const ins = solTransfersInto(tx, address).sort((a, b) => b.lamports - a.lamports);
      if (ins.length) {
        const f = ins[0];
        const fSigs = await conn.getSignaturesForAddress(new PublicKey(f.from), { limit: 1000 }).catch(() => []);
        const span =
          fSigs.length >= 2 && fSigs[0].blockTime && fSigs[fSigs.length - 1].blockTime
            ? fSigs[0].blockTime! - fSigs[fSigs.length - 1].blockTime!
            : Infinity;
        funder = {
          address: f.from,
          amountSol: f.lamports / LAMPORTS_PER_SOL,
          at: oldest.blockTime ?? null,
          busy: fSigs.length >= 1000 && span < 6 * 3600,
        };
      }
    }
  }

  // who this wallet deals with, from its recent transactions (a dozen, four at a time, keeps the RPC plan healthy)
  const recent = sigs.filter((s) => !s.err).slice(0, 12);
  const counts = new Map<string, number>();
  const ignore = opts.programIgnore ?? new Set<string>();
  for (let i = 0; i < recent.length; i += 4) {
    const chunk = recent.slice(i, i + 4);
    const txs = await Promise.all(
      chunk.map((s) =>
        withTimeout(
          conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 1 }).catch(() => null),
          8000,
          null,
        ),
      ),
    );
    for (const tx of txs) {
      if (!tx) continue;
      for (const c of counterpartiesOf(tx, address)) if (!ignore.has(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  const counterparties = [...counts.entries()]
    .map(([a, count]) => ({ address: a, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const dom = await getJson<{ result?: string; s?: string }>(
    `https://sns-sdk-proxy.bonfida.workers.dev/favorite-domain/${address}`,
    4000,
  );
  const domain = dom && dom.s === "ok" && typeof dom.result === "string" ? `${dom.result}.sol` : null;

  const balanceSol = lamports / LAMPORTS_PER_SOL;
  const solUsd = px[SOL_MINT] ?? null;
  const findings: Finding[] = [];
  let score = 0;
  const usdTotal = (solUsd ? balanceSol * solUsd : 0) + tokens.reduce((s, t) => s + (t.usd ?? 0), 0);
  if (usdTotal > 0) {
    findings.push({
      level: usdTotal > 1000 ? "high" : "med",
      text: `Anyone can see this wallet holds about $${Math.round(usdTotal).toLocaleString("en-US")}.`,
    });
    score += usdTotal > 10000 ? 25 : usdTotal > 1000 ? 18 : 8;
  }
  if (domain) {
    findings.push({ level: "high", text: `It is named ${domain}, so the address points back to a chosen identity.` });
    score += 20;
  }
  if (funder?.busy) {
    findings.push({
      level: "high",
      text: "It was first funded by a very busy wallet, the pattern of an exchange. Exchanges keep ID on file.",
    });
    score += 25;
  } else if (funder) {
    findings.push({ level: "med", text: "Its first deposit came from one wallet, which ties the two together for good." });
    score += 10;
  }
  const regulars = counterparties.filter((c) => c.count >= 2);
  if (regulars.length) {
    findings.push({
      level: "med",
      text: `It trades value with the same ${regulars.length} wallet${regulars.length > 1 ? "s" : ""} again and again.`,
    });
    score += Math.min(15, regulars.length * 5);
  }
  const active = hours.reduce((s, v) => s + v, 0);
  const quiet = (() => {
    // the longest run of near-silent hours is when its owner sleeps
    let best = 0;
    let run = 0;
    for (let i = 0; i < 48; i++) {
      if (hours[i % 24] <= active * 0.01) run++;
      else run = 0;
      best = Math.max(best, Math.min(run, 24));
    }
    return best;
  })();
  if (active >= 30 && quiet >= 5) {
    findings.push({
      level: "med",
      text: `Its activity goes quiet for ${quiet} hours a day, which gives away roughly where in the world its owner sleeps.`,
    });
    score += 10;
  }
  if (sigs.length >= 100) score += 5;
  score = Math.min(100, score);

  const report: ExposureReport = {
    address,
    checkedAt: Date.now(),
    balanceSol,
    solUsd,
    tokens: tokens.slice(0, 8),
    tokenCount: tokens.length,
    txCount: sigs.length,
    txCountCapped: capped,
    firstSeen: !capped && sigs.length ? (sigs[sigs.length - 1].blockTime ?? null) : null,
    lastSeen: sigs[0]?.blockTime ?? null,
    funder,
    counterparties,
    activeHoursUtc: hours,
    domain,
    score,
    findings: findings.length ? findings : [{ level: "low", text: "This address has almost no public history yet." }],
  };
  cache.set(address, { at: Date.now(), report });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return report;
}
