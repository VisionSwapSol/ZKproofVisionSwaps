import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, MessageV0, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { paysTo, readDelivery, newHopHistory, type HistoryRpc } from "../src/history.ts";

const blockhash = "11111111111111111111111111111111";
const compile = (payer: Keypair, ixs: TransactionInstruction[]) => MessageV0.compile({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs });

test("a hop's own transaction counts as paying the recipient only with a standard SOL transfer from it to that address", () => {
  const hop = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const elsewhere = Keypair.generate().publicKey;
  const delivery = compile(hop, [ComputeBudgetProgram.setComputeUnitLimit({ units: 2_500 }), SystemProgram.transfer({ fromPubkey: hop.publicKey, toPubkey: to, lamports: 100_000_000 })]);
  assert.equal(paysTo(delivery, hop.publicKey, to.toBase58()), true);
  assert.equal(paysTo(delivery, hop.publicKey, elsewhere.toBase58()), false, "a transfer to someone else is not this delivery");
  // the owner's app moving the SOL into the pool: a program call, with a sliver sent to the waiting room
  const program = Keypair.generate().publicKey;
  const deposit = compile(hop, [
    new TransactionInstruction({ programId: program, keys: [{ pubkey: hop.publicKey, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data: Buffer.alloc(12, 2) }),
    SystemProgram.transfer({ fromPubkey: hop.publicKey, toPubkey: elsewhere, lamports: 7 }),
  ]);
  assert.equal(paysTo(deposit, hop.publicKey, to.toBase58()), false, "another program's instruction naming the recipient never counts");
  // a System instruction of another kind (allocate, say) from the hop to the recipient's key
  const other = compile(hop, [SystemProgram.assign({ accountPubkey: hop.publicKey, programId: to })]);
  assert.equal(paysTo(other, hop.publicKey, to.toBase58()), false);
  // a transfer to the recipient from some other account, in a transaction the hop paid for
  const third = Keypair.generate();
  const notFromHop = compile(hop, [SystemProgram.transfer({ fromPubkey: third.publicKey, toPubkey: to, lamports: 5 })]);
  assert.equal(paysTo(notFromHop, hop.publicKey, to.toBase58()), false);
});

test("the first transaction a hop paid for itself is its delivery only when it paid the recipient; one that paid elsewhere first means none", async () => {
  const sigs = ["after", "own", "dust", "tx1"];
  const rpc = (first: (to: string) => boolean): HistoryRpc => ({
    list: async (q) => {
      const from = q.before ? sigs.indexOf(q.before) + 1 : 0;
      const end = q.until && sigs.includes(q.until) ? sigs.indexOf(q.until) : sigs.length;
      return sigs.slice(from, end).map((signature) => ({ signature, err: null }));
    },
    read: async (sig) => (sig === "own" ? { byHop: true, pays: first } : sig === "after" ? { byHop: true, pays: () => true } : { byHop: false }),
  });
  assert.equal(await readDelivery(newHopHistory(), "tx1", "R", rpc((r) => r === "R")), "own");
  const h = newHopHistory();
  assert.equal(await readDelivery(h, "tx1", "R", rpc(() => false)), null, "a later transfer to the recipient doesn't make the move a delivery");
  assert.equal(h.first?.sig, "own", "what it paid for first is kept, so the caller can tell a move from no transfer at all");
});
