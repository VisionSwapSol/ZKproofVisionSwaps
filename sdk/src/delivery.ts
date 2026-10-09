import { ed25519 } from "@noble/curves/ed25519.js";
import { ComputeBudgetProgram, PublicKey, SystemProgram, SYSVAR_RECENT_BLOCKHASHES_PUBKEY, type Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { concat, toBE, toLE } from "./field.ts";
import { grossUp } from "./extdata.ts";

/**
 * Delivery: how a private payment to an outside address arrives as a standard SOL transfer.
 *
 * The pool program pays a spend's recipient by changing its balance directly, which leaves no
 * transfer instruction in the transaction, and deposit scanners that follow instructions never
 * see it. So a payment to anyone but this account's own wallets is sealed to a one-time "hop"
 * address (hopWallet) instead. The pool pays the hop (TX1), and the hop then sends the exact amount
 * on in a transaction of its own (TX2): compute budget, compute price and one System transfer,
 * signed by the hop alone and paid for by the hop, which ends at exactly zero.
 *
 * The hop signs TX2 in the owner's browser before TX1 is sent, so nobody can change where it goes.
 * TX2 comes in two shapes:
 *  - L1, on a recent blockhash: the shape every wallet and exchange withdrawal has;
 *  - N2, on a durable nonce, for payments sent while the page is closed: the relayer's nonce
 *    authority (which holds no SOL, and signs read-only) adds its signature when it sends it.
 * Both cost the hop exactly DELIVERY_FEE, so either pays the recipient the same amount.
 *
 * Messages are written byte by byte here, in a fixed order, so the browser and the relayer always
 * build the same bytes from the same fields: the relayer never signs or sends anything a visitor built.
 */

export const DELIVERY_V = 1;
/** compute units each delivery asks for (it uses well under half) */
export const DELIVERY_CU = 2_500;
/** micro-lamports per compute unit: L1 pays 7,000 in priority, N2 (one signature more) 2,000 */
export const DELIVERY_PRICE_L1 = 2_800_000;
export const DELIVERY_PRICE_N2 = 800_000;
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** what the hop pays the network for either shape (the same, so either pays the recipient the same) */
export const DELIVERY_FEE = 12_000n;
/** the oldest app that sends payments the way this server takes them */
export const DELIVERY_MIN_CLIENT = "1.6.0";
/** a durable nonce account's size */
export const NONCE_SPACE = 80;

/** The network fee of a delivery with `signatures` signatures at `price` micro-lamports per unit. */
export function deliveryFeeOf(signatures: number, price: number): bigint {
  return BigInt(signatures) * LAMPORTS_PER_SIGNATURE + (BigInt(DELIVERY_CU) * BigInt(price) + 999_999n) / 1_000_000n;
}

/** What /api/pool/info publishes about deliveries; the app refuses to send when it differs from its own. */
export type DeliveryInfo = {
  v: number;
  cu: number;
  priceL1: number;
  priceN2: number;
  fee: string;
  minClient: string;
  /** the relayer's nonce authority (null without a relayer) */
  nonceAuthority: string | null;
  /** whether payments can be delivered while the page is closed (send later, split payments) */
  nonce: boolean;
};

/** Whether the server's delivery terms are the ones this code was built with. */
export function sameDeliveryTerms(d: Pick<DeliveryInfo, "v" | "cu" | "priceL1" | "priceN2" | "fee">): boolean {
  return d.v === DELIVERY_V && d.cu === DELIVERY_CU && d.priceL1 === DELIVERY_PRICE_L1 && d.priceN2 === DELIVERY_PRICE_N2 && d.fee === DELIVERY_FEE.toString();
}

// ─── amounts ───

/** The treasury's balance and rent minimum: an emptied treasury can't take a fee below its rent, and then none is charged. */
export type TreasuryView = { lamports: bigint; rentMin: bigint };

/**
 * What the program credits a spend's recipient, exactly as it computes it (lib.rs, transact): the
 * net after the relayer fee, less the protocol fee, which is dropped when the treasury couldn't
 * stay rent-exempt with it. Without `treasury` the treasury is taken to receive.
 */
export function predictCredit(withdraw: bigint, relayerFee: bigint, feeBps: number, treasury?: TreasuryView): bigint {
  if (relayerFee > withdraw) throw new Error("relayer fee exceeds amount");
  const net = withdraw - relayerFee;
  let fee = (net * BigInt(feeBps)) / 10000n;
  if (fee > 0n && treasury && treasury.lamports + fee < treasury.rentMin) fee = 0n;
  return net - fee;
}

/**
 * The `withdraw` that makes the hop receive exactly `amount` plus the delivery fee, so the recipient
 * gets exactly `amount`. The program's credit steps by 0 or 1 as `withdraw` grows, so an exact one
 * always exists; it is checked, never assumed.
 */
export function deliveryWithdraw(amount: bigint, relayerFee: bigint, feeBps: number, treasury?: TreasuryView): bigint {
  if (amount <= 0n) throw new Error("nothing to deliver");
  const want = amount + DELIVERY_FEE;
  // no protocol fee on it (too small, or a treasury that can't take one): the plain sum
  const plain = want + relayerFee;
  if (predictCredit(plain, relayerFee, feeBps, treasury) === want) return plain;
  const w = grossUp(want, relayerFee, feeBps);
  if (predictCredit(w, relayerFee, feeBps, treasury) !== want) throw new Error("no exact amount found");
  return w;
}

// ─── messages ───

const te = new TextEncoder();
const COMPUTE_BUDGET = ComputeBudgetProgram.programId;
const SYSTEM = SystemProgram.programId;

/** Solana's compact length prefix. */
function shortVec(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (!v) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

type Ix = { program: number; accounts: number[]; data: Uint8Array };

/** A legacy message from its parts, in exactly the order given. */
function legacyMessage(header: [number, number, number], keys: PublicKey[], blockhash: string, ixs: Ix[]): Uint8Array {
  const seen = new Set(keys.map((k) => k.toBase58()));
  if (seen.size !== keys.length) throw new Error("an address appears twice in the delivery");
  const hash = bs58.decode(blockhash);
  if (hash.length !== 32) throw new Error("bad blockhash");
  return concat(
    Uint8Array.from(header),
    shortVec(keys.length),
    ...keys.map((k) => k.toBytes()),
    hash,
    shortVec(ixs.length),
    ...ixs.map((ix) => concat(Uint8Array.of(ix.program), shortVec(ix.accounts.length), Uint8Array.from(ix.accounts), shortVec(ix.data.length), ix.data)),
  );
}

const u32 = (n: number) => toLE(BigInt(n), 4);
const cuLimit = (program: number): Ix => ({ program, accounts: [], data: concat(Uint8Array.of(2), u32(DELIVERY_CU)) });
const cuPrice = (program: number, price: number): Ix => ({ program, accounts: [], data: concat(Uint8Array.of(3), toLE(BigInt(price), 8)) });
const transfer = (program: number, from: number, to: number, lamports: bigint): Ix => ({ program, accounts: [from, to], data: concat(u32(2), toLE(lamports, 8)) });

export type L1Fields = { hop: PublicKey; to: PublicKey; lamports: bigint; blockhash: string };
export type N2Fields = { hop: PublicKey; to: PublicKey; lamports: bigint; nonceAccount: PublicKey; authority: PublicKey; nonce: string };

function checkLamports(lamports: bigint) {
  if (lamports <= 0n || lamports >= 1n << 64n) throw new Error("bad delivery amount");
}

/**
 * L1: [SetComputeUnitLimit, SetComputeUnitPrice, Transfer(hop → to)] on a recent blockhash, signed
 * and paid for by the hop. Keys: hop (signer, writable), to (writable), System, ComputeBudget.
 */
export function l1Message(f: L1Fields): Uint8Array {
  checkLamports(f.lamports);
  return legacyMessage([1, 0, 2], [f.hop, f.to, SYSTEM, COMPUTE_BUDGET], f.blockhash, [
    cuLimit(3),
    cuPrice(3, DELIVERY_PRICE_L1),
    transfer(2, 0, 1, f.lamports),
  ]);
}

/**
 * N2: [AdvanceNonceAccount, SetComputeUnitLimit, SetComputeUnitPrice, Transfer(hop → to)] on a
 * durable nonce. The hop signs and pays; the nonce authority signs read-only, so its signature can
 * only ever advance that one nonce. Keys: hop (signer, writable), authority (signer, read-only),
 * nonce account (writable), to (writable), System, RecentBlockhashes, ComputeBudget.
 */
export function n2Message(f: N2Fields): Uint8Array {
  checkLamports(f.lamports);
  return legacyMessage([2, 1, 3], [f.hop, f.authority, f.nonceAccount, f.to, SYSTEM, SYSVAR_RECENT_BLOCKHASHES_PUBKEY, COMPUTE_BUDGET], f.nonce, [
    { program: 4, accounts: [2, 5, 1], data: u32(4) },
    cuLimit(6),
    cuPrice(6, DELIVERY_PRICE_N2),
    transfer(4, 0, 3, f.lamports),
  ]);
}

/** The transaction as sent: its signatures (fee payer first) and the message. */
export function deliveryTransaction(message: Uint8Array, signatures: Uint8Array[]): Uint8Array {
  if (signatures.some((s) => s.length !== 64)) throw new Error("bad signature");
  if (signatures.length !== message[0]) throw new Error("wrong number of signatures");
  return concat(shortVec(signatures.length), ...signatures, message);
}

/** A signature over a delivery message (the hop's in the browser, the nonce authority's on the server). */
export function signDelivery(message: Uint8Array, signer: Keypair): Uint8Array {
  return ed25519.sign(message, signer.secretKey.slice(0, 32));
}

/** Whether `sig` is `signer`'s signature over exactly these bytes. */
export function verifyDelivery(message: Uint8Array, sig: Uint8Array, signer: PublicKey): boolean {
  if (sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, message, signer.toBytes(), { zip215: false });
  } catch {
    return false;
  }
}

/** A durable nonce account's contents (an 80-byte System account), or null when it isn't an initialized one. */
export function readNonceAccount(data: Uint8Array): { authority: PublicKey; nonce: string } | null {
  if (data.length !== NONCE_SPACE) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // version 1 ("current"), state 1 ("initialized")
  if (dv.getUint32(0, true) !== 1 || dv.getUint32(4, true) !== 1) return null;
  return { authority: new PublicKey(data.slice(8, 40)), nonce: bs58.encode(data.slice(40, 72)) };
}

// ─── who may receive ───

/** Programs, sysvars and other addresses that can never be a payment's recipient. */
export const RESERVED_ADDRESSES: readonly string[] = [
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "Stake11111111111111111111111111111111111111",
  "StakeConfig11111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
  "ZkE1Gama1Proof11111111111111111111111111111",
  "NativeLoader1111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "SysvarEpochSchedu1e111111111111111111111111",
  "SysvarFees111111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "SysvarRecentB1ockHashes11111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarRewards111111111111111111111111111111",
  "SysvarS1otHashes111111111111111111111111111",
  "SysvarS1otHistory11111111111111111111111111",
  "SysvarStakeHistory1111111111111111111111111",
  "SysvarEpochRewards1111111111111111111111111",
  "SysvarLastRestartS1ot1111111111111111111111",
];

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** An address's account as far as the recipient check needs it (null when it doesn't exist). */
export type AccountView = { owner: PublicKey | string; executable: boolean; lamports: number | bigint; dataLength: number } | null;

/**
 * What kind of address a recipient is:
 *  - "wallet": an ordinary wallet; "new": nothing there yet (it needs at least the rent minimum)
 *  - "off-curve" / "new-off-curve": an address only a program can sign for, such as a multisig vault
 *  - "token-account", "nonce-account", "program", "program-owned", "reserved": never paid
 */
export type RecipientClass = "wallet" | "new" | "off-curve" | "new-off-curve" | "token-account" | "nonce-account" | "program" | "program-owned" | "reserved";

export function classifyRecipient(address: PublicKey, acct: AccountView, reserved: ReadonlySet<string> = new Set()): RecipientClass {
  const a = address.toBase58();
  if (reserved.has(a) || RESERVED_ADDRESSES.includes(a)) return "reserved";
  const onCurve = PublicKey.isOnCurve(address.toBytes());
  if (!acct || BigInt(acct.lamports) === 0n) return onCurve ? "new" : "new-off-curve";
  if (acct.executable) return "program";
  const owner = typeof acct.owner === "string" ? acct.owner : acct.owner.toBase58();
  if (TOKEN_PROGRAMS.has(owner)) return "token-account";
  if (owner !== SYSTEM.toBase58()) return "program-owned";
  if (acct.dataLength === NONCE_SPACE) return "nonce-account";
  if (acct.dataLength !== 0) return "program-owned";
  return onCurve ? "wallet" : "off-curve";
}

/** Whether a payment may go: at once, after the sender confirms (an address only a program signs for), or never. */
export function recipientVerdict(c: RecipientClass): "ok" | "confirm" | "blocked" {
  if (c === "wallet" || c === "new") return "ok";
  if (c === "off-curve" || c === "new-off-curve") return "confirm";
  return "blocked";
}

/**
 * A recent recipient that looks like `address` at a glance (same first and last four characters)
 * but isn't it: address-poisoning spam plants such lookalikes in a wallet's history.
 */
export function lookalike(address: string, recent: readonly string[]): string | null {
  for (const r of recent) {
    if (r !== address && r.length > 8 && r.slice(0, 4) === address.slice(0, 4) && r.slice(-4) === address.slice(-4)) return r;
  }
  return null;
}

// ─── signed requests ───

/**
 * What a payment to one of this account's own wallets carries instead of a delivery: that wallet's
 * signature over the spend's two nullifiers and its own address, so the relayer knows the recipient
 * is a wallet the sender holds the key of (an exchange address never is).
 */
export function ownMessage(nullifiers: readonly [string, string] | readonly string[], recipient: PublicKey): Uint8Array {
  if (nullifiers.length !== 2) throw new Error("two nullifiers");
  return concat(te.encode("vs:own:v1"), ...nullifiers.map((n) => toBE(BigInt("0x" + n), 32)), recipient.toBytes());
}

/** What a hop signs to look up its own delivery on the relayer (`ts` in ms, so an old one can't be replayed for long). */
export function hopLookupMessage(hop: PublicKey, ts: number): Uint8Array {
  return concat(te.encode("vs:hop-lookup:v1"), hop.toBytes(), toBE(BigInt(ts), 8));
}
