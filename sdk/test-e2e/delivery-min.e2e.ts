// The smallest delivery, against a local validator (no program needed): the hop pays its own fee, and
// the network lets a fee payer keep either nothing or at least the rent minimum once that fee is taken.
// What the hop keeps then is the amount it delivers, so the amount must be at least the rent minimum.
//   1. start a validator:  wsl bash ~/vs/localnet.sh   (or solana-test-validator)
//   2. run:                node --import tsx --test sdk/test-e2e/delivery-min.e2e.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { l1Message, deliveryTransaction, signDelivery, DELIVERY_FEE } from "../src/index.ts";

const conn = new Connection(process.env.VS_RPC ?? "http://127.0.0.1:8899", "confirmed");

async function fund(who: Keypair, lamports: bigint) {
  const sig = await conn.requestAirdrop(who.publicKey, Number(lamports));
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash("confirmed")) }, "confirmed");
}

/** An L1 from a hop holding `amount` plus the delivery fee, simulated: its error, or null when it would run. */
async function l1At(amount: bigint): Promise<unknown> {
  const hop = Keypair.generate();
  await fund(hop, amount + DELIVERY_FEE);
  // the recipient already holds SOL: only the hop's own rule is under test here
  const recipient = Keypair.generate();
  await fund(recipient, 1_000_000_000n);
  const to = recipient.publicKey;
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const m = l1Message({ hop: hop.publicKey, to, lamports: amount, blockhash });
  const raw = deliveryTransaction(m, [signDelivery(m, hop)]);
  const sim = await conn.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: true });
  return sim.value.err;
}

test("an L1 whose hop would keep less than the rent minimum after its fee is refused; at the minimum it runs", async () => {
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  const below = await l1At(rent - 1n);
  assert.match(JSON.stringify(below), /InsufficientFundsForRent.*"account_index":0/, "rent minimum less one lamport: the hop itself is refused");
  assert.equal(await l1At(rent), null, "the rent minimum itself");
});
