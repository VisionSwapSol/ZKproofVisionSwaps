import { createHash } from "node:crypto";
import { cleanBody, precheck, deliveryInfo } from "./relayer.ts";
import { conn } from "./chain.ts";
import { nonces, sendOwner, SEND_TTL, SCHEDULE_TTL } from "./nonces.ts";
import { heldBy, isReserved, jobTokenOk } from "./schedule.ts";

/**
 * POST /api/relay/prepare: the step between proving a payment to an outside address and handing it
 * over. The payment is checked here as fully as it can be without sending it (its proof too), then
 * given what its hop signs over: a recent blockhash for a payment sent now (L1), and a durable
 * nonce (N2) for one sent later, or as a spare for one sent now.
 *
 *   { v: 2, request, delivery: { to, amount, mode: "instant" | "scheduled", offCurveOk?, spare? }, jobId?, token? }
 *   → { leaseId?, nonce?: { account, value, authority }, blockhash?, lastValidBlockHeight?, delivery }
 *
 * A scheduled payment's nonce is leased to its job id (and token), and asking again under the same
 * id gets the same nonce while it waits. A payment sent now gets a nonce only when one is spare (and
 * it wants one: `spare: false` asks for none), leased to the payment's own notes, so asking again
 * for the same payment gets the same nonce back instead of another.
 */
export async function prepareDelivery(raw: unknown, ip: string) {
  const r = (raw ?? {}) as Record<string, unknown>;
  const bad = () => Object.assign(new Error("Malformed request."), { status: 400 });
  if (r.v !== 2 || !r.delivery || typeof r.delivery !== "object") throw bad();
  const d = r.delivery as Record<string, unknown>;
  const mode = d.mode;
  if (mode !== "instant" && mode !== "scheduled") throw bad();
  const body = cleanBody({ v: 2, request: r.request, delivery: { to: d.to, amount: d.amount, ...(d.offCurveOk === true ? { offCurveOk: true } : {}) } });
  const nfs = body.request.nullifiers;
  let jobId: string | undefined;
  let tokenHash: string | undefined;
  if (mode === "scheduled") {
    if (!nonces.authorityKey) {
      throw Object.assign(new Error("Sending later isn't available right now. You can send it now instead."), { status: 503, code: "no_nonce" });
    }
    jobId = String(r.jobId ?? "");
    const token = String(r.token ?? "");
    if (!/^[0-9a-f]{24}$/.test(jobId) || !/^[0-9a-f]{32,64}$/.test(token)) throw bad();
    tokenHash = createHash("sha256").update(token).digest("hex");
    if (!jobTokenOk(jobId, tokenHash)) throw Object.assign(new Error("Not allowed."), { status: 403 });
  }
  // notes another scheduled payment holds (a job asking for itself again holds its own)
  const held = heldBy(nfs);
  const others = held.jobs.filter((id) => id !== jobId);
  if (others.length) {
    throw Object.assign(new Error("This SOL is set aside for a scheduled payment."), { status: 409, code: "held", held: held.nullifiers, jobs: others });
  }
  if (isReserved(nfs)) {
    throw Object.assign(new Error("This SOL is being scheduled in another payment right now. Please try again in a moment."), { status: 409, code: "in_flight" });
  }
  // everything checked (the proof too) before a nonce is handed out, so junk can't use the pool up
  await precheck(body, ip, jobId);
  if (mode === "scheduled") {
    const leased = nonces.lease({ owner: `job:${jobId}`, tokenHash, ttlMs: SCHEDULE_TTL, scheduled: true, ip, nullifiers: nfs });
    if (!leased) {
      throw Object.assign(new Error("Sending later is busy right now. Nothing was spent. Try again in a few minutes, or send it now."), {
        status: 503,
        code: "lease_busy",
        retryAfter: 60,
      });
    }
    // the value it is signed over is the one on-chain now (a nonce no payment has signed over yet)
    const lease = await nonces.confirmValue(leased);
    return { leaseId: lease.leaseId, nonce: { account: lease.account, value: lease.value, authority: nonces.authorityKey!.toBase58() }, delivery: deliveryInfo() };
  }
  // sent now: a spare nonce when there is one (the delivery can then still go if the blockhash runs out first)
  let lease: ReturnType<typeof nonces.lease> = null;
  try {
    lease = nonces.authorityKey && d.spare !== false ? nonces.lease({ owner: sendOwner(nfs), ttlMs: SEND_TTL, scheduled: false, ip, nullifiers: nfs }) : null;
    if (lease) lease = await nonces.confirmValue(lease);
  } catch {
    lease = null;
  }
  const bh = await conn.getLatestBlockhash("confirmed");
  return {
    ...(lease ? { leaseId: lease.leaseId, nonce: { account: lease.account, value: lease.value, authority: nonces.authorityKey!.toBase58() } } : {}),
    blockhash: bh.blockhash,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    delivery: deliveryInfo(),
  };
}
