import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchTree, classifyRecipient, recipientVerdict } from "@visionswap/sdk";
import { config } from "./config.ts";
import { conn, pool, poolConfig, rpcFetchWithFallback } from "./chain.ts";
import { programInfo, depositFeesOn } from "./features.ts";
import { startIndexer, store, indexerStatus, noteActivity } from "./indexer.ts";
import { startScreening, screeningStatus, screen, screenLocal } from "./screening.ts";
import { attest, refundFor, startGuard } from "./guard.ts";
import { relay, relayerQuote, cleanBody, routeOf, reservedSet, deliveryInfo } from "./relayer.ts";
import { prepareDelivery } from "./prepare.ts";
import { nonces, startNonces, stopNonces } from "./nonces.ts";
import { hops, startHops, stopHops } from "./hops.ts";
import { startCrank, settleOne } from "./crank.ts";
import { schedule, jobStatusRoutes, cancel, heldBy, isReserved, schedulerStatus, startScheduler, stopScheduler, WINDOWS, type ScheduleInput } from "./schedule.ts";
import { prepareOrder, activateOrder, cancelOrder, updateOrder, orderStatuses, orderLimits, ordersHealth, startKeeper, stopKeeper } from "./orders.ts";
import { initState, flushAll, stateStatus, stateNotSaved, stateHandover, takeOver, stopRenewing, releaseLease } from "./durable.ts";
import { proxyRpc } from "./rpc.ts";
import { buildSwap, quote, searchTokens, topTokens, icon, iconSigned, sellFeeAccount, WSOL, type Side } from "./swap.ts";
import { speedOf } from "./priority.ts";
import { jupiterHost, limiter, WAIT } from "./jupiter.ts";
import { getPrice, prices, priceStats } from "./pricebook.ts";
import { proxyTrust, proxyVerdict, rateKey } from "./clientip.ts";
import { gate } from "./gate.ts";
import { exposure } from "./exposure.ts";
import { fundsStatus, startFundsWatch } from "./funds.ts";
import { log } from "./log.ts";
import { shared } from "./flight.ts";
import { parseKey, looksLikeKey, looksLikeSecret } from "./keys.ts";
import { healthRoutes } from "./health.ts";
import { startupGate } from "./startup.ts";

const VERSION = "1.8.0";
/** Tells copies of the server apart: one site should be answered by exactly one copy. */
const INSTANCE = randomBytes(4).toString("hex");
const STARTED = Date.now();
const exposureConn = new Connection(config.exposureRpcUrl, {
  commitment: "confirmed",
  fetch: rpcFetchWithFallback(config.exposureRpcUrl, config.rpcFallbackUrl),
});

// req.ip is the visitor as our own proxies saw them, never what the visitor wrote (see clientip.ts)
const trustProxy = config.trustProxyHops == null ? false : proxyTrust(config.trustProxyHops);
const app = Fastify({ logger: false, trustProxy, bodyLimit: 256 * 1024 });
await app.register(rateLimit, {
  global: false,
  keyGenerator: (req) => rateKey(req.ip),
  errorResponseBuilder: (_req, ctx) =>
    Object.assign(new Error(`Too many requests from your network. Try again in ${ctx.after}.`), { statusCode: ctx.statusCode }),
});
// limits answer in the same { error } shape as everything else, so the app shows the reason
app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
  if (err.statusCode === 429) return reply.code(429).send({ error: err.message });
  reply.send(err);
});

// ─── privacy & security headers ───
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");
const API_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";

app.addHook("onSend", async (req, reply, payload) => {
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  reply.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  reply.header("X-Frame-Options", "DENY");
  if (req.protocol === "https") reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (!req.url.startsWith("/api/")) reply.header("Content-Security-Policy", CSP);
  else {
    // API answers are data, never pages: even one opened as a document (say, an icon) gets
    // no script, no access to the site's storage, and can't be framed or hotlinked
    reply.header("Content-Security-Policy", API_CSP);
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
  }
  return payload;
});

// app traffic makes the indexer follow the chain closely
// (a transaction sent through /api/rpc counts too, once it has gone out: see the route)
const ACTIVE = /^\/api\/(pool\/(leaves|nullifiers|waiting)|relay|attest|swap\/build)/;
app.addHook("onRequest", async (req) => {
  if (ACTIVE.test(req.url)) noteActivity();
});

// Orders and send-later payments are answered only while this copy runs them (see startup.ts)
let stateReady = !config.relayer;
/** Another copy has held the state for over three minutes while this one waits, or took it from this one. */
const handoverStuck = () => {
  const h = stateHandover();
  return !!config.relayer && (h.lost || (h.waitingSec ?? 0) > 180);
};
startupGate(app, () => stateReady);

// the first proxied requests double-check TRUST_PROXY_HOPS; a wrong setting is logged once
let proxyChecks = 0;
app.addHook("onRequest", async (req) => {
  if (proxyChecks >= 200 || !req.headers["x-forwarded-for"]) return;
  const v = proxyVerdict(req.raw.socket.remoteAddress ?? "", String(req.headers["x-forwarded-for"]), config.trustProxyHops);
  // "unsure" can come from a visitor's own header, so only certain mistakes are logged
  if (!v.ok && !v.unsure) {
    log("TRUST_PROXY_HOPS looks wrong:", v.reason);
    proxyChecks = 200;
  } else proxyChecks++;
});

// ─── helpers ───
function countryOf(req: FastifyRequest): string | null {
  const h = req.headers["cf-ipcountry"] ?? req.headers["x-vercel-ip-country"] ?? req.headers["x-country-code"];
  return typeof h === "string" ? h.toUpperCase() : null;
}

function blocked(req: FastifyRequest, reply: FastifyReply): boolean {
  const c = countryOf(req);
  if (c && config.blockedCountries.includes(c)) {
    reply.code(451).send({ error: "VisionSwap is not available in your region." });
    return true;
  }
  return false;
}

function fail(reply: FastifyReply, e: unknown) {
  const err = e as Error & { status?: number; retryAfter?: number; code?: string; held?: unknown; jobs?: unknown };
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (err.retryAfter) reply.header("Retry-After", String(err.retryAfter));
  if (status >= 500 && !err.status) log("error:", err.message.slice(0, 300));
  // a short code lets the app tell cases apart (say, "relayer_unfunded": nothing was spent)
  const code = typeof err.code === "string" && /^[a-z_]{1,32}$/.test(err.code) && err.status ? { code: err.code } : {};
  // notes held by a scheduled payment: which ones, so the app can set them aside and pick others
  const held = code.code === "held" && Array.isArray(err.held) && Array.isArray(err.jobs) ? { held: err.held, jobs: err.jobs } : {};
  // a delivery refused as stale: what the pool would have paid its hop, so the app can tell why
  const credit = code.code === "stale" && typeof (err as { credit?: unknown }).credit === "string" ? { credit: (err as { credit?: string }).credit } : {};
  reply.code(status).send({ error: status === 500 && !err.status ? "Something went wrong. Please try again." : err.message, ...code, ...held, ...credit });
}

const num = (v: unknown, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

let zkFiles: { wasm: string; zkey: string } | null = null;
function zkArtifacts() {
  if (zkFiles) return zkFiles;
  const dir = join(config.webDist, "zk");
  if (existsSync(dir)) {
    const files = readdirSync(dir);
    const wasm = files.find((f) => f.endsWith(".wasm"));
    const zkey = files.find((f) => f.endsWith(".zkey"));
    if (wasm && zkey) zkFiles = { wasm: `/zk/${wasm}`, zkey: `/zk/${zkey}` };
  }
  return zkFiles ?? { wasm: "/zk/transaction.wasm", zkey: "/zk/transaction.zkey" };
}

let slotCache: { at: number; slot: number } | null = null;
const readSlot = shared(async () => {
  const slot = await conn.getSlot("confirmed");
  slotCache = { at: Date.now(), slot };
  return slot;
});
async function currentSlot(): Promise<number> {
  if (slotCache && Date.now() - slotCache.at < 2000) return slotCache.slot;
  return readSlot();
}

let treeCache: { at: number; tree: Awaited<ReturnType<typeof fetchTree>> } | null = null;
const readTree = shared(async () => {
  const tree = await fetchTree(conn, pool);
  treeCache = { at: Date.now(), tree };
  return tree;
});
async function treeNow() {
  if (treeCache && Date.now() - treeCache.at < 5000) return treeCache.tree;
  return readTree();
}

let vaultCache: { at: number; lamports: bigint; rentMin: bigint } | null = null;
const readVault = shared(async () => {
  const a = await conn.getAccountInfo(pool.vault, "confirmed");
  if (!a) return null;
  const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(a.data.length));
  vaultCache = { at: Date.now(), lamports: BigInt(a.lamports), rentMin };
  return vaultCache;
});
async function vault() {
  if (vaultCache && Date.now() - vaultCache.at < 15_000) return vaultCache;
  return readVault();
}

// ─── pool ───
/**
 * What the operator should look at: a balance to top up, an index that can't move on, state that
 * the next publish wouldn't find, or payments and order trades running late. Each one is a yes/no
 * that is off while all is well, so nothing here shows when anyone schedules or places anything.
 */
function warningsOf(funds: Awaited<ReturnType<typeof fundsStatus>>, indexer: ReturnType<typeof indexerStatus>): string[] {
  const w: string[] = [];
  if (funds.relayer?.low) w.push("RELAYER_LOW");
  if (funds.guard?.low) w.push("GUARD_LOW");
  if (indexer.state === "stuck") w.push("INDEXER_STUCK");
  if (stateNotSaved()) w.push("STATE_NOT_SAVED");
  if (handoverStuck()) w.push("STATE_HANDOVER_WAITING");
  if (startFailed()) w.push("STATE_START_FAILED");
  if (config.relayer && stateReady) {
    // judged by the random send moment, never by a payment's window end: that would date its scheduling
    if (schedulerStatus().oldestOverdueSec > 600) w.push("SCHEDULE_LATE");
    if (ordersHealth().oldestQueuedSec > 300) w.push("ORDERS_STALLED");
    // a pool payment landed over ten minutes ago and its delivery still hasn't (the finisher keeps trying)
    if (hops.status().late > 0) w.push("DELIVERY_LATE");
  }
  return w;
}

// Anyone sees a summary; the live counts need HEALTH_TOKEN (see health.ts)
healthRoutes(app, {
  token: config.healthToken,
  summary: async () => {
    const funds = await fundsStatus();
    const indexer = indexerStatus();
    const bal = funds.relayer?.lamports == null ? null : BigInt(funds.relayer.lamports);
    const problems: string[] = [];
    if (indexer.state === "stuck") problems.push("The pool index has stopped following the chain.");
    if (config.relayer && bal == null) problems.push("The relayer's balance can't be read: the RPC may be down.");
    if (config.relayer && bal != null && bal < config.relayerMinLamports) problems.push("The relayer needs more SOL.");
    if (stateNotSaved()) {
      problems.push(
        stateStatus().backend === "disk"
          ? "App Storage support didn't load (the @replit/object-storage package is missing), so orders and scheduled payments are kept on this machine only and the next publish would start without them. Ask the Agent to run npm ci --include=dev, check that the deployment build in .replit still runs it, then publish again."
          : "Orders and scheduled payments aren't being saved to App Storage, so the next publish would start without them. Create a bucket in the App Storage tool (or check the [objectStorage] section in .replit), then publish again.",
      );
    }
    if (startFailed()) problems.push("Orders and scheduled payments couldn't start on this copy; it tries again every 30 seconds. If this lasts, restart the deployment.");
    if (handoverStuck()) {
      const h = stateHandover();
      problems.push(
        h.paused
          ? "App Storage stopped taking this copy's updates, so it has paused orders and scheduled payments (another copy may run them meanwhile). It takes them back by itself once App Storage answers again."
          : h.lost
            ? "Another copy of the site took over orders and scheduled payments, so this copy has paused them; it takes them back by itself once that copy stops. The site should run on one machine: if this lasts, stop the extra copy."
            : h.unanswered
              ? "App Storage isn't answering, so this copy can't tell yet whether the copy before it has saved and stopped. Orders and scheduled payments start here once it answers, or after 10 minutes at the latest."
              : "The copy this one replaces is still running orders and scheduled payments, so this copy waits for it to stop (10 minutes at the most). The site should run on one machine: if this lasts, stop the other copy.",
      );
    }
    return {
      problems,
      warnings: warningsOf(funds, indexer),
      fields: {
        version: VERSION,
        network: config.network,
        programId: config.programId.toBase58(),
        program: await programInfo(),
        depositFees: await depositFeesOn(),
        jupiter: { key: !!config.jupiterKey, host: jupiterHost() },
        instance: INSTANCE,
        uptimeSeconds: Math.round((Date.now() - STARTED) / 1000),
        indexer: { state: indexer.state },
        relayer: funds.relayer,
        guard: funds.guard,
        state: stateStatus(),
      },
    };
  },
  details: async () => ({
    jupiter: { key: !!config.jupiterKey, host: jupiterHost(), ...limiter.stats() },
    prices: priceStats(),
    orders: config.relayer && stateReady ? ordersHealth() : null,
    scheduler: config.relayer && stateReady ? schedulerStatus() : null,
    deliveries: config.relayer && stateReady ? { ...hops.status(), nonces: nonces.status() } : null,
    indexer: indexerStatus(),
    screening: screeningStatus(),
    sellFeeAccount: await sellFeeAccount(),
  }),
  warnings: async () => warningsOf(await fundsStatus(), indexerStatus()),
});

// small requests get a small body limit: the default 256 KB is for proofs and split payments
const SMALL_BODY = 8 * 1024;

// the app's own sync calls: generous limits, only there to stop scripted floods
const SYNC_LIMIT = { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } };

app.get("/api/pool/info", SYNC_LIMIT, async (_req, reply) => {
  try {
    const [cfg, tree, q, depositFees, program] = await Promise.all([poolConfig(), treeNow(), relayerQuote(), depositFeesOn(), programInfo()]);
    // how much more the pool may take right now (the program refuses deposits past its cap)
    let tvlRoom: string | null = null;
    if (cfg.tvlCap > 0n) {
      const v = await vault().catch(() => null);
      tvlRoom = v ? (v.lamports - v.rentMin >= cfg.tvlCap ? "0" : (cfg.tvlCap - (v.lamports - v.rentMin)).toString()) : null;
    }
    return {
      network: config.network,
      programId: config.programId.toBase58(),
      feeBps: cfg.feeBps,
      depositFees,
      program,
      accounts: { config: pool.config.toBase58(), vault: pool.vault.toBase58(), tree: pool.tree.toBase58() },
      minDeposit: cfg.minDeposit.toString(),
      maxDeposit: cfg.maxDeposit.toString(),
      tvlCap: cfg.tvlCap.toString(),
      tvlRoom,
      depositDelaySlots: cfg.depositDelay.toString(),
      depositsPaused: cfg.depositsPaused,
      requireAttestation: cfg.requireAttestation,
      treasury: cfg.treasury.toBase58(),
      guard: cfg.guard.toBase58(),
      relayer: q.relayer,
      relayerFee: q.fee.toString(),
      // what a payment's own fee payer spends, so "send it yourself" can pay itself back exactly
      // (one signature more than the relayer's: the one-time hop of a delivery co-signs)
      selfRelayCost: (q.cost + 5000n).toString(),
      // sending later, and spreading a split payment, deliver on the relayer's durable nonces
      sendLater: q.relayer && config.deliveryNonce ? Object.keys(WINDOWS) : [],
      delivery: deliveryInfo(),
      orders: !!q.relayer,
      sellFeeBps: config.sellFeeBps,
      leaves: tree.nextIndex,
      root: tree.currentRoot.toString(16).padStart(64, "0"),
      indexed: store.count,
      zk: zkArtifacts(),
    };
  } catch (e) {
    fail(reply, Object.assign(e as Error, { status: 503, message: "The pool is not reachable right now." }));
  }
});

app.get("/api/pool/leaves", SYNC_LIMIT, async (req, reply) => {
  const q = req.query as Record<string, string>;
  const from = Math.max(0, Math.floor(num(q.from, 0)));
  const limit = Math.min(50_000, Math.max(1, Math.floor(num(q.limit, 20_000))));
  reply.header("X-Total", String(store.count));
  reply.header("Cache-Control", "no-store");
  reply.type("application/octet-stream").send(store.leafRange(from, limit));
});

app.get("/api/pool/nullifiers", SYNC_LIMIT, async (req, reply) => {
  const q = req.query as Record<string, string>;
  const from = Math.max(0, Math.floor(num(q.from, 0)));
  const limit = Math.min(100_000, Math.max(1, Math.floor(num(q.limit, 50_000))));
  reply.header("X-Total", String(store.nfCount));
  reply.header("Cache-Control", "no-store");
  reply.type("application/octet-stream").send(store.nullifierRange(from, limit));
});

// The whole waiting room, which is public on-chain anyway. Clients pick out
// their own deposits locally, so nobody has to say which wallets are theirs.
app.get("/api/pool/waiting", SYNC_LIMIT, async () => {
  const cfg = await poolConfig().catch(() => null);
  const slot = await currentSlot().catch(() => 0);
  const deposits = [...store.pending.values()].map((p) => ({
    inner: p.inner,
    depositor: p.depositor,
    amount: p.amount,
    slot: p.slot,
    readyAt: cfg ? (BigInt(p.slot) + cfg.depositDelay).toString() : null,
  }));
  return { slot, deposits };
});

app.get("/api/stats", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => {
  const [v, px] = await Promise.all([vault().catch(() => null), prices([WSOL], { maxAgeMs: 60_000, lane: "background", maxWaitMs: WAIT.price })]);
  const now = Math.floor(Date.now() / 1000);
  let pendingLamports = 0n;
  for (const p of store.pending.values()) pendingLamports += BigInt(p.amount);
  const shielded = v ? v.lamports - v.rentMin - pendingLamports : null;
  return {
    network: config.network,
    solUsd: (px[WSOL] ?? getPrice(WSOL))?.usd ?? null,
    shieldedSol: shielded === null ? null : Number(shielded) / 1e9,
    notes: store.count,
    exits24h: store.spends.filter((s) => s.t > now - 86400 && s.w > 0n).length,
    deposits24h: store.deposits.filter((s) => s.t > now - 86400).length,
    waiting: store.pending.size,
  };
});

// ─── guard & relayer ───
// each check reads the depositor's recent funding: a few at a time keeps the RPC plan healthy
const attests = gate(4, 30, 15_000, "Screening is busy. Try again in a moment.");
app.post("/api/attest", { bodyLimit: SMALL_BODY, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  try {
    const body = req.body as { depositor?: string };
    return await attests(() => attest(String(body?.depositor ?? "")));
  } catch (e) {
    if ((e as Error).message.includes("Invalid public key")) return reply.code(400).send({ error: "Bad address." });
    // screening is briefly unavailable: say when to ask again, so waiting apps back off together
    const retryAfter = (e as { retryAfter?: number }).retryAfter;
    if (retryAfter) reply.header("Retry-After", String(retryAfter));
    fail(reply, e);
  }
});

// Taking a deposit back, for depositors with nothing left to pay the network fee:
// they sign the request, the guard pays, and the program refunds only to them.
// Returning money is never region-blocked.
app.post("/api/refund", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
  try {
    const b = req.body as { inner?: string; signature?: string };
    return { signature: await refundFor(String(b?.inner ?? ""), String(b?.signature ?? "")) };
  } catch (e) {
    fail(reply, e);
  }
});

// Settling is permissionless; this lets an account with no SOL ask for its ready deposit to be added now.
app.post("/api/settle", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
  try {
    const inner = String((req.body as { inner?: string })?.inner ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(inner)) return reply.code(400).send({ error: "Bad deposit id." });
    return { signature: await settleOne(inner) };
  } catch (e) {
    fail(reply, e);
  }
});

app.get("/api/relay/quote", SYNC_LIMIT, async (_req, reply) => {
  try {
    const q = await relayerQuote();
    return { relayer: q.relayer, fee: q.fee.toString(), feeBps: q.feeBps, treasury: q.treasury };
  } catch (e) {
    fail(reply, e);
  }
});

// a v2 body carries a delivery's signatures besides the proof: 64 KB is plenty, and keeps junk small
const RELAY_BODY = 64 * 1024;

/**
 * A payment sent now: { v: 2, request, delivery | own } (see relayer.ts). A page from before
 * deliveries sends a bare request: it may still pay the relayer (cutting and joining notes), and
 * is told to refresh (426 update_required) for anything else.
 */
app.post("/api/relay", { bodyLimit: RELAY_BODY, config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  try {
    const body = cleanBody(req.body);
    if (config.relayer) routeOf(body, config.relayer.publicKey);
    const request = body.request;
    // notes a scheduled payment holds (maybe made on another device) can't go out in another one
    const held = heldBy(request.nullifiers);
    if (held.jobs.length) {
      return reply.code(409).send({ error: "This SOL is set aside for a scheduled payment.", code: "held", held: held.nullifiers, jobs: held.jobs });
    }
    // notes being checked for a scheduled payment this moment: refused until that's settled
    if (isReserved(request.nullifiers)) {
      return reply.code(409).send({ error: "This SOL is being scheduled in another payment right now. Please try again in a moment.", code: "in_flight" });
    }
    return await relay(body, { ip: rateKey(req.ip) });
  } catch (e) {
    fail(reply, e);
  }
});

// a payment to an outside address, checked and given what its one-time hop signs over (see prepare.ts)
app.post("/api/relay/prepare", { bodyLimit: RELAY_BODY, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  try {
    if (!config.relayer) throw Object.assign(new Error("No relayer is available right now."), { status: 503, code: "no_relayer" });
    return await prepareDelivery(req.body, rateKey(req.ip));
  } catch (e) {
    fail(reply, e);
  }
});

// "Send later": the proof is checked now (here, without telling anyone outside) and sent at a random moment inside the window
app.post("/api/relay/schedule", { bodyLimit: RELAY_BODY, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  const b = req.body as ScheduleInput;
  try {
    if (!b?.request) throw Object.assign(new Error("Malformed request."), { status: 400 });
    return await schedule(b, rateKey(req.ip));
  } catch (e) {
    fail(reply, e);
  }
});

// Recipients checked before a split payment starts, so one refused address can't leave it half paid
// (against the sanctions list here; each payment gets the full check when it goes out). A single
// recipient sent now, as "send it yourself" asks, gets the full check: the relayer isn't in that path
// (a payment the relayer sends says `full: false`, since the relayer screens it fully when it sends it).
// Those full checks wait in a line of their own, so they can never hold up deposit checks.
// Each answer also says what kind of address it is (see classifyRecipient): "blocked" ones can't be
// paid at all, and "confirm" ones (only a program can sign for them) are sent once the sender confirms.
// Asked as { v: 2, recipients, later }; pages from before deliveries are told to refresh.
const checks = gate(2, 10, 15_000, "Screening is busy. Try again in a moment.");
app.post("/api/relay/check", { bodyLimit: SMALL_BODY, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  const b = req.body as { v?: unknown; recipients?: unknown; later?: unknown; full?: unknown };
  if (b?.v !== 2) return reply.code(426).send({ error: "VisionSwap was updated. Refresh the page to send this. Nothing was spent.", code: "update_required" });
  if (!Array.isArray(b?.recipients) || b.recipients.length > 25) return reply.code(400).send({ error: "Malformed request." });
  const full = b.full !== false && b.later !== true && b.recipients.length === 1;
  const valid = b.recipients.filter((r) => {
    try {
      parseKey(r);
      return true;
    } catch {
      return false;
    }
  }) as string[];
  // what is at each address (one read for all of them); unknown when the network can't say
  const accts = valid.length ? await conn.getMultipleAccountsInfo(valid.map((a) => new PublicKey(a)), "confirmed").catch(() => null) : [];
  const reserved = await poolConfig()
    .then((cfg) => reservedSet(cfg, []))
    .catch(() => new Set<string>());
  const out = [];
  for (const r of b.recipients) {
    // echoed back no longer than an address can be
    const address = String(r ?? "").slice(0, 64);
    const at = valid.indexOf(r as string);
    if (at < 0) {
      out.push({ address, ok: false, reason: "invalid" });
      continue;
    }
    let kind: string | null = null;
    let verdict: string | null = null;
    if (hops.isHop(address)) [kind, verdict] = ["reserved", "blocked"];
    else if (accts) {
      const a = accts[at];
      const c = classifyRecipient(new PublicKey(address), a ? { owner: a.owner, executable: a.executable, lamports: a.lamports, dataLength: a.data.length } : null, reserved);
      [kind, verdict] = [c, recipientVerdict(c)];
    }
    if (verdict === "blocked") {
      out.push({ address, ok: false, reason: "blocked", class: kind, verdict });
      continue;
    }
    // the full check may ask Range: it waits its turn, and a busy turn reads as "try again"
    const s = full ? await checks(() => screen(address)).catch(() => ({ ok: false, reason: "unavailable" }) as const) : screenLocal(address);
    out.push({ address, ok: s.ok, ...(s.ok ? {} : { reason: s.reason === "unavailable" ? "unavailable" : "refused" }), class: kind, verdict });
  }
  return out;
});

// Hops holding SOL (public chain facts, swept daily): the owner's app picks out its own here, so it never names them
app.get("/api/hops/open", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (_req, reply) => {
  reply.header("Cache-Control", "no-store");
  return hops.open();
});

// A hop's own delivery (where it goes, how much), asked with the hop's signature: for an app that lost its own record
app.post("/api/hops/lookup", { bodyLimit: SMALL_BODY, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
  const b = (req.body ?? {}) as { hop?: unknown; ts?: unknown; sig?: unknown };
  try {
    if (!looksLikeKey(b.hop) || typeof b.sig !== "string" || b.sig.length > 90 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(b.sig)) {
      throw Object.assign(new Error("Malformed request."), { status: 400 });
    }
    return hops.lookup(b.hop, Number(b.ts), b.sig);
  } catch (e) {
    fail(reply, e);
  }
});

// how scheduled payments are doing (POST /api/relay/jobs/status, and the older GET /api/relay/jobs?ids=)
jobStatusRoutes(app, fail);

app.post("/api/relay/cancel", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
  const b = req.body as { id?: string; token?: string };
  try {
    return cancel(String(b?.id ?? ""), String(b?.token ?? ""));
  } catch (e) {
    fail(reply, e);
  }
});

// private orders: take-profit, stop-loss, limit buys and DCA, run by the order keeper
app.post("/api/orders/prepare", { bodyLimit: SMALL_BODY, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  try {
    if (!config.relayer) throw Object.assign(new Error("Orders aren't available right now."), { status: 503 });
    const b = (req.body ?? {}) as Record<string, unknown>;
    // shapes checked before anything is decoded: a long string would hold the whole server
    if (!looksLikeKey(b.owner) || !looksLikeKey(b.mint)) throw Object.assign(new Error("Bad address."), { status: 400 });
    if (typeof b.secret === "string" && b.secret && !looksLikeSecret(b.secret)) throw Object.assign(new Error("Bad order key."), { status: 400 });
    return await prepareOrder(b, rateKey(req.ip));
  } catch (e) {
    fail(reply, e);
  }
});
app.post("/api/orders/activate", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
  const b = req.body as { id?: string; token?: string };
  try {
    return await activateOrder(String(b?.id ?? ""), String(b?.token ?? ""));
  } catch (e) {
    fail(reply, e);
  }
});
app.post("/api/orders/cancel", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
  const b = req.body as { id?: string; token?: string };
  try {
    return cancelOrder(String(b?.id ?? ""), String(b?.token ?? ""));
  } catch (e) {
    fail(reply, e);
  }
});
// a running order's terms change without a new approval (checked like a new order)
app.post("/api/orders/update", { bodyLimit: SMALL_BODY, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  const b = (req.body ?? {}) as Record<string, unknown>;
  try {
    return await updateOrder(String(b.id ?? ""), String(b.token ?? ""), b, rateKey(req.ip));
  } catch (e) {
    fail(reply, e);
  }
});
const orderIds = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(",")).filter((x) => /^[0-9a-f]{24}$/.test(x));
app.get("/api/orders", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
  try {
    return orderStatuses(orderIds((req.query as Record<string, string>).ids));
  } catch (e) {
    fail(reply, e);
  }
});
// the same, with the ids in the body instead of the address
app.post("/api/orders/status", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
  try {
    return orderStatuses(orderIds((req.body as { ids?: unknown } | null)?.ids));
  } catch (e) {
    fail(reply, e);
  }
});
// the smallest orders the server takes, so the app can check before it moves any funds
app.get("/api/orders/limits", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => orderLimits());

// ─── network gateway ───
// rpc.ts counts each call by its cost, per visitor and for everyone together; the plain request
// limit on top only bounds calls it turns away, which cost the sender nothing otherwise
app.post("/api/rpc", { bodyLimit: 32 * 1024, config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
  // the shared budget counts a whole IPv6 /56 as one visitor (a home is often given one)
  const r = await proxyRpc(req.body, rateKey(req.ip, 56));
  if (r.sends) noteActivity();
  if (r.retryAfter) reply.header("Retry-After", String(r.retryAfter));
  reply.code(r.status).send(r.json);
});

app.get("/api/swap/quote", { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
  const q = req.query as Record<string, string>;
  try {
    return await quote({
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      amount: q.amount,
      slippageBps: num(q.slippageBps, 100),
      side: (q.side === "sell" ? "sell" : "buy") as Side,
      ip: rateKey(req.ip),
    });
  } catch (e) {
    fail(reply, e);
  }
});

app.post("/api/swap/build", { bodyLimit: SMALL_BODY, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (blocked(req, reply)) return;
  const b = req.body as Record<string, string>;
  try {
    return await buildSwap({
      inputMint: b.inputMint,
      outputMint: b.outputMint,
      amount: String(b.amount),
      slippageBps: num(b.slippageBps, 100),
      side: (b.side === "sell" ? "sell" : "buy") as Side,
      taker: b.taker,
      // the speed and try number only raise the priority fee, which buildSwap keeps within each speed's cap
      speed: speedOf(b.speed),
      attempt: num(b.attempt, 0),
      ip: rateKey(req.ip),
    });
  } catch (e) {
    fail(reply, e);
  }
});

app.get("/api/tokens/search", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
  try {
    return await searchTokens(String((req.query as Record<string, string>).q ?? ""), rateKey(req.ip));
  } catch (e) {
    fail(reply, e);
  }
});

app.get("/api/tokens/top", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (_req, reply) => {
  try {
    return await topTokens();
  } catch (e) {
    fail(reply, e);
  }
});

// display prices from the shared price book: up to a minute old, new tokens fetched when Jupiter has room
app.get("/api/price", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
  const ids = String((req.query as Record<string, string>).ids ?? "")
    .split(",")
    .filter(Boolean)
    .slice(0, 50);
  const got = await prices(ids, { maxAgeMs: 60_000, lane: "background", maxWaitMs: WAIT.price, ip: rateKey(req.ip) });
  // a token that couldn't be fetched just now shows its last known price, if there is one
  // ?at=1 also says how old each price is (ms), so the order form shows its real age; an age, not a
  // time, so a browser clock that runs ahead of this server doesn't make every price look stale
  const withAt = (req.query as Record<string, string>).at === "1";
  const now = Date.now();
  return Object.fromEntries(
    ids.map((m) => {
      const e = (Object.hasOwn(got, m) ? got[m] : getPrice(m)) ?? null;
      return [m, e ? (withAt ? { usd: e.usd, age: Math.max(0, now - e.at) } : e.usd) : null];
    }),
  );
});

// Checks TRUST_PROXY_HOPS after a move: ok must be true, and seenAs your own address.
app.get("/api/ip-check", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
  const v = proxyVerdict(req.raw.socket.remoteAddress ?? "", req.headers["x-forwarded-for"] as string | undefined, config.trustProxyHops);
  return {
    ok: v.ok,
    ...(v.reason ? { reason: v.reason } : {}),
    seenAs: req.ip,
    forwardedEntries: String(req.headers["x-forwarded-for"] ?? "").split(",").filter((x) => x.trim()).length,
    publicProxyHops: config.trustProxyHops,
    // region blocking (BLOCKED_COUNTRIES) works only when a service in front reports the visitor's country
    country: countryOf(req),
  };
});

app.get("/api/icon", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
  const q = req.query as Record<string, string>;
  const u = String(q.u ?? "");
  if (!u || !iconSigned(u, String(q.s ?? ""))) return reply.code(404).send();
  try {
    const r = await icon(u);
    if (!r) return reply.code(404).send();
    reply.header("Cache-Control", "public, max-age=86400");
    // a logo drawn as SVG shows fine in the page's <img>, but opened on its own it downloads rather than
    // runs: with the sandbox policy every /api answer carries, an SVG can never act as a page of this site
    reply.header("Content-Disposition", r.type === "image/svg+xml" ? 'attachment; filename="icon.svg"' : 'inline; filename="icon"');
    reply.type(r.type).send(r.body);
  } catch (e) {
    fail(reply, e);
  }
});

// each check reads a wallet's recent history: two at a time keeps the RPC plan healthy, a few more wait their turn
const exposureChecks = gate(2, 8, 20_000, "The exposure check is busy. Try again in a moment.");
app.get("/api/exposure/:address", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
  const { address } = req.params as { address: string };
  try {
    parseKey(address);
  } catch {
    return reply.code(400).send({ error: "That doesn't look like a Solana address." });
  }
  try {
    return await exposureChecks(() => exposure(exposureConn, address));
  } catch (e) {
    if ((e as { status?: number }).status === 503) return fail(reply, e);
    fail(reply, Object.assign(e as Error, { status: 502, message: "Couldn't read that address right now. Try again shortly." }));
  }
});

app.get("/api/legal", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => ({
  contact: config.contactEmail || null,
  repo: config.repoUrl || null,
  token: config.tokenMint || null,
  blockedCountries: config.blockedCountries,
}));

// ─── the website ───
if (existsSync(join(config.webDist, "index.html"))) {
  // social previews need absolute URLs: use PUBLIC_ORIGIN, or the address the visitor used
  const rawHtml = readFileSync(join(config.webDist, "index.html"), "utf8");
  const pageFor = (req: FastifyRequest) => {
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "");
    const o = (config.publicOrigin || (host ? `${req.protocol}://${host}` : "")).replace(/\/$/, "");
    if (!o || !/^https?:\/\/[a-z0-9.:-]+$/i.test(o)) return rawHtml;
    return rawHtml
      .replace('content="/og.png"', `content="${o}/og.png"`)
      .replace("</head>", `  <meta property="og:url" content="${o}/" />
  </head>`);
  };
  await app.register(fastifyStatic, {
    root: config.webDist,
    wildcard: false,
    index: false,
    setHeaders(res, path) {
      if (/[\\/](assets|zk|fonts|media)[\\/]/.test(path)) res.header("Cache-Control", "public, max-age=31536000, immutable");
      else res.header("Cache-Control", "public, max-age=300");
    },
  });
  // A build that skipped copying the proving files (say, a host ran `vite build`
  // by hand) would leave the app unable to prove anything. Serve them from the
  // circuit artifacts instead.
  if (!existsSync(join(config.webDist, "zk", "manifest.json"))) {
    log("web: no proving files in the build; serving them from the circuit artifacts");
    app.get("/zk/manifest.json", async (_req, reply) =>
      reply.header("Cache-Control", "no-cache").send({ wasm: "/zk/transaction.wasm", zkey: "/zk/transaction.zkey" }),
    );
    for (const name of ["transaction.wasm", "transaction.zkey"]) {
      app.get(`/zk/${name}`, async (_req, reply) =>
        reply
          .header("Cache-Control", "no-cache")
          .type(name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream")
          .send(readFileSync(join(config.artifactsDir, name))),
      );
    }
  }
  app.get("/*", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    try {
      return await reply.sendFile(url.replace(/^\//, ""));
    } catch {
      reply.header("Cache-Control", "no-cache").type("text/html").send(pageFor(req));
    }
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
    reply.header("Cache-Control", "no-cache").type("text/html").send(pageFor(req));
  });
}

// ─── start ───
// a stray async error is written down, never fatal: the pool must keep settling and relaying
process.on("unhandledRejection", (e) => log("unhandled rejection:", ((e as Error)?.message ?? String(e)).slice(0, 200)));
// a host restarting the app (a republish, say) lets payments already in flight finish first,
// and saves orders and scheduled payments before it goes (once straight away, again at the end),
// then hands over to the next copy at once
let shuttingDown = false;
/** whether the keeper and the scheduler run (only ever after this copy has loaded what they hold) */
let running = false;
/** the last start of the keeper and the scheduler failed (it is tried again every 30 seconds) */
let stateStartFailed = false;
const startFailed = () => stateStartFailed && !shuttingDown && !stateHandover().lost;
/** each start or stop of the keeper and the scheduler waits for the one before it */
let stateStep: Promise<void> = Promise.resolve();
/**
 * Starts or stops the keeper and the scheduler. Each start reads orders and payments from storage
 * again (another copy may have run them meanwhile); never started after a shutdown began, or while
 * another copy holds them. A stop saves what they hold; one that never started saves nothing, so an
 * empty list can't replace the stored one.
 */
function runState(on: boolean): Promise<void> {
  stateStep = stateStep
    .then(async () => {
      if (on === running || (on && (shuttingDown || stateHandover().lost))) return;
      if (!on) {
        running = false;
        stateReady = false;
        await Promise.all([stopScheduler(), stopKeeper()]);
        stopHops();
        stopNonces();
        return;
      }
      // the nonces and the delivery ledger first: scheduled payments are sent on them
      const started = await Promise.allSettled([startNonces().then(startHops).then(startScheduler), startKeeper()]);
      const failed = started.find((r) => r.status === "rejected");
      if (failed) {
        // nothing runs half started: both stop (without saving what may be only part of a list) and the start is tried again
        await Promise.allSettled([stopScheduler(), stopKeeper(false)]);
        stopHops();
        stopNonces();
        stateStartFailed = true;
        log(`state: couldn't start orders and scheduled payments (${String((failed.reason as Error)?.message ?? failed.reason).slice(0, 160)}); trying again in 30 seconds`);
        setTimeout(() => void runState(true), 30_000).unref();
        return;
      }
      stateStartFailed = false;
      running = true;
      // lost meanwhile: the stop queued behind this start runs next
      stateReady = !stateHandover().lost;
    })
    .catch((e) => log(`state: couldn't ${on ? "start" : "stop"} orders and scheduled payments: ${(e as Error)?.message ?? e}`));
  return stateStep;
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    shuttingDown = true;
    const by = Date.now() + 19_000;
    stopRenewing();
    setTimeout(() => process.exit(0), 20_000).unref();
    const flush = () => flushAll().catch((e) => log(`state: couldn't save at shutdown: ${(e as Error)?.message ?? e}`));
    void (async () => {
      const stopped = Promise.allSettled([app.close(), runState(false)]);
      const cap = new Promise((r) => setTimeout(r, 12_000));
      await flush();
      await Promise.race([stopped, cap]);
      await flush();
      // what is left of the 20 seconds goes to handing over
      await releaseLease(by);
    })().finally(() => process.exit(0));
  });
}

startScreening();
startIndexer();
startCrank();
void initState();
startGuard();
startFundsWatch();

// the site answers first (a publish goes live only once it does), then takes over orders and payments
await app.listen({ port: config.port, host: config.host });
log(
  `VisionSwap server ${VERSION} on :${config.port} (${config.network}, program ${config.programId.toBase58()}, relayer ${
    config.relayer ? "on" : "off"
  }, guard ${config.guard ? "on" : "off"}, Jupiter ${config.jupiterKey ? "with a key" : "without a key"} at ${config.jupiterRpm}/min, ${
    config.trustProxyHops == null ? "no proxy in front" : `${config.trustProxyHops} public proxy hop(s) in front`
  })`,
);
if (config.relayer) {
  // the stored orders and payments are read only once the copy before this one has saved them; App
  // Storage then gets at most 15 seconds, and whatever it answers later is added back. Another copy
  // taking them over pauses them here until it stops (see takeOver).
  const held = await takeOver(INSTANCE, () => shuttingDown, {
    onLost: () => {
      stateReady = false;
      void runState(false);
    },
    onRegained: () => void runState(true),
  });
  if (held) await runState(true);
}
