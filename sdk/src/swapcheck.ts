import { PublicKey, SystemProgram, ComputeBudgetProgram, type AddressLookupTableAccount, type VersionedTransaction } from "@solana/web3.js";

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

// ─── what the route itself says: Jupiter's swap instruction, decoded ───

/**
 * The exact-in route instructions of Jupiter's v6 program (its published IDL), by their 8-byte
 * discriminators. Exact-out routes and the token-ledger variants are never used by the app, so a
 * swap carrying one is refused.
 */
const ROUTES: Record<string, { kind: JupiterRoute["kind"]; v2: boolean; shared: boolean }> = {
  "229,23,203,151,122,227,173,42": { kind: "route", v2: false, shared: false },
  "193,32,155,51,65,214,156,129": { kind: "shared_accounts_route", v2: false, shared: true },
  "187,100,250,204,49,196,175,20": { kind: "route_v2", v2: true, shared: false },
  "209,152,83,147,124,254,216,233": { kind: "shared_accounts_route_v2", v2: true, shared: true },
};

export type JupiterRoute = {
  kind: "route" | "shared_accounts_route" | "route_v2" | "shared_accounts_route_v2";
  /** what the route takes from the wallet */
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
  /**
   * the least the route may deliver: Jupiter's program fails the swap below it (worked out rounded
   * down, so it never overstates the guarantee; Jupiter's API states it rounded up, one unit more)
   */
  minOut: bigint;
  /** who authorises the transfer out (must be the wallet) */
  authority: PublicKey;
  /** the account the input is taken from */
  source: PublicKey;
  /** every account the output may be paid into (the user's, and a separate destination when one is named) */
  destinations: PublicKey[];
  sourceMint: PublicKey | null;
  destinationMint: PublicKey;
  /** the account a platform fee is paid to, when the route names one */
  platformFeeAccount: PublicKey | null;
};

const le64 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at, true);
const le16 = (d: Uint8Array, at: number) => new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(at, true);

/**
 * Decodes the one Jupiter swap instruction in `tx` by position, with `tables` (the transaction's
 * address lookup tables) resolving its accounts. The amounts after the variable-length route plan
 * are read from the end of the data (v1 routes) or from the front (v2 routes). Throws with a
 * plain-language reason when there isn't exactly one, or it isn't an exact-in route.
 */
export function decodeJupiterRoute(tx: VersionedTransaction, tables: AddressLookupTableAccount[] = []): JupiterRoute {
  const msg = tx.message;
  const keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
  const jup = msg.compiledInstructions.filter((ix) => keys.get(ix.programIdIndex)?.toBase58() === JUPITER_PROGRAM);
  if (jup.length !== 1) throw new Error("The swap doesn't hold exactly one Jupiter route.");
  const ix = jup[0];
  const d = ix.data;
  const shape = d.length >= 8 ? ROUTES[Array.from(d.subarray(0, 8)).join(",")] : undefined;
  if (!shape) throw new Error("The swap uses a kind of Jupiter route the app doesn't make.");
  const acct = (i: number): PublicKey => {
    const at = ix.accountKeyIndexes[i];
    const k = at === undefined ? undefined : keys.get(at);
    if (!k) throw new Error("The swap's route is missing an account.");
    return k;
  };
  // Anchor's "not given" for an optional account is the program's own id in its place
  const optional = (i: number): PublicKey | null => {
    const k = acct(i);
    return k.toBase58() === JUPITER_PROGRAM ? null : k;
  };
  let inAmount: bigint;
  let quotedOutAmount: bigint;
  let slippageBps: number;
  let platformFeeBps: number;
  if (shape.v2) {
    // [disc 8][id u8, shared only] in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16, route_plan
    const at = 8 + (shape.shared ? 1 : 0);
    if (d.length < at + 22 + 4) throw new Error("The swap's route data is too short.");
    inAmount = le64(d, at);
    quotedOutAmount = le64(d, at + 8);
    slippageBps = le16(d, at + 16);
    platformFeeBps = le16(d, at + 18);
  } else {
    // [disc 8][id u8, shared only] route_plan, then in_amount u64, quoted_out_amount u64, slippage_bps u16, platform_fee_bps u8
    const at = d.length - 19;
    if (at < 8 + (shape.shared ? 1 : 0) + 4) throw new Error("The swap's route data is too short.");
    inAmount = le64(d, at);
    quotedOutAmount = le64(d, at + 8);
    slippageBps = le16(d, at + 16);
    platformFeeBps = d[at + 18];
  }
  if (slippageBps > 10_000) throw new Error("The swap's price room is out of range.");
  const minOut = (quotedOutAmount * BigInt(10_000 - slippageBps)) / 10_000n;
  const base = { kind: shape.kind, inAmount, quotedOutAmount, slippageBps, platformFeeBps, minOut };
  const keep = (xs: (PublicKey | null)[]) => xs.filter((x): x is PublicKey => !!x);
  switch (shape.kind) {
    case "route":
      // token_program, user_transfer_authority, user_source_token_account, user_destination_token_account,
      // destination_token_account?, destination_mint, platform_fee_account?, event_authority, program
      return { ...base, authority: acct(1), source: acct(2), destinations: keep([acct(3), optional(4)]), sourceMint: null, destinationMint: acct(5), platformFeeAccount: optional(6) };
    case "shared_accounts_route":
      // token_program, program_authority, user_transfer_authority, source_token_account, program_source_token_account,
      // program_destination_token_account, destination_token_account, source_mint, destination_mint, platform_fee_account?, ...
      return { ...base, authority: acct(2), source: acct(3), destinations: [acct(6)], sourceMint: acct(7), destinationMint: acct(8), platformFeeAccount: optional(9) };
    case "route_v2":
      // user_transfer_authority, user_source_token_account, user_destination_token_account, source_mint, destination_mint,
      // source_token_program, destination_token_program, destination_token_account?, event_authority, program
      return { ...base, authority: acct(0), source: acct(1), destinations: keep([acct(2), optional(7)]), sourceMint: acct(3), destinationMint: acct(4), platformFeeAccount: null };
    default:
      // program_authority, user_transfer_authority, source_token_account, program_source_token_account,
      // program_destination_token_account, destination_token_account, source_mint, destination_mint, ...
      return { ...base, authority: acct(1), source: acct(2), destinations: [acct(5)], sourceMint: acct(6), destinationMint: acct(7), platformFeeAccount: null };
  }
}

const ataOf = (owner: PublicKey, mint: PublicKey, program: string) =>
  PublicKey.findProgramAddressSync([owner.toBytes(), new PublicKey(program).toBytes(), mint.toBytes()], new PublicKey(ATA_PROGRAM))[0];
/** The wallet's own token accounts for `mint` (under either token program). */
const ownAccounts = (owner: PublicKey, mint: PublicKey) => new Set([TOKEN_PROGRAM, TOKEN_2022].map((p) => ataOf(owner, mint, p).toBase58()));

/**
 * The checks on a decoded route against the trade the app asked for, on top of checkSwapTx: the
 * wallet authorises it, it takes exactly `amount` from the wallet's own account for `inputMint`,
 * pays only into the wallet's own account for `outputMint`, charges no more than
 * `maxPlatformFeeBps`, its on-chain minimum is at least `minOut` (the least the person was shown,
 * give or take one unit of rounding), and its price room is never wider than `slippageBps`, the
 * room the person chose (a minimum beside it never stands in for that). `quotedMinOut` (the minimum
 * the build said it carries) must match the instruction too. Throws with a plain-language reason.
 */
export function checkJupiterRoute(
  r: JupiterRoute,
  o: {
    owner: PublicKey;
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    maxPlatformFeeBps: number;
    minOut?: bigint | null;
    quotedMinOut?: bigint | null;
  },
): void {
  const inMint = new PublicKey(o.inputMint);
  const outMint = new PublicKey(o.outputMint);
  if (!r.authority.equals(o.owner)) throw new Error("The swap would be authorised by someone other than this wallet.");
  if (r.inAmount !== o.amount) throw new Error("The swap would trade a different amount than you asked for.");
  if (r.sourceMint && !r.sourceMint.equals(inMint)) throw new Error("The swap would sell a different token than you asked for.");
  if (!r.destinationMint.equals(outMint)) throw new Error("The swap would buy a different token than you asked for.");
  if (!ownAccounts(o.owner, inMint).has(r.source.toBase58())) throw new Error("The swap would take funds from an account that isn't this wallet's.");
  const mine = ownAccounts(o.owner, outMint);
  if (!r.destinations.length || r.destinations.some((k) => !mine.has(k.toBase58()))) throw new Error("The swap's tokens would land somewhere other than this wallet.");
  if (r.platformFeeBps > o.maxPlatformFeeBps) throw new Error("The swap would charge a higher fee than VisionSwap does.");
  if (o.minOut != null) {
    // Jupiter's API states a route's minimum rounded up, and the one worked out here from the instruction
    // is rounded down: they differ by one unit at most, and that one unit of rounding is all that's allowed
    if (r.minOut + 1n < o.minOut) throw new Error("The swap's guaranteed minimum is lower than the one you were shown.");
  }
  // never more room than chosen, whatever minimum comes with it: the room is only ever narrowed, by the app, to keep a minimum
  if (r.slippageBps > o.slippageBps) throw new Error("The swap allows more price movement than you chose.");
  // the minimum the build reported is the one the instruction enforces (one unit of rounding either way)
  if (o.quotedMinOut != null && r.minOut + 1n < o.quotedMinOut) throw new Error("The swap's guaranteed minimum doesn't match its quote.");
}
