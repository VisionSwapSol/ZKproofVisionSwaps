// Rehearses a program upgrade on the LOCAL chain before doing it for real.
//   1. deploy the version that is live on mainnet, run 2-GO-LIVE --localnet
//   2. node --import tsx ops/rehearse-upgrade.ts --localnet before
//   3. run 3-ADMIN --localnet, option 13 (the upgrade being rehearsed)
//   4. node --import tsx ops/rehearse-upgrade.ts --localnet after
// "before" leaves a spendable note and a deposit still in the waiting room, both
// made the way today's live app makes them. "after" checks the upgraded program
// still settles that deposit, spends that note, refuses the old deposit format
// (so nobody pays a fee they weren't shown), and charges the new deposit fee.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  Pool,
  attestationMessage,
  computeBudget,
  depositFee,
  encodeMeta,
  fetchConfig,
  fetchPending,
  fetchTree,
  keysFromSignature,
  leavesFromEvents,
  MerkleTree,
  noteInner,
  randomNonce,
  scanNotes,
  scanPoolHistory,
  selectInputs,
  spentSet,
  splitWithdraw,
  TRANSACT_CU,
  type ConfigParams,
} from "@visionswap/sdk";
import { proveSpend } from "../sdk/src/prover.ts";
import { ROOT, loadKey, loadSettings, netFromArgs, rpcFor, sol } from "./common.ts";

const net = netFromArgs();
if (net !== "localnet") throw new Error("Rehearsals only run on the local chain (--localnet).");
const phase = process.argv.includes("after") ? "after" : "before";
const s = loadSettings(net);
const conn = new Connection(rpcFor(net, s), "confirmed");
const need = (n: string) => {
  const k = loadKey(n, net);
  if (!k) throw new Error(`keys/localnet-${n}.json is missing`);
  return k;
};
const program = need("program");
const admin = need("deployer");
const guard = need("guard");
const relayer = need("relayer");
const pool = new Pool(program.publicKey);
const user = Keypair.fromSeed(createHash("sha256").update("visionswap upgrade rehearsal user").digest());
const keys = keysFromSignature(ed25519.sign(new TextEncoder().encode("rehearsal"), user.secretKey.slice(0, 32)));
const art = join(ROOT, "circuits", "artifacts");
const SOL = BigInt(LAMPORTS_PER_SOL);
const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  try {
    return await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
  } catch (e) {
    const logs = (e as { logs?: string[] }).logs;
    throw new Error((e as Error).message + (logs ? "\n" + logs.join("\n") : ""));
  }
}

function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`FAILED: ${what}`);
  console.log(`  ok  ${what}`);
}

/** A deposit instruction as today's live app builds it: no fee limit at the end. */
function depositIx(amount: bigint, expiry: bigint, withFeeLimit: boolean) {
  const nonce = randomNonce();
  const inner = noteInner(keys, nonce);
  const ix = pool.deposit({ depositor: user.publicKey, amount, inner, meta: encodeMeta(keys, nonce, amount), attestationExpiry: expiry, maxFeeBps: 80 });
  if (!withFeeLimit) ix.data = ix.data.subarray(0, ix.data.length - 2);
  return { ix, inner };
}

async function deposit(amount: bigint, withFeeLimit: boolean) {
  const expiry = BigInt(await conn.getSlot("confirmed")) + 150n;
  const sig = ed25519.sign(attestationMessage(user.publicKey, expiry), guard.secretKey.slice(0, 32));
  const d = depositIx(amount, expiry, withFeeLimit);
  await send([pool.attestationInstruction(guard.publicKey, sig, user.publicKey, expiry), d.ix], [user]);
  return d.inner;
}

async function waitDelay() {
  const delay = (await fetchConfig(conn, pool)).depositDelay;
  const start = BigInt(await conn.getSlot("confirmed"));
  while (BigInt(await conn.getSlot("confirmed")) < start + delay + 1n) await new Promise((r) => setTimeout(r, 300));
}

async function myNotes() {
  const events = (await scanPoolHistory(conn, pool)).flatMap((h) => h.events);
  const leaves = leavesFromEvents(events);
  return { tree: new MerkleTree(leaves.map((l) => l.leaf)), ...scanNotes(keys, leaves, spentSet(events)) };
}

if (phase === "before") {
  const cfg = await fetchConfig(conn, pool);
  const params: ConfigParams = { ...cfg, depositDelay: 5n };
  await send([pool.updateConfig(admin.publicKey, params)], [admin]);
  await conn.confirmTransaction(await conn.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL), "confirmed");

  // a note made and settled under the old program
  const a = await deposit(SOL, false);
  await waitDelay();
  await send([pool.settle(pool.pending(a), user.publicKey, cfg.treasury)], [relayer]); // the extra treasury account is ignored by the old program
  // a deposit left waiting across the upgrade
  const b = await deposit(SOL / 2n, false);
  const p = await conn.getAccountInfo(pool.pending(b), "confirmed");
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(p!.data.length));
  check(BigInt(p!.lamports) === rent, "the old program charges no deposit fee");
  check((await myNotes()).total === SOL, "a 1 SOL note exists before the upgrade");
  check((await fetchPending(conn, pool)).length === 1, "one deposit is waiting across the upgrade");
  console.log("\n  Ready. Now run 3-ADMIN --localnet, option 13, then: rehearse-upgrade.ts --localnet after");
} else {
  const cfg = await fetchConfig(conn, pool);
  // 1. the deposit made before the upgrade still settles, with no fee taken from it
  const [w] = await fetchPending(conn, pool);
  check(!!w, "the deposit made before the upgrade is still waiting");
  await waitDelay();
  const t0 = await bal(cfg.treasury);
  await send([pool.settle(w.address, w.depositor, cfg.treasury)], [relayer]);
  check((await bal(cfg.treasury)) === t0, "it settles under the new program, and no fee is taken from a deposit that never paid one");
  check((await myNotes()).total === SOL + SOL / 2n, "both old deposits are now notes");

  // 2. the old deposit format (today's live app) is refused, so nobody pays a fee they weren't shown
  let refused = false;
  try {
    await deposit(SOL / 10n, false);
  } catch (e) {
    refused = /InstructionDidNotDeserialize|0x66\b|custom program error: 0x66|102/i.test((e as Error).message);
  }
  check(refused, "a deposit from an old copy of the app is refused until the page is refreshed");

  // 3. the new deposit fee
  const amount = SOL / 4n;
  const fee = depositFee(amount, cfg.feeBps);
  const d = await deposit(amount, true);
  const p = await conn.getAccountInfo(pool.pending(d), "confirmed");
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(p!.data.length));
  check(BigInt(p!.lamports) === rent + fee, `the new deposit carries its ${sol(fee)} SOL fee`);
  await waitDelay();
  const t1 = await bal(cfg.treasury);
  await send([pool.settle(pool.pending(d), user.publicKey, cfg.treasury)], [relayer]);
  check((await bal(cfg.treasury)) - t1 === fee, "the fee reaches the treasury at settlement");

  // 4. a note made before the upgrade can be spent after it
  const { tree, notes } = await myNotes();
  const oldNote = notes.find((n) => n.amount === SOL)!;
  const withdraw = SOL / 2n;
  const recipient = Keypair.generate().publicKey;
  const sp = await proveSpend({
    keys,
    tree,
    inputs: [oldNote],
    outputs: [
      { amount: oldNote.amount - withdraw, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient, relayer: relayer.publicKey, withdraw, relayerFee: 2_000_000n, maxFeeBps: cfg.feeBps },
    wasm: join(art, "transaction.wasm"),
    zkey: join(art, "transaction.zkey"),
  });
  await send([...computeBudget(TRANSACT_CU, 0), pool.transact(sp, cfg.treasury)], [relayer]);
  check((await bal(recipient)) === splitWithdraw(withdraw, 2_000_000n, cfg.feeBps).toRecipient, "a note from before the upgrade pays out exactly");

  // 5. the books still balance
  const tree2 = await fetchTree(conn, pool);
  const v = await conn.getAccountInfo(pool.vault, "confirmed");
  const vaultRent = BigInt(await conn.getMinimumBalanceForRentExemption(v!.data.length));
  const live = (await myNotes()).total;
  check(BigInt(v!.lamports) - vaultRent - tree2.pendingLamports === live, "the vault holds exactly every live note");
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
  console.log("\n  Rehearsal passed.");
}
