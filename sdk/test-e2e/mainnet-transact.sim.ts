// Read-only check of the private-spend path on Solana MAINNET. It rebuilds the
// pool from the chain alone, makes a real zero-value proof against the live
// root, and SIMULATES the transact the relayer would send (no signatures,
// nothing is sent, no funds move).
//   node --import tsx --test sdk/test-e2e/mainnet-transact.sim.ts
// Optional: VS_RPC (default: the public mainnet endpoint), VS_PROGRAM, VS_RELAYER.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  Pool,
  fetchConfig,
  fetchTree,
  scanPoolHistory,
  leavesFromEvents,
  keysFromSignature,
  randomNonce,
  MerkleTree,
  computeBudget,
  TRANSACT_CU,
  H2,
  H3,
  type OwnedNote,
} from "../src/index.ts";
import { proveSpend, verifyOffchain } from "../src/prover.ts";

const here = dirname(fileURLToPath(import.meta.url));
const art = join(here, "..", "..", "circuits", "artifacts");
const conn = new Connection(process.env.VS_RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const pool = new Pool(new PublicKey(process.env.VS_PROGRAM ?? "VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6"));
const relayer = new PublicKey(process.env.VS_RELAYER ?? "2nkK5N2hsgFQfsDaD19Qpg6Q6TZ3VXfnGNiy1kBcSEAw");

test("mainnet: the pool rebuilds from chain history and a private spend simulates cleanly", { timeout: 300_000 }, async () => {
  const cfg = await fetchConfig(conn, pool);
  const onchain = await fetchTree(conn, pool);

  // 1. rebuild the tree from events alone, exactly as an independent client would
  const history = await scanPoolHistory(conn, pool, { concurrency: 2 });
  const leaves = leavesFromEvents(history.flatMap((h) => h.events));
  const tree = new MerkleTree(leaves.map((l) => l.leaf));
  console.log(`  ${leaves.length} leaf(s) in the pool; on-chain next index ${onchain.nextIndex}`);
  assert.equal(tree.size, Number(onchain.nextIndex), "event history and the tree account agree on size");
  assert.ok(onchain.roots.includes(tree.root()), "the rebuilt root is one the program knows");
  assert.ok(tree.size > 0, "needs at least one leaf to borrow a Merkle path from");

  // 2. a real proof that spends two zero-value notes (no Merkle check applies to zero amounts)
  const keys = keysFromSignature(Keypair.generate().secretKey);
  const blinding = 12345678901234567890n;
  const c = H2(0n, H2(keys.pubKey, blinding));
  const zero: OwnedNote = {
    index: 0,
    leaf: tree.leaf(0),
    amount: 0n,
    blinding,
    nonce: randomNonce(),
    nullifier: H3(c, 0n, H3(keys.privKey, c, 0n)),
  } as OwnedNote;
  const recipient = Keypair.generate().publicKey;
  const sp = await proveSpend({
    keys,
    tree,
    inputs: [zero],
    outputs: [
      { amount: 0n, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient, relayer, withdraw: 0n, relayerFee: 0n, maxFeeBps: cfg.feeBps },
    wasm: join(art, "transaction.wasm"),
    zkey: join(art, "transaction.zkey"),
  });
  const vk = JSON.parse(readFileSync(join(art, "verification_key.json"), "utf8"));
  assert.ok(await verifyOffchain(vk, sp.publicSignals, sp.raw), "proof verifies off-chain");

  // 3. the transaction the relayer sends, simulated against the live program
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: relayer,
    recentBlockhash: blockhash,
    instructions: [...computeBudget(TRANSACT_CU, 20_000), pool.transact(sp, cfg.treasury)],
  }).compileToLegacyMessage();
  const tx = new VersionedTransaction(msg);
  const size = tx.serialize().length;
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const logs = sim.value.logs ?? [];
  console.log(`  transact: ${size} bytes, ${sim.value.unitsConsumed} of ${TRANSACT_CU} CU, err ${JSON.stringify(sim.value.err)}`);
  if (sim.value.err) console.log(logs.slice(-12).map((l) => "    " + l).join("\n"));
  assert.equal(sim.value.err, null, "the live program accepts the spend");
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});
