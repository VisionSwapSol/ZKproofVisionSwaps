import { createHash } from "node:crypto";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { conn, pool } from "./chain.ts";
import { config } from "./config.ts";
import { shared } from "./flight.ts";

/** What anyone can check about the deployed program, read straight from the chain. */
export type ProgramInfo = {
  /** the account holding the program's code */
  dataAddress: string;
  /** who can upgrade it; null once it is permanent */
  upgradeAuthority: string | null;
  /** slot of the last deployment or upgrade */
  deployedSlot: number;
  /**
   * sha256 of the deployed code with trailing zero bytes trimmed, the way
   * `solana-verify get-program-hash` computes it (the code's storage can be
   * larger than the code, and the rest is zeros)
   */
  sha256: string;
  size: number;
};

let programCache: { at: number; v: ProgramInfo } | null = null;
/** while the RPC fails, the chain is asked again at most every 10 s (the last answer stands meanwhile) */
let programFailAt = 0;

export async function programInfo(): Promise<ProgramInfo | null> {
  if (programCache && Date.now() - programCache.at < 600_000) return programCache.v;
  if (Date.now() - programFailAt < 10_000) return programCache?.v ?? null;
  return readProgram();
}

/** One read at a time: the program's code is about half a megabyte. */
const readProgram = shared(async (): Promise<ProgramInfo | null> => {
  const failed = () => {
    programFailAt = Date.now();
    return programCache?.v ?? null;
  };
  try {
    const p = await conn.getAccountInfo(config.programId, "confirmed");
    if (!p?.executable || p.data.length < 36) return failed();
    const dataAddress = new PublicKey(p.data.subarray(4, 36));
    const d = await conn.getAccountInfo(dataAddress, "confirmed");
    if (!d || d.data.length < 45) return failed();
    let end = d.data.length;
    while (end > 45 && d.data[end - 1] === 0) end--;
    const code = d.data.subarray(45, end);
    const v: ProgramInfo = {
      dataAddress: dataAddress.toBase58(),
      upgradeAuthority: d.data[12] === 1 ? new PublicKey(d.data.subarray(13, 45)).toBase58() : null,
      deployedSlot: Number(d.data.readBigUInt64LE(4)),
      sha256: createHash("sha256").update(code).digest("hex"),
      size: code.length,
    };
    programCache = { at: Date.now(), v };
    return v;
  } catch {
    return failed();
  }
});

let feeProbe: { at: number; v: boolean } | null = null;
let feeFailAt = 0;

/**
 * Whether the deployed program charges the deposit fee (the October 2026
 * upgrade). That version refuses to decode a deposit written in the older
 * format, so the server asks it to, in a simulation that sends nothing. The
 * answer is refreshed every minute, so the site follows an upgrade by itself
 * whichever happens first: the program upgrade or the website update.
 * Null means "not known yet".
 */
export async function depositFeesOn(): Promise<boolean | null> {
  // once the upgrade is seen it stays; until then, look again every minute
  if (feeProbe && Date.now() - feeProbe.at < (feeProbe.v ? 3_600_000 : 60_000)) return feeProbe.v;
  if (Date.now() - feeFailAt < 10_000) return feeProbe?.v ?? null;
  return probeFees();
}

/** One probe at a time; an inconclusive one is tried again after 10 s at the soonest. */
const probeFees = shared(async (): Promise<boolean | null> => {
  const payer = config.relayer?.publicKey ?? config.guard?.publicKey;
  if (!payer) return feeProbe?.v ?? null;
  const failed = () => {
    feeFailAt = Date.now();
    return feeProbe?.v ?? null;
  };
  try {
    const ix = pool.deposit({ depositor: payer, amount: 0n, inner: 1n, meta: new Uint8Array(28), attestationExpiry: 0n, maxFeeBps: 0 });
    ix.data = ix.data.subarray(0, ix.data.length - 2); // the older format: no fee limit at the end
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToLegacyMessage());
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    const logs = (sim.value.logs ?? []).join("\n");
    // only trust the answer if the program itself ran and refused the call
    if (!/Instruction: Deposit/.test(logs)) return failed();
    const v = /InstructionDidNotDeserialize|Error Number: 102\./.test(logs);
    feeProbe = { at: Date.now(), v };
    return v;
  } catch {
    return failed();
  }
});
