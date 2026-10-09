import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { all as proxyAll } from "@fastify/proxy-addr";
import { proxyTrust, proxyVerdict, rateKey } from "../src/clientip.ts";
import { gate } from "../src/gate.ts";
import { admit, keyCount, proxyRpc } from "../src/rpc.ts";
import { config } from "../src/config.ts";
import { parseKey, looksLikeSecret } from "../src/keys.ts";
import { healthRoutes } from "../src/health.ts";
import { rememberVendor } from "../src/screening.ts";
import { sniffImage } from "../src/swap.ts";

/** The address Fastify reports as req.ip for this connection and X-Forwarded-For. */
const ipOf = (socket: string, xff: string | null, hops: number) => {
  const req = { socket: { remoteAddress: socket }, connection: { remoteAddress: socket }, headers: xff ? { "x-forwarded-for": xff } : {} };
  const list = proxyAll(req as never, proxyTrust(hops));
  return list[list.length - 1];
};

test("the visitor's address comes from what our proxies wrote, never from what the visitor wrote", () => {
  // Google's load balancer appends "<visitor>, <balancer>" and connects from its own range
  assert.equal(ipOf("35.191.3.4", "203.0.113.9, 34.120.1.1", 1), "203.0.113.9");
  assert.equal(ipOf("35.191.3.4", "6.6.6.6, 203.0.113.9, 34.120.1.1", 1), "203.0.113.9", "a made-up entry is ignored");
  // an extra private hop inside the host changes nothing
  assert.equal(ipOf("10.0.0.2", "1.1.1.1, 203.0.113.9, 34.120.1.1, 35.191.0.7", 1), "203.0.113.9");
  // a visitor connecting straight in can't claim an address
  assert.equal(ipOf("198.51.100.4", "1.2.3.4", 1), "198.51.100.4");
  // a host that writes only the visitor
  assert.equal(ipOf("10.0.0.2", "6.6.6.6, 203.0.113.9", 0), "203.0.113.9");
});

test("rate-limit keys group an IPv6 /64", () => {
  assert.equal(rateKey("203.0.113.9"), "203.0.113.9");
  assert.equal(rateKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(rateKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(rateKey("2001:db8:1:2:bbbb:cccc:dddd:eeee"), "2001:db8:1:2::/64");
  assert.equal(rateKey("2001:db8::1"), "2001:db8:0:0::/64");
  // the RPC budget groups a whole /56 (one home's usual allocation)
  assert.equal(rateKey("2001:db8:1:2ab::1", 56), "2001:db8:1:200::/56");
  assert.equal(rateKey("2001:db8:1:2ff:9::1", 56), "2001:db8:1:200::/56");
  assert.equal(rateKey("203.0.113.9", 56), "203.0.113.9");
});

test("gate: a few at a time, a few more wait, the rest are turned away", async () => {
  const g = gate(1, 1, 50, "busy");
  let release!: () => void;
  const first = g(() => new Promise<void>((r) => (release = r)));
  const second = g(async () => "second");
  await assert.rejects(g(async () => "third"), (e: Error & { status?: number }) => e.status === 503);
  release();
  await first;
  assert.equal(await second, "second");
  assert.deepEqual(g.stats(), { active: 0, queued: 0 });
  // waiting too long gives up
  let hold!: () => void;
  const busy = g(() => new Promise<void>((r) => (hold = r)));
  await assert.rejects(g(async () => 1), /busy/);
  hold();
  await busy;
});

test("the RPC gateway passes only the app's calls, in small amounts", async () => {
  const call = (method: string, params: unknown[] = []) => ({ jsonrpc: "2.0", id: 1, method, params });
  assert.equal((await proxyRpc(call("getProgramAccounts", ["x"]))).status, 403);
  assert.equal((await proxyRpc(call("constructor"))).status, 403);
  assert.equal((await proxyRpc(call("getSignaturesForAddress", ["x", { limit: 1000 }]))).status, 403);
  assert.equal((await proxyRpc(call("getSignaturesForAddress", ["x"]))).status, 403, "no limit means 1000");
  assert.equal((await proxyRpc(call("getMultipleAccounts", [new Array(101).fill("x")]))).status, 403);
  assert.equal((await proxyRpc(Array.from({ length: 6 }, () => call("getBalance", ["x"])))).status, 400);
  // everyone together: a burst of two seconds' worth, refilled every second
  const now = Date.now() + 10_000;
  let n = 0;
  while (admit("visitor-a", 5, now)) n++;
  assert.equal(n, 6, "one visitor: three seconds of their own 10 a second");
  for (const k of ["visitor-a2", "visitor-a3"]) while (admit(k, 5, now)) n++;
  assert.equal(n, 9, "60 at the default 30 a second, 18 of them held back for payments (the last call may dip in)");
  assert.equal(admit("visitor-b", 3, now), false);
  assert.equal(admit("visitor-b", 2, now, true), true, "sending and confirming still get through");
  assert.equal(admit("visitor-b", 1, now + 1_000), true, "it refills every second");
});

/** Runs visitors against the gateway on a made-up clock; returns each one's share of calls let in. */
function simulate(start: number, seconds: number, visitors: { key: string; everyMs: number; cost: number; urgent?: boolean }[]) {
  const got = new Map<string, { asked: number; ok: number }>();
  for (let t = 0; t < seconds * 1000; t += 10) {
    for (const v of visitors) {
      if (t % v.everyMs) continue;
      const g = got.get(v.key) ?? { asked: 0, ok: 0 };
      g.asked++;
      if (admit(v.key, v.cost, start + t, v.urgent)) g.ok++;
      got.set(v.key, g);
    }
  }
  return (key: string) => got.get(key)!.ok / got.get(key)!.asked;
}

test("the RPC gateway shares fairly: a few greedy visitors can't shut out anyone else", () => {
  // three scripts asking 50 times a second each, against one ordinary app tab
  const share = simulate(Date.now() + 1e6, 30, [
    { key: "greedy-1", everyMs: 20, cost: 1 },
    { key: "greedy-2", everyMs: 20, cost: 1 },
    { key: "greedy-3", everyMs: 20, cost: 1 },
    { key: "tab", everyMs: 500, cost: 1 },
    { key: "tab-history", everyMs: 5_000, cost: 5 },
    { key: "tab-send", everyMs: 1_000, cost: 1, urgent: true },
  ]);
  assert.ok(share("tab") >= 0.9, `balance reads: ${share("tab")}`);
  assert.ok(share("tab-history") >= 0.9, `history reads aren't starved by cheap ones: ${share("tab-history")}`);
  assert.ok(share("tab-send") >= 0.9, `sends: ${share("tab-send")}`);
  assert.ok(share("greedy-1") < 0.25, "each script gets about its fair share");
});

test("many greedy visitors at once still leave ordinary visitors their even share", () => {
  // twelve scripts: each one's own floor of 4 a second adds up to more than the site's 30
  const greedy = Array.from({ length: 12 }, (_, i) => ({ key: `many-${i}`, everyMs: 20, cost: 1 }));
  const all = [...greedy, { key: "tab-2", everyMs: 1_000, cost: 1 }, { key: "tab-2-history", everyMs: 5_000, cost: 5 }];
  // the scripts come first; a tab arriving waits a moment while the split adjusts (the app retries
  // a busy answer), so the first seconds are left aside
  const t0 = Date.now() + 1.5e6;
  simulate(t0, 10, greedy);
  simulate(t0 + 10_000, 3, all);
  const share = simulate(t0 + 13_000, 30, all);
  assert.ok(share("tab-2") >= 0.9, `balance reads: ${share("tab-2")}`);
  assert.ok(share("tab-2-history") >= 0.9, `history reads: ${share("tab-2-history")}`);
});

test("on a small RPC plan one visitor's urgent polling can't drain the payment reserve", () => {
  const rate = config.rpcProxyPerSecond;
  config.rpcProxyPerSecond = 5;
  try {
    const share = simulate(Date.now() + 2e6, 60, [
      { key: "poller", everyMs: 100, cost: 1, urgent: true },
      { key: "payer", everyMs: 1_000, cost: 1, urgent: true },
      { key: "reader", everyMs: 2_000, cost: 1 },
    ]);
    assert.ok(share("payer") >= 0.9, `payments still confirm: ${share("payer")}`);
    assert.ok(share("reader") >= 0.9, `reads still pass: ${share("reader")}`);
  } finally {
    config.rpcProxyPerSecond = rate;
  }
});

test("the gateway keeps count of a bounded number of visitors, at a small cost per call", () => {
  const t0 = Date.now() + 3e6;
  const started = performance.now();
  for (let i = 0; i < 60_000; i++) admit(`rotating-${i}`, 1, t0 + i / 10);
  assert.ok(keyCount() <= 50_000, `${keyCount()} kept`);
  assert.ok(performance.now() - started < 2_000, "no full scans");
  admit("later", 1, t0 + 60_000);
  assert.ok(keyCount() < 10, "quiet visitors are forgotten");
});

test("visitor addresses are checked for shape before any decoding", () => {
  const started = performance.now();
  for (const bad of ["z".repeat(200_000), "1".repeat(45), "0OIl".repeat(10), "", 42, null, ["x"]]) {
    assert.throws(() => parseKey(bad), (e: Error & { status?: number }) => e.status === 400 && /Invalid public key/.test(e.message));
  }
  assert.ok(performance.now() - started < 50, "a huge string is refused at once");
  assert.equal(parseKey("So11111111111111111111111111111111111111112").toBase58(), "So11111111111111111111111111111111111111112");
  const t0 = performance.now();
  assert.equal(looksLikeSecret("z".repeat(200_000)), false);
  assert.equal(looksLikeSecret("z".repeat(88)), true);
  assert.equal(looksLikeSecret("0".repeat(88)), false);
  assert.ok(performance.now() - t0 < 50, "an order key is checked for shape at once too");
});

test("public /api/health is a summary; the live counts need the operator's token", async () => {
  const app = Fastify();
  const token = "operator-secret-1234";
  healthRoutes(app, {
    token,
    summary: async () => ({
      problems: [],
      warnings: [],
      fields: {
        version: "1.5.0",
        jupiter: { key: true, host: "lite-api.jup.ag", lanes: { exec: { queued: 3 } } },
        indexer: { state: "live", lastSlotAt: 123 },
        state: { backend: "replit app storage", restored: {}, errors: 0, saved: true },
        // a detail put in the summary by mistake never reaches the public
        scheduler: { waiting: 2 },
      },
    }),
    details: async () => ({
      jupiter: { key: true, host: "lite-api.jup.ag", lanes: {} },
      prices: { pollsLastMinute: 4 },
      orders: { active: 1, oldestQueuedSec: 0 },
      scheduler: { waiting: 2, late: 0 },
    }),
    warnings: async () => ["SCHEDULE_LATE"],
  });
  const get = async (url: string, headers: Record<string, string> = {}) => (await app.inject({ method: "GET", url, headers })).json() as Record<string, unknown>;
  const pub = await get("/api/health");
  assert.equal(pub.ok, true);
  for (const k of ["scheduler", "orders", "prices"]) assert.ok(!(k in pub), `no ${k} in public`);
  assert.deepEqual(pub.jupiter, { key: true, host: "lite-api.jup.ag" });
  assert.deepEqual(pub.indexer, { state: "live" });
  const wrong = await get("/api/health", { "x-health-token": "operator-secret-9999" });
  assert.ok(!("scheduler" in wrong), "a wrong token of the same length shows nothing more");
  assert.ok(!("scheduler" in (await get("/api/health?token="))));
  for (const op of [await get("/api/health", { "x-health-token": token }), await get(`/api/health?token=${token}`)]) {
    for (const k of ["scheduler", "orders", "prices"]) assert.ok(k in op, `${k} for the operator`);
  }
  const alerts = await app.inject({ method: "GET", url: "/api/health/alerts" });
  assert.equal(alerts.statusCode, 503);
  assert.deepEqual(alerts.json(), { ok: false, warnings: ["SCHEDULE_LATE"] });
  await app.close();
});

test("Range's answers are kept an hour at most, and only so many", () => {
  const cache = new Map<string, { at: number; flagged: boolean }>();
  const t = 1_700_000_000_000;
  rememberVendor(cache, "old", false, t);
  rememberVendor(cache, "newer", true, t + 1_000);
  rememberVendor(cache, "now", false, t + 3_600_000);
  assert.deepEqual([...cache.keys()], ["newer", "now"], "expired ones go");
  for (let i = 0; i < 20_005; i++) rememberVendor(cache, `a${i}`, false, t + 3_600_000);
  assert.equal(cache.size, 20_000);
  assert.ok(!cache.has("newer") && cache.has("a20004"), "the oldest go first");
});

test("only real raster images pass as icons", () => {
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(Buffer.from("\0\0\0\x1cftypavif")), "image/avif");
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from("<!doctype html><script>x</script>")), null);
});

test("in Fastify: req.ip ignores a made-up header, and a limit answers in the app's { error } shape", async () => {
  const app = Fastify({ trustProxy: proxyTrust(1) });
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => rateKey(req.ip),
    errorResponseBuilder: (_req, ctx) => Object.assign(new Error(`Too many requests from your network. Try again in ${ctx.after}.`), { statusCode: ctx.statusCode }),
  });
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err.statusCode === 429) return reply.code(429).send({ error: err.message });
    reply.send(err);
  });
  app.get("/ip", { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } }, async (req) => ({ ip: req.ip }));
  app.get("/boom", async () => {
    throw Object.assign(new Error("nope"), { statusCode: 418 });
  });
  const ask = (xff: string) => app.inject({ url: "/ip", remoteAddress: "35.191.0.9", headers: { "x-forwarded-for": xff } });
  assert.equal((await ask("9.9.9.9, 203.0.113.5, 34.1.2.3")).json().ip, "203.0.113.5");
  const second = await ask("8.8.8.8, 203.0.113.5, 34.1.2.3");
  assert.equal(second.statusCode, 429, "a new made-up entry doesn't buy a fresh limit");
  assert.match(second.json().error, /Too many requests/);
  assert.equal((await app.inject({ url: "/boom" })).statusCode, 418, "other errors keep their usual handling");
  await app.close();
});

test("ip-check: trusting more hops than exist is caught even without a made-up header", () => {
  // Replit: the balancer writes "<visitor>, <balancer>" and connects from Google's range
  assert.equal(proxyVerdict("35.191.3.4", "203.0.113.9, 34.120.1.1", 1).ok, true);
  const tooMany = proxyVerdict("35.191.3.4", "203.0.113.9, 34.120.1.1", 2);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.reason ?? "", /fake/);
  const tooFew = proxyVerdict("35.191.3.4", "203.0.113.9, 34.120.1.1", 0);
  assert.equal(tooFew.ok, false);
  assert.equal(tooFew.unsure, true);
  assert.equal(proxyVerdict("35.191.3.4", "203.0.113.9, 34.120.1.1", null).ok, false, "off behind a proxy");
  assert.equal(proxyVerdict("10.0.0.2", "10.0.0.9", 1).ok, false, "only the host's own addresses");
  assert.equal(proxyVerdict("127.0.0.1", undefined, 1).ok, true, "a local run");
  assert.equal(proxyVerdict("198.51.100.4", "1.2.3.4", 1).ok, true, "a visitor straight in can't claim an address");
});

test("SVG logos are recognised (and served only as downloads); HTML never is", async () => {
  const { sniffSvg, ipfsPath } = await import("../src/swap.ts");
  assert.equal(sniffSvg(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>')), true);
  assert.equal(sniffSvg(Buffer.from("<svg viewBox='0 0 1 1'/>")), true);
  assert.equal(sniffSvg(Buffer.from("<!doctype html><html><svg></svg></html>")), false);
  assert.equal(sniffSvg(Buffer.from("hello <svg>")), false);
  assert.equal(ipfsPath("https://ipfs.io/ipfs/QmQr3Fz4h1etNsF7oLGMRHiCzhB5y9a7GjyodnF7zLHK1g"), "/ipfs/QmQr3Fz4h1etNsF7oLGMRHiCzhB5y9a7GjyodnF7zLHK1g");
  assert.equal(ipfsPath("https://bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum.ipfs.nftstorage.link"), "/ipfs/bafkreibk3covs5ltyqxa272uodhculbr6kea6betidfwy3ajsav2vjzyum");
  assert.equal(ipfsPath("https://arweave.net/abc"), null);
});

test("while orders and payments aren't loaded here, every route that reads them asks the app to come back", async () => {
  const { startupGate } = await import("../src/startup.ts");
  const app = Fastify();
  let ready = false;
  startupGate(app, () => ready);
  for (const [method, url] of [["POST", "/api/relay/jobs/status"], ["GET", "/api/relay/jobs"], ["POST", "/api/relay/cancel"], ["POST", "/api/relay/schedule"], ["POST", "/api/relay"], ["POST", "/api/relay/prepare"], ["POST", "/api/relay/check"], ["GET", "/api/hops/open"], ["POST", "/api/hops/lookup"], ["GET", "/api/orders/status"], ["GET", "/api/orders/limits"], ["GET", "/api/relay/fees"]] as const) {
    app.route({ method, url, handler: async () => ({ ok: true }) });
  }
  const ask = (method: "GET" | "POST", url: string) => app.inject({ method, url, payload: method === "POST" ? {} : undefined });
  for (const [method, url] of [["POST", "/api/relay/jobs/status"], ["POST", "/api/relay/jobs/status?x=1"], ["GET", "/api/relay/jobs?ids=a"], ["POST", "/api/relay/cancel"], ["GET", "/api/hops/open"], ["POST", "/api/hops/lookup"], ["GET", "/api/orders/status"]] as const) {
    const r = await ask(method, url);
    assert.equal(r.statusCode, 503, `${method} ${url}`);
    assert.equal(r.headers["retry-after"], "10");
    assert.equal((r.json() as { code?: string }).code, "busy");
  }
  // a payment sent now waits on the app's "busy, trying again" path
  assert.equal((await ask("POST", "/api/relay")).statusCode, 429);
  assert.equal((await ask("POST", "/api/relay/schedule")).statusCode, 429);
  assert.equal((await ask("POST", "/api/relay/prepare")).statusCode, 429);
  // nothing else is held up
  assert.equal((await ask("GET", "/api/orders/limits")).statusCode, 200);
  assert.equal((await ask("GET", "/api/relay/fees")).statusCode, 200);
  assert.equal((await ask("POST", "/api/relay/check")).statusCode, 200, "a recipient check needs no stored state");
  assert.equal((await ask("GET", "/api/relay/jobs/statusx")).statusCode, 404);
  ready = true;
  assert.equal((await ask("POST", "/api/relay/jobs/status")).statusCode, 200);
  await app.close();
});

test("asking whether an address was ever used is a light read; full history reads cost more", async () => {
  const { costOf } = await import("../src/rpc.ts");
  assert.equal(costOf({ method: "getSignaturesForAddress", params: ["x", { limit: 1 }] }), 2);
  assert.equal(costOf({ method: "getSignaturesForAddress", params: ["x", { limit: 10 }] }), 5);
  assert.equal(costOf({ method: "getSignaturesForAddress", params: ["x"] }), 5);
  assert.equal(costOf({ method: "getBalance", params: ["x"] }), 1);
});
