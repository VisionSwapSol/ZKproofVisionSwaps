import type { FastifyInstance } from "fastify";

/**
 * Orders, send-later payments and deliveries are answered only once this copy has loaded them, which on the
 * published site is after the copy it replaces has saved and stopped (see takeOver in durable.ts),
 * and never while another copy holds them. Meanwhile those routes ask the app to come back in a
 * moment; the app already waits and retries.
 */
export const STATEFUL = /^\/api\/(orders(?!\/limits)|relay(\/(schedule|cancel|prepare|jobs(\/status)?))?([?#]|$)|hops\/(open|lookup)([?#]|$))/;

export function startupGate(app: FastifyInstance, ready: () => boolean) {
  app.addHook("onRequest", async (req, reply) => {
    if (ready() || !STATEFUL.test(req.url)) return;
    reply.header("Retry-After", "10");
    // a payment sent now waits on a 429 (the app's "busy, trying again" path); the rest say "still loading"
    const now = /^\/api\/relay(\/prepare)?([?#]|$)/.test(req.url) || req.url.startsWith("/api/relay/schedule");
    return reply.code(now ? 429 : 503).send({ error: "The site is starting up. Try again in a moment.", code: "busy" });
  });
}
