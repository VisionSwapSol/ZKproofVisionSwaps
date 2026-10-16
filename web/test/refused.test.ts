import { test } from "node:test";
import assert from "node:assert/strict";
import { refusedForSure } from "../src/lib/chainerr.ts";

test("a preflight BlockhashNotFound is not a sure refusal: the node that answered may just be behind", () => {
  assert.equal(refusedForSure(new Error("failed to send transaction: Transaction simulation failed: Blockhash not found")), false);
  assert.equal(refusedForSure({ message: "Transaction simulation failed: Blockhash not found", logs: [] }), false);
  assert.equal(refusedForSure({ message: 'failed to send transaction: {"err":"BlockhashNotFound"}' }), false);
});

test("real refusals still count as refusals", () => {
  assert.equal(refusedForSure(new Error("Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1771")), true);
  assert.equal(refusedForSure({ message: "Transaction simulation failed", logs: ["Program log: Error: insufficient funds"] }), true);
  assert.equal(refusedForSure(new Error("Attempt to debit an account but found no record of a prior credit.")), true);
  assert.equal(refusedForSure(new Error("Transaction signature verification failure")), true);
});

test("a lost reply is not a refusal", () => {
  assert.equal(refusedForSure(new Error("fetch failed")), false);
  assert.equal(refusedForSure(new Error("The operation was aborted due to timeout")), false);
});
