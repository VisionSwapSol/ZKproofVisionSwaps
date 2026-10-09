import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * /api/health and /api/health/alerts. Anyone may see a summary; live counts (payments waiting,
 * orders queued, Jupiter use, price polls) would show when people schedule, place and send things,
 * so only the operator sees those, with HEALTH_TOKEN.
 *
 * The summary passes through a fixed list of fields (and of the fields inside them), so a detail
 * added to it by mistake later never reaches the public.
 */
const PUBLIC: Record<string, true | readonly string[]> = {
  version: true,
  network: true,
  programId: true,
  program: true,
  depositFees: true,
  jupiter: ["key", "host"],
  instance: true,
  uptimeSeconds: true,
  indexer: ["state"],
  relayer: ["address", "lamports", "low", "threshold"],
  guard: ["address", "lamports", "low", "threshold"],
  state: ["backend", "restored", "errors", "saved"],
};

export type Health = {
  /** the operator's HEALTH_TOKEN (none: the details are never shown) */
  token: string | null | undefined;
  /** plain reasons the site isn't fully working (ok is false and the answer a 503 while there are any), the warnings, and the summary */
  summary: () => Promise<{ problems: string[]; warnings: string[]; fields: Record<string, unknown> }>;
  /** what only the operator sees */
  details: () => Promise<Record<string, unknown>>;
  /** for the uptime monitor: on/off flags only */
  warnings: () => Promise<string[]>;
};

/** The operator's token, in an x-health-token header or ?token= (compared in constant time). */
export function isOperator(token: string | null | undefined, req: FastifyRequest): boolean {
  if (!token) return false;
  const given = req.headers["x-health-token"] ?? (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof given !== "string" || !given) return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(given), hash(token));
}

/** Only the listed fields (and, for objects, only their listed fields) of the summary. */
function publicView(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, allowed] of Object.entries(PUBLIC)) {
    if (!(k in fields)) continue;
    const v = fields[k];
    if (allowed === true || v == null || typeof v !== "object") out[k] = v;
    else out[k] = Object.fromEntries(allowed.filter((f) => f in v).map((f) => [f, (v as Record<string, unknown>)[f]]));
  }
  return out;
}

export function healthRoutes(app: FastifyInstance, h: Health) {
  const limit = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };
  app.get("/api/health", limit, async (req, reply) => {
    const { problems, warnings, fields } = await h.summary();
    if (problems.length) reply.code(503);
    const body: Record<string, unknown> = { ok: problems.length === 0, problems, warnings, ...publicView(fields) };
    if (isOperator(h.token, req)) Object.assign(body, await h.details());
    return body;
  });
  // for an uptime monitor: answers 503 (naming the problem) while anything in `warnings` needs the operator
  app.get("/api/health/alerts", limit, async (_req, reply) => {
    const warnings = await h.warnings();
    reply.code(warnings.length ? 503 : 200).send({ ok: warnings.length === 0, warnings });
  });
}
