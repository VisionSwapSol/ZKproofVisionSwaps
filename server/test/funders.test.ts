import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { Pool } from "@visionswap/sdk";
import { notFunders } from "../src/funding.ts";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const AGGREGATOR = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const EXCHANGE = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const pool = new Pool(Keypair.generate().publicKey);
const ctx = { programId: pool.programId.toBase58(), vault: pool.vault.toBase58(), own: [] as string[] };
const key = () => Keypair.generate().publicKey;

type Ins = { programId: PublicKey; accounts?: PublicKey[]; data?: string; program?: string; parsed?: unknown; stackHeight?: number };

/** A parsed transaction shaped like an RPC node's answer; only what notFunders reads. */
function tx(opts: {
  keys: { k: PublicKey; signer?: boolean }[];
  top: Ins[];
  inner?: { index: number; instructions: Ins[] }[];
  tokens?: { accountIndex: number; mint: string; owner: string }[];
}): ParsedTransactionWithMeta {
  return {
    slot: 1,
    transaction: {
      signatures: [],
      message: {
        accountKeys: opts.keys.map(({ k, signer }) => ({ pubkey: k, signer: !!signer, writable: true })),
        instructions: opts.top,
        recentBlockhash: "",
      },
    },
    meta: {
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: opts.inner ?? [],
      preTokenBalances: (opts.tokens ?? []).map((t) => ({ ...t, uiTokenAmount: { amount: "0", decimals: 9, uiAmount: 0 } })),
      postTokenBalances: [],
      err: null,
    },
  } as unknown as ParsedTransactionWithMeta;
}

const transfer = (source: PublicKey, authority: PublicKey, stackHeight?: number): Ins => ({
  programId: TOKEN,
  program: "spl-token",
  parsed: { type: "transfer", info: { source: source.toBase58(), destination: key().toBase58(), authority: authority.toBase58(), amount: "1" } },
  stackHeight,
});

test("a private withdrawal from the pool is not a funder, but a wallet paying in the same transaction is", () => {
  const me = key();
  const sender = key();
  const t = tx({
    keys: [{ k: sender, signer: true }, { k: me }, { k: pool.vault }],
    top: [{ programId: pool.programId, accounts: [], data: bs58.encode(new Uint8Array(8)) }],
  });
  const skip = notFunders(t, me.toBase58(), ctx);
  assert.ok(skip.has(pool.vault.toBase58()));
  assert.ok(!skip.has(sender.toBase58()));
});

test("a waiting-room account handing back its deposit is not a funder", () => {
  const me = key();
  const inner = 5n;
  const pending = pool.pending(inner);
  const ix = pool.refund(me, pending, me);
  const t = tx({
    keys: [{ k: me, signer: true }, { k: pending }],
    top: [{ programId: pool.programId, accounts: ix.keys.map((k) => k.pubkey), data: bs58.encode(ix.data) }],
  });
  assert.ok(notFunders(t, me.toBase58(), ctx).has(pending.toBase58()));
});

test("an exchange pool paying for a sale is not a funder; the same move by anyone else is", () => {
  const me = key();
  const vault = key();
  const poolAuthority = key();
  const sale = tx({
    keys: [{ k: me, signer: true }, { k: vault }],
    top: [{ programId: AGGREGATOR, accounts: [], data: "" }],
    inner: [{ index: 0, instructions: [{ programId: EXCHANGE, accounts: [], data: "", stackHeight: 2 }, transfer(vault, poolAuthority, 3)] }],
    tokens: [{ accountIndex: 1, mint: WSOL, owner: poolAuthority.toBase58() }],
  });
  assert.ok(notFunders(sale, me.toBase58(), ctx).has(vault.toBase58()));

  // a wallet unwrapping its own SOL straight to the address: it signed, so it is screened
  const dirty = key();
  const dirtyWsol = key();
  const direct = tx({
    keys: [{ k: dirty, signer: true }, { k: dirtyWsol }, { k: me }],
    top: [transfer(dirtyWsol, dirty)],
    tokens: [{ accountIndex: 1, mint: WSOL, owner: dirty.toBase58() }],
  });
  assert.ok(!notFunders(direct, me.toBase58(), ctx).has(dirtyWsol.toBase58()));

  // its own program moving SOL out of an account it controls, even inside an exchange call
  const custom = key();
  const held = key();
  const viaOwnProgram = tx({
    keys: [{ k: me, signer: true }, { k: held }],
    top: [{ programId: EXCHANGE, accounts: [held], data: "" }, { programId: custom, accounts: [], data: "" }],
    inner: [{ index: 1, instructions: [transfer(held, key(), 2)] }],
    tokens: [{ accountIndex: 1, mint: WSOL, owner: key().toBase58() }],
  });
  assert.ok(!notFunders(viaOwnProgram, me.toBase58(), ctx).has(held.toBase58()));

  // without call depths the caller is unknown: screened as before
  const unknownDepth = tx({
    keys: [{ k: me, signer: true }, { k: vault }],
    top: [{ programId: AGGREGATOR, accounts: [], data: "" }],
    inner: [{ index: 0, instructions: [{ programId: EXCHANGE, accounts: [], data: "" }, transfer(vault, poolAuthority)] }],
    tokens: [{ accountIndex: 1, mint: WSOL, owner: poolAuthority.toBase58() }],
  });
  assert.ok(!notFunders(unknownDepth, me.toBase58(), ctx).has(vault.toBase58()));
});

test("the address's own token accounts are not funders", () => {
  const me = key();
  const mine = key();
  const t = tx({ keys: [{ k: me, signer: true }, { k: mine }], top: [], tokens: [{ accountIndex: 1, mint: WSOL, owner: me.toBase58() }] });
  assert.ok(notFunders(t, me.toBase58(), ctx).has(mine.toBase58()));
});
