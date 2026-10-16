import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { MAINNET_PROGRAM_ID, MAX_RELAYER_FEE, poolProblems } from "../src/pins.ts";
import { Pool } from "../src/program.ts";

const accountsOf = (id: string) => {
  const p = new Pool(id);
  return { config: p.config.toBase58(), vault: p.vault.toBase58(), tree: p.tree.toBase58() };
};
const good = { network: "mainnet", programId: MAINNET_PROGRAM_ID, feeBps: 80, relayerFee: "1545760", selfRelayCost: "1550760", sellFeeBps: 0, accounts: accountsOf(MAINNET_PROGRAM_ID) };

test("the live pool's description checks out", () => {
  assert.deepEqual(poolProblems(good), { refuse: [], fees: [], swap: [] });
});

test("another program on mainnet, or accounts that aren't the program's, are refused", () => {
  const other = Keypair.generate().publicKey.toBase58();
  assert.ok(poolProblems({ ...good, programId: other, accounts: accountsOf(other) }).refuse.length);
  assert.ok(poolProblems({ ...good, accounts: accountsOf(other) }).refuse.length);
  assert.ok(poolProblems({ ...good, programId: "not an address" }).refuse.length);
  // a test network may run its own copy
  assert.deepEqual(poolProblems({ ...good, network: "devnet", programId: other, accounts: accountsOf(other) }).refuse, []);
});

test("a build for VisionSwap's own site takes no other program, whatever network the server names", () => {
  const other = Keypair.generate().publicKey.toBase58();
  assert.deepEqual(poolProblems(good, { official: true }), { refuse: [], fees: [], swap: [] });
  // a server claiming another network can't switch the program that way
  assert.ok(poolProblems({ ...good, network: "devnet", programId: other, accounts: accountsOf(other) }, { official: true }).refuse.length);
  assert.ok(poolProblems({ ...good, network: "localnet" }, { official: true }).refuse.length);
});

test("fees above the ceilings are flagged", () => {
  assert.ok(poolProblems({ ...good, relayerFee: (MAX_RELAYER_FEE + 1n).toString() }).fees.length);
  assert.deepEqual(poolProblems({ ...good, relayerFee: MAX_RELAYER_FEE.toString() }).fees, []);
  assert.ok(poolProblems({ ...good, relayerFee: "lots" }).fees.length);
  assert.ok(poolProblems({ ...good, selfRelayCost: "9000000" }).fees.length);
  assert.ok(poolProblems({ ...good, feeBps: 101 }).fees.length);
  // a swap fee above its ceiling stops swaps only: pool payments never pay it
  assert.ok(poolProblems({ ...good, sellFeeBps: 500 }).swap.length);
  assert.deepEqual(poolProblems({ ...good, sellFeeBps: 500 }).fees, []);
});
