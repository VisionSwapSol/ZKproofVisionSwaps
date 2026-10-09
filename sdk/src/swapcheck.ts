import { PublicKey, SystemProgram, ComputeBudgetProgram, type VersionedTransaction } from "@solana/web3.js";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

/**
 * The structural check on a swap transaction before a Vision wallet signs it: the wallet must
 * be the only signer and the fee payer, only known programs may run at the top level, plain SOL
 * transfers may only go to the wallet's own wSOL account, and the only token instructions
 * allowed at the top level are syncing wrapped SOL and closing an account back to the wallet
 * (no transfers, burns, approvals or any other token-extension instruction). It does not judge
 * amounts or where the route's output lands: the app checks those separately against the
 * trade it asked for. Throws with a plain-language reason.
 */
export function checkSwapTx(tx: VersionedTransaction, owner: PublicKey): void {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  if (!keys[0].equals(owner)) throw new Error("Unexpected fee payer in the swap.");
  if (msg.header.numRequiredSignatures !== 1) throw new Error("Unexpected signer in the swap.");
  const wsolAta = PublicKey.findProgramAddressSync(
    [owner.toBytes(), new PublicKey(TOKEN_PROGRAM).toBytes(), WSOL.toBytes()],
    new PublicKey(ATA_PROGRAM),
  )[0];
  const system = SystemProgram.programId.toBase58();
  const allowed = new Set([ComputeBudgetProgram.programId.toBase58(), system, TOKEN_PROGRAM, TOKEN_2022, ATA_PROGRAM, JUPITER_PROGRAM]);
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]?.toBase58();
    if (!prog || !allowed.has(prog)) throw new Error("The swap calls an unexpected program.");
    if (prog === system) {
      const kind = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getUint32(0, true);
      const dest = keys[ix.accountKeyIndexes[1]];
      if (kind !== 2 || !dest?.equals(wsolAta)) throw new Error("The swap moves SOL somewhere unexpected.");
    }
    if (prog === TOKEN_PROGRAM || prog === TOKEN_2022) {
      // an allow-list: SyncNative (17) and CloseAccount (9) back to the wallet; anything else
      // (transfers, burns, approvals, Token-2022 extensions like transfer-with-fee) is refused
      const kind = ix.data[0];
      if (kind !== 17 && kind !== 9) throw new Error("The swap moves tokens somewhere unexpected.");
      if (kind === 9 && !keys[ix.accountKeyIndexes[1]]?.equals(owner)) throw new Error("The swap sends SOL somewhere unexpected.");
    }
  }
}
