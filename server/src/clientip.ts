import { isIP } from "node:net";

/**
 * Who is asking, for rate limits. Behind Replit's load balancer X-Forwarded-For reads
 * "<whatever the visitor wrote>, <visitor>, <load balancer>", and the request arrives from a
 * private or Google front-end address. Only what our own proxies wrote counts, so the walk goes
 * from the connection outwards: private and Google front-end addresses are skipped, then
 * `publicHops` public proxy entries; the next entry is the visitor. Anything further left was
 * written by the visitor and is never read.
 *
 * Fastify (proxy-addr) calls the returned function for one request at a time, hop 0 first.
 */
export function proxyTrust(publicHops: number) {
  let seen = 0;
  return (addr: string, i: number): boolean => {
    if (i === 0) seen = 0;
    if (proxyAddress(addr)) return true;
    // a visitor connecting straight to us: whatever its header says means nothing
    if (i === 0) return false;
    seen++;
    return seen <= publicHops;
  };
}

/**
 * Checks TRUST_PROXY_HOPS against one real request: walks it exactly as Fastify does and says
 * whether the address it lands on can be trusted. Trusting more hops than the host has is the
 * dangerous mistake (visitors could then write their own address), and it shows here even
 * without a made-up header: the walk runs off the end of X-Forwarded-For.
 */
export function proxyVerdict(
  socket: string,
  xff: string | undefined,
  publicHops: number | null,
): { ok: boolean; seenAs: string; reason?: string; unsure?: boolean } {
  const entries = String(xff ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // nobody's proxy in front (a local run): the connection is the visitor
  if (!entries.length) return { ok: true, seenAs: socket };
  const chain = [socket, ...[...entries].reverse()];
  if (publicHops == null) {
    return proxyAddress(socket)
      ? { ok: false, seenAs: socket, reason: "A proxy is in front of the server but TRUST_PROXY_HOPS is off: every visitor looks the same." }
      : { ok: true, seenAs: socket };
  }
  const trust = proxyTrust(publicHops);
  let i = 0;
  while (i < chain.length - 1 && trust(chain[i], i)) i++;
  const seenAs = chain[i];
  if (i === chain.length - 1 && trust(seenAs, i)) {
    return { ok: false, seenAs, reason: "More proxy hops are trusted than exist: visitors could fake their address. Lower TRUST_PROXY_HOPS by one." };
  }
  if (proxyAddress(seenAs)) {
    return { ok: false, seenAs, reason: "The address seen is one of the host's own proxies, so every visitor looks the same. Raise TRUST_PROXY_HOPS by one." };
  }
  // without a made-up header, a right setup has exactly the visitor plus the host's public hops
  if (entries.filter((x) => !proxyAddress(x)).length > publicHops + 1) {
    return { ok: false, seenAs, reason: "More addresses arrived than TRUST_PROXY_HOPS expects, so the one seen may be the host's. Unless you're on a VPN or office network, raise TRUST_PROXY_HOPS by one.", unsure: true };
  }
  return { ok: true, seenAs };
}

/** Private networks, loopback, and the ranges Google's load balancers connect from. */
export function proxyAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (isIP(v4) === 4) {
    const [a, b, c] = v4.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 35 && b === 191) ||
      (a === 130 && b === 211 && c < 4)
    );
  }
  if (isIP(ip) !== 6) return false;
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * The rate-limit bucket for an address: one IPv6 home or phone gets a whole /64, so it counts as one.
 * `bits` 56 groups wider still (a home is often given a /56), for budgets one person mustn't multiply.
 */
export function rateKey(ip: string, bits: 64 | 56 = 64): string {
  const v4 = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  if (isIP(v4) !== 6) return v4;
  const groups = expand(v4);
  if (!groups) return v4;
  if (bits === 56) return `${groups.slice(0, 3).join(":")}:${(parseInt(groups[3], 16) & 0xff00).toString(16)}::/56`;
  return `${groups.slice(0, 4).join(":")}::/64`;
}

function expand(ip: string): string[] | null {
  let s = ip.split("%")[0].toLowerCase();
  // an IPv4 tail (::ffff:1.2.3.4 style) becomes two groups
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    s = s.slice(0, tail.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = rest === undefined ? [] : rest ? rest.split(":") : [];
  const zeros = 8 - h.length - t.length;
  if (rest === undefined ? h.length !== 8 : zeros < 0) return null;
  return [...h, ...new Array(rest === undefined ? 0 : zeros).fill("0"), ...t].map((g) => g.replace(/^0+(?=.)/, ""));
}
