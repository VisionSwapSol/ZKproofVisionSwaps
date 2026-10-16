import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  ComputeBudgetProgram,
  Ed25519Program,
  type Keypair,
} from "@solana/web3.js";
import { concat, fromBE, toBE, toLE } from "./field.ts";
import { META_LEN } from "./notes.ts";
import type { SpendProof } from "./prover.ts";

export const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const ATTESTATION_TAG = new TextEncoder().encode("VSA1");
/**
 * Compute units a pool spend asks for (VS-53). Every transact on mainnet so far (254 of them, read
 * in October 2026) used at most 214,975 units in all (the proof check, two tree inserts, two
 * nullifier accounts: fixed work that depends on public data only), and the upgrade rehearsal measured
 * its transact_v2 at up to 209,993, so this leaves about 30% on top, and the largest stays under the
 * alert line. It was 450,000, more than twice the use.
 */
export const TRANSACT_CU = 280_000;
/**
 * The compute figure the relayer's published fee is worked out from: the earlier request, kept so
 * the fee doesn't move when the request got smaller (a proof carries the fee it was made with, and a
 * change would send every held proof through the fee's grace period). The relayer simply pays a
 * little less priority than the fee allows for.
 */
export const TRANSACT_FEE_CU = 450_000;
/**
 * Compute units per settle in a batch: a settle on mainnet has used at most 40,449 units in all, and
 * the upgrade rehearsal measured its settles at up to 44,483, so this leaves 30% on top of the largest
 * and keeps them all under the alert line (it was 60,000).
 */
export const SETTLE_CU = 58_000;
/** A measured spend or settle using more than this share of what it asked for is reported: the margin is getting thin. */
export const CU_ALERT_SHARE = 0.8;
/** Whether `used` compute units (from a simulation or a landed transaction) come close to the `limit` asked for. */
export function cuNearLimit(used: number | null | undefined, limit: number): boolean {
  return typeof used === "number" && Number.isFinite(used) && used > limit * CU_ALERT_SHARE;
}

const te = new TextEncoder();
const disc = (kind: string, name: string) => sha256(te.encode(`${kind}:${name}`)).slice(0, 8);
const ix = (name: string) => disc("global", name);
export const ACCOUNT_DISC = {
  Config: disc("account", "Config"),
  Tree: disc("account", "Tree"),
  Pending: disc("account", "Pending"),
  Nullifier: disc("account", "Nullifier"),
  Vault: disc("account", "Vault"),
};
export const EVENT_DISC = {
  DepositQueued: disc("event", "DepositQueued"),
  DepositSettled: disc("event", "DepositSettled"),
  DepositRefunded: disc("event", "DepositRefunded"),
  Spent: disc("event", "Spent"),
  ConfigUpdated: disc("event", "ConfigUpdated"),
};

export type ConfigParams = {
  guard: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  minDeposit: bigint;
  maxDeposit: bigint;
  tvlCap: bigint;
  depositDelay: bigint;
  requireAttestation: boolean;
  depositsPaused: boolean;
};

export type PoolConfig = ConfigParams & {
  admin: PublicKey;
  pendingAdmin: PublicKey;
  bump: number;
  vaultBump: number;
};

export type TreeState = {
  nextIndex: number;
  rootIndex: number;
  deposits: number;
  spends: number;
  pendingLamports: bigint;
  roots: bigint[];
  currentRoot: bigint;
};

export type PendingDeposit = {
  address: PublicKey;
  depositor: PublicKey;
  amount: bigint;
  inner: bigint;
  meta: Uint8Array;
  slot: bigint;
};

const u16 = (n: number) => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
};
const u64 = (n: bigint) => toLE(n, 8);
const bool = (v: boolean) => new Uint8Array([v ? 1 : 0]);

/** Everything address-shaped about one deployment of the pool. */
export class Pool {
  readonly programId: PublicKey;
  readonly config: PublicKey;
  readonly tree: PublicKey;
  readonly vault: PublicKey;

  constructor(programId: PublicKey | string) {
    this.programId = typeof programId === "string" ? new PublicKey(programId) : programId;
    this.config = this.pda([te.encode("config")]);
    this.tree = this.pda([te.encode("tree")]);
    this.vault = this.pda([te.encode("vault")]);
  }

  pda(seeds: Uint8Array[]): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, this.programId)[0];
  }

  pending(inner: bigint): PublicKey {
    return this.pda([te.encode("pending"), toBE(inner)]);
  }

  nullifier(n: bigint): PublicKey {
    return this.pda([te.encode("nf"), toBE(n)]);
  }

  programData(): PublicKey {
    return PublicKey.findProgramAddressSync([this.programId.toBytes()], BPF_UPGRADEABLE_LOADER)[0];
  }

  // ─── instructions ───

  initialize(admin: PublicKey, p: ConfigParams): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: this.config, isSigner: false, isWritable: true },
        { pubkey: this.tree, isSigner: false, isWritable: true },
        { pubkey: this.vault, isSigner: false, isWritable: true },
        { pubkey: this.programId, isSigner: false, isWritable: false },
        { pubkey: this.programData(), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concat(ix("initialize"), encodeParams(p))),
    });
  }

  updateConfig(admin: PublicKey, p: ConfigParams): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: this.config, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(concat(ix("update_config"), encodeParams(p))),
    });
  }

  transferAdmin(admin: PublicKey, next: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: admin, isSigner: true, isWritable: false },
        { pubkey: this.config, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(concat(ix("transfer_admin"), next.toBytes())),
    });
  }

  acceptAdmin(next: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: next, isSigner: true, isWritable: false },
        { pubkey: this.config, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(ix("accept_admin")),
    });
  }

  deposit(args: {
    depositor: PublicKey;
    amount: bigint;
    inner: bigint;
    meta: Uint8Array;
    attestationExpiry: bigint;
    /** the pool fee the depositor agreed to; the deposit fails if the pool's fee is higher */
    maxFeeBps: number;
  }): TransactionInstruction {
    if (args.meta.length !== META_LEN) throw new Error("bad meta");
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: args.depositor, isSigner: true, isWritable: true },
        { pubkey: this.config, isSigner: false, isWritable: false },
        { pubkey: this.tree, isSigner: false, isWritable: true },
        { pubkey: this.vault, isSigner: false, isWritable: true },
        { pubkey: this.pending(args.inner), isSigner: false, isWritable: true },
        { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concat(ix("deposit"), u64(args.amount), toBE(args.inner), args.meta, u64(args.attestationExpiry), u16(args.maxFeeBps)),
      ),
    });
  }

  /** The deposit fee goes to `treasury` (the pool's configured treasury). */
  settle(pending: PublicKey, depositor: PublicKey, treasury: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.config, isSigner: false, isWritable: false },
        { pubkey: this.tree, isSigner: false, isWritable: true },
        { pubkey: pending, isSigner: false, isWritable: true },
        { pubkey: depositor, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(ix("settle")),
    });
  }

  refund(authority: PublicKey, pending: PublicKey, depositor: PublicKey): TransactionInstruction {
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: authority, isSigner: true, isWritable: false },
        { pubkey: this.config, isSigner: false, isWritable: false },
        { pubkey: this.tree, isSigner: false, isWritable: true },
        { pubkey: this.vault, isSigner: false, isWritable: true },
        { pubkey: pending, isSigner: false, isWritable: true },
        { pubkey: depositor, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(ix("refund")),
    });
  }

  transact(sp: Pick<SpendProof, "proof" | "root" | "nullifiers" | "commitments" | "ext">, treasury: PublicKey) {
    const e = sp.ext;
    const data = concat(
      ix("transact"),
      sp.proof,
      toBE(sp.root),
      toBE(sp.nullifiers[0]),
      toBE(sp.nullifiers[1]),
      toBE(sp.commitments[0]),
      toBE(sp.commitments[1]),
      u64(e.withdraw),
      u64(e.relayerFee),
      u16(e.maxFeeBps),
      e.meta0,
      e.meta1,
    );
    return new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: e.relayer, isSigner: true, isWritable: true },
        { pubkey: e.recipient, isSigner: false, isWritable: true },
        { pubkey: this.config, isSigner: false, isWritable: false },
        { pubkey: this.tree, isSigner: false, isWritable: true },
        { pubkey: this.vault, isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: false, isWritable: true },
        { pubkey: this.nullifier(sp.nullifiers[0]), isSigner: false, isWritable: true },
        { pubkey: this.nullifier(sp.nullifiers[1]), isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    });
  }

  /** The guard's screening attestation, placed right before `deposit`. */
  attestationInstruction(guard: PublicKey, signature: Uint8Array, depositor: PublicKey, expiry: bigint) {
    return Ed25519Program.createInstructionWithPublicKey({
      publicKey: guard.toBytes(),
      message: attestationMessage(depositor, expiry),
      signature,
    });
  }

  // ─── decoding ───

  decodeConfig(data: Uint8Array): PoolConfig {
    checkDisc(data, ACCOUNT_DISC.Config, "Config");
    const r = new Reader(data, 8);
    const admin = r.pubkey();
    const pendingAdmin = r.pubkey();
    const guard = r.pubkey();
    const treasury = r.pubkey();
    return {
      admin,
      pendingAdmin,
      guard,
      treasury,
      feeBps: r.u16(),
      minDeposit: r.u64(),
      maxDeposit: r.u64(),
      tvlCap: r.u64(),
      depositDelay: r.u64(),
      requireAttestation: r.bool(),
      depositsPaused: r.bool(),
      bump: r.u8(),
      vaultBump: r.u8(),
    };
  }

  decodeTree(data: Uint8Array): TreeState {
    checkDisc(data, ACCOUNT_DISC.Tree, "Tree");
    const r = new Reader(data, 8);
    const nextIndex = Number(r.u64());
    const rootIndex = Number(r.u64());
    const deposits = Number(r.u64());
    const spends = Number(r.u64());
    const pendingLamports = r.u64();
    r.skip(24 + 26 * 32);
    const roots: bigint[] = [];
    for (let i = 0; i < 256; i++) roots.push(fromBE(r.bytes(32)));
    return { nextIndex, rootIndex, deposits, spends, pendingLamports, roots, currentRoot: roots[rootIndex] };
  }

  /** Bytes in a waiting-room account: discriminator, depositor, amount, inner, meta, slot, bump. */
  static readonly PENDING_SPACE = 8 + 32 + 8 + 32 + META_LEN + 8 + 1;

  decodePending(address: PublicKey, data: Uint8Array): PendingDeposit {
    checkDisc(data, ACCOUNT_DISC.Pending, "Pending");
    const r = new Reader(data, 8);
    return {
      address,
      depositor: r.pubkey(),
      amount: r.u64(),
      inner: fromBE(r.bytes(32)),
      meta: r.bytes(META_LEN),
      slot: r.u64(),
    };
  }
}

export function attestationMessage(depositor: PublicKey, expiry: bigint): Uint8Array {
  return concat(ATTESTATION_TAG, depositor.toBytes(), u64(expiry));
}

/**
 * What a depositor signs to ask the guard to hand a waiting deposit back (the
 * guard then pays the network fee). The program only ever refunds to the
 * depositor, so the request can't send the money anywhere else.
 */
export function refundRequestMessage(programId: PublicKey, inner: string): Uint8Array {
  return new TextEncoder().encode(`VisionSwap refund request v1\nprogram ${programId.toBase58()}\ndeposit ${inner.toLowerCase()}`);
}

/** The depositor's signature on a refund request (a Solana keypair's ed25519 key signs it). */
export function signRefundRequest(depositor: Keypair, programId: PublicKey, inner: string): Uint8Array {
  return ed25519.sign(refundRequestMessage(programId, inner), depositor.secretKey.slice(0, 32));
}

export function computeBudget(units: number, microLamports: number): TransactionInstruction[] {
  const out = [ComputeBudgetProgram.setComputeUnitLimit({ units })];
  if (microLamports > 0) out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  return out;
}

function encodeParams(p: ConfigParams): Uint8Array {
  return concat(
    p.guard.toBytes(),
    p.treasury.toBytes(),
    u16(p.feeBps),
    u64(p.minDeposit),
    u64(p.maxDeposit),
    u64(p.tvlCap),
    u64(p.depositDelay),
    bool(p.requireAttestation),
    bool(p.depositsPaused),
  );
}

function checkDisc(data: Uint8Array, d: Uint8Array, name: string) {
  for (let i = 0; i < 8; i++) if (data[i] !== d[i]) throw new Error(`not a ${name} account`);
}

export class Reader {
  constructor(
    private b: Uint8Array,
    public o = 0,
  ) {}
  bytes(n: number) {
    if (this.o + n > this.b.length) throw new Error("short read");
    const v = this.b.slice(this.o, this.o + n);
    this.o += n;
    return v;
  }
  skip(n: number) {
    this.o += n;
  }
  u8() {
    return this.bytes(1)[0];
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    const v = this.bytes(2);
    return v[0] | (v[1] << 8);
  }
  u64() {
    const v = this.bytes(8);
    let n = 0n;
    for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(v[i]);
    return n;
  }
  pubkey() {
    return new PublicKey(this.bytes(32));
  }
}
