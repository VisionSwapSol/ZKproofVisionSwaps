import { PublicKey, Transaction } from "@solana/web3.js";
import { computeBudget } from "@visionswap/sdk";
import { config } from "./config.ts";
import { conn, pool, poolConfig, confirm, payerUnfunded } from "./chain.ts";
import { store } from "./indexer.ts";
import type { PendingRec } from "./store.ts";
import { isFlagged, screenedSinceStart } from "./guard.ts";
import { log } from "./log.ts";

/**
 * Settles waiting-room deposits once their delay is over. Settling is
 * permissionless, so if this server ever stops, depositors (or anyone) can
 * settle with any wallet; the app has a button for it.
 */
const tried = new Map<string, number>();

/** Simulation failures are summed up in the log at most once a minute. */
let quiet = { at: 0, skipped: 0, reason: "" };
function noteSkip(reason: string) {
  quiet.skipped++;
  quiet.reason = reason;
  if (Date.now() - quiet.at < 60_000) return;
  log(`crank: ${quiet.skipped} deposit(s) not settled in the last minute (${quiet.reason})`);
  quiet = { at: Date.now(), skipped: 0, reason: "" };
}

const reasonOf = (err: unknown, logs: string[] | null) =>
  payerUnfunded(err, logs)
    ? "the relayer is out of SOL"
    : (logs ?? []).some((l) => /StillWaiting|0x1774/.test(l))
      ? "still waiting"
      : JSON.stringify(err).slice(0, 80);

async function settleTx(batch: PendingRec[], treasury: PublicKey) {
  const payer = config.relayer!;
  const tx = new Transaction().add(
    ...computeBudget(60_000 * batch.length, config.priorityMicroLamports),
    ...batch.map((p) => pool.settle(pool.pending(BigInt("0x" + p.inner)), new PublicKey(p.depositor), treasury)),
  );
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer);
  return tx;
}

/** Simulates first, then sends and confirms: how many deposits it settled, or why it couldn't. */
async function trySettle(batch: PendingRec[], treasury: PublicKey): Promise<{ settled: number; err?: string; unfunded?: boolean }> {
  const tx = await settleTx(batch, treasury);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) return { settled: 0, err: reasonOf(sim.value.err, sim.value.logs), unfunded: payerUnfunded(sim.value.err, sim.value.logs) };
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  return { settled: (await confirm(sig, 45_000)) === "confirmed" ? batch.length : 0 };
}

/**
 * Why our relayer leaves a waiting deposit alone for now: the guard flagged it
 * (it waits for its refund instead of joining the pool), or it was already
 * waiting when this server started and hasn't been re-screened here yet (flags
 * live in memory only). One queued since the start needs no extra look.
 */
export function heldBack(inner: string, guard = { isFlagged, screenedSinceStart }): "flagged" | "unscreened" | null {
  if (guard.isFlagged(inner)) return "flagged";
  return guard.screenedSinceStart(inner) ? null : "unscreened";
}

export async function settleReady(): Promise<number> {
  const payer = config.relayer;
  if (!payer || store.pending.size === 0) return 0;
  const cfg = await poolConfig();
  const slot = BigInt(await conn.getSlot("confirmed"));
  const now = Date.now();
  const ready = [...store.pending.values()].filter(
    (p) => BigInt(p.slot) + cfg.depositDelay <= slot && now - (tried.get(p.inner) ?? 0) > 20_000 && !heldBack(p.inner),
  );
  let done = 0;
  for (let i = 0; i < ready.length; i += 6) {
    const batch = ready.slice(i, i + 6);
    batch.forEach((p) => tried.set(p.inner, now));
    try {
      // a second copy of this server (say, a dev workspace next to the published one) rarely picks the same moment
      await new Promise((r) => setTimeout(r, Math.random() * 2500));
      let res = await trySettle(batch, cfg.treasury);
      if (res.err && !res.unfunded && batch.length > 1) {
        // one deposit that can't settle (already settled or refunded) must not hold back the others
        for (const p of batch) {
          res = await trySettle([p], cfg.treasury);
          if (res.err) noteSkip(res.err);
          done += res.settled;
          if (res.unfunded) break;
        }
      } else {
        if (res.err) noteSkip(res.err);
        done += res.settled;
      }
      if (res.unfunded) break; // nothing settles until the relayer is topped up
    } catch (e) {
      log("crank:", (e as Error).message.slice(0, 160));
    }
  }
  for (const [k, t] of tried) if (now - t > 600_000) tried.delete(k);
  return done;
}

/** Settles one waiting deposit right away (the app's "add it now" button, for accounts with no SOL to pay the fee). */
export async function settleOne(inner: string): Promise<string> {
  const payer = config.relayer;
  if (!payer) throw Object.assign(new Error("Settling isn't available on this server."), { status: 503 });
  const p = store.pending.get(inner);
  if (!p) throw Object.assign(new Error("That deposit has already left the waiting room."), { status: 404 });
  const held = heldBack(inner);
  if (held === "flagged") {
    throw Object.assign(new Error("This deposit can't be added to the pool. It will be sent back to the address it came from."), { status: 409 });
  }
  if (held) {
    throw Object.assign(new Error("Adding deposits is paused for a moment. Your deposit is safe; please try again in a few minutes."), { status: 503 });
  }
  const cfg = await poolConfig();
  const slot = BigInt(await conn.getSlot("confirmed"));
  if (BigInt(p.slot) + cfg.depositDelay > slot) throw Object.assign(new Error("That deposit is still in the waiting room."), { status: 409 });
  const tx = await settleTx([p], cfg.treasury);
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    if (payerUnfunded(sim.value.err, sim.value.logs)) {
      noteSkip(reasonOf(sim.value.err, sim.value.logs));
      throw Object.assign(new Error("Adding deposits is paused for a moment. Your deposit is safe; please try again in a few minutes."), {
        status: 503,
      });
    }
    if ((sim.value.logs ?? []).some((l) => /StillWaiting|0x1774/.test(l))) {
      throw Object.assign(new Error("That deposit is still in the waiting room."), { status: 409 });
    }
    throw Object.assign(new Error("That deposit has already left the waiting room."), { status: 409 });
  }
  // the crank leaves this deposit alone while it is being added here (it would race this transaction)
  tried.set(inner, Date.now());
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const outcome = await confirm(sig, 45_000);
  if (outcome !== "confirmed") {
    // the crank (or anyone: settling is permissionless) added it first, so this copy failed: it is in the pool
    const still = await conn.getAccountInfo(pool.pending(BigInt("0x" + inner)), "confirmed").catch(() => undefined);
    if (still === null) throw Object.assign(new Error("That deposit has already left the waiting room."), { status: 404 });
    throw Object.assign(new Error("The network is slow right now. Try again in a minute."), { status: 503 });
  }
  return sig;
}

export function startCrank() {
  if (!config.crank || !config.relayer) return;
  const loop = async () => {
    try {
      await settleReady();
    } catch {
      /* next round */
    }
    setTimeout(loop, 4000).unref();
  };
  void loop();
}
