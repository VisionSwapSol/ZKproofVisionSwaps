// Read-only check of the Jupiter path on Solana MAINNET. It builds real swap
// transactions through the server code and SIMULATES them (no signatures,
// nothing is sent, no funds move).
//   node --import tsx --test server/test/mainnet-swap.sim.ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NETWORK = "mainnet";
process.env.RPC_URL = process.env.MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
process.env.DATA_DIR = "data-sim";
delete process.env.RELAYER_SECRET;
delete process.env.GUARD_SECRET;

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

const { PublicKey, VersionedTransaction } = await import("@solana/web3.js");
const { conn } = await import("../src/chain.ts");
const swap = await import("../src/swap.ts");
const { checkSwapTx } = await import("@visionswap/sdk");

/** Finds real wallets that hold USDC and some SOL, from recent USDC transfers. */
async function findHolders(): Promise<{ solRich: string; usdcRich: string; wsolAccount: string }> {
  const sigs = await conn.getSignaturesForAddress(new PublicKey(USDC), { limit: 25 });
  let solRich = "";
  let usdcRich = "";
  let wsolAccount = "";
  for (const s of sigs) {
    if (solRich && usdcRich && wsolAccount) break;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (!tx?.meta) continue;
    for (const b of tx.meta.postTokenBalances ?? []) {
      if (!b.owner) continue;
      const ui = Number(b.uiTokenAmount.uiAmount ?? 0);
      const onCurve = PublicKey.isOnCurve(new PublicKey(b.owner).toBytes());
      if (!onCurve) continue;
      if (b.mint === WSOL && !wsolAccount && ui >= 0) {
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
        wsolAccount = keys.get(b.accountIndex)!.toBase58();
      }
      if (b.mint === USDC && ui > 5) {
        const lamports = await conn.getBalance(new PublicKey(b.owner));
        if (lamports > 0.2e9 && !solRich) solRich = b.owner;
        if (lamports > 0.02e9 && !usdcRich && b.owner !== solRich) usdcRich = b.owner;
      }
    }
  }
  if (!solRich || !usdcRich) throw new Error("could not find test wallets on mainnet right now");
  return { solRich, usdcRich, wsolAccount };
}

const holders = await findHolders();
console.log("  test wallets:", holders);

async function simulate(b64: string, taker?: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  if (taker) checkSwapTx(tx, new PublicKey(taker)); // the same check the app runs before signing
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { err: sim.value.err, logs: sim.value.logs ?? [], units: sim.value.unitsConsumed, size: tx.serialize().length };
}

test("private buy: SOL -> USDC builds and simulates cleanly, no fee taken", { timeout: 120_000 }, async () => {
  const q = await swap.quote({ inputMint: WSOL, outputMint: USDC, amount: "50000000", slippageBps: 100, side: "buy" });
  assert.equal(q.feeBps, 0);
  assert.ok(BigInt(q.outAmount) > 0n);
  const b = await swap.buildSwap({ inputMint: WSOL, outputMint: USDC, amount: "50000000", slippageBps: 100, side: "buy", taker: holders.solRich });
  const r = await simulate(b.tx, holders.solRich);
  console.log(`  buy: ${r.size} bytes, ${r.units} CU, out ≈ ${Number(b.quote.outAmount) / 1e6} USDC, route ${b.quote.route.join(" + ")}`);
  assert.equal(r.err, null, r.logs.slice(-8).join("\n"));
});

test("private buy of a Token-2022 pump token (MPP32) builds, passes the app's check and simulates cleanly", { timeout: 120_000 }, async () => {
  const M32 = "6hKtz8FV7cAQMrbjcBZeTQAcrYep3WCM83164JpJpump";
  const b = await swap.buildSwap({ inputMint: WSOL, outputMint: M32, amount: "100000000", slippageBps: 100, side: "buy", taker: holders.solRich });
  const r = await simulate(b.tx, holders.solRich);
  console.log(`  buy M32: ${r.size} bytes, ${r.units} CU, out ≈ ${Number(b.quote.outAmount) / 1e6} M32, route ${b.quote.route.join(" + ")}`);
  assert.equal(r.err, null, r.logs.slice(-8).join("\n"));
});

test("private sell: USDC -> SOL takes no swap fee by default (the SOL pays the pool fee on its way back in)", { timeout: 120_000 }, async () => {
  const q = await swap.quote({ inputMint: USDC, outputMint: WSOL, amount: "2000000", slippageBps: 100, side: "sell" });
  assert.equal(q.feeBps, 0);
  const b = await swap.buildSwap({ inputMint: USDC, outputMint: WSOL, amount: "2000000", slippageBps: 100, side: "sell", taker: holders.usdcRich });
  const r = await simulate(b.tx, holders.usdcRich);
  console.log(`  sell: ${r.size} bytes, ${r.units} CU, out ≈ ${Number(b.quote.outAmount) / 1e9} SOL`);
  assert.equal(r.err, null, r.logs.slice(-8).join("\n"));
});

test("optional swap fee on sells (SELL_SWAP_FEE_BPS) lands in a wSOL account and simulates cleanly", { timeout: 120_000 }, async () => {
  if (!holders.wsolAccount) return;
  process.env.SELL_FEE_ACCOUNT = holders.wsolAccount;
  const { config } = await import("../src/config.ts");
  (config as { sellFeeAccount: string }).sellFeeAccount = holders.wsolAccount;
  (config as { sellFeeBps: number }).sellFeeBps = 80;
  const q = await swap.quote({ inputMint: USDC, outputMint: WSOL, amount: "2000000", slippageBps: 100, side: "sell" });
  assert.equal(q.feeBps, 80, "sell pays the platform fee");
  assert.ok(q.feeAmount && BigInt(q.feeAmount) > 0n);
  const b = await swap.buildSwap({ inputMint: USDC, outputMint: WSOL, amount: "2000000", slippageBps: 100, side: "sell", taker: holders.usdcRich });
  const r = await simulate(b.tx, holders.usdcRich);
  console.log(`  sell: ${r.size} bytes, ${r.units} CU, out ≈ ${Number(b.quote.outAmount) / 1e9} SOL after fee ${q.feeAmount} lamports`);
  assert.equal(r.err, null, r.logs.slice(-8).join("\n"));
});
