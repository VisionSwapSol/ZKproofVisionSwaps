import { test } from "node:test";
import assert from "node:assert/strict";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkSwapTx, JUPITER_PROGRAM } from "../src/swapcheck.ts";

const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const wsolOf = (o: PublicKey) => PublicKey.findProgramAddressSync([o.toBytes(), TOKEN.toBytes(), WSOL.toBytes()], ATA)[0];

const tx = (owner: PublicKey, extra: TransactionInstruction[]) =>
  new VersionedTransaction(
    new TransactionMessage({
      payerKey: owner,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
        SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolOf(owner), lamports: 1_000_000 }),
        new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: wsolOf(owner), isSigner: false, isWritable: true }], data: Buffer.from([17]) }),
        new TransactionInstruction({ programId: new PublicKey(JUPITER_PROGRAM), keys: [{ pubkey: owner, isSigner: true, isWritable: false }], data: Buffer.from([1]) }),
        ...extra,
      ],
    }).compileToV0Message(),
  );

const tokenIx = (program: PublicKey, data: number[], keys: PublicKey[], owner: PublicKey) =>
  new TransactionInstruction({
    programId: program,
    keys: [...keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })), { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.from(data),
  });

test("an ordinary wrap, swap and close back to the wallet passes", () => {
  const owner = Keypair.generate().publicKey;
  checkSwapTx(tx(owner, [tokenIx(TOKEN, [9], [wsolOf(owner), owner], owner)]), owner);
});

test("token instructions beyond syncing and closing are refused, whichever token program", () => {
  const owner = Keypair.generate().publicKey;
  const elsewhere = Keypair.generate().publicKey;
  for (const program of [TOKEN, TOKEN_2022]) {
    // transfers (3, 12), approvals (4, 13), burns (8, 15), revoke (5), set authority (6),
    // Token-2022's transfer-with-fee (26, 1) and withdraw-excess-lamports (38)
    for (const data of [[3], [12], [4], [13], [8], [15], [5], [6], [26, 1], [38]]) {
      assert.throws(() => checkSwapTx(tx(owner, [tokenIx(program, data, [wsolOf(owner), elsewhere], owner)]), owner), /tokens somewhere unexpected/, `${program.toBase58()} ${data}`);
    }
  }
  // closing an account must pay the wallet itself
  assert.throws(() => checkSwapTx(tx(owner, [tokenIx(TOKEN, [9], [wsolOf(owner), elsewhere], owner)]), owner), /SOL somewhere unexpected/);
});

test("plain SOL may only go to the wallet's own wrapped-SOL account", () => {
  const owner = Keypair.generate().publicKey;
  assert.throws(() => checkSwapTx(tx(owner, [SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 })]), owner), /SOL somewhere/);
});
