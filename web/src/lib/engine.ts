import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  ComputeBudgetProgram,
  type AddressLookupTableAccount,
  type Keypair,
  type AccountInfo,
  type Connection,
  type ConfirmedSignatureInfo,
} from "@solana/web3.js";
import {
  Pool,
  SIGN_MESSAGE,
  keysFromSignature,
  keysFromMaster,
  keysFingerprint,
  visionWallet,
  depositWallet,
  randomMaster,
  encodePrivateKey,
  decodePrivateKey,
  noteInner,
  encodeMeta,
  randomNonce,
  tryOpen,
  selectInputs,
  grossUp,
  splitWithdraw,
  depositFee,
  maxDepositFor,
  depositParts,
  signRefundRequest,
  fromBE,
  hex,
  toBE,
  checkSwapTx,
  gasWallet,
  orderKey,
  computeBudget,
  TRANSACT_CU,
  eventsFromLogs,
  hopWallet,
  noteLeaf,
  ownMessage,
  signDelivery,
  sameDeliveryTerms,
  predictCredit,
  deliveryWithdraw,
  DELIVERY_FEE,
  type DeliveryInfo,
  type RecipientClass,
  type TreasuryView,
  type Keys,
  type OwnedNote,
  paysTo,
} from "@visionswap/sdk";
import bs58 from "bs58";
import { api, apiBinary, conn, formatUnits, sendAndConfirm, confirmSig, signatureOf, signatureState, setPoolProgram, ApiError, StillPending } from "./net";
import { PRICE_MOVED } from "./chainerr";
import { checkSwapSpend, lastPart, leftOver, maxWithdraw, mergePlan, roomFor, settlePayer, speedEstimate, speedOf, sweepAmount, sweepParts, MAX_MERGES, type MergePlan, type Speed } from "./trade";
import { call, zkFiles } from "./zk";
import { idbGet, idbSet, idbDel, ls } from "./idb";
import { accountTag, deviceKey, dropDeviceKey, historyKeys, holdsFunds, isSealed, sealWith, unsealWith } from "./device";
import { nextStep, payOpen, payoutFor, walletDeposit, PAY_KEEP_MS, type PayStatus, type PayStep, type PayView, type WalletPay } from "./walletpay";
import { MAX_KEYS, chunk, sleep, randInt, shuffle, range, paced, gapScan, syncDelay, Rotation, planMoves, afterMove, dueMove, leavesHold, type MovePlan } from "./poll";
import { inTime, keySlots, leftOf, mergeReply, pickKeyN, replyChanged, scaleLegs, sellClash, shrinkLegs, stepsKept, tokenDelegate, type OrderReply } from "./orders";
import { ownPaidText, walletName } from "./vwallets";
import { afterFailure, batchFinished, gapMs, nextWaiting, onLoad, resolveRunning, retryFailed, setItem, stopRest, BATCH_MAX, BATCH_MIN, BUSY_GAP, type Batch, type Facts } from "./batch";
import { isLive, isOpen, goneOut, finishDue, cancelledMeanwhile, patchJob, mergeReplies, pollGroups, needsProof, backoff, splitSummary, spentVerdict, definite, prepPlan, prepStep, prepRounds, type JobReply, type JobStatus, type PartOutcome } from "./jobs";
import {
  APP_VERSION,
  newerVersion,
  payQuote,
  finishAmount,
  finishTransaction,
  l1Sig,
  n2Sig,
  nonceOk,
  lookupBody,
  signText,
  refusalText,
  recipientProblem,
  offCurve,
  poisoned,
  OFF_CURVE_TEXT,
  readLegs,
  HELD_MARK_MS,
  hasDeliveryLine,
  fillDeliveryLine,
  keptFound,
  writeLegs,
  upsertLeg,
  patchLeg,
  recentRecipients,
  sortOpen,
  trustedRecipient,
  feeChanged,
  autoFinishable,
  finishGate,
  afterFailedFinish,
  moveOutVerdict,
  HISTORY_UNREAD,
  MOVED_ELSEWHERE,
  HISTORY_PAGE,
  HISTORY_PAGES,
  HISTORY_READS,
  MaybeSent,
  newHopHistory,
  readDelivery,
  type HistoryRpc,
  type HopHistory,
  type HopLeg,
  type HopLookup,
  type HopView,
  type NonceLease,
  lookupWait,
  worthShowing,
  notesRead,
} from "./hops";

// ─────────────────────────── types ───────────────────────────

export type PoolInfo = {
  network: "mainnet" | "devnet" | "localnet";
  programId: string;
  feeBps: number;
  minDeposit: string;
  maxDeposit: string;
  /** the most the pool may hold; "0" means no cap (older servers leave it out) */
  tvlCap?: string;
  /** how much more the pool can take right now, or null when there is no cap */
  tvlRoom?: string | null;
  depositDelaySlots: string;
  depositsPaused: boolean;
  requireAttestation: boolean;
  treasury: string;
  guard: string;
  relayer: string | null;
  relayerFee: string;
  /** what a payment's own fee payer spends (older servers leave it out) */
  selfRelayCost?: string;
  /** the "send later" windows this server offers */
  sendLater?: string[];
  /** how payments to outside addresses are delivered (see sdk/src/delivery.ts); the app sends none when it differs from its own */
  delivery?: DeliveryInfo;
  /** whether this server runs the order keeper */
  orders?: boolean;
  sellFeeBps: number;
  /** whether the on-chain program charges the deposit fee yet (null: not known) */
  depositFees: boolean | null;
  program: { dataAddress: string; upgradeAuthority: string | null; deployedSlot: number; sha256: string; size: number } | null;
  accounts: { config: string; vault: string; tree: string };
  leaves: number;
  root: string;
};

export type Waiting = {
  inner: string;
  amount: bigint;
  slot: bigint;
  readyAt: bigint | null;
  depositor: string;
  /** set when a Vision wallet made the deposit */
  vision: number | null;
  /** set when a deposit address (QR code) made the deposit */
  deposit: number | null;
  /** set when a one-time sending address of this account made it (SOL that came back to it, going into the pool) */
  hop?: boolean;
};

export type TokenHolding = {
  mint: string;
  amount: bigint;
  decimals: number;
  program: string;
  account: string;
  /** an order's key allowed to trade from this account, and for how much */
  delegate?: string | null;
  delegated?: bigint;
};
export type VisionView = { index: number; address: string; lamports: bigint; tokens: TokenHolding[] };
/**
 * Why SOL at a deposit address waits for its owner instead of moving into the pool by itself:
 * it came back from the waiting room, screening refused where it came from, or moving it failed.
 */
export type Held = "returned" | "refused" | "failed";
/**
 * A deposit address and what it holds: SOL, and any tokens sent to it by mistake (only SOL goes
 * into the pool). `wait` says why a move into the pool is paused for a little while, if it is.
 */
export type DepositView = { index: number; address: string; lamports: bigint; held: Held | null; tokens: TokenHolding[]; wait: string | null };

/** What this device last saw in a Vision wallet: its SOL, and its token accounts (so they can be re-read cheaply). */
type VisionRec = { l: string; a: { acc: string; mint: string; prog: string; dec: number }[] };
const retired = (r: VisionRec | undefined) => !!r && r.l === "0" && !r.a.length;
/** The amount held in a token account, from its raw data (the same place for both token programs). */
const tokenAmount = (d: Uint8Array): bigint => {
  let x = 0n;
  if (d.length >= 72) for (let k = 71; k >= 64; k--) x = (x << 8n) | BigInt(d[k]);
  return x;
};
/** Random gap between two deposit addresses moving into the pool by themselves: minutes, so payers of different links aren't grouped by timing. */
const MOVE_GAP: [number, number] = [60_000, 360_000];

export type Activity = {
  t: number;
  kind: "shield" | "send" | "buy" | "sell" | "refund" | "merge" | "sweep";
  text: string;
  sig?: string;
  /**
   * A payment delivered to an outside address: `sig` is then its delivery, the standard transfer the
   * recipient sees (its Transaction ID), sent from the one-time address `hop`. `onward`: SOL that came
   * back to the hop after its delivery, sent on from there (`sig` is that transfer's own).
   */
  delivery?: { hop: string; to: string; onward?: boolean };
};

/** When a private payment goes out: now, or at a random moment inside a window. */
export type When = "now" | "15m" | "1h" | "24h";
export const WHEN_LABEL: Record<When, string> = { now: "now", "15m": "15 minutes", "1h": "1 hour", "24h": "24 hours" };
/** A scheduled payment's window; "2m" spreads several payments sent "now" over two minutes. */
export type Window = Exclude<When, "now"> | "2m";
export const WINDOW_LABEL: Record<Window, string> = { "2m": "2 minutes", "15m": "15 minutes", "1h": "1 hour", "24h": "24 hours" };
const WINDOW_MS: Record<Window, number> = { "2m": 2 * 60_000, "15m": 15 * 60_000, "1h": 3_600_000, "24h": 24 * 3_600_000 };
/** One payment of a send: who gets it and what they receive. */
/**
 * One payment; `fresh` marks a new Vision wallet of the sender's, which must still be unused when it goes.
 * `offCurveOk` / `lookalikeOk`: the sender confirmed an address only a program signs for, or one that
 * looks like an earlier recipient's.
 */
export type Part = { to: string; amount: bigint; fresh?: boolean; offCurveOk?: boolean; lookalikeOk?: boolean };
/** A step the sender confirms before a payment goes (see Part). */
export type Ask = { kind: "off-curve" | "lookalike"; address: string; similar?: string; text: string };
/**
 * Where a spend's SOL goes: the one place that decides what a proof names as its recipient.
 *  - "pay": an outside address. The proof names a one-time sending address made from its change
 *    note, which passes `amount` on in a standard transfer signed here (see hops.ts).
 *  - "own": a wallet of this account's own, which signs the spend's notes to show it is.
 *  - "fee": nothing for anyone but the fee payer itself (cutting and joining notes).
 */
type Dest =
  | { kind: "pay"; to: PublicKey; amount: bigint; mode: "instant" | "scheduled" | "self"; offCurveOk?: boolean; only?: "l1" | "n2" }
  | { kind: "own"; kp: Keypair }
  | { kind: "fee" };
type PayDest = Extract<Dest, { kind: "pay" }>;
/**
 * What a payment came to: the Transaction ID the recipient sees, and the pool spend's. For an outside
 * address `sig` is its delivery's, and "" while that delivery hasn't been seen landing (never the pool
 * spend's, which isn't the transfer the recipient sees); `hop` is its sending address.
 */
type Paid = { sig: string; tx1: string; hop?: string };
/** A spend as the relayer takes it (server/src/relayer.ts, RelayRequest). */
type RelayRequestBody = {
  proof: string;
  root: string;
  nullifiers: string[];
  commitments: string[];
  recipient: string;
  withdraw: string;
  relayerFee: string;
  maxFeeBps: number;
  meta0: string;
  meta1: string;
};
/** The relayer's answer to a payment: the pool spend's signature, and for an outside address its delivery. */
type RelayAnswer = { signature: string; pending?: boolean; delivery?: { status: "delivered" | "pending" | "waiting"; signature: string | null; hop: string } };
/** What a payment to an outside address is signed on (POST /api/relay/prepare). */
type Prepared = { blockhash?: string; lastValidBlockHeight?: number; leaseId?: string; nonce?: NonceLease; delivery: DeliveryInfo };
const UPDATE_TEXT = "VisionSwap has been updated. Refresh the page to send. Nothing was spent.";
/** Asks the sender to confirm a recipient before anything is sent (shown by the form, never as an error). */
class NeedsConfirm extends Error {
  constructor(readonly ask: Ask) {
    super(ask.text);
  }
}
/** A payment handed to the relayer to send later. Kept on this device; the relayer holds only the proof. */
export type Job = {
  id: string;
  token: string;
  to: string;
  /** what the recipient receives, and what leaves the private balance */
  amount: string;
  withdraw: string;
  window: Window;
  created: number;
  latest: number;
  nullifiers: string[];
  /** the relay request (proof and sealed details), so it can be handed back if the relayer loses it */
  request?: unknown;
  /** the new notes of every proof handed over for it: any of them in the pool means it went out */
  outs?: string[];
  status: JobStatus;
  signature?: string | null;
  error?: string | null;
  /** why it is still waiting, from the relayer (being topped up, running late) */
  note?: string | null;
  /** from the relayer: it goes out within minutes / roots left before its proof would go stale */
  soon?: boolean;
  rootsLeft?: number | null;
  /** when this device last made it a fresh proof, and how a run of failed tries backs off */
  refreshed?: number;
  tries?: number;
  nextTry?: number;
  /** the pool fee went up: the recipient would get `amount` instead, once the owner says so */
  confirm?: { amount: string } | null;
  /** cancelled here, but the relayer couldn't confirm it yet (it may still have been on its way there): asked again until it does */
  cancelPending?: boolean;
  /**
   * A payment to an outside address: the proof's one-time sending address, delivered from with the
   * N2 transfer signed here; `offCurveOk` carries the sender's confirmation of a program-managed address.
   * Once the pool paid it: `tx1`, and when it was first seen delivering.
   */
  hop?: string;
  offCurveOk?: boolean;
  tx1?: string;
  delivering?: number;
  /** a payment to a wallet of this account's own: that wallet's signature over the proof's notes (see ownMessage) */
  own?: string;
};
/** A cancel the relayer couldn't confirm yet, of a payment made in the last few minutes: it may still be arriving there, so its notes stay held and the app keeps asking. */
const unconfirmedCancel = (j: Job) => !!j.cancelPending && Date.now() - j.created < 10 * 60_000;
/** This account's fee wallets as this device knows them (see gasState); `bal` is what each held when last read. */
type GasState = { next: number; used: number[]; seen?: number[]; scanned?: boolean; bal?: Record<number, { l: string; t: number }> };
/** A payment request: a link anyone can pay, landing on its own deposit address and moving into the private balance. */
export type PayRequest = {
  index: number;
  address: string;
  /** the amount asked for (lamports), or null for any amount */
  amount: string | null;
  note: string;
  created: number;
  /** what payers have sent to it so far (lamports, before the pool's fees) */
  received: string;
  /** waiting-room rent of its last move, which comes back to the address and isn't a new payment */
  rentOut?: string;
};

/**
 * A private order, kept by the order keeper: take-profit / stop-loss on a Vision wallet's tokens,
 * a limit buy, or a DCA. The Vision wallet approved the order's own key for exactly its amount;
 * cancelling revokes that on-chain.
 */
export type Order = {
  id: string;
  token: string;
  /** which account-derived key the order uses (orderKey(keys, keyN)), so it can be handed back to the keeper */
  keyN?: number;
  kind: "sell" | "buy" | "dca";
  vision: number;
  mint: string;
  symbol: string;
  decimals: number;
  program: string;
  /** raw units of the input: tokens for sells, lamports for buys */
  amount: string;
  /** the lowest take-profit step still open */
  tpUsd?: number;
  slUsd?: number;
  /** a trailing stop: sells this far (%) below the highest price since it started */
  trailPct?: number;
  /** take-profit steps, each selling part of the amount at its own price */
  legs?: { tpUsd: number | null; amount: string; filled?: boolean }[];
  buyBelowUsd?: number;
  dca?: { count: number; every: number; done: number; next: number; paused?: boolean; exact?: boolean };
  slippageBps: number;
  /** the stop-loss's own price room; unset, it follows slippageBps */
  slSlippageBps?: number;
  created: number;
  expires: number;
  status: "pending" | "active" | "filled" | "cancelled" | "expired" | "failed" | "unknown";
  fills: { t: number; sig: string; spent: string; got: string; priceUsd?: number | null; leg?: number; round?: number }[];
  lastPrice?: number | null;
  error?: string | null;
  // what the keeper last said about it
  stage?: string | null;
  /** raw input traded so far */
  spent?: string;
  priceAt?: number | null;
  noPriceSince?: number | null;
  armed?: boolean;
  peak?: number | null;
  /** the stop that applies now (the higher of the fixed and the trailing one) */
  stop?: number | null;
  /** cancelled while a trade was on its way: it may still end filled */
  settling?: boolean;
  /** a filled sell whose SOL still has to go back into the private balance */
  sweep?: boolean;
  /** ended with its permission (or a buy's SOL) still in the Vision wallet: cleaned up by itself once */
  release?: boolean;
  /** the approval's transaction (the order key's first; its later ones are trades) */
  approveSig?: string;
  /** what had traded before the keeper was handed the order again (the keeper's own counts start from zero) */
  base?: { fills: Order["fills"]; spent: string; buys: number; legs: NonNullable<Order["legs"]> };
};

/** The smallest orders the keeper takes, and its other bounds (GET /api/orders/limits). */
export type OrderLimits = {
  minSellUsd: number;
  minBuyLamports: string;
  minDcaBuyLamports: string;
  minDcaEverySec: number;
  maxDcaEverySec: number;
  dcaCount: [number, number];
  maxSlippageBps: number;
  trailPct: [number, number];
  maxLegs: number;
  maxDays: number;
};
const ORDER_LIMITS: OrderLimits = {
  minSellUsd: 2,
  minBuyLamports: "20000000",
  minDcaBuyLamports: "5000000",
  minDcaEverySec: 3600,
  maxDcaEverySec: 2_592_000,
  dcaCount: [2, 100],
  maxSlippageBps: 2500,
  trailPct: [1, 50],
  maxLegs: 4,
  maxDays: 90,
};

/** A change to a live order's terms (POST /api/orders/update): fields left out keep their value. */
export type OrderPatch = {
  amount?: bigint;
  tpUsd?: number;
  legs?: { tpUsd: number; amount: bigint }[];
  slUsd?: number | null;
  trailPct?: number | null;
  slippageBps?: number;
  slSlippageBps?: number | null;
  days?: number;
  buyBelowUsd?: number;
  paused?: boolean;
  exact?: boolean;
};

/** The guard's short-lived "this depositor passed screening" pass. */
type Attestation = { guard: string; expiry: string; signature: string };

/** Who submits a payment when the relayer can't: a Vision wallet, or one of this account's fee wallets. */
export type SelfPayer = { kind: "vision"; index: number } | { kind: "gas"; index: number };

/**
 * What is running. `bg` marks work the app started by itself (a paid link's SOL moving in, a filled
 * order's SOL coming home): it holds the same lock, so nothing interleaves with it, but the page
 * shows it as a small status line instead of covering the form.
 */
export type Busy = { kind: Activity["kind"] | "unlock" | "sync"; step: string; detail?: string; bg?: boolean; spot?: string } | null;

/** What just finished, in plain words, with the transaction to look up if wanted; `wallets` adds a way to the Wallets tab. */
export type Notice = { title: string; text: string; sig?: string; wallets?: boolean } | null;

/**
 * An action started from the Wallets tab (a row, or "+ Fund new wallets"): it runs as background work,
 * one at a time, and waits its turn while something else runs. `spot` names where it shows ("v3" is
 * Vision wallet #4's row, "fund" the fund form), which is also where its result goes (see Said).
 */
export type SpotJob = { id: number; spot: string; step: string; running: boolean };
/** How a Wallets-tab action ended, shown where it was started. */
export type Said = { ok: boolean; title: string; text: string; sig?: string; at: number };

export type State = {
  pool: PoolInfo | null;
  poolError: string | null;
  owner: string | null;
  unlocked: boolean;
  /** how the private account was opened: by a wallet's signature, or with a private key */
  account: "wallet" | "key" | null;
  /** deposit addresses that hold SOL, plus the one shown as a QR code */
  deposits: DepositView[];
  /** which deposit address the QR code shows */
  qrIndex: number;
  /** rent for a waiting-room account and for an empty wallet, read from the chain */
  rent: { pending: bigint; wallet: bigint } | null;
  fingerprint: string | null;
  syncing: boolean;
  synced: number;
  total: number;
  notes: OwnedNote[];
  balance: bigint;
  waiting: Waiting[];
  slot: number;
  publicLamports: bigint | null;
  vision: VisionView[];
  activity: Activity[];
  busy: Busy;
  error: string | null;
  notice: Notice;
  solUsd: number | null;
  /** payments scheduled to go out later */
  jobs: Job[];
  /** payment request links made on this device */
  requests: PayRequest[];
  /** private orders placed from this device */
  orders: Order[];
  /** private balance held for scheduled payments, not spendable meanwhile */
  locked: bigint;
  /** change from this device's latest spends, counted in `balance` before its notes arrive (not spendable yet) */
  arriving: bigint;
  /** the part of `locked` held by scheduled payments made on another device */
  aside: bigint;
  /** the scheduled payment getting a fresh proof in the background, if any */
  refreshingJob: string | null;
  /** scheduled payments being cancelled right now (cancelling never waits for anything else) */
  cancellingJobs: string[];
  /** the server takes payments only from a newer version of this page: sending waits for a refresh */
  update: boolean;
  /** a payment waiting for the sender to confirm its recipient */
  ask: Ask | null;
  /** this account's sending addresses holding SOL: deliveries to finish, and SOL that came back */
  hops: HopView[];
  /** payments made straight from the wallet on this device (see walletpay.ts) */
  pays: WalletPay[];
  /** Wallets-tab actions running or waiting their turn (see SpotJob) */
  spots: SpotJob[];
  /** how the latest Wallets-tab actions ended, by spot, this visit */
  said: Record<string, Said>;
  /** the spot whose result just came in: the dock repeats it for a moment */
  lastSaid: string | null;
  /** one action across several Vision wallets, one wallet at a time (see batch.ts); kept on this device */
  batch: Batch | null;
  /** that batch is running in another tab of this browser: shown here, run there */
  batchAway: boolean;
};
export type { WalletPay, Batch };

export type WalletLike = {
  publicKey: PublicKey;
  signMessage: (m: Uint8Array) => Promise<Uint8Array>;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
};

const LEAF_REC = 60;
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
/** A token this network has no account for: nothing can trade it, and a buy stops before paying anything. */
const NO_MARKET = "There's no market for this token right now. Nothing was spent.";
/** SOL a Vision wallet needs on top of the swap itself: rent for its token account and fees. */
export const VISION_RESERVE = 6_000_000n;
/**
 * Token-2022 tokens (stonk.fun launches, tokenized stocks) need bigger token accounts, and their
 * routes often pass through other Token-2022 tokens, each opening a temporary account. Their
 * Vision wallets keep a little more SOL, all of which comes back when the wallet is emptied.
 */
export const VISION_RESERVE_2022 = 10_000_000n;
export const visionReserve = (program?: string | null) => (program === TOKEN_2022_ID ? VISION_RESERVE_2022 : VISION_RESERVE);
/**
 * A modest priority fee on the app's own deposits, sweeps, clean-ups and approvals, so a busy
 * network doesn't leave them waiting. Every fee figure that depends on it counts it.
 */
const OWN_PRICE = 10_000; // micro-lamports per compute unit
const DEPOSIT_CU = 120_000;
const SWEEP_CU = 200_000;
const ownPriority = (units: number) => BigInt(Math.ceil((units * OWN_PRICE) / 1_000_000));
/** The most a fee top-up may add to a Vision wallet: fees and temporary accounts, never a trade's own SOL. */
export const TOPUP_MAX = 50_000_000n;
const TOKEN_2022_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const b64 = (u: Uint8Array) => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ─────────────────────────── engine ───────────────────────────

class Engine {
  private s: State = {
    pool: null,
    poolError: null,
    owner: null,
    unlocked: false,
    account: null,
    deposits: [],
    qrIndex: 0,
    rent: null,
    fingerprint: null,
    syncing: false,
    synced: 0,
    total: 0,
    notes: [],
    balance: 0n,
    jobs: [],
    requests: [],
    orders: [],
    locked: 0n,
    arriving: 0n,
    aside: 0n,
    refreshingJob: null,
    cancellingJobs: [],
    waiting: [],
    slot: 0,
    publicLamports: null,
    vision: [],
    activity: [],
    busy: null,
    error: null,
    notice: null,
    solUsd: null,
    update: false,
    ask: null,
    hops: [],
    pays: [],
    spots: [],
    said: {},
    lastSaid: null,
    batch: null,
    batchAway: false,
  };
  private subs = new Set<() => void>();
  private keys: Keys | null = null;
  private poolObj: Pool | null = null;
  private leafBytes: Uint8Array = new Uint8Array(0);
  private leafCount = 0;
  private nfBytes: Uint8Array = new Uint8Array(0);
  private nfCount = 0;
  private spent = new Set<bigint>();
  private workerSize = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** when the pool's settings were last read */
  private poolAt = 0;
  /** notes just spent (nullifier -> when), hidden until the pool data shows them gone */
  private pendingSpent = new Map<bigint, number>();
  /** this device's recent spends whose new notes (hex) the pool data doesn't show yet, read from leaf `from` on */
  /** recent spends of this device whose new notes the pool data doesn't show yet: their leaves, and what they hold */
  private notesDue: { outs: string[]; from: number; at: number; amount: bigint }[] = [];
  /** Notes found so far, by leaf index, and how far the leaves have been looked through, for these keys. */
  private owned = new Map<number, OwnedNote>();
  /** every leaf this account owns (any amount, spent or not), by index: each spend's change note names its sending address */
  private ownLeaves = new Map<number, bigint>();
  /** sending addresses worked out from those leaves so far (leaf → address) */
  private hopOf = new Map<bigint, string>();
  /** when deliveries on this device were last looked at, and when the relayer's list of open sending addresses was */
  private hopsAt = 0;
  private hopScanAt = 0;
  /** the treasury as last read: an emptied one takes no fee, which changes what a payment's withdrawal must be */
  private treasury: { view: TreasuryView; at: number } | null = null;
  private scannedTo = 0;
  private scannedFor: Keys | null = null;
  /** Whether this account ever held a note (if not, it can't have funded a Vision wallet). */
  private everOwned = false;
  /** The pool copy grew since it was last saved in this browser. */
  private cacheDirty = false;
  private cacheSavedAt = 0;
  /** Syncs in a row that found nothing new, and when something last changed: the sync slows down while idle. */
  private idle = 0;
  private changedAt = 0;
  private chainAt = 0;
  /** Derived keypairs of the open account, by role and index (deriving them isn't free). */
  private kps = new Map<string, Keypair>();
  private kpsFor: Keys | null = null;

  // ─── store plumbing ───
  subscribe = (f: () => void) => {
    this.subs.add(f);
    return () => this.subs.delete(f);
  };
  get = () => this.s;
  private set(p: Partial<State>) {
    this.s = { ...this.s, ...p };
    this.subs.forEach((f) => f());
    // an action just ended: a wallet change that waited for it goes ahead now
    if ("busy" in p && !p.busy && this.pendingOwner) {
      const next = this.pendingOwner;
      this.pendingOwner = null;
      queueMicrotask(() => this.setOwner(next.owner));
    }
    // and so does a lock that waited for it
    if ("busy" in p && !p.busy && this.pendingLock) {
      const l = this.pendingLock;
      this.pendingLock = null;
      queueMicrotask(() => this.closeKeyAccount(l.forget, l.clearHistory));
    }
    // and a message that waited its turn shows once nothing else is on screen
    if ("busy" in p && !p.busy && this.queued.length) queueMicrotask(() => this.nextQueued());
    // and the next Wallets-tab action in line starts (after a lock that waited, which drops the line)
    if ("busy" in p && !p.busy && this.s.spots.some((j) => !j.running)) queueMicrotask(() => this.nextSpot());
    // the "it's empty for now" hint goes by itself as soon as anything arrives (and is forgotten once replaced)
    if (this.emptyHint && (this.s.notice !== this.emptyHint || holdsFunds(this.s))) {
      const showing = this.s.notice === this.emptyHint;
      this.emptyHint = null;
      if (showing) {
        this.set({ notice: null });
        if (this.queued.length) queueMicrotask(() => this.nextQueued());
      }
    }
  }
  private pendingOwner: { owner: string | null } | null = null;
  private pendingLock: { forget: boolean; clearHistory: boolean } | null = null;
  /** The empty-account hint, while it's on screen: it never holds back other messages (see shown). */
  private emptyHint: Notice = null;

  // ─── pool ───
  async loadPool(): Promise<PoolInfo | null> {
    try {
      const pool = await api<PoolInfo>("/api/pool/info");
      this.poolObj = new Pool(pool.programId);
      setPoolProgram(pool.programId);
      this.poolAt = Date.now();
      // a server that delivers payments differently from this page (a newer release): it waits for a refresh
      const d = pool.delivery;
      const update = !!d && (newerVersion(d.minClient, APP_VERSION) || !sameDeliveryTerms(d));
      this.set({ pool, poolError: null, update: this.s.update || update });
      if (!this.s.rent) void this.loadRent();
      return pool;
    } catch (e) {
      this.set({ poolError: (e as Error).message });
      return null;
    }
  }

  /** The two rent amounts every deposit depends on, straight from the chain. */
  private async loadRent() {
    try {
      const [pending, wallet] = await Promise.all([
        conn().getMinimumBalanceForRentExemption(Pool.PENDING_SPACE),
        conn().getMinimumBalanceForRentExemption(0),
      ]);
      this.set({ rent: { pending: BigInt(pending), wallet: BigInt(wallet) } });
    } catch {
      /* asked again before any deposit */
    }
  }

  private async rentNow(): Promise<{ pending: bigint; wallet: bigint }> {
    if (!this.s.rent) await this.loadRent();
    if (!this.s.rent) throw new Error("Can't reach the network right now. Check your connection and try again.");
    return this.s.rent;
  }

  private pool(): Pool {
    if (!this.poolObj) throw new Error("Pool not loaded yet.");
    return this.poolObj;
  }

  // ─── wallet & account ───
  setOwner(owner: string | null) {
    // a wallet switching or disconnecting mid-trade doesn't pull the account out from under it: the change waits for the step to end
    if (this.s.busy && this.s.account !== "key" && owner !== this.s.owner) {
      this.pendingOwner = { owner };
      return;
    }
    this.pendingOwner = null;
    if (owner === this.s.owner) return;
    // an account opened with a private key doesn't belong to a wallet: a wallet coming or going only changes where shielding can come from
    if (this.s.account !== "key") this.lock();
    this.set({ owner, publicLamports: null, error: null });
    if (owner) void this.refreshPublic();
  }

  lock() {
    this.pendingLock = null;
    // a batch this tab was running lets go of it (another tab may then continue it)
    this.lease(false);
    this.keys = null;
    this.pendingSpent.clear();
    this.notesDue = [];
    this.owned.clear();
    this.scannedFor = null;
    this.depSeen.clear();
    this.idle = 0;
    // the derived keys go with the account
    this.kps.clear();
    this.kpsFor = null;
    this.visionDormant.clear();
    this.depDormant.clear();
    // deposit tokens and paused moves are by address number: they belong to this account
    this.depositTokens.clear();
    this.tokensAt.clear();
    this.retry.clear();
    this.rechecked.clear();
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
    this.watchQr(false);
    this.set({
      unlocked: false,
      account: null,
      fingerprint: null,
      notes: [],
      balance: 0n,
      jobs: [],
      requests: [],
      orders: [],
      locked: 0n,
      arriving: 0n,
      aside: 0n,
      refreshingJob: null,
      cancellingJobs: [],
      waiting: [],
      vision: [],
      deposits: [],
      activity: [],
      busy: null,
      notice: null,
      ask: null,
      hops: [],
      pays: [],
      spots: [],
      said: {},
      lastSaid: null,
      batch: null,
      batchAway: false,
    });
    this.bgTask = null;
    this.spot = null;
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = null;
    if (this.awayTimer) clearTimeout(this.awayTimer);
    this.awayTimer = null;
    this.goAfter = false;
    this.spotRuns.clear();
    this.landedAt.clear();
    this.queued = [];
    this.ownLeaves.clear();
    this.hopOf.clear();
    this.hopsAt = 0;
    this.hopScanAt = 0;
    this.treasury = null;
  }

  hasUnlockedBefore(owner: string): boolean {
    return !!ls.get<string | null>(`vs:fp:${owner}`, null);
  }

  /** Signs the account message (twice the first time, to be sure the wallet signs deterministically). */
  async unlock(wallet: WalletLike) {
    const owner = wallet.publicKey.toBase58();
    this.set({ busy: { kind: "unlock", step: "Waiting for your wallet to sign" }, error: null });
    try {
      if (!this.poolObj && !(await this.loadPool())) throw new Error("The pool can't be reached right now. Try again in a moment.");
      const msg = new TextEncoder().encode(SIGN_MESSAGE);
      const sig1 = await wallet.signMessage(msg);
      const keys = keysFromSignature(sig1);
      const fp = keysFingerprint(keys);
      const known = ls.get<string | null>(`vs:fp:${owner}`, null);
      if (!known) {
        this.set({ busy: { kind: "unlock", step: "One more signature to confirm it stays the same" } });
        const sig2 = await wallet.signMessage(msg);
        if (keysFingerprint(keysFromSignature(sig2)) !== fp) {
          throw new Error(
            "This wallet gives a different signature every time, so it can't hold a VisionSwap account. Try Phantom, Solflare or Backpack.",
          );
        }
        ls.set(`vs:fp:${owner}`, fp);
      } else if (known !== fp) {
        throw new Error("This signature doesn't match the account opened before with this wallet.");
      }
      await this.open(keys, "wallet");
    } catch (e) {
      const m = (e as Error).message || "Signing was cancelled.";
      this.set({ busy: null, error: walletDeclined(e) ? "Signing was cancelled." : m });
    }
  }

  private async open(keys: Keys, account: "wallet" | "key") {
    const fp = keysFingerprint(keys);
    this.keys = keys;
    this.set({
      unlocked: true,
      account,
      fingerprint: fp,
      qrIndex: ls.get<number>(`vs:dq:${fp}`, 0),
      activity: ls.get<Activity[]>(`vs:act:${fp}`, []),
      jobs: ls.get<Job[]>(`vs:jobs:${fp}`, []),
      requests: ls.get<PayRequest[]>(`vs:req:${fp}`, []),
      orders: ls.get<Order[]>(`vs:orders:${fp}`, []),
      pays: ls.get<WalletPay[]>(`vs:walletpay:${fp}`, []),
      busy: null,
    });
    // a batch left unfinished here waits for "Continue" (where its running wallet got to is looked up first)
    this.loadBatch();
    this.fullSyncOk = false;
    await this.sync(true);
    await this.verifyCache();
    this.idle = 0;
    this.scheduleSync();
    // then the chain, for this account's own addresses; a device that never looked before first finds the ones already used
    this.discover(false, true);
  }

  // ─── accounts without a wallet: the private key is the account ───
  /** A brand-new private key. Nothing is opened until the person has saved it. */
  newPrivateKey(): string {
    return encodePrivateKey(randomMaster());
  }

  /** Whether "Keep me signed in" saved a private key on this device. */
  hasSavedKey(): boolean {
    return ls.get<unknown>("vs:key", null) != null;
  }

  /** Whether a passkey has opened an account in this browser (so signing in comes first). */
  usedPasskey(): boolean {
    return !!ls.get<number>("vs:pk", 0);
  }

  /** The short tag of the account a private key opens ("7F3A"), or null when the text isn't a key. */
  tagOf(text: string): string | null {
    const r = decodePrivateKey(text);
    return "problem" in r ? null : accountTag(keysFingerprint(keysFromMaster(r.master)));
  }

  /** Opens the account whose key "Keep me signed in" saved. */
  async openSavedKey() {
    const v = ls.get<unknown>("vs:key", null);
    let text: string | null = typeof v === "string" ? v : null; // kept in plain text by an older version (protectSavedKey seals it)
    if (isSealed(v)) {
      // storage that can't be read right now (a phone tab back from the background) keeps everything for the next try
      const k = await deviceKey(false).catch(() => {
        throw new Error("Couldn't open your saved sign-in just now. Try again in a moment.");
      });
      // no sealing key, or one that doesn't open this seal: the saved sign-in is gone for good
      text = k ? await unsealWith(k, v).catch(() => null) : null;
    }
    if (!text) {
      await this.forgetSavedKey();
      throw new Error("This device can't open your saved sign-in anymore. Open your account with your passkey or private key.");
    }
    await this.openWithKey(text, true, "saved");
    if (typeof v === "string") await this.protectSavedKey();
  }

  /** Seals a key that an older version saved in plain text. Left as it is if this browser can't keep a sealing key. */
  async protectSavedKey() {
    const v = ls.get<unknown>("vs:key", null);
    if (typeof v === "string") await this.saveKey(v).catch(() => {});
  }

  private async saveKey(text: string): Promise<boolean> {
    const k = await deviceKey(true);
    if (!k) return false;
    ls.set("vs:key", await sealWith(k, text));
    return true;
  }

  private async forgetSavedKey() {
    try {
      localStorage.removeItem("vs:key");
    } catch {
      /* storage blocked */
    }
    await dropDeviceKey();
  }

  /**
   * Opens the account a private key belongs to. Throws a plain-language reason when the text isn't a key.
   * `remember` keeps the key sealed on this device ("Keep me signed in"); a passkey account keeps nothing
   * but a note that a passkey is used here, and opening the saved key ("saved") leaves storage as it is.
   */
  async openWithKey(text: string, remember: boolean, via: "key" | "passkey" | "saved" = "key") {
    const r = decodePrivateKey(text);
    if ("problem" in r) {
      throw new Error(
        r.problem === "empty"
          ? "Paste your VisionSwap private key first."
          : r.problem === "wallet-key"
            ? "That's a wallet's secret key. Never paste a wallet key into any website. A VisionSwap private key starts with vsk1."
            : r.problem === "not-ours"
              ? "That isn't a VisionSwap private key. It starts with vsk1."
              : "That key has a typo: a character is wrong, missing or extra. Copy it again from your backup.",
      );
    }
    this.set({ busy: { kind: "unlock", step: "Opening your private account" }, error: null });
    try {
      if (!this.poolObj && !(await this.loadPool())) throw new Error("The pool can't be reached right now. Try again in a moment.");
      if (this.s.unlocked) this.lock();
      if (via === "passkey") ls.set("vs:pk", 1);
      // one saved sign-in per device: opening without "Keep me signed in" (or with a passkey) forgets any earlier one
      const kept = remember && via === "key" && (await this.saveKey(encodePrivateKey(r.master)).catch(() => false));
      if (via !== "saved" && !kept) await this.forgetSavedKey();
      this.openedVia = via;
      await this.open(keysFromMaster(r.master), "key");
      if (remember && via === "key" && !kept) {
        this.set({ notice: { title: "Signed in for this visit", text: "This browser can't keep you signed in, so you'll open your account with your key next time." } });
      }
    } catch (e) {
      this.set({ busy: null, error: (e as Error).message });
      throw e;
    }
  }

  /** Whether the open account came from a passkey (it has a backup key the person may not have saved yet). */
  openedWithPasskey(): boolean {
    return this.s.account === "key" && this.openedVia === "passkey";
  }
  private openedVia: "key" | "passkey" | "saved" | null = null;

  /** Notes that the backup of a key was copied, downloaded or typed back, so it isn't asked for again here. */
  markBackedUp(text: string) {
    const r = decodePrivateKey(text);
    if (!("problem" in r)) ls.set(`vs:bk:${keysFingerprint(keysFromMaster(r.master))}`, 1);
  }

  backedUp(): boolean {
    return !!this.s.fingerprint && !!ls.get<number>(`vs:bk:${this.s.fingerprint}`, 0);
  }

  /** After a passkey sign-in: an account with nothing in it may mean another passkey was picked. */
  /** The unlock's own read of this account's addresses: whether it went through. */
  private unlockRead: Promise<boolean> | null = null;

  async noticeIfEmpty() {
    // wait for the unlock's reads of this account's addresses (and any first look for older ones)
    const read = await (this.unlockRead ?? Promise.resolve(false));
    await this.discovery;
    if (!read) return;
    const s = this.s;
    if (!s.unlocked || !s.fingerprint || s.error || s.notice) return;
    // only a complete look counts: a network blip must never make a funded account look empty
    if (!this.fullSyncOk || s.synced < s.total || !s.deposits.length) return;
    const empty =
      !s.notes.length &&
      !s.waiting.length &&
      !s.activity.length &&
      !s.vision.length &&
      !s.jobs.length &&
      !s.orders.length &&
      !s.requests.length &&
      s.deposits.every((d) => d.lamports === 0n && !d.tokens.length);
    if (empty) {
      this.emptyHint = {
        title: `Account ${accountTag(s.fingerprint)} is open`,
        text: "It's empty for now. Expecting funds here? Lock it and sign in with your other passkey or your backup key.",
      };
      this.set({ notice: this.emptyHint });
    }
  }

  /** This account's private key, for its owner to back up. Only accounts opened with a key have one to show. */
  privateKey(): string | null {
    return this.keys && this.s.account === "key" ? encodePrivateKey(this.keys.master) : null;
  }

  /** What this account still has going: scheduled payments and orders running, and buys waiting to finish. */
  unfinishedWork(): { running: number; buys: number } {
    return {
      running:
        this.s.jobs.filter((j) => j.status === "scheduled" || j.status === "sending" || j.status === "stale").length +
        this.s.orders.filter((o) => o.status === "pending" || o.status === "active").length,
      buys: this.intentIndexes().filter((i) => this.s.vision.some((v) => v.index === i && v.lamports > 0n)).length,
    };
  }

  /**
   * Closes the account on this device. `forget` (signing out) also forgets the saved sign-in and the
   * passkey note; `clearHistory` also removes this account's activity, payment links, scheduled
   * payments, orders and saved balances from this device (device.ts historyKeys).
   */
  /** Accounts whose history was cleared from this device this session. */
  private cleared = new Set<string>();
  closeKeyAccount(forget: boolean, clearHistory = false) {
    // an action the person started finishes on its own account first: the lock waits for it, as a
    // wallet change does (background work stops by itself, quietly; a Wallets-tab action was the person's)
    if (this.s.busy && (!this.s.busy.bg || this.s.busy.spot)) {
      this.pendingLock = { forget, clearHistory };
      return;
    }
    this.pendingLock = null;
    const fp = this.s.fingerprint;
    if (forget) {
      void this.forgetSavedKey();
      try {
        localStorage.removeItem("vs:pk");
      } catch {
        /* storage blocked */
      }
    }
    if (clearHistory && fp) {
      // a move still finishing in the background writes no history back for this account (see moveDeposit)
      this.cleared.add(fp);
      try {
        const all = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
        for (const k of historyKeys(fp, all)) localStorage.removeItem(k);
      } catch {
        /* storage blocked */
      }
    }
    this.lock();
  }

  /** Syncs every 9 s while something is going on, slowing to about once a minute while nothing changes. */
  private scheduleSync() {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(async () => {
      if (!this.keys) return;
      // a payment from the wallet waiting to go carries on in a hidden tab too
      if (!document.hidden || this.paysDue()) {
        // the pool's settings (fee, limits, pause) can change while the page is open
        if (Date.now() - this.poolAt > 60_000) await this.loadPool();
        await this.tick();
      }
      if (this.keys) this.scheduleSync();
    }, syncDelay(this.idle, this.lively()));
    // a hidden tab doesn't poll; coming back to it catches up straight away
    if (!this.visibilityHooked) {
      this.visibilityHooked = true;
      document.addEventListener("visibilitychange", () => {
        if (document.hidden || !this.keys) return;
        this.idle = 0;
        void this.tick(Date.now() - this.chainAt < 9000).then(() => {
          if (this.keys) this.scheduleSync();
        });
      });
    }
  }
  private visibilityHooked = false;

  /** One round: the pool data from the server, then this account's own addresses on the chain. */
  private async tick(skipChain = false) {
    const t = Date.now();
    await this.sync().catch(() => {});
    if (!skipChain) await this.pollChain(false).catch(() => {});
    this.idle = this.changedAt >= t ? 0 : this.idle + 1;
  }

  /** Something is under way that should be followed closely. */
  private lively(): boolean {
    return (
      !!this.s.busy ||
      this.moving.size > 0 ||
      this.qrTimer != null ||
      // a deposit address whose turn to move in comes up within half a minute
      Object.values(this.moveState().plan).some((t) => t - Date.now() < 30_000) ||
      // a sale's SOL whose turn to move back comes up soon (only while its wallet still has one to move)
      Object.entries(this.vmoveState().plan).some(([k, t]) => t - Date.now() < 30_000 && this.s.orders.some((o) => o.sweep && o.vision === Number(k))) ||
      this.s.jobs.some((j) => j.status === "scheduled" || j.status === "sending" || j.status === "delivering" || j.status === "waiting" || unconfirmedCancel(j)) ||
      this.paysDue()
    );
  }

  /** A payment from the wallet that this page still has to send. */
  private paysDue(): boolean {
    return this.s.pays.some((p) => p.status === "paying" || p.status === "waiting" || p.status === "sending");
  }

  /** Back to quick syncs, after the person did something. */
  private wake() {
    if (this.idle === 0 || !this.syncTimer) return;
    this.idle = 0;
    this.scheduleSync();
  }

  /**
   * Looks at this account's own addresses on the chain. Each kind (the wallet, deposit addresses,
   * Vision wallets) goes in its own requests, a random moment apart, so one person's addresses
   * don't reach the RPC provider together.
   */
  private async pollChain(full: boolean) {
    const keys = this.keys;
    if (!keys) return;
    this.chainAt = Date.now();
    const later = (lo: number, hi: number, f: () => Promise<void>) => sleep(randInt(lo, hi)).then(() => (this.keys === keys ? f() : undefined));
    await Promise.all([
      // an account opened with a private key reads the connected wallet's balance only when it's used
      this.s.account === "wallet" ? later(0, 1500, () => this.refreshPublic()) : null,
      later(200, 2500, () => this.refreshDeposits({ unlock: full })),
      later(full ? 1000 : 500, 4000, () => (full ? this.refreshVision() : this.checkDormantVision())),
      // a wallet with a buy waiting to finish is followed every round, so "Finish the buy" never shows on a stale view
      !full && this.intentIndexes().length ? later(800, 3000, () => this.refreshVision(this.intentIndexes(), false)) : null,
    ]);
  }

  /** Adds to the activity list; `fp` names another account's (on this device) for work that outlived it. */
  private log(a: Omit<Activity, "t">, fp = this.s.fingerprint) {
    if (!fp) return;
    const here = fp === this.s.fingerprint;
    const activity = [{ ...a, t: Date.now() }, ...(here ? this.s.activity : ls.get<Activity[]>(`vs:act:${fp}`, []))].slice(0, 200);
    ls.set(`vs:act:${fp}`, activity);
    if (here) this.set({ activity });
  }

  // ─── syncing the pool (everything is downloaded, nothing is asked for) ───
  private cacheKey() {
    return `pool:${this.s.pool?.network}:${this.s.pool?.programId}`;
  }

  private async loadCache() {
    if (this.leafCount) return;
    const c = await idbGet<{ leaves: Uint8Array; nfs: Uint8Array }>(this.cacheKey());
    if (c && c.leaves.length % LEAF_REC === 0 && c.nfs.length % 32 === 0) {
      this.leafBytes = c.leaves;
      this.leafCount = c.leaves.length / LEAF_REC;
      this.nfBytes = c.nfs;
      this.nfCount = c.nfs.length / 32;
      for (let i = 0; i < this.nfCount; i++) this.spent.add(fromBE(this.nfBytes.subarray(i * 32, i * 32 + 32)));
    }
  }

  private async resetCache() {
    this.leafBytes = new Uint8Array(0);
    this.leafCount = 0;
    this.nfBytes = new Uint8Array(0);
    this.nfCount = 0;
    this.spent.clear();
    this.workerSize = 0;
    // leaf indexes may differ in the new copy: look through it from the start
    this.owned.clear();
    this.ownLeaves.clear();
    this.scannedTo = 0;
    this.notesDue.forEach((d) => (d.from = 0));
    this.cacheSavedAt = 0;
    await call({ type: "reset" });
    await idbDel(this.cacheKey());
  }

  private async feedWorker() {
    if (this.workerSize > this.leafCount) {
      await call({ type: "reset" });
      this.workerSize = 0;
    }
    if (this.workerSize === this.leafCount) return;
    const out: string[] = [];
    for (let i = this.workerSize; i < this.leafCount; i++) {
      out.push(fromBE(this.leafBytes.subarray(i * LEAF_REC, i * LEAF_REC + 32)).toString());
    }
    const r = await call<{ root: string; size: number }>({ type: "append", leaves: out });
    this.workerSize = r.size;
  }

  private async workerRoot(): Promise<bigint> {
    const r = await call<{ root: string }>({ type: "append", leaves: [] });
    this.lastWorkerRoot = BigInt(r.root);
    return this.lastWorkerRoot;
  }
  private lastWorkerRoot = -1n;

  private syncRun: Promise<void> | null = null;
  /** Whether the last full sync of the open account finished without an error. */
  private fullSyncOk = false;

  /** One sync at a time. A caller that arrives mid-sync waits for it rather than skipping it. */
  sync(full = false): Promise<void> {
    this.syncRun ??= this.runSync(full).finally(() => (this.syncRun = null));
    return this.syncRun;
  }

  /** Drops the local copy of the pool and downloads it again, holding the sync slot so nothing reads the old copy meanwhile. */
  private async resync(): Promise<void> {
    while (this.syncRun) await this.syncRun;
    this.syncRun = this.resetCache()
      .then(() => this.runSync(true))
      .finally(() => (this.syncRun = null));
    return this.syncRun;
  }

  private async runSync(full: boolean): Promise<void> {
    if (!this.s.pool) await this.loadPool();
    if (!this.s.pool) return;
    this.set({ syncing: true });
    try {
      await this.loadCache();
      const had = this.leafCount + this.nfCount;
      // new leaves
      for (;;) {
        const { data, total } = await apiBinary(`/api/pool/leaves?from=${this.leafCount}&limit=20000`);
        if (data.length) {
          const merged = new Uint8Array(this.leafBytes.length + data.length);
          merged.set(this.leafBytes);
          merged.set(data, this.leafBytes.length);
          this.leafBytes = merged;
          this.leafCount += data.length / LEAF_REC;
        }
        this.set({ synced: this.leafCount, total });
        if (this.leafCount >= total || !data.length) break;
      }
      for (;;) {
        const { data, total } = await apiBinary(`/api/pool/nullifiers?from=${this.nfCount}&limit=50000`);
        if (data.length) {
          const merged = new Uint8Array(this.nfBytes.length + data.length);
          merged.set(this.nfBytes);
          merged.set(data, this.nfBytes.length);
          this.nfBytes = merged;
          for (let i = 0; i < data.length / 32; i++) this.spent.add(fromBE(data.subarray(i * 32, i * 32 + 32)));
          this.nfCount += data.length / 32;
        }
        if (this.nfCount >= total || !data.length) break;
      }
      await this.feedWorker();
      if (this.leafCount + this.nfCount !== had) {
        this.cacheDirty = true;
        this.changedAt = Date.now();
      }
      // the copy kept in this browser is written only when it grew, at most every half minute
      if (this.cacheDirty && Date.now() - this.cacheSavedAt > 30_000) {
        this.cacheDirty = false;
        this.cacheSavedAt = Date.now();
        void idbSet(this.cacheKey(), { leaves: this.leafBytes, nfs: this.nfBytes });
      }
      await this.scanNew();
      this.refilter();
      void this.pollJobs();
      void this.pollOrders();
      void this.pollHops().catch(() => {});
      // pool data from the server only; this account's addresses on the chain are pollChain's
      await Promise.all([this.refreshWaiting(), full || this.s.solUsd == null ? this.refreshPrice() : Promise.resolve()]);
      // payments from the wallet, once the waiting room is read too
      void this.runWalletPays().catch(() => {});
      if (full) this.fullSyncOk = true;
    } catch (e) {
      this.fullSyncOk = false;
      this.set({ error: e instanceof ApiError ? e.message : this.s.error });
    } finally {
      this.set({ syncing: false });
    }
  }

  /**
   * Opens only the leaves that arrived since the last look. Notes already found are kept with
   * their nullifiers, so nothing is hashed twice; a long first look pauses now and then so the
   * page stays responsive.
   */
  private async scanNew() {
    const keys = this.keys;
    if (!keys) return;
    if (this.scannedFor !== keys || this.leafCount < this.scannedTo) {
      this.owned.clear();
      this.ownLeaves.clear();
      this.scannedTo = 0;
      this.scannedFor = keys;
      this.everOwned = false;
    }
    let i = this.scannedTo;
    while (i < this.leafCount) {
      const end = Math.min(this.leafCount, i + 2000);
      for (; i < end; i++) {
        const rec = this.leafBytes.subarray(i * LEAF_REC, i * LEAF_REC + LEAF_REC);
        // cheap tag check first; only our notes reach the Poseidon check in tryOpen
        const n = tryOpen(keys, i, fromBE(rec.subarray(0, 32)), rec.subarray(32));
        if (!n) continue;
        this.everOwned = true;
        this.ownLeaves.set(i, n.leaf);
        if (n.amount > 0n && !this.spent.has(n.nullifier)) this.owned.set(i, n);
      }
      this.scannedTo = i;
      if (i < this.leafCount) {
        await sleep(0);
        if (this.scannedFor !== keys) return;
      }
    }
  }

  /** Notes, balance and held amount from the notes found so far; spent ones are dropped for good. */
  private refilter() {
    if (!this.keys) return;
    const notes: OwnedNote[] = [];
    // a spend the pool data still doesn't show after a few minutes never landed: its notes come back
    for (const [nf, t] of this.pendingSpent) if (Date.now() - t > 5 * 60_000) this.pendingSpent.delete(nf);
    for (const [i, n] of this.owned) {
      if (this.spent.has(n.nullifier)) this.owned.delete(i);
      else if (!this.pendingSpent.has(n.nullifier)) notes.push(n);
    }
    notes.sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : a.index - b.index));
    // a spend's change is shown the moment its notes are spent, not when the pool data catches up with it
    // (shown only: it can't be spent before its notes arrive)
    const coming = this.notesDue
      .filter((d) => Date.now() - d.at < 120_000 && !leavesHold(this.leafBytes, this.leafCount, LEAF_REC, d.outs, d.from))
      .reduce((s, d) => s + d.amount, 0n);
    const held = this.heldNullifiers();
    const aside = new Set(this.asideList().map((a) => a.nf));
    this.set({
      notes,
      balance: notes.reduce((s, n) => s + n.amount, 0n) + coming,
      arriving: coming,
      locked: notes.filter((n) => held.has(nfHex(n.nullifier))).reduce((s, n) => s + n.amount, 0n),
      aside: notes.filter((n) => aside.has(nfHex(n.nullifier))).reduce((s, n) => s + n.amount, 0n),
    });
  }

  /** Nullifiers of the notes that scheduled payments will spend (this device's, and those another device's hold). */
  private heldNullifiers(): Set<string> {
    return new Set([...this.s.jobs.filter((j) => isLive(j.status) || unconfirmedCancel(j)).flatMap((j) => j.nullifiers), ...this.asideList().map((a) => a.nf)]);
  }

  // notes the relayer said a scheduled payment holds, made on another device of this account
  private asideKey() {
    return `vs:aside:${this.s.fingerprint}`;
  }
  private asideList(): { nf: string; jobs: string[]; at: number }[] {
    if (!this.s.fingerprint) return [];
    // a scheduled payment has gone (or can be made again) within a day
    return ls.get<{ nf: string; jobs: string[]; at: number }[]>(this.asideKey(), []).filter((a) => Date.now() - a.at < 26 * 3_600_000);
  }
  private setAside(data: Record<string, unknown>) {
    const held = Array.isArray(data.held) ? data.held.map(String) : [];
    const jobs = Array.isArray(data.jobs) ? data.jobs.map(String).filter((x) => /^[0-9a-f]{24}$/.test(x)) : [];
    const list = this.asideList().filter((a) => !held.includes(a.nf));
    for (const nf of held) list.push({ nf, jobs, at: Date.now() });
    ls.set(this.asideKey(), list);
    this.refilter();
    // held by one of this device's own payments that already ended here (given up on while the
    // relayer still kept it): it is called off there, and its notes are free again
    const fp = this.s.fingerprint;
    for (const id of jobs) {
      const j = this.s.jobs.find((x) => x.id === id);
      if (!j || isLive(j.status)) continue;
      void this.callOff(j.id, j.token).then((r) => {
        if (r !== "ended" || this.s.fingerprint !== fp) return;
        ls.set(
          this.asideKey(),
          this.asideList().filter((a) => !a.jobs.includes(id)),
        );
        this.refilter();
      });
    }
  }

  /** Notes free to spend now (not held by a scheduled payment). */
  private freeNotes(): OwnedNote[] {
    const held = this.heldNullifiers();
    return this.s.notes.filter((n) => !held.has(nfHex(n.nullifier)));
  }

  /** The private balance that can be spent right now. */
  spendable(): bigint {
    return this.s.balance - this.s.arriving - this.s.locked;
  }

  /**
   * The copy of the pool saved in this browser must still match the chain, or
   * the balance shown would be wrong. A spend checks this anyway; doing it on
   * unlock keeps the balance right from the start.
   */
  private async verifyCache() {
    try {
      const a = await conn().getAccountInfo(this.pool().tree, "confirmed");
      if (!a) return;
      const t = this.pool().decodeTree(a.data);
      if (this.leafCount > t.nextIndex || !t.roots.includes(await this.workerRoot())) await this.resync();
    } catch {
      /* checked again before any spend */
    }
  }

  /** The tree root the proof will use must be one the program knows. Returns the pool's root list as read. */
  private async checkRoot() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const a = await conn().getAccountInfo(this.pool().tree, "confirmed");
      if (!a) throw new Error("The pool account could not be read.");
      const t = this.pool().decodeTree(a.data);
      if (t.roots.includes(await this.workerRoot())) return t;
      if (attempt === 0) {
        // most likely we are a few leaves behind
        await this.sync();
      } else if (attempt === 1) {
        // otherwise start over from scratch
        await this.resync();
      }
    }
    throw new Error("The pool data didn't check out against the chain. Please try again shortly.");
  }

  async refreshPrice() {
    try {
      const r = await api<Record<string, number | null>>(`/api/price?ids=${WSOL}`);
      this.set({ solUsd: r[WSOL] ?? null });
    } catch {
      /* keep the old price */
    }
  }

  async refreshPublic() {
    if (!this.s.owner) return;
    try {
      const l = await conn().getBalance(new PublicKey(this.s.owner), "confirmed");
      this.set({ publicLamports: BigInt(l) });
    } catch {
      /* keep old value */
    }
  }

  private visionIndexKey() {
    return `vs:vw:${this.s.fingerprint}`;
  }

  private knownVision(): number {
    return ls.get<number>(this.visionIndexKey(), 0);
  }

  private markVision(i: number) {
    if (i + 1 > this.knownVision()) ls.set(this.visionIndexKey(), i + 1);
  }

  /** The address of Vision wallet #i (it's used once something is sent to it). */
  visionAddress(i: number): string {
    return this.visionKeypair(i).publicKey.toBase58();
  }

  /** Vision wallets used before and emptied since (zero SOL, no token accounts at their last look), not listed with the rest. */
  emptiedVision(): number[] {
    if (!this.keys) return [];
    const recs = ls.get<Record<number, VisionRec>>(this.visionRecsKey(), {});
    return range(this.knownVision()).filter((i) => retired(recs[i]) && !this.s.vision.some((v) => v.index === i));
  }

  private namesKey() {
    return `vs:vname:${this.s.fingerprint}`;
  }

  /** The names given to Vision wallets on this device (by index); kept here only, never sent anywhere. */
  visionNames(): Record<number, string> {
    return this.s.fingerprint ? ls.get<Record<number, string>>(this.namesKey(), {}) : {};
  }

  /** Names Vision wallet #i on this device; an empty name takes it away. */
  nameVision(i: number, name: string) {
    if (!this.s.fingerprint) return;
    const all = { ...this.visionNames() };
    const n = name.trim().slice(0, 32);
    if (n) all[i] = n;
    else delete all[i];
    ls.set(this.namesKey(), all);
  }

  /** Marks Vision wallet #i as used, so it's listed and never handed out again. */
  claimVision(i: number) {
    this.markVision(i);
  }

  /** Whether Vision wallet #i is still unused here (a buy, say, may have taken it since it was picked). */
  visionFree(i: number): boolean {
    return i >= this.knownVision() && !this.s.vision.some((v) => v.index === i);
  }

  /** Vision wallet ("v") or deposit address ("d") #i of the open account, derived once. */
  private kp(role: "v" | "d", i: number): Keypair {
    const keys = this.need().keys;
    if (this.kpsFor !== keys) {
      this.kps.clear();
      this.kpsFor = keys;
    }
    let k = this.kps.get(role + i);
    if (!k) {
      k = role === "v" ? visionWallet(keys, i) : depositWallet(keys, i);
      this.kps.set(role + i, k);
    }
    return k;
  }

  /** The server's copy of the waiting room trails the chain by a moment: wait until a new deposit shows, so it never seems to vanish. */
  private async awaitWaiting(depositor: string, before: number, added = 1) {
    for (let i = 0; i < 16; i++) {
      await this.refreshWaiting();
      if (this.s.waiting.filter((w) => w.depositor === depositor).length >= before + added) return;
      await new Promise((r) => setTimeout(r, 750));
    }
  }

  private waitingFrom(depositor: string): number {
    return this.s.waiting.filter((w) => w.depositor === depositor).length;
  }

  /**
   * The waiting room is public, so the app downloads all of it and picks out
   * this account's deposits locally. Asking the server about each wallet would
   * tell it which Vision wallets belong to the same person.
   */
  async refreshWaiting() {
    if (!this.keys) return;
    // who made the deposit: this wallet, a Vision wallet, or a deposit address
    const mine = new Map<string, { vision: number | null; deposit: number | null }>();
    if (this.s.owner) mine.set(this.s.owner, { vision: null, deposit: null });
    for (let i = 0; i < this.knownVision() + 2; i++) mine.set(this.kp("v", i).publicKey.toBase58(), { vision: i, deposit: null });
    for (let i = 0; i < this.depositRange(); i++) mine.set(this.kp("d", i).publicKey.toBase58(), { vision: null, deposit: i });
    // SOL that came back to a sending address and is going into the pool from it
    const back = new Set(this.legs().filter((l) => l.status === "returned" && Date.now() - (l.done ?? l.at) < 2 * 86_400_000).map((l) => l.hop));
    for (const h of back) mine.set(h, { vision: null, deposit: null });
    try {
      const r = await api<{
        slot: number;
        deposits: { inner: string; depositor: string; amount: string; slot: string; readyAt: string | null }[];
      }>("/api/pool/waiting");
      const out: Waiting[] = r.deposits
        .filter((x) => mine.has(x.depositor))
        .map((x) => ({
          inner: x.inner,
          amount: BigInt(x.amount),
          slot: BigInt(x.slot),
          readyAt: x.readyAt ? BigInt(x.readyAt) : null,
          depositor: x.depositor,
          ...mine.get(x.depositor)!,
          ...(back.has(x.depositor) ? { hop: true } : {}),
        }));
      if (out.map((w) => w.inner).join() !== this.s.waiting.map((w) => w.inner).join()) this.changedAt = Date.now();
      this.set({ waiting: out, slot: r.slot || this.s.slot });
    } catch {
      /* keep what we had */
    }
  }

  /** Several accounts in one go, in groups the RPC accepts (at most 100 addresses each). */
  private async accounts(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> {
    const out: (AccountInfo<Buffer> | null)[] = [];
    for (const part of chunk(keys, MAX_KEYS)) out.push(...(await conn().getMultipleAccountsInfo(part, "confirmed")));
    return out;
  }

  private visionRecsKey() {
    return `vs:vst:${this.s.fingerprint}`;
  }

  /**
   * The Vision wallets list. On unlock it reads each wallet that isn't retired (emptied, with no
   * token accounts, at its last look); after a trade only the wallets in `only`, looked over in
   * full. Every wallet is its own request, in random order, a moment apart, and one that can't be
   * read right now keeps what was shown before.
   */
  async refreshVision(only?: number[], full = !!only) {
    const keys = this.keys;
    if (!keys) return;
    const recs = ls.get<Record<number, VisionRec>>(this.visionRecsKey(), {});
    const list = only ?? range(this.knownVision()).filter((i) => !retired(recs[i]));
    const got = new Map<number, { view: VisionView | null; rec: VisionRec }>();
    await paced(
      shuffle(list),
      2,
      (i) =>
        this.readVision(i, recs[i], full).then(
          (r) => void got.set(i, r),
          () => {},
        ),
      list.length > 1 ? [100, 700] : [0, 0],
    );
    if (this.keys !== keys || !got.size) return;
    // merged into what is there now: another refresh may have finished meanwhile
    const now = ls.get<Record<number, VisionRec>>(this.visionRecsKey(), {});
    const views = new Map(this.s.vision.map((v) => [v.index, v]));
    for (const [i, r] of got) {
      now[i] = r.rec;
      this.landedAt.delete(i);
      if (r.view) {
        views.set(i, r.view);
        this.markVision(i);
      } else views.delete(i);
    }
    ls.set(this.visionRecsKey(), now);
    this.set({ vision: [...views.values()].sort((a, b) => a.index - b.index) });
    for (const [i, r] of got) {
      const it = this.buyIntent(i);
      if (!it) continue;
      // the token arrived: the buy is done
      if (r.view?.tokens.some((t) => t.mint === it.mint)) this.clearIntent(i);
      // a buy whose wallet never got its SOL (the relay didn't go through) has nothing to finish
      else if (!r.view && !it.sig && Date.now() - (it.at ?? 0) > 30 * 60_000) this.clearIntent(i);
    }
  }

  /**
   * One Vision wallet. With a record from last time, one request re-reads its SOL and its known
   * token accounts; it's looked over in full (its token accounts listed) only when that changed,
   * when `full` is asked, or when it holds SOL and was never looked at.
   */
  private async readVision(i: number, rec: VisionRec | undefined, full: boolean): Promise<{ view: VisionView | null; rec: VisionRec }> {
    const owner = this.kp("v", i).publicKey;
    const address = owner.toBase58();
    const view = (lamports: bigint, tokens: TokenHolding[]) => (lamports > 0n || tokens.length ? { index: i, address, lamports, tokens } : null);
    // no record yet (history cleared, or saved by an older version): one full look, so tokens held with no SOL still show
    // (a balance can't stand in for it: a wallet at zero SOL can still own token accounts). That costs 3 requests per
    // wallet once, paced like every refresh; the record written then brings it back to one request from the next unlock
    if (!full && rec) {
      if (retired(rec)) {
        // an emptied wallet ends at exactly zero, with no token accounts: its SOL says whether anything arrived since
        const lamports = BigInt(await conn().getBalance(owner, "confirmed"));
        if (lamports === 0n) return { view: null, rec: { l: "0", a: [] } };
      } else {
        const infos = await this.accounts([owner, ...rec.a.map((a) => new PublicKey(a.acc))]);
        const lamports = BigInt(infos[0]?.lamports ?? 0);
        // the same SOL and the same token accounts: only token amounts can have moved
        if (lamports.toString() === rec.l && infos.slice(1).every(Boolean)) {
          const tokens = rec.a
            .map((a, k) => ({ mint: a.mint, amount: tokenAmount(infos[k + 1]!.data), decimals: a.dec, program: a.prog, account: a.acc, ...tokenDelegate(infos[k + 1]!.data) }))
            .filter((t) => t.amount > 0n);
          return { view: view(lamports, tokens), rec };
        }
      }
    }
    const [l, std, t22] = await Promise.all([
      conn().getBalance(owner, "confirmed"),
      conn().getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(TOKEN_PROGRAM) }, "confirmed"),
      conn().getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(TOKEN_2022) }, "confirmed"),
    ]);
    const a: VisionRec["a"] = [];
    const tokens: TokenHolding[] = [];
    for (const [prog, r] of [
      [TOKEN_PROGRAM, std],
      [TOKEN_2022, t22],
    ] as const) {
      for (const x of r.value) {
        const info = (x.account.data as { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number }; delegate?: string; delegatedAmount?: { amount: string } } } }).parsed
          .info;
        const acc = x.pubkey.toBase58();
        a.push({ acc, mint: info.mint, prog, dec: info.tokenAmount.decimals });
        if (BigInt(info.tokenAmount.amount) > 0n)
          tokens.push({
            mint: info.mint,
            amount: BigInt(info.tokenAmount.amount),
            decimals: info.tokenAmount.decimals,
            program: prog,
            account: acc,
            delegate: info.delegate ?? null,
            delegated: BigInt(info.delegatedAmount?.amount ?? "0"),
          });
      }
    }
    return { view: view(BigInt(l), tokens), rec: { l: BigInt(l).toString(), a } };
  }

  private visionDormant = new Rotation([30_000, 75_000]);

  /**
   * Now and then one retired Vision wallet, on its own: SOL sent to one later still shows up. Wallets
   * taken but never read yet (a payment to a fresh wallet of this account's, say) take their turn too.
   */
  private async checkDormantVision() {
    const keys = this.keys;
    if (!keys) return;
    const recs = ls.get<Record<number, VisionRec>>(this.visionRecsKey(), {});
    const i = this.visionDormant.take(
      Date.now(),
      range(this.knownVision()).filter((i) => retired(recs[i]) || (!recs[i] && !this.s.vision.some((v) => v.index === i))),
    );
    if (i == null) return;
    try {
      const lamports = await conn().getBalance(this.kp("v", i).publicKey, "confirmed");
      if (lamports > 0 && this.keys === keys) {
        this.changedAt = Date.now();
        await this.refreshVision([i]);
      }
    } catch {
      /* next turn */
    }
  }

  // ─── finding addresses this account already used ───
  private discovery: Promise<void> | null = null;

  private foundKey() {
    return `vs:found:${this.s.fingerprint}`;
  }

  /**
   * On unlock, reads this account's addresses; then, once per device (again with `again`), looks
   * for addresses used before. Handing out a new address waits only for that look, never for the reads.
   */
  private discover(again: boolean, unlocking = false): Promise<void> {
    if (unlocking) this.unlockRead = this.pollChain(true).then(
      () => true,
      () => false,
    );
    const done = ls.get<{ vision?: number; deposit?: number }>(this.foundKey(), {});
    if (!again && done.deposit && done.vision) return this.discovery ?? Promise.resolve();
    const prev = this.discovery;
    const d: Promise<void> = (async () => {
      await prev;
      // a moment after the unlock's reads, so the two don't leave together
      if (unlocking) await sleep(randInt(1500, 4000));
      await this.runDiscover(again);
    })()
      .catch(() => {})
      .finally(() => {
        if (this.discovery === d) this.discovery = null;
      });
    this.discovery = d;
    return d;
  }

  /** Whether an address was ever used on-chain (any transaction at all, even if it's empty now). */
  private async hasHistory(who: PublicKey): Promise<boolean> {
    try {
      return (await conn().getSignaturesForAddress(who, { limit: 1 }, "confirmed")).length > 0;
    } catch {
      throw new Error("Can't reach the network right now. Check your connection and try again.");
    }
  }

  /**
   * Finds the Vision wallets and deposit addresses this account used, from their history on-chain
   * rather than this device's memory, the way wallets do: look past the last one known, a few at
   * a time, until ten in a row were never used. A new device, or one whose storage was cleared,
   * then shows them all and never hands one out again. Done once per device (the counters it
   * raises are kept), or again when asked.
   */
  private async runDiscover(again: boolean) {
    const keys = this.keys;
    if (!keys) return;
    const done = ls.get<{ vision?: number; deposit?: number }>(this.foundKey(), {});
    const used = async (role: "v" | "d", i: number) => {
      await sleep(randInt(100, 700));
      return this.hasHistory(this.kp(role, i).publicKey);
    };
    if (again || !done.deposit) {
      const r = await gapScan(this.knownDeposit(), (i) => used("d", i), 10, 2);
      if (this.keys !== keys) return;
      if (r.next > 0) this.markDeposit(r.next - 1);
      done.deposit = Date.now();
      ls.set(this.foundKey(), done);
      // whatever they hold now shows under Deposit addresses, and moves in by itself
      if (r.found.length) await this.refreshDeposits({ only: r.found, tokens: true });
    }
    if (again || !done.vision) {
      // an account that never held a note can't have funded a Vision wallet (all leaves were looked through)
      const never = !this.everOwned && this.scannedFor === keys && this.s.total > 0 && this.scannedTo >= this.s.total;
      if (again || !never) {
        await sleep(randInt(500, 3000));
        const r = await gapScan(this.knownVision(), (i) => used("v", i), 10, 2);
        if (this.keys !== keys) return;
        if (r.next > 0) this.markVision(r.next - 1);
        // looked over in full: an emptied wallet can still hold tokens someone sent it
        if (r.found.length) await this.refreshVision(r.found, true);
      }
      done.vision = Date.now();
      ls.set(this.foundKey(), done);
    }
  }

  /**
   * For "Check for more": looks for addresses used on another device, then reads every Vision
   * wallet and deposit address once (tokens included), emptied ones too.
   */
  async findMore() {
    this.need();
    await this.discovery;
    await this.runDiscover(true);
    await this.refreshVision(range(this.knownVision()), true);
    await sleep(randInt(500, 2500));
    await this.refreshDeposits({ only: range(Math.max(this.knownDeposit(), this.s.qrIndex + 1)), tokens: true });
  }

  /**
   * The next Vision wallet to fund, checked on-chain to have no history (another device may have
   * used it). Each is taken before the check, so two buys started together never get the same one.
   */
  private async freshVisionIndex(): Promise<number> {
    await this.discovery;
    for (let tries = 0; tries < 25; tries++) {
      const i = this.nextVisionIndex();
      this.markVision(i);
      if (!(await this.hasHistory(this.kp("v", i).publicKey))) return i;
    }
    throw new Error("Couldn't find an unused Vision wallet just now. Please try again in a moment.");
  }

  /**
   * Vision wallet #i again for a new buy, when nothing was ever paid into it (a batch's earlier try
   * that stopped before paying): no buy waiting, nothing held, no history on-chain. Else null.
   */
  private async unusedVision(i: number | undefined): Promise<number | null> {
    if (i == null || this.buyIntent(i) || this.s.vision.some((v) => v.index === i && (v.lamports > 0n || v.tokens.length > 0))) return null;
    return (await this.hasHistory(this.kp("v", i).publicKey).catch(() => true)) ? null : i;
  }

  /** The next deposit address for a payment link, checked on-chain to have no history. Taken before the check, so a new QR code moves past it. */
  private async freshDepositIndex(): Promise<number> {
    await this.discovery;
    for (let tries = 0; tries < 25; tries++) {
      const i = Math.max(this.knownDeposit(), this.s.qrIndex + 1);
      this.markDeposit(i);
      if (!(await this.hasHistory(this.kp("d", i).publicKey))) return i;
    }
    throw new Error("Couldn't find an unused address just now. Please try again in a moment.");
  }

  // ─── deposit addresses: shield by QR code, from any wallet or exchange ───
  private depositCountKey() {
    return `vs:dw:${this.s.fingerprint}`;
  }

  private knownDeposit(): number {
    return ls.get<number>(this.depositCountKey(), 0);
  }

  private markDeposit(i: number) {
    if (i + 1 > this.knownDeposit()) ls.set(this.depositCountKey(), i + 1);
  }

  private heldKey(i: number) {
    return `vs:dh:${this.s.fingerprint}:${i}`;
  }

  private heldWhy(i: number): Held | null {
    const v = ls.get<Held | boolean | null>(this.heldKey(i), null);
    return v === true ? "returned" : v || null;
  }

  private setHeld(i: number, held: Held | null, fp = this.s.fingerprint) {
    const key = `vs:dh:${fp}:${i}`;
    ls.set(key, held);
    // "returned" marks from before 1.4.1 could be wrong (a private payment looked like a return): those are checked again once
    ls.set(`${key}:v`, held === "returned");
    if (fp === this.s.fingerprint) this.set({ deposits: this.s.deposits.map((d) => (d.index === i ? { ...d, held } : d)) });
  }

  /** How many deposit addresses the waiting room is matched against (locally, nothing is asked): every one used, plus a couple ahead. */
  private depositRange(): number {
    return Math.max(this.knownDeposit(), this.s.qrIndex + 1) + 2;
  }

  depositKeypair(i: number): Keypair {
    return this.kp("d", i);
  }

  depositAddress(i: number): string {
    return this.depositKeypair(i).publicKey.toBase58();
  }

  exportDeposit(i: number): string {
    return bs58.encode(this.depositKeypair(i).secretKey);
  }

  // ─── payment requests ───
  /**
   * A payment request: a fresh deposit address of its own, written into a link. Whatever is paid
   * to it moves into the private balance like any QR deposit; payers only ever see that address,
   * never the private balance or any wallet of yours. One link is meant for one person or one bill.
   */
  async createRequest(amount: bigint | null, note: string): Promise<PayRequest> {
    this.need();
    // never an address used before, from this device or another
    const index = await this.freshDepositIndex();
    const r: PayRequest = {
      index,
      address: this.depositAddress(index),
      amount: amount ? amount.toString() : null,
      note: note.trim().slice(0, 80),
      created: Date.now(),
      received: "0",
    };
    this.saveRequests([r, ...this.s.requests]);
    return r;
  }

  /** The link that pays a request. The details live after "#", so they never reach any server. */
  requestLink(r: PayRequest): string {
    const q = new URLSearchParams({ to: r.address });
    if (r.amount) q.set("amount", solText(BigInt(r.amount)));
    if (r.note) q.set("note", r.note);
    return `${location.origin}/pay#${q.toString()}`;
  }

  removeRequest(index: number) {
    this.saveRequests(this.s.requests.filter((r) => r.index !== index));
  }

  private saveRequests(list: PayRequest[]) {
    if (this.s.fingerprint) ls.set(`vs:req:${this.s.fingerprint}`, list);
    this.set({ requests: list });
  }

  /**
   * Counts a payment that just moved in. The waiting-room rent of the request's last move comes
   * back to its address once that deposit has joined the pool; it rides along with the next
   * payment, but it was never paid by anyone, so it isn't counted.
   */
  private requestPaid(index: number, arrived: bigint, rentOut: bigint, stillWaiting: boolean, fp = this.s.fingerprint) {
    // (another account's list, on this device, for a move that outlived it)
    const here = fp === this.s.fingerprint;
    const list = here ? this.s.requests : ls.get<PayRequest[]>(`vs:req:${fp}`, []);
    if (!fp || !list.some((r) => r.index === index)) return;
    const next = list.map((r) => {
      if (r.index !== index) return r;
      const back = stillWaiting ? 0n : BigInt(r.rentOut ?? "0");
      const paid = arrived > back ? arrived - back : 0n;
      // rent of a deposit still waiting hasn't come back yet: it arrives with a later payment
      const owed = stillWaiting ? BigInt(r.rentOut ?? "0") : 0n;
      return { ...r, received: (BigInt(r.received) + paid).toString(), rentOut: (rentOut + owed).toString() };
    });
    if (here) this.saveRequests(next);
    else ls.set(`vs:req:${fp}`, next);
  }

  /** Puts a fresh deposit address in the QR code (each one is a new address; older ones keep working). */
  newDepositAddress() {
    const i = Math.max(this.knownDeposit(), this.s.qrIndex + 1);
    this.markDeposit(i);
    ls.set(`vs:dq:${this.s.fingerprint}`, i);
    this.set({ qrIndex: i });
    void this.refreshDeposits({ only: [i] });
  }

  /** The network fee of a deposit: 5,000 lamports per signature (the guard's pass counts as one), plus its small priority fee. */
  depositTxFee(): bigint {
    return 5_000n * (this.s.pool?.requireAttestation ? 2n : 1n) + ownPriority(DEPOSIT_CU);
  }

  /** The least a deposit address has to receive to make the smallest deposit: the deposit, its fee, the waiting-room rent and the network fee. */
  minReceive(): bigint | null {
    const pool = this.s.pool;
    const rent = this.s.rent;
    if (!pool || !rent) return null;
    const min = BigInt(pool.minDeposit);
    return min + this.depositFee(min) + rent.pending + this.depositTxFee();
  }

  /** The last balance seen at each deposit address this session. */
  private depSeen = new Map<number, bigint>();
  private depDormant = new Rotation([25_000, 60_000]);

  /** Deposit addresses that held SOL at the last look, so the next unlock checks them first. */
  private fundedKey() {
    return `vs:df:${this.s.fingerprint}`;
  }

  /** Deposit addresses whose balance can change any moment: the QR code, payment links not paid yet (from the last month), and SOL that hasn't moved in yet. */
  private depositWatch(): Set<number> {
    const w = new Set<number>([this.s.qrIndex, ...this.moving]);
    const month = Date.now() - 30 * 86_400_000;
    for (const r of this.s.requests) {
      const got = BigInt(r.received);
      if (r.created > month && (r.amount ? got < BigInt(r.amount) : got === 0n)) w.add(r.index);
    }
    for (const [i, l] of this.depSeen) if (l > 0n && !this.heldWhy(i)) w.add(i);
    return w;
  }

  /**
   * Deposit balances. Routinely just the addresses that can change, each in its own request, in
   * random order; now and then one of the others (paid and moved in long ago), in case it's paid
   * again. On unlock also the ones that held SOL or tokens last time. `only` reads just those;
   * `tokens` also looks at their tokens straight away (a first look, or "Check for more").
   */
  async refreshDeposits(opts: { only?: number[]; unlock?: boolean; tokens?: boolean } = {}) {
    const keys = this.keys;
    if (!keys) return;
    const watch = this.depositWatch();
    let singles: number[];
    if (opts.only) singles = opts.only;
    else {
      if (opts.unlock) {
        for (const i of ls.get<number[]>(this.fundedKey(), [])) watch.add(i);
        this.depDormant.soon();
      }
      const dormant = this.depDormant.take(
        Date.now(),
        range(this.knownDeposit()).filter((i) => !watch.has(i)),
      );
      singles = dormant == null ? [...watch] : [...watch, dormant];
    }
    try {
      const seen = new Map<number, bigint>();
      await paced(
        shuffle(singles),
        2,
        (i) =>
          conn()
            .getBalance(this.kp("d", i).publicKey, "confirmed")
            .then(
              (l) => void seen.set(i, BigInt(l)),
              () => {},
            ),
        singles.length > 1 ? [100, 900] : [0, 0],
      );
      if (this.keys !== keys) return;
      const funded = new Set(ls.get<number[]>(this.fundedKey(), []));
      for (const [i, l] of seen) {
        if ((this.depSeen.get(i) ?? 0n) !== l) this.changedAt = Date.now();
        this.depSeen.set(i, l);
        const tokens = this.depositTokens.get(this.kp("d", i).publicKey.toBase58());
        if (l > 0n || tokens?.length) {
          this.markDeposit(i);
          funded.add(i);
        } else if (tokens) funded.delete(i); // tokens not looked at yet: the look below decides
      }
      ls.set(this.fundedKey(), [...funded]);
      const views = this.showDeposits();
      // tokens only where they're likely: addresses being watched, or holding (or lately holding) something
      const look = [...seen.keys()].filter((i) => {
        // asked for: everything not looked at in the last minute (a look just started isn't repeated)
        const at = this.tokensAt.get(this.kp("d", i).publicKey.toBase58()) ?? 0;
        if (Date.now() - at < (opts.tokens ? 60_000 : 5 * 60_000)) return false;
        return opts.tokens || watch.has(i) || seen.get(i)! > 0n || funded.has(i);
      });
      const scan = look.length ? this.refreshDepositTokens(look) : null;
      void this.freshQr(this.kp("d", this.s.qrIndex).publicKey, views);
      void this.autoMove();
      // a first look (unlock, addresses found, "Check for more") waits for the tokens too, so nothing reads as empty too soon
      if (scan && (opts.unlock || opts.tokens)) await scan;
    } catch {
      /* keep what we had */
    }
  }

  /** The Deposit addresses list, from the balances and tokens seen this session: those holding something, and the QR code's. */
  private showDeposits(): DepositView[] {
    const now = Date.now();
    const views: DepositView[] = [];
    for (const [i, l] of [...this.depSeen].sort((a, b) => a[0] - b[0])) {
      const address = this.kp("d", i).publicKey.toBase58();
      const tokens = this.depositTokens.get(address) ?? [];
      if (l === 0n && !tokens.length && i !== this.s.qrIndex) continue;
      const retry = this.retry.get(i);
      views.push({ index: i, address, lamports: l, held: this.heldWhy(i), tokens, wait: retry && retry.at > now ? retry.why : null });
    }
    this.set({ deposits: views });
    return views;
  }

  /** Tokens seen at each deposit address this session, and when each address was last asked. */
  private depositTokens = new Map<string, TokenHolding[]>();
  private tokensAt = new Map<string, number>();

  /**
   * Tokens sent to a deposit address (USDC from an exchange, say) can't go into the pool, which
   * takes SOL only. They're listed so they're never lost from view: the address's key can be
   * exported to reach them. Each address is asked on its own, a moment apart, at most every few
   * minutes, so the addresses never reach the RPC provider together.
   */
  private async refreshDepositTokens(indexes: number[]) {
    const keys = this.keys;
    if (!keys) return;
    for (const i of indexes) this.tokensAt.set(this.kp("d", i).publicKey.toBase58(), Date.now());
    let changed = false;
    await paced(
      shuffle(indexes),
      2,
      async (i) => {
        if (this.keys !== keys) return;
        const owner = this.kp("d", i).publicKey;
        const address = owner.toBase58();
        try {
          const [std, t22] = await Promise.all([
            conn().getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(TOKEN_PROGRAM) }, "confirmed"),
            conn().getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(TOKEN_2022) }, "confirmed"),
          ]);
          const tokens: TokenHolding[] = [];
          for (const [prog, r] of [
            [TOKEN_PROGRAM, std],
            [TOKEN_2022, t22],
          ] as const) {
            for (const a of r.value) {
              const info = (a.account.data as { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } }).parsed.info;
              if (BigInt(info.tokenAmount.amount) > 0n)
                tokens.push({ mint: info.mint, amount: BigInt(info.tokenAmount.amount), decimals: info.tokenAmount.decimals, program: prog, account: a.pubkey.toBase58() });
            }
          }
          if (this.keys !== keys) return;
          const before = this.depositTokens.get(address);
          if (!before || before.map((t) => `${t.account}:${t.amount}`).join() !== tokens.map((t) => `${t.account}:${t.amount}`).join()) {
            if (before || tokens.length) this.changedAt = Date.now();
            changed = true;
          }
          this.depositTokens.set(address, tokens);
        } catch {
          this.tokensAt.set(address, Date.now() - 4 * 60_000); // ask again in a minute
        }
      },
      indexes.length > 1 ? [100, 900] : [0, 0],
    );
    if (this.keys !== keys || !changed) return;
    // what was found shows now, and an address holding tokens is looked at first on the next unlock
    const funded = new Set(ls.get<number[]>(this.fundedKey(), []));
    for (const i of indexes) {
      const tokens = this.depositTokens.get(this.kp("d", i).publicKey.toBase58());
      if (!tokens) continue;
      if (tokens.length) {
        this.markDeposit(i);
        funded.add(i);
      } else if (!((this.depSeen.get(i) ?? 0n) > 0n)) funded.delete(i);
    }
    ls.set(this.fundedKey(), [...funded]);
    this.showDeposits();
  }

  private freshChecked = new Set<string>();

  /**
   * The QR code should always show an address nobody has paid before (a reused address links deposits).
   * This device remembers the ones it used, but another device may have used one too: an empty
   * address with any history on-chain is skipped for the next one.
   */
  private async freshQr(address: PublicKey | undefined, views: DepositView[]) {
    if (!address) return;
    const id = address.toBase58();
    const here = views.find((v) => v.address === id);
    // SOL that can't go in (refused, returned) stays listed under Deposit addresses; new deposits get a new code
    if (here?.held && here.lamports > 0n) {
      this.newDepositAddress();
      return;
    }
    // SOL arriving right now keeps its address until it has moved in (a short payment is topped up there)
    if (this.freshChecked.has(id) || (here && here.lamports > 0n)) return;
    this.freshChecked.add(id);
    try {
      const [any] = await conn().getSignaturesForAddress(address, { limit: 1 }, "confirmed");
      if (any && this.keys && this.depositAddress(this.s.qrIndex) === id) this.newDepositAddress();
    } catch {
      this.freshChecked.delete(id); // try again on the next check
    }
  }

  private qrTimer: ReturnType<typeof setTimeout> | null = null;

  /** While the QR code is on screen, check its address (only that one) every few seconds, less often after a few minutes, so arriving SOL moves on straight away. */
  watchQr(on: boolean) {
    if (this.qrTimer) clearTimeout(this.qrTimer);
    this.qrTimer = null;
    if (!on) return;
    const since = Date.now();
    const next = () => {
      this.qrTimer = setTimeout(
        () => {
          if (!document.hidden) void this.refreshDeposits({ only: [this.s.qrIndex] });
          next();
        },
        Date.now() - since < 180_000 ? 3000 : 8000,
      );
    };
    next();
    void this.refreshDeposits({ only: [this.s.qrIndex] });
  }

  private moving = new Set<number>();
  private moveFails = new Map<number, number>();
  /** Deposit addresses whose move into the pool is paused for a while after a passing problem (kept in memory only). */
  private retry = new Map<number, { at: number; n: number; why: string }>();
  private rechecked = new Set<number>();

  /** Waits longer after each passing problem (10 s, 30 s, 2 min, then 10 min), and never less than the server asked. */
  private backOff(index: number, why: string, seconds?: number | null) {
    const n = (this.retry.get(index)?.n ?? 0) + 1;
    const ladder = [10_000, 30_000, 120_000, 600_000];
    const wait = Math.max((seconds ?? 0) * 1000, ladder[Math.min(n, ladder.length) - 1]);
    this.retry.set(index, { at: Date.now() + wait, n, why });
    this.set({ deposits: this.s.deposits.map((d) => (d.index === index ? { ...d, wait: why } : d)) });
  }

  private moveKey() {
    return `vs:dmove:${this.s.fingerprint}`;
  }

  /** When each waiting deposit address may move in, and when the last one did; kept on this device so a reload doesn't bunch them up. */
  private moveState(): { plan: MovePlan; last: number } {
    return this.s.fingerprint ? ls.get(this.moveKey(), { plan: {}, last: 0 }) : { plan: {}, last: 0 };
  }

  /** The same for Vision wallets whose sale's SOL goes back into the pool by itself (see tidyOrders). */
  private vmoveKey() {
    return `vs:vmove:${this.s.fingerprint}`;
  }
  private vmoveState(): { plan: MovePlan; last: number } {
    return this.s.fingerprint ? ls.get(this.vmoveKey(), { plan: {}, last: 0 }) : { plan: {}, last: 0 };
  }
  /** When anything of this account last moved into the pool by itself or by hand: the next automatic move keeps its gap from it. */
  private lastMove(): number {
    return Math.max(this.moveState().last, this.vmoveState().last);
  }

  /** How long until a waiting deposit address moves in by itself (ms), when it's waiting its turn. */
  moveEta(index: number): number | null {
    const t = this.moveState().plan[index];
    return t == null ? null : Math.max(0, t - Date.now());
  }

  /**
   * SOL that lands on a deposit address moves into the pool by itself while the page is open.
   * Several waiting at once (payment links paid while the page was closed) go in one at a time,
   * in random order, a random 1 to 6 min apart, so payers of different links can't be grouped by
   * timing; a payment to the QR code on screen goes straight in. The one exception is SOL that
   * came back from the pool (a deposit taken back): that waits for its owner to choose.
   */
  private async autoMove() {
    if (!this.keys || this.s.busy || this.moving.size) return;
    const min = this.minReceive();
    if (min == null) return;
    const now = Date.now();
    const paused = (i: number) => (this.retry.get(i)?.at ?? 0) > now;
    // a "returned" mark from an older version is checked again once (a private payment used to look like a return); one address a round
    const old = this.s.deposits.find(
      (d) => d.held === "returned" && d.lamports >= min && !paused(d.index) && !this.rechecked.has(d.index) && !ls.get(`${this.heldKey(d.index)}:v`, false),
    );
    if (old) {
      this.rechecked.add(old.index);
      const again = await this.cameBackFromPool(old.address);
      if (again === "not") this.setHeld(old.index, null);
      else if (again === "returned") this.setHeld(old.index, "returned");
      else {
        this.rechecked.delete(old.index);
        this.backOff(old.index, "Can't reach the network right now. Trying again shortly.");
      }
      return;
    }
    // one paused after a passing problem keeps its place in line; its turn just waits for the pause to end
    const ready = this.s.deposits.filter((d) => !d.held && d.lamports >= min && (this.moveFails.get(d.index) ?? 0) < 3).map((d) => d.index);
    const st = this.moveState();
    // the gap counts from any move into the pool, a Vision wallet's included
    const last = this.lastMove();
    let plan = planMoves(now, ready, st.plan, last, MOVE_GAP, this.qrTimer ? this.s.qrIndex : null);
    const i = dueMove(now, Object.fromEntries(Object.entries(plan).filter(([k]) => !paused(Number(k)))), last, MOVE_GAP[0]);
    if (i != null) plan = afterMove(now, plan, i, MOVE_GAP);
    ls.set(this.moveKey(), { plan, last: i != null ? now : st.last });
    if (i == null) return;
    this.picked = { index: i, at: now, last: st.last };
    try {
      const d = this.s.deposits.find((x) => x.index === i)!;
      const back = await this.cameBackFromPool(d.address);
      if (back === "unknown") {
        this.backOff(i, "Can't reach the network right now. Trying again shortly.");
        this.requeue(i);
        return;
      }
      if (back === "returned") {
        this.setHeld(i, "returned");
        return;
      }
      await this.moveDeposit(i, true).catch(() => {});
    } finally {
      this.picked = null;
    }
  }

  /** The address autoMove just took its turn for, and when the line's last move was before that. */
  private picked: { index: number; at: number; last: number } | null = null;

  /**
   * A move that stopped before anything was sent keeps its place in line: its turn comes back when
   * its pause ends, and it doesn't count as a move for the gap before the next one (nothing reached the chain).
   */
  private requeue(index: number) {
    const at = Math.max(Date.now(), this.retry.get(index)?.at ?? 0);
    if (!Number.isFinite(at)) return;
    const ms = this.moveState();
    const p = this.picked?.index === index ? this.picked : null;
    ls.set(this.moveKey(), { plan: { ...ms.plan, [index]: at }, last: p && ms.last === p.at ? p.last : ms.last });
  }

  /**
   * Whether the SOL at `address` came back from the pool (a deposit refunded to it), judged by
   * the latest real payment into it. Private payments from the pool (a request paid privately,
   * a send-later) and the waiting-room rent that comes back after a deposit are ordinary money
   * in. "unknown" when the network can't say right now: nothing is decided on a guess.
   */
  private async cameBackFromPool(address: string): Promise<"returned" | "not" | "unknown"> {
    const program = this.s.pool?.programId;
    if (!program) return "unknown";
    try {
      const sigs = await conn().getSignaturesForAddress(new PublicKey(address), { limit: 10 }, "confirmed");
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await conn().getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
        if (!tx?.meta) return "unknown";
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
        let me = -1;
        for (let i = 0; i < keys.length; i++) if (keys.get(i)?.toBase58() === address) me = i;
        if (me < 0 || tx.meta.postBalances[me] <= tx.meta.preBalances[me]) continue; // money out, not in
        const events = eventsFromLogs(tx.meta.logMessages ?? [], program);
        if (events.some((e) => e.kind === "refunded" && e.depositor === address)) return "returned";
        // a settle hands the waiting-room rent back: not a payment, look further back
        if (events.some((e) => e.kind === "settled") && !events.some((e) => e.kind === "spent")) continue;
        return "not";
      }
      return "not";
    } catch {
      return "unknown"; // ask again later rather than guess
    }
  }

  /**
   * Moves what a deposit address holds into the pool: screened, into the
   * waiting room, then the private balance. Split into several deposits only
   * if one would go over the pool's per-deposit limit. The address ends at
   * exactly zero (Solana won't leave less than an account's rent behind).
   */
  async moveDeposit(index: number, auto = false) {
    if (this.moving.has(index)) return;
    // a move by hand takes the lock before its first await, so nothing else can start in between
    if (!auto) {
      if (this.s.busy) return;
      this.step("shield", "Moving the SOL into the pool");
    }
    // a move that starts by itself waits behind anything already running, and shows as a status line
    const task = auto ? this.bgBegin("shield", "A payment arrived: moving it into the pool") : null;
    if (auto && !task) {
      this.requeue(index);
      return;
    }
    // a move that started by itself and outlived its lock, or any move that outlived its account
    // (locked or switched), stops quietly
    const fp = this.s.fingerprint;
    const gone = () => (!!task && this.bgTask !== task) || this.s.fingerprint !== fp;
    const stop = new Error("stopped");
    const check = () => {
      if (gone()) throw stop;
    };
    this.moving.add(index);
    // once a deposit has gone out it may land, so a retry waits its turn like any other move
    let sent = false;
    // what has landed is counted even if the move stops afterwards (see book)
    let book = () => {};
    try {
      await this.loadPool();
      const { pool } = this.need();
      const rent = await this.rentNow();
      const kp = this.depositKeypair(index);
      const label = index === this.s.qrIndex ? "your deposit address" : `deposit address #${index + 1}`;
      let lamports = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
      const arrived = lamports; // what the payer sent, before fees: what a payment request counts
      const wasReturned = this.heldWhy(index) === "returned"; // the same SOL going back in isn't a new payment
      const need = this.minReceive()!;
      if (lamports < need) {
        throw new Error(
          `${capital(label)} holds ${fmt(lamports, 6)} SOL. Send at least ${fmtUp(need - lamports)} SOL more to the same address to reach the smallest deposit.`,
        );
      }
      if (pool.depositsPaused) throw new Error(`Deposits are paused right now. The SOL is safe at ${label}.`);
      const txFee = this.depositTxFee();
      const max = BigInt(pool.maxDeposit);
      const parts = depositParts(lamports, { rentPending: rent.pending, txFee, feeBps: this.depositFeeBps(), min: BigInt(pool.minDeposit), max });
      if (!parts.length) throw new Error(`${capital(label)} holds too little for a deposit.`);
      const room = pool.tvlRoom != null ? BigInt(pool.tvlRoom) : null;
      if (room != null && parts.reduce((s, a) => s + a, 0n) > room) {
        throw new Error(`The pool is at its deposit limit right now. The SOL is safe at ${label}; try again later.`);
      }
      // a move that starts by itself is screened first, so a passing screening hiccup never shows
      let att: Attestation | undefined;
      if (auto && pool.requireAttestation) att = await this.attestation(kp.publicKey);
      check();
      this.step("shield", auto ? `${fmt(lamports)} SOL arrived at ${label}` : `Moving the SOL at ${label} into the pool`, "Screening where it came from, then into the waiting room.");
      const before = this.waitingFrom(kp.publicKey.toBase58());
      // read before this move adds waiting deposits of its own (a sync can show them mid-move)
      const prevWaiting = this.s.waiting.some((w) => w.deposit === index);
      let total = 0n;
      let sig = "";
      const landed: { amount: bigint; sig: string; cost: bigint }[] = [];
      let booked = false;
      let fresh = false;
      // the payment request, the activity and the move plan learn about deposits that landed, under
      // the account that made them, even when the move lost its lock or its account meanwhile
      book = () => {
        if (booked || !landed.length || !fp) return;
        booked = true;
        const here = this.s.fingerprint === fp;
        // its account closed with its history cleared meanwhile: no activity or payment link comes back for it
        const quiet = !here && this.cleared.has(fp);
        const all = landed.length === parts.length;
        if (!quiet) for (const l of landed) this.log({ kind: "shield", text: `Shielded ${fmt(l.amount)} SOL from ${label}`, sig: l.sig }, fp);
        if (here) {
          this.moveFails.delete(index);
          this.retry.delete(index);
        }
        if (all) this.setHeld(index, null, fp);
        // only part of it went: the rest is counted by the move that takes it in
        const counted = all ? arrived : landed.reduce((t, l) => t + l.cost, 0n);
        if (!wasReturned && !quiet) this.requestPaid(index, counted, rent.pending * BigInt(landed.length), prevWaiting, fp);
        // a move by hand counts too: the next one by itself still waits its random gap after this
        const key = `vs:dmove:${fp}`;
        const ms = ls.get<{ plan: MovePlan; last: number }>(key, { plan: {}, last: 0 });
        ls.set(key, { plan: afterMove(Date.now(), ms.plan, index, MOVE_GAP), last: Date.now() });
        // every deposit gets its own address, so two deposits can't be linked through one; the old one keeps working
        fresh = all && here && index === this.s.qrIndex;
        if (fresh) this.newDepositAddress();
        else if (all && !here && ls.get<number>(`vs:dq:${fp}`, 0) === index) {
          // its account closed meanwhile: its QR code still moves on, as newDepositAddress does, so the next payer gets a new address
          const next = Math.max(ls.get<number>(`vs:dw:${fp}`, 0), index + 1);
          ls.set(`vs:dw:${fp}`, next + 1);
          ls.set(`vs:dq:${fp}`, next);
        }
      };
      for (let k = 0; k < parts.length; k++) {
        check();
        const last = k === parts.length - 1;
        if (parts.length > 1) this.step("shield", `Deposit ${k + 1} of ${parts.length}`, "The pool takes at most a set amount per deposit, so this goes in parts.");
        let amount = parts[k];
        let dust = 0n;
        if (last) {
          // plan the last part from what is really there now (more may have arrived meanwhile)
          lamports = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
          const budget = lamports - rent.pending - txFee;
          amount = this.maxDepositFor(budget);
          if (amount > max) amount = max;
          dust = budget - amount - this.depositFee(amount);
          // whatever is left must be zero or enough to keep the address open; a sliver rides along instead
          if (dust >= rent.wallet) dust = 0n;
        }
        check(); // the note must belong to the account this address belongs to
        const { ixs } = await this.depositIxs(kp.publicKey, amount, k === 0 ? att : undefined);
        if (dust > 0n) {
          const pendingAccount = ixs[ixs.length - 1].keys[4].pubkey;
          ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: pendingAccount, lamports: dust }));
        }
        const tx = new Transaction().add(...ixs);
        tx.feePayer = kp.publicKey;
        tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
        tx.sign(kp);
        sent = true;
        sig = await sendAndConfirm(tx, "deposit");
        landed.push({ amount, sig, cost: amount + this.depositFee(amount) + rent.pending + txFee + dust });
        total += amount;
        check();
      }
      check();
      book();
      this.step("shield", "Into the waiting room");
      await Promise.all([this.awaitWaiting(kp.publicKey.toBase58(), before, parts.length), this.refreshDeposits({ only: [index] })]);
      if (gone()) return sig;
      this.done(
        auto ? "Received and shielded" : "Moved into the pool",
        `${fmt(total)} SOL from ${this.s.requests.find((r) => r.index === index) ? `your payment request${this.s.requests.find((r) => r.index === index)!.note ? ` "${this.s.requests.find((r) => r.index === index)!.note}"` : ""}` : label} is in the waiting room. It joins your private balance in about ${this.waitLabel()}. You can close this page; it carries on without you.${fresh ? " Your QR code now shows a fresh address for your next deposit." : ""}`,
        sig,
      );
      return sig;
    } catch (e) {
      // parts that landed before this stopped still count
      book();
      if (gone()) return;
      const m = (e as Error)?.message ?? "";
      const status = e instanceof ApiError ? e.status : 0;
      const refused = status === 403;
      // (an automatic move's error never replaces the person's own message: see bgSay)
      if (auto && !refused) {
        // a passing problem with a move that started by itself shows nothing: it waits and tries again
        if (status === 451) {
          // not from this region: once per visit, and nothing is remembered (a different connection may be fine)
          this.retry.set(index, { at: Infinity, n: 99, why: "Moving into the pool isn't available from this region." });
          this.fail(e);
        }
        const passing =
          e instanceof StillPending ||
          status === 429 ||
          status >= 500 ||
          /expired|blockhash|busy|for rent|reach the network|briefly unavailable|paused|deposit limit|failed to (fetch|get)|network ?error|load failed|timed? ?out|dropped|not indexed/i.test(m);
        if (passing) {
          const why =
            status === 429 || status === 503 || /screening/i.test(m)
              ? "Screening is busy right now. It tries again by itself shortly."
              : /paused|deposit limit/i.test(m)
                ? "The pool isn't taking deposits right now. It tries again by itself later."
                : "The network is busy right now. It tries again by itself shortly.";
          this.backOff(index, why, e instanceof ApiError ? e.retryAfter : null);
          if (!sent) this.requeue(index);
          return;
        }
        // a real refusal on-chain: a few tries, spaced out, before asking the owner
        const fails = (this.moveFails.get(index) ?? 0) + 1;
        this.moveFails.set(index, fails);
        if (fails < 3) {
          this.backOff(index, "Moving this in didn't work the first time. It tries again by itself shortly.");
          if (!sent) this.requeue(index);
          return;
        }
        this.setHeld(index, "failed");
        this.fail(e);
      }
      if (refused) {
        this.setHeld(index, "refused");
        this.fail(
          new Error(
            "The SOL that arrived can't go into the pool: it came from an address that doesn't pass screening. It stays at your deposit address, and only you can move it.",
          ),
        );
      }
      this.fail(e);
    } finally {
      this.moving.delete(index);
      this.bgEnd(task);
    }
  }

  /** Sends everything a deposit address holds to another wallet, as an ordinary (public) transfer. */
  async sendFromDeposit(index: number, to: string) {
    try {
      let dest: PublicKey;
      try {
        dest = new PublicKey(to.trim());
      } catch {
        throw new Error("That doesn't look like a Solana address.");
      }
      const kp = this.depositKeypair(index);
      if (dest.equals(kp.publicKey)) throw new Error("That's this deposit address itself.");
      this.step("send", "Sending from your deposit address");
      const lamports = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
      const amount = lamports - 5_000n;
      if (amount <= 0n) throw new Error("There's nothing to send at this address.");
      const { wallet: rentMin } = await this.rentNow();
      const exists = (await conn().getBalance(dest, "confirmed")) > 0;
      if (!exists && amount < rentMin) throw new Error(`A new address needs at least ${fmt(rentMin, 6)} SOL to exist. Send it to a wallet that already holds SOL.`);
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: amount }));
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
      tx.sign(kp);
      const sig = await sendAndConfirm(tx, "transfer");
      const who = `${dest.toBase58().slice(0, 4)}…${dest.toBase58().slice(-4)}`;
      this.setHeld(index, null);
      this.retry.delete(index);
      this.moveFails.delete(index);
      this.log({ kind: "send", text: `Sent ${fmt(amount)} SOL from a deposit address to ${who}`, sig });
      await this.refreshDeposits({ only: [index] });
      this.done("Sent", `${fmt(amount)} SOL is on its way to ${who}.`, sig);
      return sig;
    } catch (e) {
      this.fail(e);
    }
  }

  // ─── fees ───
  feeBps() {
    return this.s.pool?.feeBps ?? 80;
  }

  relayerFee(): bigint {
    return BigInt(this.s.pool?.relayerFee ?? "2000000");
  }

  /** What a private send of `amount` to one of this account's own wallets costs (the pool pays it directly), and what the pool takes. */
  quoteSend(amount: bigint) {
    const relayerFee = this.relayerFee();
    const withdraw = grossUp(amount, relayerFee, this.feeBps());
    const split = splitWithdraw(withdraw, relayerFee, this.feeBps());
    return { withdraw, ...split, deliveryFee: 0n };
  }

  /**
   * What a private payment of exactly `amount` to an outside address costs: as quoteSend, plus the
   * delivery fee its one-time sending address pays for the standard transfer to the recipient.
   */
  quotePay(amount: bigint, relayerFee = this.relayerFee()) {
    return payQuote(amount, relayerFee, this.feeBps(), this.treasury?.view);
  }

  /** The quote for a payment to `to` (null: not typed yet, taken as an outside address). */
  quoteFor(to: string | null, amount: bigint) {
    return to && this.ownKeypairFor(to) ? this.quoteSend(amount) : this.quotePay(amount);
  }

  /** The most one private payment can deliver, after fees (a delivery's too) and after joining notes when the balance is in several pieces. */
  maxSendable(): bigint {
    return this.maxSpend(DELIVERY_FEE);
  }

  /**
   * The most "Send it yourself" can deliver: when the balance is in several pieces, the same fee
   * payer joins them first, each join costing the self-send cost (no relayer involved). A payment to
   * an outside address also pays its delivery fee.
   */
  maxSelfSendable(): bigint {
    const cost = this.selfCost();
    const top = maxWithdraw(
      this.freeNotes().map((n) => n.amount),
      cost,
    );
    if (top <= cost) return 0n;
    let x = splitWithdraw(top, cost, this.feeBps()).toRecipient - DELIVERY_FEE;
    for (let i = 0; x > 0n && i < 64 && grossUp(x + DELIVERY_FEE, cost, this.feeBps()) > top; i++) x -= 1n + x / 1_000_000_000n;
    return x > 0n ? x : 0n;
  }

  /** The treasury's balance and rent minimum, read at most once a minute (an emptied treasury takes no fee). */
  private async readTreasury() {
    const pool = this.s.pool;
    if (!pool || (this.treasury && Date.now() - this.treasury.at < 60_000)) return;
    try {
      const a = await conn().getAccountInfo(new PublicKey(pool.treasury), "confirmed");
      const rentMin = BigInt(await conn().getMinimumBalanceForRentExemption(a?.data.length ?? 0));
      this.treasury = { view: { lamports: BigInt(a?.lamports ?? 0), rentMin }, at: Date.now() };
    } catch {
      // unknown: taken to receive, as it nearly always does (a payment the relayer finds off by its fee comes back "stale", nothing spent)
    }
  }

  // ─── deliveries: payments to outside addresses (see hops.ts) ───

  /** This account's own wallet at `address`: a Vision wallet, a deposit address or a fee wallet; null for anyone else's. */
  ownKeypairFor(address: string): Keypair | null {
    const keys = this.keys;
    if (!keys) return null;
    const v = Math.max(this.knownVision(), this.nextVisionIndex()) + 4;
    const d = this.depositRange();
    const g = this.gasState().next + 4;
    const sig = `${v}:${d}:${g}`;
    if (this.ownFor !== keys || this.ownSig !== sig) {
      const m = new Map<string, Keypair>();
      const vi = new Map<string, number>();
      for (let i = 0; i < v; i++) {
        m.set(this.kp("v", i).publicKey.toBase58(), this.kp("v", i));
        vi.set(this.kp("v", i).publicKey.toBase58(), i);
      }
      for (let i = 0; i < d; i++) m.set(this.kp("d", i).publicKey.toBase58(), this.kp("d", i));
      for (let i = 0; i < g; i++) {
        const k = gasWallet(keys, i);
        m.set(k.publicKey.toBase58(), k);
      }
      this.ownMap = m;
      this.ownVision = vi;
      this.ownFor = keys;
      this.ownSig = sig;
    }
    return this.ownMap.get(address) ?? null;
  }
  private ownMap = new Map<string, Keypair>();
  private ownVision = new Map<string, number>();

  /** Which of this account's Vision wallets `address` is (its index), or null for any other address. */
  visionIndexOf(address: string): number | null {
    if (!this.ownKeypairFor(address)) return null;
    return this.ownVision.get(address) ?? null;
  }

  /** How an address is named in lists and messages: "Vision wallet #4 (yours)" for one of this account's, else short. */
  addressName(address: string): string {
    const i = this.visionIndexOf(address);
    return i == null ? shortAddr(address) : `${walletName(i)} (yours)`;
  }

  /** The same with a note after it: "9xT4…oB7Y (scheduled)", or "Vision wallet #4 (yours), scheduled". */
  private nameWith(address: string, note: string): string {
    return this.visionIndexOf(address) == null ? `${shortAddr(address)} (${note})` : `${this.addressName(address)}, ${note}`;
  }
  private ownFor: Keys | null = null;
  private ownSig = "";

  /** The pool's and the relayer's own addresses: never a payment's recipient. */
  private reservedHere(): Set<string> {
    const p = this.s.pool;
    const out = new Set<string>();
    if (!p) return out;
    for (const a of [p.programId, p.treasury, p.guard, p.relayer, p.delivery?.nonceAuthority, p.accounts.config, p.accounts.vault, p.accounts.tree]) if (a) out.add(a);
    return out;
  }

  /** This device's deliveries (see HopLeg). */
  private legs(): HopLeg[] {
    return this.s.fingerprint ? readLegs(this.s.fingerprint) : [];
  }
  private saveLeg(leg: HopLeg) {
    if (this.s.fingerprint) writeLegs(this.s.fingerprint, upsertLeg(readLegs(this.s.fingerprint), leg));
  }
  private patchLeg(hop: string, patch: Partial<HopLeg>) {
    if (this.s.fingerprint) writeLegs(this.s.fingerprint, patchLeg(readLegs(this.s.fingerprint), hop, patch));
    // its delivery landed: the activity line written before that gets its Transaction ID
    if (patch.status === "delivered" && patch.tx2) this.fillDeliveryId(hop, patch.tx2);
  }
  /** A proof that will never go (refused with nothing spent): its sending address is nobody's to look after. */
  private dropLeg(hop: string) {
    if (this.s.fingerprint) writeLegs(this.s.fingerprint, readLegs(this.s.fingerprint).filter((l) => l.hop !== hop));
  }

  /**
   * The Transaction ID of each delivery this device knows to have landed, by sending address, and
   * each one's pool spend (never shown as the Transaction ID): for the activity list.
   */
  deliveryIds(): Map<string, { tx1?: string; tx2?: string }> {
    return new Map(this.legs().map((l) => [l.hop, { tx1: l.tx1, ...(l.status === "delivered" && l.tx2 ? { tx2: l.tx2 } : {}) }]));
  }

  /** The activity lines of this sending address with no Transaction ID yet get the delivery's; true when there was one. */
  private fillDeliveryId(hop: string, sig: string): boolean {
    const fp = this.s.fingerprint;
    if (!fp) return false;
    const activity = fillDeliveryLine(this.s.activity, hop, sig);
    if (!activity) return false;
    ls.set(`vs:act:${fp}`, activity);
    this.set({ activity });
    return true;
  }

  /** One of this device's deliveries seen landed (`sig`): its leg says so, and its activity line has the Transaction ID. */
  private legDelivered(leg: HopLeg, sig: string) {
    this.patchLeg(leg.hop, { status: "delivered", tx2: sig, done: Date.now() });
    this.logDelivery({ kind: "send", text: `Sent ${fmt(BigInt(leg.amount))} SOL to ${shortAddr(leg.to)}${leg.job ? " (scheduled)" : ""}`, sig, delivery: { hop: leg.hop, to: leg.to } });
  }

  /**
   * A payment this page just sent: its activity line, unless a look at its sending address while the
   * send was still under way found it delivered and wrote one already (that one gets the Transaction ID).
   */
  private logSent(a: Omit<Activity, "t">) {
    const hop = a.delivery?.hop;
    if (hop && hasDeliveryLine(this.s.activity, hop)) {
      if (a.sig) this.fillDeliveryId(hop, a.sig);
      return;
    }
    this.log(a);
  }

  /** A delivery finished: its line in the activity gets the Transaction ID, or a line is added when there isn't one. */
  private logDelivery(a: Omit<Activity, "t"> & { sig: string; delivery: { hop: string; to: string } }) {
    if (!this.fillDeliveryId(a.delivery.hop, a.sig)) this.log(a);
  }

  /** The key of one of this account's sending addresses, made again from the change note that names it. */
  private hopKeypair(hop: string): Keypair | null {
    const keys = this.keys;
    if (!keys) return null;
    const leg = this.legs().find((l) => l.hop === hop);
    let out0: bigint | null = leg ? BigInt("0x" + leg.out0) : null;
    if (out0 === null) for (const [leaf, a] of this.hopOf) if (a === hop) out0 = leaf;
    if (out0 === null) return null;
    const kp = hopWallet(keys, out0);
    return kp.publicKey.toBase58() === hop ? kp : null;
  }

  /**
   * Whether `hop` is one of this job's own sending addresses: the one its proof names, one this device
   * wrote down for it, or the one made from any proof it was given (never the relayer's word alone).
   */
  private ownJobHop(j: Job, hop: string): boolean {
    if ((j.request as RelayRequestBody | undefined)?.recipient === hop) return true;
    if (this.legs().some((l) => l.hop === hop && l.job === j.id)) return true;
    const keys = this.keys;
    if (!keys) return false;
    const outs = j.outs ?? (j.request as { commitments?: string[] } | undefined)?.commitments ?? [];
    return outs.some((c) => {
      const leaf = BigInt("0x" + c);
      let h = this.hopOf.get(leaf);
      if (!h) {
        h = hopWallet(keys, leaf).publicKey.toBase58();
        this.hopOf.set(leaf, h);
      }
      return h === hop;
    });
  }

  /** The sender confirmed a recipient the form asked about (or not): the question goes. */
  clearAsk() {
    this.set({ ask: null });
  }

  /**
   * Looks after deliveries while the app is open, at most once a minute: one this device started
   * that hasn't landed yet is finished from its sending address (after giving the relayer a couple
   * of minutes), scheduled payments the relayer says are waiting for the app are finished, and about
   * every quarter hour the relayer's public list of sending addresses holding SOL is checked for any
   * of this account's (one paid on another device, or SOL that came back to one after its delivery).
   */
  private async pollHops() {
    if (!this.keys || this.hopping || Date.now() - this.hopsAt < 60_000) return;
    this.hopping = true;
    this.hopsAt = Date.now();
    const keys = this.keys;
    try {
      const now = Date.now();
      // a scheduled payment's delivery is the relayer's while the payment is open (finishJobs takes over when it is due)
      const jobOpen = (id?: string) => !!id && this.s.jobs.some((j) => j.id === id && isOpen(j.status));
      const legs = this.legs().filter((l) => now - l.at > 120_000 && !jobOpen(l.job));
      // ones whose pool payment went first; proofs that may never have gone (a job's that has ended too),
      // only a couple a look, those looked at longest ago first, so every one is reached in turn
      // open ones too, a few a look, those looked at longest ago first (one never looked at before, newest first):
      // a few that can't be finished never keep the others from their turn
      const byLook = (a: HopLeg, b: HopLeg) => (this.legLooked.get(a.hop) ?? 0) - (this.legLooked.get(b.hop) ?? 0);
      const proved = legs.filter((l) => l.status === "proved").sort(byLook);
      const due = [...legs.filter((l) => l.status === "sent" || l.status === "waiting").sort(byLook).slice(0, 6), ...proved.slice(0, 2)];
      const rentMin = this.s.rent?.wallet ?? 0n;
      // ones that couldn't be finished by themselves show under Deliveries, with "Finish now"
      const stuck: HopView[] = [];
      for (const leg of due) {
        if (this.keys !== keys) return;
        const hop = new PublicKey(leg.hop);
        this.legLooked.set(leg.hop, now);
        const bal = await conn()
          .getBalance(hop, "confirmed")
          .catch(() => null);
        if (bal === null) continue;
        // a proof never sent (or not yet landed) leaves nothing, and so does one the relayer sent and delivered
        // after this page closed (before it could hear back): its history tells, and the payment is written down
        // with its Transaction ID (one never paid has no history: one listing, nothing read)
        if (bal === 0 && leg.status === "proved") {
          const by = await this.deliveredFrom(hop, { tx1: leg.tx1, to: leg.to });
          if (by && this.keys === keys) this.legDelivered(leg, by);
          continue;
        }
        // emptied, or holding too little to be a payment (dust a stranger sent it), or a payment that came
        // back after its delivery: delivered when the sending address paid for its own transfer to the recipient
        const by = await this.deliveredFrom(hop, { tx1: leg.tx1, to: leg.to });
        if (by === undefined) this.hopUnread.add(leg.hop);
        else this.hopUnread.delete(leg.hop);
        if (by) {
          // (a page closed while it was delivering never wrote its activity line: it gets one now)
          if (this.keys === keys) this.legDelivered(leg, by);
          continue;
        }
        // still holding a payment: kept on this device's ledger while it does (see pruneLegs)
        if (BigInt(bal) >= rentMin + DELIVERY_FEE && now - (leg.held ?? 0) > HELD_MARK_MS) this.patchLeg(leg.hop, { held: now });
        if (BigInt(bal) < rentMin + DELIVERY_FEE) continue;
        // its history shows no delivery: it waits for this app (one whose history couldn't be read stays as it is)
        if (by === null && leg.status !== "waiting") this.patchLeg(leg.hop, { status: "waiting" });
        // finished by itself only when its history shows no delivery and it holds what an undelivered
        // payment does; anything else (a history that can't be read, a refund) is the owner's to decide
        if (by === null && autoFinishable(BigInt(bal), BigInt(leg.amount)) && (await this.finishInBackground(leg.hop, leg.to))) continue;
        // one whose history can't be told is offered for a look: into the private balance, or anywhere the owner picks
        stuck.push({ hop: leg.hop, lamports: BigInt(bal), to: leg.to, kind: by === null ? "finish" : "look" });
      }
      if (this.keys !== keys) return;
      if (stuck.length) this.set({ hops: [...stuck, ...this.s.hops.filter((h) => !stuck.some((x) => x.hop === h.hop))] });
      await this.finishJobs();
      if (Date.now() - this.hopScanAt > 15 * 60_000) {
        this.hopScanAt = Date.now();
        await this.scanHops();
      }
    } finally {
      this.hopping = false;
    }
  }
  private hopping = false;
  /** when each delivery was last looked at by pollHops (not saved) */
  private legLooked = new Map<string, number>();
  /** sending addresses whose history couldn't be told when last looked at (not saved): shown for a look, never finished on a guess */
  private hopUnread = new Set<string>();
  /** what was read of each sending address's history (by address and the pool spend that paid it; not saved): see readDelivery */
  private hopHistory = new Map<string, HopHistory>();
  /** the look at each one's history under way, so looks at one address take turns (and the later one finds what the first read) */
  private historyTurn = new Map<string, Promise<void>>();

  /** Finishes one delivery as background work (it waits its turn behind anything running), and says so once it is done. */
  private async finishInBackground(hop: string, to: string): Promise<string | null> {
    const task = this.bgBegin("send", "Finishing a delivery");
    if (!task) return null;
    try {
      const leg = this.legs().find((l) => l.hop === hop);
      const sig = await this.completeHop(hop, to, true);
      this.logDelivery({ kind: "send", text: leg ? `Delivered ${fmt(BigInt(leg.amount))} SOL to ${shortAddr(to)}` : `Delivered a payment to ${shortAddr(to)}`, sig, delivery: { hop, to } });
      this.set({ hops: this.s.hops.filter((h) => h.hop !== hop) });
      this.patchJobsByHop(hop, sig);
      this.bgEnd(task);
      this.bgSay({ notice: { title: "Delivered", text: `${leg ? `${fmt(BigInt(leg.amount))} SOL` : "The payment"} arrived at ${shortAddr(to)} as a standard SOL transfer.`, sig } });
      return sig;
    } catch {
      // tried again on a later look
      return null;
    } finally {
      this.bgEnd(task);
    }
  }

  /**
   * Scheduled payments whose pool payment landed and whose delivery is this app's to finish (the
   * relayer says so, or it has taken far longer than the relayer ever does). The relayer's own
   * transfer may still land first; either way the recipient is paid once.
   */
  private async finishJobs() {
    const now = Date.now();
    for (const j of this.s.jobs) {
      if (j.status === "delivering" && j.delivering == null) this.patchJobs(j.id, { delivering: now }, ["delivering"]);
    }
    for (const j of this.s.jobs.filter((x) => finishDue(x, now)).slice(0, 3)) {
      const req = j.request as RelayRequestBody | undefined;
      // a job from another device has no ledger here: its proof names its sending address
      if (req && !this.hopKeypair(req.recipient)) this.hopOf.set(BigInt("0x" + req.commitments[0]), req.recipient);
      // only this job's own sending addresses (the relayer's word alone never picks one)
      const hops = [...new Set([j.hop, ...this.legs().filter((l) => l.job === j.id).map((l) => l.hop)].filter((h): h is string => !!h && this.ownJobHop(j, h)))];
      for (const hop of hops) {
        const bal = await conn()
          .getBalance(new PublicKey(hop), "confirmed")
          .catch(() => null);
        if (bal === null) continue;
        const leg = this.legs().find((l) => l.hop === hop);
        // delivered when the sending address paid for its own transfer to the recipient (one never paid has none; dust sent to it since changes nothing)
        const by = await this.deliveredFrom(new PublicKey(hop), { tx1: leg?.tx1 ?? (hop === j.hop ? j.tx1 : undefined), to: j.to });
        if (by) {
          this.patchLeg(hop, { status: "delivered", tx2: by, done: Date.now() });
          this.patchJobs(j.id, { status: "sent", signature: by, error: null, note: null }, ["delivering", "waiting"]);
          this.logDelivery({ kind: "send", text: `Sent ${fmt(BigInt(j.amount))} SOL to ${this.nameWith(j.to, "scheduled")}`, sig: by, delivery: { hop, to: j.to } });
          break;
        }
        // its SOL went elsewhere first (moved into the private balance, or sent on, from this account): never delivered
        if (by === null && this.movedElsewhere(hop, leg?.tx1 ?? (hop === j.hop ? j.tx1 : undefined))) {
          this.patchJobs(j.id, { status: "failed", error: MOVED_ELSEWHERE, note: null }, ["delivering", "waiting"]);
          break;
        }
        // nothing there to pass on (or only dust a stranger sent)
        if (BigInt(bal) < (this.s.rent?.wallet ?? 0n) + DELIVERY_FEE) continue;
        // finished by itself only when its history shows no delivery and it holds what an undelivered payment does
        if (by !== null || !autoFinishable(BigInt(bal), BigInt(leg?.amount ?? j.amount))) continue;
        if (this.hopKeypair(hop) && (await this.finishInBackground(hop, j.to))) break;
      }
    }
  }

  /**
   * Finds this account's sending addresses that hold SOL, among those the relayer lists (a public
   * list of chain facts, downloaded whole, so it never learns which are this account's). Each spend's
   * change note names its sending address, so every one is found again from the notes alone, on any
   * device. One whose delivery never landed is to be finished; one delivered before that holds SOL
   * again got it back (an exchange returning a deposit, say).
   *
   * One scan at a time: a later one waits for the one under way, so a slower look never undoes what a
   * newer one found (the background look finishing after the owner's check, say). Resolves with how
   * many holding SOL couldn't be looked up and aren't shown (undefined when the scan was cut short).
   */
  scanHops(deep = false): Promise<number | undefined> {
    const run = this.scanTurn.then(() => this.scanHopsNow(deep));
    this.scanTurn = run.catch(() => {});
    return run;
  }
  private scanTurn: Promise<unknown> = Promise.resolve();

  private async scanHopsNow(deep: boolean): Promise<number | undefined> {
    const keys = this.keys;
    if (!keys) return;
    let open: { hop: string; lamports: string | null }[] = [];
    if (!deep) {
      try {
        open = (await api<{ hops: { hop: string; lamports: string | null }[] }>("/api/hops/open")).hops;
      } catch {
        return;
      }
    }
    // every own leaf's sending address, worked out once each (a moment apart now and then, so the page stays responsive)
    let n = 0;
    for (const leaf of this.ownLeaves.values()) {
      if (this.hopOf.has(leaf)) continue;
      this.hopOf.set(leaf, hopWallet(keys, leaf).publicKey.toBase58());
      if (++n % 200 === 0) {
        await sleep(0);
        if (this.keys !== keys) return;
      }
    }
    const mine = new Set(this.hopOf.values());
    const legs = this.legs();
    for (const l of legs) mine.add(l.hop);
    const fresh: { hop: string; lamports: bigint }[] = [];
    // less than this is dust a stranger sent, or rent coming home: never shown (see sortOpen), so never looked up or kept
    const rentMin = this.s.rent?.wallet ?? 0n;
    // ones a check of every address found holding SOL earlier: the relayer may list them no more
    const deepKey = `vs:hopdeep:${this.s.fingerprint}`;
    const saved = this.s.fingerprint ? ls.get<string[]>(deepKey, []) : [];
    const before = saved.filter((h) => mine.has(h));
    const emptied = new Set<string>();
    if (deep) {
      // every sending address of this account, read straight from the chain (the owner asked: see checkAllHops)
      const all = [...mine];
      const infos = await this.accounts(all.map((a) => new PublicKey(a)));
      if (this.keys !== keys) return;
      all.forEach((hop, i) => {
        const l = BigInt(infos[i]?.lamports ?? 0);
        if (worthShowing(l, rentMin)) fresh.push({ hop, lamports: l });
      });
    } else {
      const listed = new Set(open.map((o) => o.hop));
      const found = [...open.filter((o) => mine.has(o.hop)), ...before.filter((h) => !listed.has(h)).map((hop) => ({ hop, lamports: null }))];
      // what the relayer listed may be a day old: each is read again now
      for (const o of found.slice(0, 20)) {
        const l = await conn()
          .getBalance(new PublicKey(o.hop), "confirmed")
          .catch(() => null);
        if (l !== null && worthShowing(BigInt(l), rentMin)) fresh.push({ hop: o.hop, lamports: BigInt(l) });
        // one found earlier that holds nothing (or only dust) now needs no more looks
        else if (l !== null) emptied.add(o.hop);
      }
    }
    if (this.keys !== keys) return;
    // (one not worked out yet on this look stays as it was)
    // (read again just before: what another look kept meanwhile is built on, never undone)
    if (this.s.fingerprint) ls.set(deepKey, keptFound(ls.get<string[]>(deepKey, []), mine, deep, fresh.map((o) => o.hop), emptied));
    // one this device has no record of: its own delivery, as the relayer remembers it (asked with the address's signature)
    const known = new Map<string, { delivered: boolean; to: string | null }>();
    // ones whose lookup failed: never taken as delivered (or not) on that alone; they keep what was shown for them
    const unsure = new Set<string>();
    let asked = 0;
    for (const o of fresh) {
      if (legs.some((l) => l.hop === o.hop)) continue;
      const kp = this.hopKeypair(o.hop);
      if (!kp) continue;
      // paced under the relayer's limit (see LOOKUP_GAP_MS)
      const wait = lookupWait(asked++);
      if (wait) {
        await sleep(wait);
        if (this.keys !== keys) return;
      }
      const r = await this.lookupHop(kp);
      if (!r) {
        unsure.add(o.hop);
        continue;
      }
      // the recipient only when this account's own signature at the hop covers it: one it doesn't is never
      // sent anything, and the SOL is offered back instead (into the private balance, or anywhere the owner picks)
      const to = trustedRecipient(kp.publicKey, r);
      // (one whose SOL this account moved elsewhere before it went is never finished either: what is there now came back)
      known.set(o.hop, { delivered: r.status === "delivered" || r.status === "withdrawn" || r.status === "unknown" || !to, to });
    }
    if (this.keys !== keys) return;
    const views = sortOpen(
      fresh.filter((o) => !unsure.has(o.hop)),
      legs,
      known,
      this.s.rent?.pending ?? 0n,
      this.s.rent?.wallet ?? 0n,
      this.hopUnread,
    );
    const kept = this.s.hops.filter((h) => unsure.has(h.hop));
    this.set({ hops: [...views, ...kept] });
    return unsure.size - kept.length;
  }

  /** What the relayer remembers of one sending address (null when it couldn't say): asked once more after its limit's wait. */
  private async lookupHop(kp: Keypair): Promise<HopLookup | null> {
    for (let i = 0; ; i++) {
      try {
        return await api<HopLookup>("/api/hops/lookup", { json: lookupBody(kp, Date.now()) });
      } catch (e) {
        if (i || !(e instanceof ApiError) || e.status !== 429) return null;
        await sleep(Math.min(60, Math.max(5, e.retryAfter ?? 20)) * 1000);
      }
    }
  }

  /**
   * Reads every one of this account's sending addresses straight from the chain, when the owner asks:
   * finds SOL that came back to one long after its delivery (an exchange's late refund), or a delivery
   * left unfinished for months, once the relayer's list has let it go. The site's RPC sees these
   * addresses asked about together, so this never runs by itself. Answers how many hold SOL, and how
   * many more couldn't be looked up just now (the relayer busy or out of reach): never "none" for those.
   */
  async checkAllHops(): Promise<{ found: number; unread: number }> {
    const keys = this.keys;
    if (!keys) throw new Error("Unlock your account first.");
    // each sending address is worked out from a note: every note must have been read first (a new device may still be reading them)
    await this.sync();
    if (this.keys !== keys) throw new Error("Unlock your account first.");
    if (!notesRead({ scannedFor: this.scannedFor, keys, scannedTo: this.scannedTo, leafCount: this.leafCount, total: this.s.total })) {
      throw new Error("Still reading your notes. Try again in a moment.");
    }
    const unread = await this.scanHops(true);
    if (unread === undefined) throw new Error("Couldn't read them just now. Try again in a minute.");
    return { found: this.s.hops.length, unread };
  }

  /** "Finish now" on a delivery: everything at its sending address goes to its recipient as a standard transfer. */
  async finishHop(hop: string) {
    if (this.s.busy) return;
    try {
      const v = this.s.hops.find((h) => h.hop === hop);
      if (!v?.to) throw new Error("This delivery's recipient isn't known on this device. Use “Send it somewhere else” instead.");
      this.step("send", "Delivering to the recipient", "A standard SOL transfer from a one-time sending address.");
      const leg = this.legs().find((l) => l.hop === hop);
      const sig = await this.completeHop(hop, v.to);
      this.logDelivery({ kind: "send", text: `Delivered ${fmt(leg ? BigInt(leg.amount) : v.lamports - DELIVERY_FEE)} SOL to ${shortAddr(v.to)}`, sig, delivery: { hop, to: v.to } });
      this.set({ hops: this.s.hops.filter((h) => h.hop !== hop) });
      this.patchJobsByHop(hop, sig);
      this.done("Delivered", `The payment arrived at ${shortAddr(v.to)} as a standard SOL transfer.`, sig);
    } catch (e) {
      // its history couldn't be told (before anything was sent): offered for a look, so the SOL is never out of reach
      if ((e as Error)?.message === HISTORY_UNREAD) {
        this.hopUnread.add(hop);
        this.set({ hops: this.s.hops.map((h) => (h.hop === hop && h.kind === "finish" ? { ...h, kind: "look" as const } : h)) });
      }
      this.fail(e);
    }
  }

  /** A scheduled payment delivered from here: sent, with its delivery as its Transaction ID. */
  private patchJobsByHop(hop: string, sig: string) {
    const j = this.s.jobs.find((x) => x.hop === hop || this.legs().some((l) => l.hop === hop && l.job === x.id));
    if (j) this.patchJobs(j.id, { status: "sent", signature: sig, error: null, note: null }, ["delivering", "waiting", "sending"]);
  }

  /** SOL that came back to a sending address, sent on to `to` (any address: a wallet, or the exchange again) in a standard transfer. */
  async sendHopOnward(hop: string, to: string) {
    if (this.s.busy) return;
    try {
      let dest: PublicKey;
      try {
        dest = new PublicKey(to.trim());
      } catch {
        throw new Error("That doesn't look like a Solana address.");
      }
      const why = recipientProblem(dest.toBase58(), this.reservedHere(), new Set(this.legs().map((l) => l.hop)));
      if (why) throw new Error(why);
      const kp = this.hopKeypair(hop);
      if (!kp) throw new Error("This sending address isn't one this account can open.");
      this.step("send", "Checking the recipient");
      // what is at the address (a token account or a program can't take SOL this way), and the sanctions list:
      // nothing checks this transfer again, so no answer means no transfer. The address was typed here on purpose.
      await this.checkRecipients([{ to: dest.toBase58(), amount: 0n, offCurveOk: true, lookalikeOk: true }], false, true);
      this.step("send", "Sending it on", "A standard SOL transfer from the sending address.");
      const before = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
      const sig = await this.sendFromHop(kp, dest);
      await this.afterMoveOut(hop, null, { sig, to: dest.toBase58() });
      const amount = before - DELIVERY_FEE;
      this.log({ kind: "send", text: `Sent ${fmt(amount)} SOL that came back to a sending address on to ${shortAddr(dest.toBase58())}`, sig, delivery: { hop, to: dest.toBase58(), onward: true } });
      this.set({ hops: this.s.hops.filter((h) => h.hop !== hop) });
      this.done("Sent", `${fmt(amount)} SOL arrived at ${shortAddr(dest.toBase58())} as a standard SOL transfer.`, sig);
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * SOL that came back to a sending address goes into the private balance: the sending address
   * deposits it like a deposit address does (screened, then through the waiting room).
   */
  async returnToPool(hop: string) {
    if (this.s.busy) return;
    try {
      this.step("shield", "Moving the SOL into the pool");
      await this.loadPool();
      const { pool } = this.need();
      const kp = this.hopKeypair(hop);
      if (!kp) throw new Error("This sending address isn't one this account can open.");
      if (pool.depositsPaused) throw new Error("Deposits are paused right now. The SOL is safe at the sending address.");
      const rent = await this.rentNow();
      const txFee = this.depositTxFee();
      const max = BigInt(pool.maxDeposit);
      const have = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
      const parts = depositParts(have, { rentPending: rent.pending, txFee, feeBps: this.depositFeeBps(), min: BigInt(pool.minDeposit), max });
      if (!parts.length) throw new Error(`It holds ${fmt(have, 6)} SOL, too little for a deposit. Use “Send it somewhere else” instead.`);
      const att = pool.requireAttestation ? await this.attestation(kp.publicKey) : undefined;
      this.step("shield", "Moving the SOL into the pool", "Screening where it came from, then into the waiting room.");
      let total = 0n;
      let sig = "";
      for (let k = 0; k < parts.length; k++) {
        if (parts.length > 1) this.step("shield", `Deposit ${k + 1} of ${parts.length}`, "The pool takes at most a set amount per deposit, so this goes in parts.");
        let amount = parts[k];
        let dust = 0n;
        if (k === parts.length - 1) {
          // the last part from what is really there now, so the address ends at zero (a sliver rides along)
          const budget = BigInt(await conn().getBalance(kp.publicKey, "confirmed")) - rent.pending - txFee;
          amount = this.maxDepositFor(budget);
          if (amount > max) amount = max;
          dust = budget - amount - this.depositFee(amount);
          if (dust >= rent.wallet) dust = 0n;
        }
        const { ixs } = await this.depositIxs(kp.publicKey, amount, k === 0 ? att : undefined);
        if (dust > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ixs[ixs.length - 1].keys[4].pubkey, lamports: dust }));
        const tx = new Transaction().add(...ixs);
        tx.feePayer = kp.publicKey;
        tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
        tx.sign(kp);
        sig = await sendAndConfirm(tx, "deposit");
        total += amount;
        this.log({ kind: "shield", text: `Shielded ${fmt(amount)} SOL that came back to a sending address`, sig });
      }
      // one found by the scan (paid on another device) gets an entry here too, so its waiting-room deposit is known as this account's
      if (!this.legs().some((l) => l.hop === hop)) {
        const leaf = [...this.hopOf].find(([, a]) => a === hop)?.[0];
        if (leaf !== undefined) {
          const to = this.s.hops.find((h) => h.hop === hop)?.to ?? "";
          this.saveLeg({ hop, out0: leaf.toString(16).padStart(64, "0"), to, amount: "0", status: "returned", at: Date.now(), done: Date.now() });
        }
      }
      await this.afterMoveOut(hop, "returned");
      this.set({ hops: this.s.hops.filter((h) => h.hop !== hop) });
      this.step("shield", "Into the waiting room");
      await this.refreshWaiting();
      this.done("Moved into the pool", `${fmt(total)} SOL is in the waiting room. It joins your private balance in about ${this.waitLabel()}.`, sig);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) this.fail(new Error("This SOL can't go into the pool: where it came from doesn't pass screening. It stays at the sending address; you can send it somewhere else."));
      this.fail(e);
    }
  }

  /**
   * After this app moved SOL out of a sending address (into the private balance, or on to an address the
   * owner picked): a delivery still open there is settled from the address's history, as the relayer
   * settles it. Its first own transfer paid the recipient: delivered (what was moved came back after it).
   * This move paying the recipient (`move`: sent on to the delivery's own recipient) delivered it, with
   * this move as its Transaction ID, even before the history lists it. It paid elsewhere first (the
   * history shows it): never delivered, and its scheduled payment ends "not delivered", so a later
   * word from the relayer can't call it sent, nor give this move as its Transaction ID. A history that
   * can't be read now, or doesn't list the move yet, leaves the payment for its next look (finishJobs,
   * pollJobs), never "not delivered" on a guess. The leg ends `legAfter` ("returned" for SOL gone into
   * the pool), or else no longer open either way.
   */
  private async afterMoveOut(hop: string, legAfter: "returned" | null, move?: { sig: string; to: string }) {
    const leg = this.legs().find((l) => l.hop === hop);
    const job = this.s.jobs.find((j) => isOpen(j.status) && (j.hop === hop || (!!leg?.job && leg.job === j.id)));
    const open = !!leg && leg.status !== "delivered" && leg.status !== "returned";
    let delivered: string | null = null;
    if (open || job) {
      const tx1 = leg?.tx1 ?? (job?.hop === hop ? job.tx1 : undefined);
      const recipient = job?.to ?? leg?.to;
      const by = await this.deliveredFrom(new PublicKey(hop), { tx1, to: recipient }).catch(() => undefined);
      const v = moveOutVerdict({ by, move, recipient, elsewhere: this.movedElsewhere(hop, tx1) });
      if (v && "delivered" in v) {
        delivered = v.delivered;
        if (open) this.patchLeg(hop, { status: "delivered", tx2: delivered, done: Date.now() });
        if (job) {
          this.patchJobs(job.id, { status: "sent", signature: delivered, error: null, note: null }, ["delivering", "waiting"]);
          // delivered by this very move: its own line (sendHopOnward's) says so, only the payment's line gets the ID
          if (delivered === move?.sig) this.fillDeliveryId(hop, delivered);
          else this.logDelivery({ kind: "send", text: `Sent ${fmt(BigInt(job.amount))} SOL to ${this.nameWith(job.to, "scheduled")}`, sig: delivered, delivery: { hop, to: job.to } });
        }
      } else if (v && job) this.patchJobs(job.id, { status: "failed", error: MOVED_ELSEWHERE, note: null }, ["delivering", "waiting"]);
    }
    if (legAfter) this.patchLeg(hop, { status: legAfter, done: Date.now() });
    else if (open && !delivered) this.patchLeg(hop, { status: "returned", done: Date.now() });
  }

  /**
   * Whether a sending address's history, as deliveredFrom last read it (with the same `tx1`), shows a
   * transaction it paid for itself: when deliveredFrom found no delivery, that one paid elsewhere first.
   */
  private movedElsewhere(hop: string, tx1?: string): boolean {
    const t = tx1 ?? this.legs().find((l) => l.hop === hop)?.tx1;
    return !!this.hopHistory.get(`${hop}|${t ?? ""}`)?.first;
  }

  /**
   * A message signed by a payment's sending address, for an exchange that asks the sender of a
   * deposit to show it controls that address. Returns the signature (base58).
   */
  signFromSender(hop: string, text: string): string {
    const kp = this.hopKeypair(hop);
    if (!kp) throw new Error("This sending address isn't one this account can open on this device.");
    if (!text.trim()) throw new Error("Paste the message the exchange gave you first.");
    return signText(kp, text);
  }

  /**
   * The owner's delivery check (/app#delivery-check): one small private payment to `to`, delivered
   * in the chosen shape only (L1 on a blockhash, or N2 on a durable nonce), to confirm an exchange
   * credits it. This page never finishes it itself (that would be an L1), and the shape that landed
   * is read back from the chain (`went`: null while the delivery hasn't been seen landing). Returns
   * the delivery's Transaction ID ("" until then) and the pool spend's.
   */
  async deliveryCheck(to: string, amount: bigint, shape: "l1" | "n2"): Promise<(Paid & { went: "l1" | "n2" | null }) | undefined> {
    try {
      this.set({ ask: null });
      this.step("send", "Checking the pool");
      this.deliveryGate();
      const dest = new PublicKey(to.trim());
      if (this.ownKeypairFor(dest.toBase58())) throw new Error("That is one of this account's own wallets. Paste an exchange's deposit address.");
      await this.checkRecipients([{ to: dest.toBase58(), amount, offCurveOk: true, lookalikeOk: true }], false);
      await this.readTreasury();
      const q = this.quotePay(amount);
      const paid = await this.withInputs("send", q.withdraw, (inputs) =>
        this.proveAndPayout("send", inputs, { kind: "pay", to: dest, amount, mode: "instant", only: shape, offCurveOk: true }, q.withdraw, q.relayerFee),
      );
      const went = paid.sig ? await this.deliveryShape(paid.sig) : null;
      const label = `${fmt(amount)} SOL to ${shortAddr(dest.toBase58())}`;
      this.logSent({ kind: "send", text: `Delivery check (${shape.toUpperCase()}): ${label}`, ...(paid.sig ? { sig: paid.sig } : {}), ...(paid.hop ? { delivery: { hop: paid.hop, to: dest.toBase58() } } : {}) });
      if (!paid.sig) {
        this.done("Check sent", `The pool paid the sending address. Its ${shape.toUpperCase()} delivery of ${label} hasn't been seen landing yet: look at your activity in a minute. If it doesn't go, the app finishes it as L1 later, so run the ${shape.toUpperCase()} check again.`);
      } else if (went && went !== shape) {
        this.done("Check sent", `${label} arrived as ${went.toUpperCase()}. Run the check again for ${shape.toUpperCase()}.`, paid.sig);
      } else {
        this.done("Check sent", `${label} arrived as ${shape.toUpperCase()}. See whether the exchange credits it.`, paid.sig);
      }
      return { ...paid, went };
    } catch (e) {
      this.fail(e);
    }
  }

  /** The shape a delivery landed in, read from the chain: N2 carries two signatures (the hop's and the nonce authority's), L1 one. */
  private async deliveryShape(sig: string): Promise<"l1" | "n2" | null> {
    const t = await conn()
      .getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" })
      .catch(() => null);
    return t ? (t.transaction.signatures.length === 2 ? "n2" : "l1") : null;
  }

  // ─── actions ───
  private need() {
    if (!this.keys || !this.s.pool) throw new Error("Unlock your private account first.");
    return { keys: this.keys, pool: this.s.pool };
  }

  private step(kind: Activity["kind"], step: string, detail?: string) {
    // background work only updates its status line: what the person is reading stays put
    if (this.bgTask) this.set({ busy: { kind, step, detail, bg: true, ...(this.spot && this.spot.t === this.bgTask ? { spot: this.spot.spot } : {}) } });
    else this.set({ busy: { kind, step, detail }, error: null, notice: null });
    this.wake();
  }

  /** Ends an action with a plain-language confirmation; `wallets` offers the way to the Wallets tab with it. */
  private done(title: string, text: string, sig?: string, wallets = false) {
    if (this.spotEnd({ ok: true, title, text, sig })) return this.wake();
    const notice = { title, text, sig, ...(wallets ? { wallets } : {}) };
    if (this.bgTask) {
      this.bgTask = null;
      this.set({ busy: null });
      this.bgSay({ notice });
    } else this.set({ busy: null, notice });
    this.wake();
  }

  // ─── Wallets-tab actions: background work, one at a time, results where they were started ───
  /** The Wallets-tab action holding the lock (its spot, and its background-task token). */
  private spot: { spot: string; t: object } | null = null;
  private spotRuns = new Map<number, () => Promise<unknown>>();
  private spotSeq = 0;
  private saidTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Runs an action started from the Wallets tab as background work (no cover over the card), or
   * lines it up to run as soon as whatever is running ends: never a button that silently does
   * nothing. `run` calls one of the engine's actions; its confirmation or error is kept for `spot`
   * (see Said) instead of the banner, so nothing above the list moves. One per spot at a time:
   * false when that spot already has one running or waiting.
   */
  queueSpot(spot: string, step: string, run: () => Promise<unknown>): boolean {
    if (!this.keys || this.s.spots.some((j) => j.spot === spot)) return false;
    const id = ++this.spotSeq;
    this.spotRuns.set(id, run);
    const said = { ...this.s.said };
    delete said[spot];
    this.set({ spots: [...this.s.spots, { id, spot, step, running: false }], said, lastSaid: this.s.lastSaid === spot ? null : this.s.lastSaid });
    this.nextSpot();
    return true;
  }

  /** Takes an action out of the line before it starts ("Cancel" beside "Next in line"). */
  cancelSpot(id: number) {
    const j = this.s.spots.find((x) => x.id === id);
    if (!j || j.running) return;
    this.spotRuns.delete(id);
    this.set({ spots: this.s.spots.filter((x) => x.id !== id) });
  }

  /** Forgets a Wallets-tab result (its row's "×", or the dock's). */
  clearSaid(spot: string) {
    const said = { ...this.s.said };
    delete said[spot];
    this.set({ said, lastSaid: this.s.lastSaid === spot ? null : this.s.lastSaid });
  }

  /** Stops the dock repeating a Wallets-tab result (the row keeps it). */
  hideSaid() {
    if (this.s.lastSaid) this.set({ lastSaid: null });
  }

  /** The next Wallets-tab action in line, once nothing else holds the lock. */
  private nextSpot() {
    if (this.s.busy || !this.keys) return;
    const job = this.s.spots.find((j) => !j.running);
    if (!job) return;
    const run = this.spotRuns.get(job.id);
    this.spotRuns.delete(job.id);
    const keys = this.keys;
    const t = {};
    this.bgTask = t;
    this.spot = { spot: job.spot, t };
    this.set({ spots: this.s.spots.map((j) => (j.id === job.id ? { ...j, running: true } : j)), busy: { kind: "sweep", step: job.step, bg: true, spot: job.spot } });
    this.wake();
    let p: Promise<unknown>;
    try {
      p = run ? run() : Promise.resolve();
    } catch (e) {
      p = Promise.reject(e);
    }
    void p
      .catch(() => {})
      .finally(() => {
        // one that ended without a word still lets go of the lock
        if (this.spot?.t === t) this.spot = null;
        if (this.bgTask === t) {
          this.bgTask = null;
          this.set({ busy: null });
        }
        if (this.keys === keys) this.set({ spots: this.s.spots.filter((j) => j.id !== job.id) });
        this.nextSpot();
      });
  }

  /** Ends the running Wallets-tab action with `said` kept for its spot; false when none is running. */
  private spotEnd(said: Omit<Said, "at">): boolean {
    const sp = this.spot;
    if (!sp || this.bgTask !== sp.t) return false;
    this.spot = null;
    this.bgTask = null;
    this.set({ busy: null, said: { ...this.s.said, [sp.spot]: { ...said, at: Date.now() } }, lastSaid: sp.spot });
    // the dock repeats it for a few seconds only: the row keeps it
    if (this.saidTimer) clearTimeout(this.saidTimer);
    this.saidTimer = setTimeout(() => {
      if (this.s.lastSaid === sp.spot) this.set({ lastSaid: null });
    }, 8000);
    return true;
  }

  // ─── batches: one action across several Vision wallets, one wallet at a time (see batch.ts) ───
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private resolving = false;
  /** "Continue" pressed while a look at the chain was under way: acted on once it ends */
  private goAfter = false;
  private resolveTimer: ReturnType<typeof setTimeout> | null = null;
  /** This tab, for the batch's lease: only the tab holding it runs the batch (see batchAway). */
  private readonly tab = `${Date.now().toString(36)}${randInt(0, 1_000_000).toString(36)}`;
  private beat: ReturnType<typeof setInterval> | null = null;
  private awayTimer: ReturnType<typeof setTimeout> | null = null;
  private storageHooked = false;
  /** Lets go of this tab's run lock (see takeRunLock); null while this tab doesn't hold it. */
  private holding: (() => void) | null = null;
  /** Another tab holds the run lock (last looked up by watchAway / takeRunLock). */
  private lockElsewhere = false;

  private batchKey() {
    return `vs:batch:${this.s.fingerprint}`;
  }

  private leaseKey() {
    return `vs:batchtab:${this.s.fingerprint}`;
  }

  /** Kept on this device as it changes, so a reload knows where every wallet got to. */
  private saveBatch(b: Batch | null) {
    if (this.s.fingerprint) ls.set(this.batchKey(), b);
    this.set({ batch: b });
    this.lease(!!b && !b.paused && !batchFinished(b));
  }

  /**
   * While this tab runs the batch it renews a lease beside it every few seconds; another tab of the
   * same browser sees it and leaves the batch alone, so no wallet is ever paid or bought for twice.
   */
  private lease(on: boolean) {
    const fp = this.s.fingerprint;
    if (on && fp && this.keys) {
      ls.set(this.leaseKey(), { tab: this.tab, at: Date.now() });
      if (!this.beat) {
        this.beat = setInterval(() => {
          const b = this.s.batch;
          this.lease(!!b && !b.paused && !batchFinished(b));
        }, 5_000);
      }
      return;
    }
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    this.dropRunLock();
    if (fp && ls.get<{ tab: string } | null>(this.leaseKey(), null)?.tab === this.tab) ls.set(this.leaseKey(), null);
  }

  /**
   * The run lock: the browser's own lock between tabs, held by the tab running the batch until it lets
   * go or goes away. Unlike the lease it doesn't depend on timers, which browsers slow down in hidden
   * tabs, so a second tab can never take the batch over while the first still runs it. False when
   * another tab holds it. (A browser without tab locks relies on the lease alone.)
   */
  private takeRunLock(): Promise<boolean> {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const fp = this.s.fingerprint;
    if (this.holding || !locks || !fp) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      locks
        .request(`vs:batchrun:${fp}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            this.lockElsewhere = true;
            resolve(false);
            return;
          }
          this.lockElsewhere = false;
          resolve(true);
          return new Promise<void>((release) => (this.holding = release));
        })
        .catch(() => resolve(true));
    });
  }

  private dropRunLock() {
    this.holding?.();
    this.holding = null;
  }

  /** Whether another tab holds the run lock right now. */
  private async lookElsewhere() {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const fp = this.s.fingerprint;
    if (!locks || !fp || this.holding) return void (this.lockElsewhere = false);
    const q = await locks.query().catch(() => null);
    this.lockElsewhere = !!q?.held?.some((l) => l.name === `vs:batchrun:${fp}`);
  }

  /** Another tab of this browser is running this account's batch: it holds the run lock, or renewed its lease in the last 20 s. */
  private batchAway(): boolean {
    if (!this.s.fingerprint) return false;
    if (this.lockElsewhere) return true;
    const l = ls.get<{ tab: string; at: number } | null>(this.leaseKey(), null);
    return !!l && l.tab !== this.tab && Date.now() - l.at < 20_000;
  }

  /**
   * While another tab runs the batch, this one shows its progress and touches nothing. Once that tab
   * lets go (it finished, was locked or closed), this one reads the batch back like after a reload.
   */
  private watchAway(changed = false) {
    if (this.awayTimer) clearTimeout(this.awayTimer);
    this.awayTimer = null;
    if (!this.keys || !this.s.fingerprint) return;
    const keys = this.keys;
    void this.lookElsewhere().then(() => this.keys === keys && this.showAway(changed));
  }

  private showAway(changed: boolean) {
    if (!this.keys || !this.s.fingerprint) return;
    if (this.batchAway()) {
      this.set({ batch: ls.get<Batch | null>(this.batchKey(), null), batchAway: true });
      const keys = this.keys;
      this.awayTimer = setTimeout(() => this.keys === keys && this.watchAway(), 10_000);
    } else if (this.s.batchAway || (changed && !this.beat)) this.loadBatch();
  }

  private loadBatch() {
    if (!this.storageHooked && typeof window !== "undefined") {
      this.storageHooked = true;
      window.addEventListener("storage", (e) => {
        if (this.keys && this.s.fingerprint && (e.key === this.batchKey() || e.key === this.leaseKey())) this.watchAway(e.key === this.batchKey());
      });
      // a reload or a closed tab lets go at once, so the page that comes back offers "Continue" straight away
      window.addEventListener("pagehide", () => this.lease(false));
      window.addEventListener("pageshow", (e) => {
        const b = this.s.batch;
        if (e.persisted && b && !this.s.batchAway && !this.batchAway()) this.lease(!b.paused && !batchFinished(b));
      });
    }
    if (this.batchAway()) return this.watchAway();
    const b = this.s.fingerprint ? ls.get<Batch | null>(this.batchKey(), null) : null;
    this.set({ batch: b ? onLoad(b) : null, batchAway: false });
    if (b?.items.some((x) => x.status === "running")) void this.resolveBatch();
  }

  /**
   * Starts a batch (only when none is unfinished; false otherwise). Its first wallet goes at once,
   * each one after as background work, with the batch's gap in between; one that doesn't go through
   * never stops the rest.
   */
  startBatch(b: Omit<Batch, "id" | "nextAt" | "paused" | "created">): boolean {
    if (!this.keys || (this.s.batch && !batchFinished(this.s.batch)) || this.batchAway()) return false;
    if (b.items.length < BATCH_MIN || b.items.length > BATCH_MAX) return false;
    const now = Date.now();
    this.saveBatch({ ...b, id: `${now.toString(36)}${randInt(0, 1_000_000).toString(36)}`, nextAt: now, paused: false, created: now });
    this.runBatch();
    return true;
  }

  /**
   * Runs `act` only while this tab holds the run lock, on the batch as last saved (another tab may have
   * moved it on); without the lock this tab just shows the other one's progress.
   */
  private async withRunLock(act: () => void) {
    const keys = this.keys;
    if (!(await this.takeRunLock())) return void this.watchAway();
    if (this.keys !== keys || !this.s.fingerprint) return;
    const stored = ls.get<Batch | null>(this.batchKey(), null);
    if (JSON.stringify(stored) !== JSON.stringify(this.s.batch)) this.set({ batch: stored ? onLoad(stored) : null, batchAway: false });
    act();
    // still paused or finished: nothing to run, so the lock goes back
    const b = this.s.batch;
    if (!b || b.paused || batchFinished(b)) this.dropRunLock();
  }

  /** "Stop the rest": the wallets that haven't had their turn keep what they hold; one running finishes. */
  stopBatch() {
    void this.withRunLock(() => this.stopNow());
  }

  private stopNow() {
    const b = this.s.batch;
    if (!b || this.s.batchAway || this.batchAway()) return;
    const j = this.s.spots.find((x) => x.spot === "batch" && !x.running);
    if (j) this.cancelSpot(j.id);
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    this.saveBatch(stopRest(b));
    // a wallet left mid-way by a reload is still being looked up: that goes on until it's known
    if (b.items.some((x) => x.status === "running") && !this.s.spots.some((x) => x.spot === "batch")) void this.resolveBatch();
  }

  /** "Continue" after a reload or an unlock: where the running wallet got to is looked up first. */
  continueBatch() {
    void this.withRunLock(() => this.continueNow());
  }

  private continueNow() {
    const b = this.s.batch;
    if (!b || !b.paused || this.s.batchAway || this.batchAway()) return;
    if (b.items.some((x) => x.status === "running")) return void this.resolveBatch(true);
    this.saveBatch({ ...b, paused: false, nextAt: Date.now() });
    this.runBatch();
  }

  /** "Try those again": the wallets that didn't go through (or were stopped) get another turn. */
  retryBatch() {
    void this.withRunLock(() => this.retryNow());
  }

  private retryNow() {
    const b = this.s.batch;
    if (!b || !batchFinished(b) || this.s.batchAway || this.batchAway()) return;
    this.saveBatch(retryFailed(b, Date.now()));
    this.runBatch();
  }

  /** Puts a finished batch away. */
  dismissBatch() {
    if (this.s.batch && batchFinished(this.s.batch) && !this.s.batchAway) this.saveBatch(null);
  }

  /** Where an item left running (the page went away mid-way) got to, from the chain, before anything runs again. */
  private async resolveBatch(go = false) {
    if (go) this.goAfter = true;
    if (this.resolving) return;
    // the tab running the batch holds the lock: what it is doing is not this tab's to look up
    if (!(await this.takeRunLock())) return void this.watchAway();
    if (this.resolveTimer) clearTimeout(this.resolveTimer);
    this.resolveTimer = null;
    this.resolving = true;
    const keys = this.keys;
    try {
      const b0 = this.s.batch;
      if (!b0) return;
      for (let k = 0; k < b0.items.length; k++) {
        const x = b0.items[k];
        if (x.status !== "running") continue;
        let f: Facts | null = null;
        if (x.index != null) f = await this.batchFacts(b0, x.index).catch(() => null);
        const cur = this.s.batch;
        if (this.keys !== keys || !cur || cur.id !== b0.id) return;
        this.saveBatch(setItem(cur, k, resolveRunning(cur, cur.items[k], f)));
      }
    } finally {
      this.resolving = false;
    }
    if (this.keys !== keys) return;
    // the chain couldn't be read just now: looked at again in a moment (nothing runs meanwhile), stopped or not
    if (this.s.batch?.items.some((x) => x.status === "running") && !this.s.spots.some((j) => j.spot === "batch")) {
      this.resolveTimer = setTimeout(() => this.keys === keys && void this.resolveBatch(), 15_000);
      return;
    }
    const goNow = this.goAfter;
    this.goAfter = false;
    if (goNow) this.continueNow();
    const b = this.s.batch;
    if (!b || b.paused || batchFinished(b)) this.dropRunLock();
  }

  private async batchFacts(b: Batch, index: number): Promise<Facts> {
    const owner = this.visionKeypair(index).publicKey;
    const [lamports, held] = await Promise.all([
      conn().getBalance(owner, "confirmed").then(BigInt),
      // (a token the chain doesn't know at all is held by nobody)
      b.mint ? this.tokenHeld(owner, b.mint).then((h) => h.raw, (e) => (/could not find mint|invalid mint/i.test((e as Error)?.message ?? "") ? 0n : Promise.reject(e))) : Promise.resolve(0n),
      this.refreshWaiting().catch(() => {}),
    ]);
    return { intent: !!this.buyIntent(index), held, lamports, sweepMin: this.sweepMin(), waiting: this.waitingFrom(owner.toBase58()) > 0 };
  }

  /** The step shown while a wallet's turn waits in line: "Buying BONK in Vision wallet #3". */
  private batchStep(b: Batch, k: number): string {
    const x = b.items[k];
    const w = x.index != null ? walletName(x.index) : "a new Vision wallet";
    return b.kind === "sell"
      ? `Selling ${b.symbol ?? "the token"} from ${w}`
      : b.kind === "move"
        ? `Moving ${w} back to your private balance`
        : b.kind === "send"
          ? `Sending from ${w}`
          : `Buying ${b.symbol ?? "the token"} in ${w}`;
  }

  /** The batch's next wallet: its turn comes at nextAt, as background work, once nothing else runs. */
  private runBatch() {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = null;
    const b = this.s.batch;
    if (!b || b.paused || b.stopped || !this.keys || b.items.some((x) => x.status === "running")) return;
    // already in line behind another action
    if (this.s.spots.some((j) => j.spot === "batch" && !j.running)) return;
    if (nextWaiting(b) < 0) return;
    const id = b.id;
    this.batchTimer = setTimeout(
      () => {
        this.batchTimer = null;
        const cur = this.s.batch;
        if (!cur || cur.id !== id || cur.paused || cur.stopped) return;
        const k = nextWaiting(cur);
        if (k < 0) return;
        // (the last wallet's turn may still be letting go of the lock: a moment later)
        if (!this.queueSpot("batch", this.batchStep(cur, k), () => this.runBatchItem(id))) this.batchTimer = setTimeout(() => this.runBatch(), 2000);
      },
      Math.max(0, b.nextAt - Date.now()),
    );
  }

  /** One wallet's turn, under the lock as background work; its outcome is kept on its item, never in the banner. */
  private async runBatchItem(id: string) {
    const keys = this.keys;
    const b = this.s.batch;
    if (!b || b.id !== id || b.paused || b.stopped) return;
    const k = nextWaiting(b);
    if (k < 0) return;
    // another tab took the batch, or this wallet's turn, meanwhile: this one only shows it
    if (this.batchAway() || !(await this.takeRunLock())) return void this.watchAway();
    const stored = ls.get<Batch | null>(this.batchKey(), null);
    if (stored && (stored.id !== id || stored.items[k]?.status !== "waiting")) {
      // (read back as after a reload: it waits for "Continue")
      this.lease(false);
      return void this.loadBatch();
    }
    const x = b.items[k];
    // a sale sells only what is still owed of its share: what the wallet held before its first try, less what it holds now
    let before = x.before;
    let owed: bigint | undefined;
    if (b.kind === "sell" && x.index != null && b.mint) {
      // its last try's swap first: landed means its share is sold; still unknown means wait for it
      if (x.sig && x.lvh != null) {
        const state = await signatureState(x.sig, x.lvh).catch(() => "unknown" as const);
        if (state === "landed") return this.batchEnd(id, k, keys, x.sig, null);
        if (state === "unknown") return this.batchEnd(id, k, keys, undefined, "Its last sale may still go through. Nothing more was sold: try again in a minute.");
      }
      const kept = this.s.vision.find((v) => v.index === x.index)?.tokens.find((t) => t.mint === b.mint)?.amount;
      const held = await this.tokenHeld(this.visionKeypair(x.index).publicKey, b.mint).then(
        (h) => h.raw,
        () => kept,
      );
      if (held == null) return this.batchEnd(id, k, keys, undefined, "Couldn't look at the wallet just now. Nothing was sold.");
      before ??= held.toString();
      // (more held than before, from a buy meanwhile, never raises its share)
      const gone = BigInt(before) > held ? BigInt(before) - held : 0n;
      const left = BigInt(x.amount) - gone;
      if (left <= 0n) return this.batchEnd(id, k, keys, x.sig, null);
      owed = left < held ? left : held;
      if (owed <= 0n) return this.batchEnd(id, k, keys, undefined, "The wallet no longer holds this token. Nothing was sold.");
    }
    // (stopped, or put away, while that was looked up)
    const now = this.s.batch;
    if (this.keys !== keys || !now || now.id !== id || now.stopped || now.items[k].status !== "waiting") return;
    this.saveBatch(setItem(now, k, { status: "running", before, error: undefined }));
    let sig: string | undefined;
    let err: string | null = null;
    try {
      sig = (await this.batchAct(id, k, owed)) || undefined;
    } catch (e) {
      err = (e as Error)?.message || "Something went wrong.";
    }
    this.batchEnd(id, k, keys, sig, err);
  }

  /** Records how a wallet's turn ended and sets up the next one after the gap (a busy server: a little later, the same wallet). */
  private batchEnd(id: string, k: number, keys: Keys | null, sig: string | undefined, err: string | null) {
    // its result was kept for the batch's spot: the card says it per wallet instead
    if (this.s.said.batch) this.clearSaid("batch");
    // locked meanwhile: the item stays as it was saved, and is looked up after the next unlock
    const cur = this.s.batch;
    if (this.keys !== keys || !cur || cur.id !== id) return;
    const it = cur.items[k];
    let wait = gapMs(cur.pacing);
    let next = it;
    if (err == null) {
      const held = it.index != null && cur.mint ? this.s.vision.find((v) => v.index === it.index)?.tokens.find((t) => t.mint === cur.mint)?.amount : undefined;
      const got = cur.kind === "buyNew" || cur.kind === "buyFrom" ? (held != null ? held - BigInt(it.before ?? "0") : null) : null;
      next = { ...it, status: "done", sig, finish: false, error: undefined, ...(got != null && got > 0n ? { got: got.toString() } : {}) };
    } else {
      const r = afterFailure(cur, it, err, it.index != null && !!this.buyIntent(it.index));
      next = r.item;
      if (r.again) wait = BUSY_GAP;
    }
    this.saveBatch({ ...setItem(cur, k, next), nextAt: Date.now() + wait });
    this.runBatch();
  }

  /** What a wallet's turn does: the same action as on its own, so every check and recovery it has applies. */
  private async batchAct(id: string, k: number, owed?: bigint): Promise<string | undefined> {
    const b = this.s.batch!;
    const x = b.items[k];
    const slip = b.slippageBps ?? 100;
    // back to back, every wallet keeps to the price that was shown; spaced out over minutes, each one
    // trades at the price of its own turn, within the price room (a minute-old price would turn most away)
    const o: TradeOpts = { speed: speedOf(b.speed), ...(x.minOut && b.pacing === "fast" ? { minOut: BigInt(x.minOut) } : {}) };
    if ((b.kind === "buyNew" || b.kind === "buyFrom") && x.finish && x.index != null) return this.finishBuy(x.index);
    switch (b.kind) {
      case "buyNew":
        // a try again whose new wallet already holds its SOL (its buy never started) buys from there: the pool isn't paid twice
        if (x.index != null && !this.buyIntent(x.index)) {
          this.step("buy", `Checking ${walletName(x.index)}`);
          if (BigInt(await conn().getBalance(this.visionKeypair(x.index).publicKey, "confirmed")) > 0n) {
            return this.buyFrom(x.index, b.mint!, BigInt(x.amount), slip, !!b.auto, b.program, o);
          }
        }
        return this.buy(b.mint!, BigInt(x.amount), slip, !!b.auto, b.program, {
          ...o,
          index: x.index,
          // the wallet is known before anything is paid, so a reload can look at it
          onIndex: (i) => {
            const cur = this.s.batch;
            if (cur?.id === id) this.saveBatch(setItem(cur, k, { index: i }));
          },
        });
      case "buyFrom": {
        let amount = BigInt(x.amount);
        if (b.all) {
          // "All of it": what the wallet holds now, less its reserve (the least promised shrinks with it)
          this.step("buy", `Checking ${walletName(x.index!)}`);
          const lamports = BigInt(await conn().getBalance(this.visionKeypair(x.index!).publicKey, "confirmed"));
          const reserve = await this.reserveFor(b.mint!, b.program);
          const now = lamports > reserve ? lamports - reserve - ((lamports - reserve) % 1_000n) : 0n;
          if (o.minOut != null && now < amount) o.minOut = (o.minOut * now) / amount;
          amount = now;
        }
        return this.buyFrom(x.index!, b.mint!, amount, slip, !!b.auto, b.program, o);
      }
      case "sell": {
        // what is still owed of its share (never more than the wallet holds); the least it may get shrinks with it
        const amount = owed ?? BigInt(x.amount);
        const minOut = o.minOut != null ? (o.minOut * amount) / BigInt(x.amount) : undefined;
        return this.sell(x.index!, b.mint!, amount, slip, !!b.auto, {
          speed: o.speed,
          minOut,
          // its swap is remembered as it goes out, so a try again first looks whether it landed
          onSwap: (sw) => {
            const cur = this.s.batch;
            if (cur?.id === id) this.saveBatch(setItem(cur, k, { sig: sw.sig, lvh: sw.lvh }));
          },
        });
      }
      case "move":
        return this.sweep(x.index!);
      case "send":
        return this.sendFromVision(x.index!, b.to!);
    }
  }

  /**
   * The background task holding the action lock, if any (see Busy.bg). Each task gets its own
   * token, so one that outlives its account (locked or switched meanwhile) can tell, and stays quiet.
   */
  private bgTask: object | null = null;
  /** What background work had to say while another message was on screen: shown once that one is dismissed. */
  private queued: { notice?: Notice; error?: string }[] = [];

  /**
   * Takes the action lock for work the app starts by itself, before its first await, so a tap can't
   * start something in between. False when something is already running: it waits for its next turn.
   */
  private bgBegin(kind: Activity["kind"], step: string): object | null {
    if (this.s.busy) return null;
    const t = {};
    this.bgTask = t;
    this.set({ busy: { kind, step, bg: true } });
    return t;
  }

  /** Lets go of the lock a background task took, if it still holds it. */
  private bgEnd(t: object | null) {
    if (!t || this.bgTask !== t) return;
    this.bgTask = null;
    if (this.s.busy?.bg) this.set({ busy: null });
  }

  /** Whether a message (or an action) is on screen that a waiting message mustn't cover; the empty-account hint gives way. */
  private shown(): boolean {
    return !!this.s.error || !!this.s.busy || (!!this.s.notice && this.s.notice !== this.emptyHint);
  }

  /** A result of background work: shown straight away when nothing else is, never in place of the person's own message. */
  private bgSay(m: { notice?: Notice; error?: string }) {
    if (this.shown()) this.enqueue(m);
    else this.set(m.error ? { error: m.error, notice: null } : { notice: m.notice ?? null });
  }

  /** Waits its turn; the same message twice waits once. */
  private enqueue(m: { notice?: Notice; error?: string }) {
    const same = (x: { notice?: Notice; error?: string }) =>
      x.error === m.error && x.notice?.title === m.notice?.title && x.notice?.text === m.notice?.text;
    if (!this.queued.some(same)) this.queued.push(m);
  }

  /** The next queued message, once the one on screen has gone. */
  private nextQueued() {
    if (this.shown()) return;
    const m = this.queued.shift();
    if (m) this.set(m.error ? { error: m.error, notice: null } : { notice: m.notice ?? null });
  }

  private waitMinutes(): number {
    return Math.max(1, Math.round((Number(this.s.pool?.depositDelaySlots ?? 0) * 0.4) / 60));
  }

  /** How long a deposit waits in the waiting room, in words ("10 minutes"). */
  waitLabel(): string {
    const m = this.waitMinutes();
    return m === 1 ? "1 minute" : `${m} minutes`;
  }

  /** The guard's screening pass for a deposit. A brief hiccup (busy, or a payment still arriving) is asked again, quietly, a couple of times. */
  private async attestation(depositor: PublicKey): Promise<Attestation> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await api<Attestation>("/api/attest", { json: { depositor: depositor.toBase58() } });
      } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 503 && e.status !== 429) || attempt >= 3) throw e;
        const busy = this.s.busy;
        if (busy) this.set({ busy: { ...busy, step: "Screening is busy, trying again" } });
        await sleep(Math.min(e.retryAfter ?? 5, 15) * 1000);
      }
    }
  }

  /** A deposit's instructions, and its note's inner (hex, as the waiting room lists it). */
  private async depositIxs(depositor: PublicKey, amount: bigint, att?: Attestation): Promise<{ ixs: TransactionInstruction[]; inner: string }> {
    const { keys, pool } = this.need();
    const nonce = randomNonce();
    const inner = noteInner(keys, nonce);
    const meta = encodeMeta(keys, nonce, amount);
    const ixs: TransactionInstruction[] = [...computeBudget(DEPOSIT_CU, OWN_PRICE)];
    let expiry = 0n;
    if (pool.requireAttestation) {
      const a = att ?? (await this.attestation(depositor));
      expiry = BigInt(a.expiry);
      ixs.push(this.pool().attestationInstruction(new PublicKey(a.guard), unb64(a.signature), depositor, expiry));
    }
    // the fee limit is the fee this page showed: if the program would charge more, it refuses rather than surprises
    ixs.push(this.pool().deposit({ depositor, amount, inner, meta, attestationExpiry: expiry, maxFeeBps: this.depositFeeBps() }));
    return { ixs, inner: hex(toBE(inner)) };
  }

  /** The fee a deposit pays: zero while the on-chain program predates the deposit fee. */
  depositFeeBps(): number {
    return this.s.pool?.depositFees === false ? 0 : this.feeBps();
  }

  /** The pool fee on a deposit of `amount`, paid on top of it. */
  depositFee(amount: bigint): bigint {
    return depositFee(amount, this.depositFeeBps());
  }

  /** The largest deposit that fits in `budget` lamports, fee included. */
  maxDepositFor(budget: bigint): bigint {
    return maxDepositFor(budget, this.depositFeeBps());
  }

  /**
   * What a wallet keeps after shielding: enough to stay open (Solana's rent
   * minimum) plus room for a priority fee some wallets add on their own.
   */
  walletKeep(): bigint {
    return (this.s.rent?.wallet ?? 890_880n) + 2_000_000n;
  }

  /** Everything a wallet pays to shield `amount`: the amount, the pool fee, the waiting-room rent (it comes back) and the network fee. */
  shieldCost(amount: bigint): bigint {
    return amount + this.depositFee(amount) + (this.s.rent?.pending ?? 0n) + this.depositTxFee();
  }

  /**
   * The most the connected wallet can shield in one go: what it holds, minus
   * the costs above and what it keeps, within the pool's per-deposit limit and
   * the room the pool has left. Null until everything it depends on is known.
   */
  maxShield(have = this.s.publicLamports): bigint | null {
    const pool = this.s.pool;
    if (!pool || !this.s.rent || have == null) return null;
    let a = this.maxDepositFor(have - this.s.rent.pending - this.depositTxFee() - this.walletKeep());
    const max = BigInt(pool.maxDeposit);
    if (a > max) a = max;
    if (pool.tvlRoom != null && a > BigInt(pool.tvlRoom)) a = BigInt(pool.tvlRoom);
    return a > 0n ? a : 0n;
  }

  /** Public wallet -> waiting room -> private balance. */
  async shield(wallet: WalletLike, amount: bigint) {
    // something already holds the lock (a second tap, or a move that started by itself): this does nothing
    if (this.s.busy) return;
    try {
      // busy straight away, so a second tap can't start a second deposit meanwhile
      this.step("shield", "Checking the pool");
      // the fee shown must be the fee charged: if it changed since the page loaded (a program upgrade), say so first
      const shown = this.depositFeeBps();
      await this.loadPool();
      if (this.depositFeeBps() !== shown) throw new Error("The pool fee just changed. Please check the new total and try again.");
      const { pool } = this.need();
      if (pool.depositsPaused) throw new Error("Deposits are paused right now. Withdrawals still work.");
      if (amount < BigInt(pool.minDeposit)) throw new Error(`The smallest deposit is ${Number(pool.minDeposit) / 1e9} SOL.`);
      if (amount > BigInt(pool.maxDeposit)) throw new Error(`The largest single deposit is ${fmt(BigInt(pool.maxDeposit))} SOL.`);
      if (pool.tvlRoom != null && amount > BigInt(pool.tvlRoom)) {
        throw new Error(`The pool can take ${fmt(BigInt(pool.tvlRoom))} SOL more right now. Try a smaller amount.`);
      }
      // check against what the wallet holds this second, not when the page last looked
      await this.rentNow();
      const have = BigInt(await conn().getBalance(wallet.publicKey, "confirmed"));
      this.set({ publicLamports: have });
      if (this.shieldCost(amount) + this.walletKeep() > have) {
        const most = this.maxShield(have) ?? 0n;
        throw new Error(
          most >= BigInt(pool.minDeposit)
            ? `That's more than this wallet holds after fees. The most it can shield right now is ${fmt(most, 6)} SOL.`
            : "This wallet doesn't hold enough SOL to shield after fees.",
        );
      }
      this.step("shield", "Checking your wallet against sanctions lists");
      const { ixs } = await this.depositIxs(wallet.publicKey, amount);
      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet.publicKey;
      tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
      this.step("shield", "Approve the deposit in your wallet");
      const signed = await wallet.signTransaction(tx);
      this.step("shield", "Sending to Solana");
      const before = this.waitingFrom(wallet.publicKey.toBase58());
      const sig = await sendAndConfirm(signed, "deposit");
      this.log({ kind: "shield", text: `Shielded ${fmt(amount)} SOL`, sig });
      this.step("shield", "Into the waiting room");
      await Promise.all([this.awaitWaiting(wallet.publicKey.toBase58(), before), this.refreshPublic()]);
      this.done(
        "Shielded",
        `${fmt(amount)} SOL is in the waiting room. It joins your private balance in about ${this.waitLabel()}. You can close this page; it carries on without you.`,
        sig,
      );
      return sig;
    } catch (e) {
      this.fail(e);
    }
  }

  // ─── payments straight from the wallet (see walletpay.ts) ───

  /**
   * The deposit that pays `amount` from the wallet (exactly what the payment spends), or why it
   * can't: under the pool's smallest deposit, or over the most one deposit can be right now.
   */
  walletPayDeposit(amount: bigint) {
    const pool = this.s.pool;
    const max = BigInt(pool?.maxDeposit ?? 0);
    const room = pool?.tvlRoom != null ? BigInt(pool.tvlRoom) : null;
    return walletDeposit(amount, { withdrawOf: (a) => this.quotePay(a).withdraw, min: BigInt(pool?.minDeposit ?? 0), max: room != null && room < max ? room : max });
  }

  /** The most a payment from a note of `note` lamports can deliver at today's fees. */
  payoutOf(note: bigint): bigint {
    return payoutFor(note, (a) => this.quotePay(a).withdraw);
  }

  /** What a payment whose fees went up can still deliver from its note: what its note covers today, at most what it was for. */
  payFeesMost(p: WalletPay): bigint {
    const most = this.payoutOf(BigInt(p.D));
    return most < BigInt(p.amount) ? most : BigInt(p.amount);
  }

  /** The most one payment from the connected wallet can deliver: what it can shield, less the payment's own fees. Null until known. */
  walletPayMax(): bigint | null {
    const most = this.maxShield();
    return most == null ? null : this.payoutOf(most);
  }

  /**
   * Pays an outside address straight from the connected wallet: one deposit of exactly what the
   * payment spends, sent on by this page once it joins the private balance (see runWalletPays).
   * Every check runs before the wallet is asked, and the payment is kept on this device before the
   * wallet signs, so a page closed at any point picks it up again the next time it opens here.
   */
  async payFromWallet(wallet: WalletLike, part: Part, when: When) {
    // something already holds the lock (a second tap, or work started by itself): this does nothing
    if (this.s.busy) return;
    const owner = wallet.publicKey.toBase58();
    let id: string | null = null;
    try {
      this.set({ ask: null });
      this.step("send", "Checking the pool");
      // the fee shown must be the fee charged (see shield)
      const shown = this.depositFeeBps();
      await this.loadPool();
      if (this.depositFeeBps() !== shown) throw new Error("The pool fee just changed. Please check the new total and try again.");
      const { pool } = this.need();
      if (!pool.relayer) throw new Error("Paying from your wallet needs the relayer, which isn't available right now. Nothing was taken.");
      if (pool.depositsPaused) throw new Error("Deposits are paused right now, so paying from your wallet has to wait. Nothing was taken.");
      if (when !== "now" && !(pool.sendLater ?? []).includes(when)) throw new Error("Sending later isn't available right now. Pick “As soon as it's ready” instead.");
      this.deliveryGate();
      if (part.to === owner) throw new Error("That's the wallet you're paying from. Pick another address.");
      if (this.ownKeypairFor(part.to)) throw new Error("That's a wallet of this account's own. Pay it from your private balance instead.");
      // checked without asking the server about the recipient, so it isn't seen next to this deposit;
      // it gets the full check when it goes out, and anything refused then stays in the private balance
      await this.checkRecipients([part], true);
      const rentMin = (await this.rentNow()).wallet;
      if (part.amount < rentMin) throw new Error(`The smallest private send is ${fmtUp(rentMin, 5)} SOL.`);
      await this.readTreasury();
      const sized = this.walletPayDeposit(part.amount);
      if ("problem" in sized) {
        throw new Error(
          sized.problem === "small"
            ? `The smallest payment from your wallet is ${fmtUp(sized.least, 6)} SOL.`
            : `The most one payment from your wallet can be right now is ${fmtDown(sized.most, 6)} SOL.`,
        );
      }
      const D = sized.deposit;
      // checked against what the wallet holds this second (see shield)
      const have = BigInt(await conn().getBalance(wallet.publicKey, "confirmed"));
      this.set({ publicLamports: have });
      if (this.shieldCost(D) + this.walletKeep() > have) {
        const most = this.walletPayMax() ?? 0n;
        throw new Error(
          most >= rentMin ? `That's more than this wallet holds after fees. The most it can send right now is ${fmtDown(most, 6)} SOL.` : "This wallet doesn't hold enough SOL for that after fees.",
        );
      }
      this.step("send", "Checking your wallet against sanctions lists");
      const { ixs, inner } = await this.depositIxs(wallet.publicKey, D);
      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet.publicKey;
      const bh = await conn().getLatestBlockhash("confirmed");
      tx.recentBlockhash = bh.blockhash;
      // kept before the wallet signs: once the deposit may land, this device knows what it is for
      id = hex(crypto.getRandomValues(new Uint8Array(12)));
      this.paying = id;
      this.savePays([
        {
          id,
          created: Date.now(),
          to: part.to,
          amount: part.amount.toString(),
          when,
          ...(part.offCurveOk ? { offCurveOk: true } : {}),
          ...(part.lookalikeOk ? { lookalikeOk: true } : {}),
          depositor: owner,
          inner,
          D: D.toString(),
          lvh: bh.lastValidBlockHeight,
          status: "paying",
        },
        ...this.s.pays,
      ]);
      this.step("send", "Approve the payment in your wallet");
      const signed = await wallet.signTransaction(tx);
      this.patchPay(id, { sig: signatureOf(signed) });
      this.step("send", "Sending to Solana");
      const before = this.waitingFrom(owner);
      const sig = await sendAndConfirm(signed, "deposit");
      this.patchPay(id, { status: "waiting" }, ["paying"]);
      id = null;
      this.log({ kind: "shield", text: `Deposited ${fmt(D)} SOL from your wallet for a private payment to ${shortAddr(part.to)}`, sig });
      this.step("send", "Into the waiting room");
      await Promise.all([this.awaitWaiting(owner, before), this.refreshPublic()]);
      // the instruction first: on a phone the end of a long message is cut off
      this.done(
        "Paid from your wallet",
        `Keep this page open for about ${this.waitLabel()}, until it says Handed to the relayer. Then ${fmt(part.amount)} SOL goes to ${shortAddr(part.to)} ${when === "now" ? "by itself" : `at a random moment within ${WINDOW_LABEL[when]}`}.`,
        sig,
      );
      return sig;
    } catch (e) {
      // declined, refused, or certainly not landed: nothing was taken, so nothing is kept
      if (id && !(e instanceof StillPending)) this.savePays(this.s.pays.filter((x) => x.id !== id));
      // it may still land: said like any failure, but the form empties (it is listed under Payments on their way), so a second tap can't pay it twice
      if (id && e instanceof StillPending) {
        this.report(e);
        return e.signature;
      }
      // a recipient for the sender to confirm: asked on the form, nothing taken yet
      if (e instanceof NeedsConfirm) {
        this.set({ busy: null, ask: e.ask });
        throw e;
      }
      this.fail(e);
    } finally {
      this.paying = null;
    }
  }

  /** The payment the wallet is being asked to pay right now (its own action looks after it), and the one being sent. */
  private paying: string | null = null;
  private firing: string | null = null;
  private payRun = false;
  /** when the chain was last asked about each payment's deposit, and the leaf each deposit becomes */
  private payLooked = new Map<string, number>();
  private payLeaves = new Map<string, bigint>();

  /** Saves this account's payments from the wallet (finished ones stay two days) and shows them. */
  private savePays(list: WalletPay[]) {
    const now = Date.now();
    const keep = list.filter((p) => payOpen(p.status) || now - p.created < PAY_KEEP_MS);
    if (this.s.fingerprint) ls.set(`vs:walletpay:${this.s.fingerprint}`, keep);
    this.set({ pays: keep });
  }

  /** Changes one payment as it is now, only while it is in one of `from`. False when it isn't there (or no longer in one of those). */
  private patchPay(id: string, patch: Partial<WalletPay>, from?: readonly PayStatus[]): boolean {
    const cur = this.s.pays.find((p) => p.id === id);
    if (!cur || (from && !from.includes(cur.status))) return false;
    this.savePays(this.s.pays.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    return true;
  }

  private payLeaf(p: WalletPay): bigint {
    let leaf = this.payLeaves.get(p.id);
    if (leaf == null) {
      leaf = noteLeaf(BigInt(p.D), BigInt("0x" + p.inner));
      this.payLeaves.set(p.id, leaf);
    }
    return leaf;
  }

  /** The scheduled payment a payment from the wallet became, if any. */
  private payJob(p: WalletPay): Job | undefined {
    const at = p.sendingAt;
    return at ? this.s.jobs.find((j) => j.to === p.to && j.amount === p.amount && j.created >= at) : undefined;
  }

  /** A scheduled payment or a delivery to its recipient, of its amount, started since it went to "sending": the payment went (or is going). */
  private payRecorded(p: WalletPay): "sent" | "scheduled" | null {
    const at = p.sendingAt;
    if (!at) return null;
    if (this.payJob(p)) return "scheduled";
    return this.legs().some((l) => !l.job && l.to === p.to && l.amount === p.amount && l.at >= at) ? "sent" : null;
  }

  private payView(p: WalletPay): PayView {
    const leaf = this.payLeaf(p);
    const settled = [...this.ownLeaves.values()].includes(leaf);
    return {
      now: Date.now(),
      settled,
      unspent: settled && this.freeNotes().some((n) => n.leaf === leaf),
      waiting: this.s.waiting.some((w) => w.inner === p.inner),
      need: this.quotePay(BigInt(p.amount)).withdraw,
      recorded: this.payRecorded(p),
    };
  }

  /** A deposit gone from the waiting room with no note to show for it: taken back by its owner, sent back by screening, or not known yet. */
  private async depositFate(p: WalletPay): Promise<"refunded" | "returned" | "unknown"> {
    const program = this.s.pool?.programId;
    if (!program) return "unknown";
    try {
      const inner = BigInt("0x" + p.inner);
      const sigs = await conn().getSignaturesForAddress(this.pool().pending(inner), { limit: 10 }, "confirmed");
      for (const s of sigs) {
        if (s.err) continue;
        const tx = await conn().getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
        for (const e of eventsFromLogs(tx?.meta?.logMessages ?? [], program)) if (e.kind === "refunded" && e.inner === inner) return e.byGuard ? "returned" : "refunded";
      }
    } catch {
      /* asked again later */
    }
    return "unknown";
  }

  /**
   * Looks after this device's payments from the wallet, after each sync: a deposit that landed
   * waits in the waiting room, and once its note is in the private balance the payment goes out
   * (one at a time, under the background lock). One that was already sent is never sent again.
   */
  private async runWalletPays() {
    if (this.payRun || !this.keys) return;
    const fp = this.s.fingerprint;
    const todo = this.s.pays.filter((p) => (p.status === "paying" || p.status === "waiting" || p.status === "sending") && p.id !== this.paying && p.id !== this.firing);
    if (!todo.length) return;
    this.payRun = true;
    try {
      await this.readTreasury();
      for (const { id } of todo) {
        const p = this.s.pays.find((x) => x.id === id);
        if (this.s.fingerprint !== fp || !p || p.id === this.paying || p.id === this.firing) continue;
        const v = this.payView(p);
        let step = nextStep(p, v);
        if (step.do === "look") {
          if (Date.now() - (this.payLooked.get(id) ?? 0) < 30_000) continue;
          this.payLooked.set(id, Date.now());
          if (p.status === "paying") v.sig = await signatureState(p.sig!, p.lvh).catch(() => "unknown" as const);
          else v.fate = await this.depositFate(p);
          if (this.s.pays.find((x) => x.id === id)?.status !== p.status) continue;
          step = nextStep(p, v);
        }
        await this.payStep(p, step);
      }
    } finally {
      this.payRun = false;
    }
  }

  private async payStep(p: WalletPay, step: PayStep) {
    if (step.do === "drop") this.savePays(this.s.pays.filter((x) => x.id !== p.id));
    else if (step.do === "fire") {
      // waits for the relayer, and for a refresh after an update
      if (this.s.pool?.relayer && !this.s.update) await this.firePay(p.id, false);
    } else if (step.do === "set") {
      const text =
        step.why === "spent"
          ? "Its SOL was spent from your private balance before it went, so this payment wasn't sent."
          : step.why === "refunded"
            ? "The deposit was taken back to your wallet, so nothing was sent."
            : step.why === "returned"
              ? "The waiting room sent this deposit back to your wallet, so nothing was sent."
              : undefined;
      const latest = step.status === "scheduled" ? this.payJob(p)?.latest : undefined;
      if (!this.patchPay(p.id, { status: step.status, ...(step.ask ? { ask: step.ask } : {}), ...(text ? { text } : {}), ...(latest ? { latest } : {}) }, [p.status])) return;
      // a deposit that landed while the page was closed
      if (p.status === "paying") this.log({ kind: "shield", text: `Deposited ${fmt(BigInt(p.D))} SOL from your wallet for a private payment to ${shortAddr(p.to)}`, sig: p.sig });
      if (step.status === "returned") this.bgSay({ notice: { title: "Payment not sent", text: `${fmt(BigInt(p.D))} SOL for ${shortAddr(p.to)} went back to your wallet from the waiting room.` } });
    }
  }

  /**
   * Sends a payment from the wallet whose note is in the private balance: by itself (under the
   * background lock, skipped while anything else runs), or `byHand` when its owner says so,
   * `amount` replacing what it delivers when the fees went up. Marked "sending" before anything goes.
   */
  private async firePay(id: string, byHand: boolean, amount?: bigint) {
    const p = this.s.pays.find((x) => x.id === id);
    if (!p || this.firing) return;
    if (byHand && this.s.busy) return;
    // another tab of this account may have moved it on meanwhile: what is written down on this device wins
    const kept = this.s.fingerprint ? ls.get<WalletPay[]>(`vs:walletpay:${this.s.fingerprint}`, []).find((x) => x.id === id) : undefined;
    if (kept && kept.status !== p.status) {
      this.savePays(this.s.pays.map((x) => (x.id === id ? kept : x)));
      return;
    }
    const task = byHand ? null : this.bgBegin("send", `Your SOL joined your private balance: sending ${fmt(BigInt(p.amount))} SOL to ${shortAddr(p.to)}`);
    if (!byHand && !task) return;
    // its own "Paid from your wallet" message gives way, so how it went shows straight away
    if (task && p.sig && this.s.notice?.sig === p.sig) this.set({ notice: null });
    const sent: WalletPay = { ...p, amount: (amount ?? BigInt(p.amount)).toString(), sendingAt: Date.now() };
    // written down before anything goes: a page closed from here on never sends it twice (see nextStep)
    this.patchPay(id, { status: "sending", amount: sent.amount, sendingAt: sent.sendingAt, ask: undefined, text: undefined, confirm: undefined });
    this.firing = id;
    let outcome: PartOutcome | undefined;
    try {
      await this.sendMany(
        [{ to: p.to, amount: BigInt(sent.amount), ...(p.offCurveOk ? { offCurveOk: true } : {}), ...(p.lookalikeOk ? { lookalikeOk: true } : {}) }],
        p.when,
        (_, o) => (outcome = o),
        // only its own note: never any other private balance
        this.payLeaf(p),
      );
      if (outcome === "sent") this.patchPay(id, { status: "sent" }, ["sending"]);
      else if (outcome === "scheduled") this.patchPay(id, { status: "scheduled", latest: this.payJob(sent)?.latest }, ["sending"]);
      else if (outcome === "cancelled") this.patchPay(id, { status: "cancelled", text: "Cancelled before it went out. The SOL stays in your private balance." }, ["sending"]);
      // "checking": it may be on its way; the deliveries and scheduled payments find out, and the next look here follows them
    } catch (e) {
      const rec = this.payRecorded(sent);
      if (rec) this.patchPay(id, { status: rec, ...(rec === "scheduled" ? { latest: this.payJob(sent)?.latest } : {}) }, ["sending"]);
      else if (outcome !== "checking") {
        this.patchPay(
          id,
          e instanceof NeedsConfirm
            ? { status: "needs-you", ask: "confirm", confirm: e.ask.kind, text: e.ask.text }
            : e instanceof PinnedNote
              ? { status: "needs-you", ask: e.ask }
              : { status: "needs-you", ask: "error", text: (e as Error)?.message || "It didn't go out." },
          ["sending"],
        );
      }
    } finally {
      this.firing = null;
      this.bgEnd(task);
    }
  }

  /** "Stop and keep it private": a payment that hasn't gone yet won't go; its SOL stays in (or joins) the private balance. */
  stopPay(id: string) {
    this.patchPay(id, { status: "cancelled", text: "Stopped. The SOL stays in your private balance." }, ["waiting", "needs-you"]);
  }

  /**
   * Sends a payment that waits for its owner, now that they said so: as it was, with its recipient
   * confirmed ("confirm"), or for what its note still covers when the fees went up ("fees"). One
   * whose send may have started after all is never sent again.
   */
  async sendPayNow(id: string) {
    const p = this.s.pays.find((x) => x.id === id);
    if (!p || p.status !== "needs-you" || p.ask === "unsure" || this.s.busy) return;
    const rec = this.payRecorded(p);
    if (rec) {
      this.patchPay(id, { status: rec, ask: undefined, text: undefined }, ["needs-you"]);
      return;
    }
    if (p.ask === "confirm") this.patchPay(id, p.confirm === "off-curve" ? { offCurveOk: true } : { lookalikeOk: true });
    let amount: bigint | undefined;
    if (p.ask === "fees") {
      await this.readTreasury();
      // never more than was asked for, should the fees have come back down
      amount = this.payFeesMost(p);
      amount -= amount % 1_000n;
    }
    await this.firePay(id, true, amount);
  }

  /** Takes a finished payment (or one to check in the activity) off the list. */
  dismissPay(id: string) {
    this.savePays(this.s.pays.filter((p) => p.id !== id || (payOpen(p.status) && p.ask !== "unsure")));
  }

  /**
   * Proves one spend and has the relayer send it. For an outside address (`dest` "pay") the proof
   * names a one-time sending address: the relayer gets that address's signed transfer with it, and
   * the payment is followed until the recipient has it. Returns the Transaction ID the recipient sees
   * (the delivery's, for an outside address) and the pool spend's.
   */
  private async proveAndPayout(
    kind: Activity["kind"],
    inputs: OwnedNote[],
    dest: Dest,
    withdraw: bigint,
    relayerFee: bigint,
    outputs?: [bigint, bigint],
    /** runs just before the proof goes to the relayer: from then on the payment may land */
    onRelay?: () => void,
  ): Promise<Paid> {
    const { pool } = this.need();
    if (!pool.relayer) throw new Error("No relayer is available right now. You can send it yourself below.");
    if (dest.kind === "pay") this.deliveryGate();
    const p = await this.prove(kind, inputs, dest, withdraw, relayerFee, pool.relayer, outputs, false, true);
    if (dest.kind !== "pay") {
      this.step(kind, "Handing it to the relayer", "Your wallet does not appear in this transaction.");
      onRelay?.();
      const res = await this.relaySpend(kind, { v: 2, request: p.request, ...(p.own ? { own: { sig: p.own } } : {}) }, inputs, p.r.nullifiers);
      await this.afterSpend(kind, inputs, res.signature, p.r.commitments, withdraw);
      return { sig: res.signature, tx1: res.signature };
    }
    const hop = p.hop!;
    // written down before anything is sent: a delivery cut short is finished from here, on this device
    const leg: HopLeg = { hop: hop.publicKey.toBase58(), out0: p.r.commitments[0], to: dest.to.toBase58(), amount: dest.amount.toString(), status: "proved", at: Date.now() };
    this.saveLeg(leg);
    let res: RelayAnswer | undefined;
    let handed = false;
    try {
      for (let attempt = 0; !res; attempt++) {
        this.step(kind, "Handing it to the relayer", "Your wallet does not appear in this transaction.");
        const delivery = await this.signInstant(kind, p.request, dest, hop);
        if (attempt === 0) onRelay?.();
        try {
          handed = true;
          res = await this.relaySpend(kind, { v: 2, request: p.request, delivery }, inputs, p.r.nullifiers);
        } catch (e) {
          // its blockhash ran out before the relayer could send it: nothing was spent, so it is signed again (the proof stays)
          if (e instanceof ApiError && e.data?.code === "expired" && attempt < 2) continue;
          throw e;
        }
      }
    } catch (e) {
      // this proof never goes (refused, or never handed over, with nothing spent): its sending address needs no looking after
      if (!handed || nothingSpent(e)) this.dropLeg(leg.hop);
      throw e;
    }
    const sent: HopLeg = { ...leg, status: "sent", ...(res.signature ? { tx1: res.signature } : {}) };
    this.patchLeg(leg.hop, { status: "sent", ...(res.signature ? { tx1: res.signature } : {}) });
    this.step(kind, "Delivering to the recipient", "A standard SOL transfer from a one-time sending address.");
    // the delivery check sends one shape only: it never finishes the delivery itself (that would be an L1)
    const finish = !dest.only;
    let tx2 = await this.deliver(sent, res, finish);
    await this.afterSpend(kind, inputs, res.signature, p.r.commitments, withdraw);
    // the pool payment was only confirmed just now: its delivery is looked at once more
    if (!tx2) tx2 = await this.finishLeg(this.legs().find((l) => l.hop === leg.hop) ?? sent, true, finish).catch(() => null);
    return { sig: tx2 ?? "", tx1: res.signature, hop: leg.hop };
  }

  /** Hands a spend's body to the relayer; one that may still land keeps its notes out of the balance until the chain says. */
  private async relaySpend(kind: Activity["kind"], body: Record<string, unknown>, inputs: OwnedNote[], nullifiers: string[]): Promise<RelayAnswer> {
    try {
      return await this.relayOnce(kind, body, nullifiers);
    } catch (e) {
      // it may still land: its notes stay out of the balance until the pool data says either way
      if (e instanceof MaybeSent) inputs.forEach((n) => this.pendingSpent.set(n.nullifier, Date.now()));
      // the pool's fee changed (nothing was spent): the next try is worked out from the new one
      if (e instanceof ApiError && e.data?.code === "stale") {
        this.treasury = null;
        void this.loadPool();
      }
      throw e;
    }
  }

  /**
   * Hands one proof to the relayer. The answer is the signature once the payment has landed ("" when
   * only its notes show it), with its delivery when it pays an outside address. A reply that goes
   * missing is never taken as a failure: the payment may be on its way, so its notes are looked at
   * on-chain before anything is said.
   */
  private async relayOnce(kind: Activity["kind"], body: Record<string, unknown>, nullifiers: string[]): Promise<RelayAnswer> {
    for (let attempt = 0; ; attempt++) {
      let res: RelayAnswer;
      try {
        res = await api<RelayAnswer>("/api/relay", { json: body });
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 429 && attempt < 3) {
            // a busy relayer (or a busy network sharing an address): wait as long as it asks, then go on
            const s = Math.min(60, e.retryAfter ?? 20);
            this.step(kind, "Waiting a moment", `The relayer is busy. Trying again in ${s} seconds.`);
            await sleep(s * 1000);
            this.step(kind, "Handing it to the relayer", "Your wallet does not appear in this transaction.");
            continue;
          }
          this.refusal(e);
          // a refusal, or an answer the server gave with a reason: it knows for sure that nothing was spent
          if (definite(e)) throw e;
        }
        this.step(kind, "Checking whether it went through");
        return { signature: await this.settleUnknown(nullifiers) };
      }
      if (!res.pending) return res;
      this.step(kind, "Waiting for the network", "It was sent; the network hasn't confirmed it yet.");
      return { ...res, signature: await this.settleUnknown(nullifiers, res.signature) };
    }
  }

  /** The relayer's refusals that mean something here: notes another device holds, a page that needs a refresh, a relayer being topped up. */
  private refusal(e: ApiError) {
    const code = e.data?.code;
    // the pool's fee changed (nothing was spent): read again now, so the next try is worked out from the new one
    if (feeChanged(code, e.message)) {
      this.treasury = null;
      void this.loadPool();
    }
    if (code === "held" && e.data) {
      this.setAside(e.data);
      throw new NotesHeld();
    }
    if (code === "update_required") {
      this.set({ update: true });
      throw new Error(UPDATE_TEXT);
    }
    if (code === "relayer_unfunded") {
      throw new Error("The relayer is being topped up right now, so it can't send this. Nothing was spent. Try again in a little while, or send it yourself below.");
    }
  }

  /** Payments to outside addresses go only on the delivery terms this page was built for (a refresh brings newer ones). */
  private deliveryGate() {
    if (this.s.update) throw new Error(UPDATE_TEXT);
    if (!this.s.pool?.delivery) throw new Error("Private sends are being updated on the server right now. Nothing was spent. Please try again in a few minutes.");
  }

  /**
   * What a payment to an outside address is signed on, from the relayer, which checks the payment
   * (its proof too) first. Its delivery terms must be this page's. Busy answers are waited out like
   * the relayer's own.
   */
  private async prepare(kind: Activity["kind"], body: Record<string, unknown>): Promise<Prepared> {
    for (let attempt = 0; ; attempt++) {
      let res: Prepared;
      try {
        res = await api<Prepared>("/api/relay/prepare", { json: body });
      } catch (e) {
        if (e instanceof ApiError) {
          if (e.status === 429 && attempt < 3) {
            const s = Math.min(60, e.retryAfter ?? 20);
            this.step(kind, "Waiting a moment", `The relayer is busy. Trying again in ${s} seconds.`);
            await sleep(s * 1000);
            continue;
          }
          this.refusal(e);
        }
        throw e;
      }
      if (!res.delivery || !sameDeliveryTerms(res.delivery) || newerVersion(res.delivery.minClient, APP_VERSION)) {
        this.set({ update: true });
        throw new Error(UPDATE_TEXT);
      }
      return res;
    }
  }

  /** Whether a durable nonce the relayer offers is on the chain as it says (read through this site's RPC), under its published nonce authority. */
  private async nonceChecked(n: NonceLease): Promise<boolean> {
    const a = await conn()
      .getAccountInfo(new PublicKey(n.account), "confirmed")
      .catch(() => null);
    return nonceOk(a ? { owner: a.owner, data: a.data } : null, n, this.s.pool?.delivery?.nonceAuthority ?? null);
  }

  /**
   * The hop's signed transfers for a payment sent now: L1 on the relayer's recent blockhash, and N2 on
   * a spare durable nonce when it has one (so it still goes if the blockhash runs out first).
   * `only` picks one shape (the delivery check page).
   */
  private async signInstant(kind: Activity["kind"], request: RelayRequestBody, dest: PayDest, hop: Keypair) {
    const to = dest.to.toBase58();
    const amount = dest.amount.toString();
    const extra = dest.offCurveOk ? { offCurveOk: true } : {};
    // a spare nonce only when N2 may be used (the L1 check asks for none, so it never holds one for nothing)
    const prep = await this.prepare(kind, { v: 2, request, delivery: { to, amount, mode: "instant", ...extra, ...(dest.only === "l1" ? { spare: false } : {}) } });
    const nonce = prep.nonce && prep.leaseId && dest.only !== "l1" && (await this.nonceChecked(prep.nonce)) ? prep.nonce : null;
    if (dest.only === "n2" && !nonce) throw new Error("No durable nonce is free on the relayer right now, so this N2 check can't run. Nothing was spent. Try again in a minute.");
    const l1 = dest.only === "n2" || !prep.blockhash ? null : l1Sig(hop, dest.to, dest.amount, prep.blockhash);
    if (!l1 && !nonce) throw new Error("The relayer couldn't take this right now. Nothing was spent. Please try again.");
    return {
      to,
      amount,
      ...(l1 ? { blockhash: prep.blockhash, l1 } : {}),
      ...(nonce ? { leaseId: prep.leaseId, n2: n2Sig(hop, dest.to, dest.amount, nonce) } : {}),
      ...extra,
    };
  }

  /** The hop's signed N2 for a payment sent later, on the durable nonce the relayer leases to that job (same id and token, same nonce). */
  private async signScheduled(request: RelayRequestBody, dest: PayDest, hop: Keypair, id: string, token: string) {
    const to = dest.to.toBase58();
    const amount = dest.amount.toString();
    const extra = dest.offCurveOk ? { offCurveOk: true } : {};
    const prep = await this.prepare("send", { v: 2, request, delivery: { to, amount, mode: "scheduled", ...extra }, jobId: id, token });
    if (!prep.nonce || !prep.leaseId || !(await this.nonceChecked(prep.nonce))) {
      throw new Error("The relayer's details for sending later didn't check out, so nothing was scheduled. Please try again in a moment.");
    }
    return { to, amount, leaseId: prep.leaseId, n2: n2Sig(hop, dest.to, dest.amount, prep.nonce), ...extra };
  }

  /**
   * Follows a delivery the relayer was handed until the recipient has it: the relayer's own transfer
   * when it sent one, otherwise this app finishes it from the sending address. Returns the delivery's
   * signature, or null while that can't be told (the ledger keeps it, and the app looks again).
   */
  private async deliver(leg: HopLeg, res: RelayAnswer, finish = true): Promise<string | null> {
    const d = res.delivery;
    if (d?.signature && d.status !== "waiting") {
      // kept before it is followed: a page closed meanwhile still knows which transfer to look up
      this.patchLeg(leg.hop, { tx2cand: d.signature });
      try {
        await confirmSig(d.signature, "delivery", d.status === "delivered" ? 30_000 : 60_000);
        this.patchLeg(leg.hop, { status: "delivered", tx2: d.signature, done: Date.now() });
        return d.signature;
      } catch {
        // not seen landing: the sending address says how it stands
      }
    }
    return this.finishLeg(leg, true, finish).catch(() => null);
  }

  /**
   * Looks at a delivery's sending address and finishes the delivery when it needs it: one that paid
   * for its own transfer was delivered (that transfer is the delivery), one holding SOL is passed on
   * from here now (unless `finish` is off: then only looked at). `wait` gives one paid a moment ago a
   * few seconds to show. Null while it can't be told.
   */
  private async finishLeg(leg: HopLeg, wait = false, finish = true): Promise<string | null> {
    if (leg.status === "delivered" && leg.tx2) return leg.tx2;
    const hop = new PublicKey(leg.hop);
    // what its history may cost is shared by every try: waiting re-lists only what is new, and never reads more than one look does
    const budget = { pages: HISTORY_PAGES + 5, reads: HISTORY_READS };
    for (let i = 0; i < (wait ? 6 : 1); i++) {
      if (i) await sleep(2500);
      const bal = await conn()
        .getBalance(hop, "confirmed")
        .catch(() => null);
      if (bal === null) continue;
      const sig = await this.deliveredFrom(hop, { tx1: leg.tx1, to: leg.to, budget });
      if (sig) {
        this.patchLeg(leg.hop, { status: "delivered", tx2: sig, done: Date.now() });
        return sig;
      }
      // its history couldn't be read: nothing is sent on a guess
      if (sig === undefined) continue;
      if (bal > 0 && finish) return this.completeHop(leg.hop, leg.to);
    }
    return null;
  }

  /**
   * Whether a sending address delivered its payment: the first transaction it paid for itself (its fee
   * payer) after the pool spend that paid it (`tx1`), which must hold a standard transfer to `to` (both
   * default to its leg's). What others sent to it (address-poisoning dust, an exchange's refund) never
   * counts, however much came in since: the history is read back to that pool spend, or to its start.
   * Answers that transfer's signature; null when the history shows none (or shows the address paid
   * for something else first, such as a move into the pool); undefined when it can't be told (the
   * network couldn't say, or this look's share of reads ran out first: what it read is kept, and the
   * next look carries on from there), and then nothing is sent on a guess.
   */
  private async deliveredFrom(
    hop: PublicKey,
    o: { tx1?: string; to?: string; budget?: { pages: number; reads: number } } = {},
  ): Promise<string | null | undefined> {
    const leg = this.legs().find((l) => l.hop === hop.toBase58());
    const tx1 = o.tx1 ?? leg?.tx1;
    const to = o.to ?? leg?.to;
    // the relayer's own transfer as it answered (kept before it was followed): no history to read
    for (const known of [leg?.tx2cand].filter((s): s is string => !!s)) {
      const st = await conn()
        .getSignatureStatuses([known], { searchTransactionHistory: true })
        .then((r) => r.value[0])
        .catch(() => undefined);
      if (st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return known;
    }
    // what was read of it before is kept, so each transaction in it is fetched once; one look at a time per address
    const key = `${hop.toBase58()}|${tx1 ?? ""}`;
    let h = this.hopHistory.get(key);
    if (!h) this.hopHistory.set(key, (h = newHopHistory()));
    const hist = h;
    const rpc: HistoryRpc = {
      list: (q) =>
        conn()
          .getSignaturesForAddress(hop, { limit: HISTORY_PAGE, ...q }, "confirmed")
          .catch(() => null),
      read: async (sig) => {
        const t = await conn()
          .getTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" })
          .catch(() => undefined);
        if (!t) return undefined;
        const m = t.transaction.message;
        if (t.meta?.err || !m.staticAccountKeys[0]?.equals(hop)) return { byHop: false };
        return { byHop: true, pays: (r: string) => paysTo(m, hop, r) };
      },
    };
    const prev = this.historyTurn.get(key) ?? Promise.resolve();
    // (one stuck on the network is waited for only so long)
    const run = Promise.race([prev, sleep(30_000)]).then(() => readDelivery(hist, tx1, to, rpc, o.budget));
    this.historyTurn.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run.catch(() => undefined);
  }

  /**
   * Finishes a delivery from this device: everything its sending address holds, less the delivery
   * fee, goes to the recipient in a standard transfer signed here. What is really there is sent, so
   * a little extra someone sent to it rides along. If the relayer's own transfer lands first, that
   * one is the delivery (only one can: either empties the address).
   */
  async completeHop(hop: string, to: string, auto = false): Promise<string> {
    const kp = this.hopKeypair(hop);
    if (!kp) throw new Error("This sending address isn't one this account can open.");
    const sig = await this.sendFromHop(kp, new PublicKey(to), auto ? "auto" : "manual");
    this.patchLeg(hop, { status: "delivered", tx2: sig, done: Date.now() });
    return sig;
  }

  /**
   * Everything a sending address holds, less the delivery fee, to `to` in one standard transfer.
   * `finishing` a delivery, an address emptied meanwhile answers with what emptied it (the relayer's
   * transfer); finishing it by itself ("auto"), it sends only when its history shows no delivery.
   */
  private async sendFromHop(kp: Keypair, to: PublicKey, finishing: false | "manual" | "auto" = false): Promise<string> {
    if (to.equals(kp.publicKey)) throw new Error("That's the sending address itself.");
    const rent = await this.rentNow();
    const bal = await conn().getBalance(kp.publicKey, "confirmed");
    // finishing a delivery the sending address already paid its own transfer for (the relayer's): that one is
    // the delivery, and anything there now (dust, SOL that came back) is never sent to the recipient again
    // and when its history can't be read, nothing is sent on a guess (however the finish was started)
    const by = finishing ? await this.deliveredFrom(kp.publicKey, { to: to.toBase58() }) : null;
    const leg = this.legs().find((l) => l.hop === kp.publicKey.toBase58());
    const gate = finishGate(by, finishing, BigInt(bal), leg ? BigInt(leg.amount) : undefined);
    if ("delivered" in gate) return gate.delivered;
    if ("refuse" in gate) throw new Error(gate.refuse);
    const f = finishAmount(BigInt(bal), rent.wallet);
    if ("problem" in f) {
      if (f.problem === "too-small") {
        throw new Error(`This sending address holds ${fmt(BigInt(bal), 6)} SOL. A standard transfer from it needs at least ${fmtUp(rent.wallet + DELIVERY_FEE, 6)} SOL, so move it into your private balance instead.`);
      }
      throw new Error("There's nothing left to send at this sending address.");
    }
    const bh = await conn().getLatestBlockhash("confirmed");
    const tx = VersionedTransaction.deserialize(finishTransaction(kp, to, f.lamports, bh.blockhash));
    try {
      return await sendAndConfirm(tx, "delivery", { lastValidBlockHeight: bh.lastValidBlockHeight });
    } catch (e) {
      // the relayer's transfer may have emptied it first: then that one is the delivery
      const left = await conn()
        .getBalance(kp.publicKey, "confirmed")
        .catch(() => null);
      const first = finishing && left !== null && BigInt(left) < f.lamports ? await this.deliveredFrom(kp.publicKey, { to: to.toBase58() }) : null;
      return afterFailedFinish(first, e);
    }
  }

  /** A payment the relayer couldn't give an outcome for: its notes on-chain say whether it went. */
  private async settleUnknown(nullifiers: string[], signature = ""): Promise<string> {
    // the relayer stops trying within about two and a half minutes of sending it
    const went = await this.nullifiersSpent(nullifiers, 150_000);
    if (went === true) return signature;
    if (went === false) throw new Error("The payment didn't go through. Nothing was spent. Please try again.");
    throw new MaybeSent("This payment may still go through. Check your activity in a minute before sending it again.");
  }

  /** After a spend: its notes are gone, and the balance waits for the pool data to show its new ones (`outs`, hex). */
  private async afterSpend(kind: Activity["kind"], inputs: OwnedNote[], signature: string, outs: string[], withdraw: bigint) {
    inputs.forEach((n) => this.pendingSpent.set(n.nullifier, Date.now()));
    // what stays in the private balance: the spend's change, shown until its notes are read
    const kept = inputs.reduce((s, n) => s + n.amount, 0n) - withdraw;
    this.notesDue.push({ outs, from: Math.max(0, ...inputs.map((n) => n.index + 1)), at: Date.now(), amount: kept > 0n ? kept : 0n });
    this.refilter();
    this.step(kind, "Confirming on Solana");
    if (signature) {
      try {
        // the relayer answered once it landed; this is this device's own look
        await confirmSig(signature, "payment");
      } catch {
        // only notes still unspent on-chain mean it didn't happen
        if ((await this.nullifiersSpent(inputs.map((n) => nfHex(n.nullifier)), 30_000)) === false) {
          inputs.forEach((n) => this.pendingSpent.delete(n.nullifier));
          this.notesDue = this.notesDue.filter((d) => d.outs !== outs);
          this.refilter();
          throw new Error("The payment didn't go through: the network dropped it. Nothing was spent.");
        }
      }
    }
    // wait until the pool data includes this spend's own new notes, so the balance never flickers to zero
    // (counting new leaves isn't enough: someone else's payment can add them first)
    this.step(kind, "Updating your balance");
    await this.sync();
    await this.ownNotesShown(30_000);
  }

  /** Whether a recent spend of this device's still has new notes the pool data doesn't show (given up on after two minutes). */
  private notesLag(): boolean {
    const now = Date.now();
    this.notesDue = this.notesDue.filter((d) => now - d.at < 120_000 && !leavesHold(this.leafBytes, this.leafCount, LEAF_REC, d.outs, d.from));
    return this.notesDue.length > 0;
  }

  /**
   * Waits (up to `ms`) for this device's recent spends to show their new notes. Until they do, a
   * spent note is already hidden while its change isn't shown yet, so the balance looks short.
   */
  private async ownNotesShown(ms = 20_000) {
    const until = Date.now() + ms;
    while (this.notesLag() && Date.now() < until) {
      await sleep(1000);
      await this.sync();
    }
  }

  /** Whether `short()` still holds once this device's own recent spends show their new notes (waited for only when it holds). */
  private async stillShort(short: () => boolean): Promise<boolean> {
    if (!short()) return false;
    await this.ownNotesShown();
    return short();
  }

  /**
   * Makes the zero-knowledge proof for one spend: `inputs` → `withdraw` lamports out of the pool
   * (the fee to `relayer`, the rest to the recipient `dest` names), with the change in the outputs.
   * Recipient, amount, fee and relayer are sealed inside the proof, so nobody can redirect it. For an
   * outside address the recipient is a one-time sending address made from the change note this proof
   * creates (so every proof gets its own, and the app can always find it again); for one of this
   * account's wallets, that wallet signs the spend's notes. `quiet` makes it in the background,
   * without showing progress.
   */
  private async prove(
    kind: Activity["kind"],
    inputs: OwnedNote[],
    dest: Dest,
    withdraw: bigint,
    relayerFee: bigint,
    relayer: string,
    outputs?: [bigint, bigint],
    quiet = false,
    older = false,
  ) {
    const { keys, pool } = this.need();
    const say = (step: string, detail?: string) => (quiet ? undefined : this.step(kind, step, detail));
    if (dest.kind === "fee" && withdraw !== relayerFee) throw new Error("Those amounts don't add up.");
    say("Checking the pool");
    const ring = await this.checkRoot();
    const size = older ? this.olderSize(ring, inputs) : undefined;
    // that check can refresh the notes; never prove with one that is gone or already spent
    const live = new Set(this.s.notes.map((n) => `${n.index}:${n.nullifier}`));
    if (!inputs.every((n) => live.has(`${n.index}:${n.nullifier}`))) {
      throw new Error("Your private balance changed a moment ago, so nothing was sent. Please try again.");
    }
    const sumIn = inputs.reduce((s, n) => s + n.amount, 0n);
    const outs = outputs ?? [sumIn - withdraw, 0n];
    if (outs[0] < 0n || outs[1] < 0n || outs[0] + outs[1] !== sumIn - withdraw) throw new Error("Those amounts don't add up.");
    const nonce0 = randomNonce();
    const notesOut = outs.map((a, i) => ({ amount: a.toString(), nonce: hex(i === 0 ? nonce0 : randomNonce()) }));
    // the change note's leaf, known before the proof: it names this payment's one-time sending address
    const out0 = noteLeaf(outs[0], noteInner(keys, nonce0));
    const hop = dest.kind === "pay" ? hopWallet(keys, out0) : null;
    const recipient = hop ? hop.publicKey : dest.kind === "own" ? dest.kp.publicKey : new PublicKey(relayer);
    const files = await zkFiles();
    say("Making your zero-knowledge proof", "This takes a few seconds on most devices.");
    const r = await call<{
      proof: string;
      root: string;
      nullifiers: string[];
      commitments: string[];
      meta0: string;
      meta1: string;
    }>({
      type: "prove",
      master: hex(keys.master),
      wasm: files.wasm,
      zkey: files.zkey,
      inputs: inputs.map((n) => ({
        index: n.index,
        leaf: n.leaf.toString(),
        amount: n.amount.toString(),
        nonce: hex(n.nonce),
        blinding: n.blinding.toString(),
        nullifier: n.nullifier.toString(),
      })),
      outputs: notesOut,
      ext: {
        recipient: recipient.toBase58(),
        relayer,
        withdraw: withdraw.toString(),
        relayerFee: relayerFee.toString(),
        maxFeeBps: pool.feeBps,
      },
      size,
    });
    // the program only takes a root it still holds: an older one it doesn't (never expected) means something is off
    if (size !== undefined && !ring.roots.includes(BigInt("0x" + r.root))) throw new Error("The pool data didn't check out against the chain. Please try again shortly.");
    // the sending address must be the one the change note names, or the app couldn't find it again
    if (BigInt("0x" + r.commitments[0]) !== out0) throw new Error("The proof didn't come out as expected, so nothing was sent. Please try again.");
    const request: RelayRequestBody = {
      proof: r.proof,
      root: r.root,
      nullifiers: r.nullifiers,
      commitments: r.commitments,
      recipient: recipient.toBase58(),
      withdraw: withdraw.toString(),
      relayerFee: relayerFee.toString(),
      maxFeeBps: pool.feeBps,
      meta0: r.meta0,
      meta1: r.meta1,
    };
    // one of this account's own wallets says so, by signing the spend's notes and its own address
    const own = dest.kind === "own" ? bs58.encode(signDelivery(ownMessage(r.nullifiers, dest.kp.publicKey), dest.kp)) : null;
    if (hop) this.hopOf.set(out0, hop.publicKey.toBase58());
    return { r, request, hop, own };
  }
  /**
   * For a payment that goes out at once: a random one of the recent pool roots that already holds
   * its notes, so the proof doesn't show the exact moment it was made. The root stays well inside
   * the pool's list (at most 96 back), so it can't age out while the payment is sent.
   */
  private olderSize(ring: { roots: bigint[]; rootIndex: number }, inputs: OwnedNote[]): number | undefined {
    const size = this.workerSize;
    const at = ring.roots.indexOf(this.lastWorkerRoot);
    if (at < 0 || !size) return undefined;
    const age = (ring.rootIndex - at + 256) % 256;
    const lowest = Math.max(1, ...inputs.map((n) => n.index + 1), size - Math.max(0, 96 - age));
    if (lowest >= size) return undefined;
    return randInt(lowest, size);
  }

  /**
   * Whether a proof's notes have been spent on-chain (their nullifier accounts exist), waiting up to
   * `ms`. False only when the last look answered "not spent"; null when the network couldn't say.
   */
  private async nullifiersSpent(nullifiers: string[], ms: number): Promise<boolean | null> {
    const pdas = nullifiers.map((h) => this.pool().nullifier(BigInt("0x" + h)));
    const until = Date.now() + ms;
    for (;;) {
      const infos = await this.accounts(pdas).catch(() => null);
      if (infos && infos.every((i) => i)) return true;
      // one more look once the time is up, so the answer is never older than the wait
      if (Date.now() >= until) return infos ? false : null;
      await sleep(Math.min(3000, Math.max(0, until - Date.now())));
    }
  }

  /** Whether any of these new notes (hex) is in the pool data, read once over the whole list. */
  private anyLeaf(commitments: string[]): boolean {
    const want = new Set(commitments.map((c) => c.toLowerCase()));
    for (let i = this.leafCount - 1; i >= 0 && want.size; i--) if (want.has(hex(this.leafBytes.subarray(i * LEAF_REC, i * LEAF_REC + 32)))) return true;
    return false;
  }

  /** How many notes a spend of `withdraw` has to join first, and what that costs (`fee` each: one relayer fee, unless you join them yourself). */
  mergePlan(withdraw: bigint, fee = this.relayerFee()): MergePlan {
    return mergePlan(
      this.freeNotes().map((n) => n.amount),
      fee,
      withdraw,
    );
  }

  /**
   * The most a buy can spend from the private balance, when `reserve` goes to the Vision wallet
   * on top: after the pool and relayer fees, and after joining notes when the balance is in more
   * pieces than one spend can take.
   */
  maxSpend(reserve = 0n): bigint {
    const fee = this.relayerFee();
    const w = maxWithdraw(
      this.freeNotes().map((n) => n.amount),
      fee,
    );
    if (w <= fee) return 0n;
    let x = splitWithdraw(w, fee, this.feeBps()).toRecipient - reserve;
    // rounding in the fee can put the exact inverse a few lamports over
    for (let i = 0; x > 0n && i < 64 && this.quoteSend(x + reserve).withdraw > w; i++) x -= 1n + x / 1_000_000_000n;
    return x > 0n ? x : 0n;
  }

  /** Joins two notes so a bigger amount fits in one spend: the two largest free ones, unless `pick` names them. */
  private async mergeOnce(pick?: OwnedNote[]) {
    const { pool } = this.need();
    if (!pool.relayer) throw new Error("No relayer is available right now. You can send it yourself below.");
    const notes = pick ?? [...this.freeNotes()].sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, 2);
    if (notes.length < 2) throw new Error("Not enough private balance.");
    const fee = this.relayerFee();
    await this.proveAndPayout("merge", notes, { kind: "fee" }, fee, fee);
    this.log({ kind: "merge", text: "Joined two notes" });
  }

  /** Notes for one spend of `withdraw`, joining pieces first when needed: `merge` joins two (through the relayer unless given), at `joinFee` each. */
  private async inputsFor(
    kind: Activity["kind"],
    withdraw: bigint,
    merge: () => Promise<void> = () => this.mergeOnce(),
    joinFee: bigint = this.relayerFee(),
  ): Promise<OwnedNote[]> {
    // pick from fresh data, so a note spent elsewhere a moment ago is never chosen
    this.step(kind, "Checking the pool");
    await this.sync();
    // a spend of ours that just landed may not show its new notes yet: they're given a moment before anything looks short
    await this.stillShort(() => !selectInputs(this.freeNotes(), withdraw) && !this.mergePlan(withdraw, joinFee).ok);
    await this.checkRoot();
    // joins only start when they're sure to make the spend fit, so none is paid for nothing
    for (let done = 0; ; done++) {
      const pick = selectInputs(this.freeNotes(), withdraw);
      if (pick) return pick;
      const plan = this.mergePlan(withdraw, joinFee);
      if (!plan.ok || done >= MAX_MERGES) {
        throw new Error(
          plan.pieces > 2 && this.spendable() >= withdraw
            ? `Your private balance is in ${plan.pieces} pieces, and joining them for one payment costs ${fmt(joinFee, 4)} SOL per join, so that amount doesn't fit. Try a smaller amount.`
            : "Not enough private balance for that amount, including fees.",
        );
      }
      this.step(kind, `Joining your balance (${done + 1} of ${done + plan.merges})`, "Your private balance is in several pieces. Each step joins two, privately inside the pool.");
      await merge();
    }
  }

  /** The one note a payment from the wallet may spend (its deposit's, by leaf), from fresh data: PinnedNote when it is gone or no longer covers `withdraw`. */
  private async pinnedNote(leaf: bigint, withdraw: bigint): Promise<OwnedNote[]> {
    this.step("send", "Checking the pool");
    await this.sync();
    const note = this.freeNotes().find((n) => n.leaf === leaf);
    if (!note) throw new PinnedNote("unsure");
    if (note.amount < withdraw) throw new PinnedNote("fees");
    return [note];
  }

  /** Picks notes and spends them; notes another device's scheduled payment turns out to hold are set aside and others tried. */
  private async withInputs<T>(kind: Activity["kind"], withdraw: bigint, spend: (inputs: OwnedNote[]) => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await spend(await this.inputsFor(kind, withdraw));
      } catch (e) {
        if (!(e instanceof NotesHeld) || i >= 2) throw e;
      }
    }
  }

  /**
   * Checks a send's recipients before anything moves. Without the network: each must be an address
   * this app may pay (not the pool's or the relayer's own, nor one of this account's sending
   * addresses), and one that looks like an earlier recipient but isn't, or that only a program can
   * sign for, is confirmed by the sender first. Then the server is asked: the sanctions list, and what
   * is at each address (a token account or a program can't receive SOL here). Later payments are
   * checked against the local list only, and a single later one isn't looked up at all (that would
   * show it before it goes): each gets the full check when it goes out. For payments the relayer
   * sends, a server that can't be asked is no reason to stop. `strict` is for a payment sent without
   * the relayer, which nothing checks again: no answer, no payment. Returns each address's kind, when known.
   */
  private async checkRecipients(parts: Part[], later: boolean, strict = false): Promise<(RecipientClass | null)[]> {
    const outside = parts.map((p) => !this.ownKeypairFor(p.to));
    const legs = this.legs();
    const reserved = this.reservedHere();
    const mine = new Set(legs.map((l) => l.hop));
    const recent = recentRecipients(legs, this.s.jobs);
    const who = (i: number) => (parts.length > 1 ? `Payment ${i + 1} (${shortAddr(parts[i].to)}): ` : "");
    for (const [i, p] of parts.entries()) {
      if (!outside[i]) continue;
      const why = recipientProblem(p.to, reserved, mine);
      if (why) throw new Error(who(i) + why);
      const like = p.lookalikeOk ? null : poisoned(p.to, recent);
      if (like) {
        throw new NeedsConfirm({ kind: "lookalike", address: p.to, similar: like, text: "This address looks like one you paid before, but it isn't the same one. Compare both in full before you send." });
      }
      if (!p.offCurveOk && offCurve(p.to)) throw new NeedsConfirm({ kind: "off-curve", address: p.to, text: OFF_CURVE_TEXT });
    }
    if (later && parts.length === 1 && !strict) return [null];
    let res: { address: string; ok: boolean; reason?: string; class?: RecipientClass | null; verdict?: string | null }[];
    try {
      // the relayer screens a payment it sends fully when it sends it: only one sent without it is fully screened here
      res = await api("/api/relay/check", { json: { v: 2, recipients: parts.map((p) => p.to), later, full: strict } });
    } catch (e) {
      if (e instanceof ApiError) this.refusal(e);
      if (!strict) return parts.map(() => null);
      if (e instanceof ApiError && e.status === 451) throw new Error(e.message);
      const wait = e instanceof ApiError && e.retryAfter ? `in ${e.retryAfter} seconds` : "in a moment";
      throw new Error(`Couldn't check the recipient right now, so nothing was sent. Try again ${wait}.`);
    }
    for (const [i, x] of res.entries()) {
      // one of this account's own wallets is never a token account or a program's
      if (outside[i] && x.verdict === "blocked" && x.class) throw new Error(who(i) + refusalText(x.class));
      if (x.ok) continue;
      if (x.reason === "unavailable") throw new Error("Screening is briefly unavailable, so nothing was sent. Please try again in a moment.");
      throw new Error(`${parts.length > 1 ? `Payment ${i + 1} (${shortAddr(parts[i].to)}): this address` : "This address"} can't receive from VisionSwap. Nothing was sent.`);
    }
    return res.map((x, i) => (outside[i] ? (x.class ?? null) : null));
  }

  /**
   * Several private payments at once (or one), each its own proof. "now" sends one payment straight
   * away; several "now" go to the relayer to leave one by one at random moments over two minutes, so
   * they don't land together. Later ones each leave at their own random moment inside the window.
   * A payment to an outside address arrives as a standard SOL transfer from a one-time sending
   * address; one to this account's own wallets is paid by the pool directly. `onPart` hears about
   * each payment as soon as it has an outcome, so a form can take it out and pressing the button
   * again never pays anyone twice. `pin` (one payment from the wallet) spends only the note with that
   * leaf, never any other private balance: if it is gone, held elsewhere or too small, it stops (PinnedNote).
   */
  async sendMany(parts: Part[], when: When = "now", onPart?: (index: number, outcome: PartOutcome) => void, pin?: bigint) {
    const outcomes: (PartOutcome | undefined)[] = [];
    const mark = (i: number, o: PartOutcome) => {
      outcomes[i] = o;
      onPart?.(i, o);
    };
    let current = -1;
    try {
      // (a payment from the wallet sent by itself leaves any question the form is asking alone)
      if (!this.bgTask) this.set({ ask: null });
      this.step("send", "Checking the pool");
      const { pool } = this.need();
      if (!parts.length) throw new Error("Add a recipient first.");
      const offered = pool.sendLater ?? [];
      if (when !== "now" && !offered.includes(when)) throw new Error("Sending later isn't available right now. Send now instead.");
      const n = parts.length;
      // several payments "now" are spread over a couple of minutes by the relayer, when it offers that
      const window: Window | null = when !== "now" ? when : n > 1 && offered.includes("2m") ? "2m" : null;
      const later = window !== null && window !== "2m";
      if (parts.some((p) => !this.ownKeypairFor(p.to))) this.deliveryGate();
      const kinds = await this.checkRecipients(parts, later);
      const rentMin = BigInt(await conn().getMinimumBalanceForRentExemption(0));
      await this.readTreasury();
      const plans: { to: PublicKey; q: ReturnType<Engine["quoteSend"]>; dest: Dest }[] = [];
      for (const [i, p] of parts.entries()) {
        const to = new PublicKey(p.to);
        // a fresh wallet that something else used meanwhile (another device of this account, say) would tie the two together
        if (p.fresh && (await this.hasHistory(to))) throw new Error(`That fresh Vision wallet (${shortAddr(p.to)}) was used meanwhile. Nothing was sent: remove it and add a new fresh wallet.`);
        const own = this.ownKeypairFor(p.to);
        // the one-time sending address pays its own fee and must keep nothing or the rent minimum once that is
        // taken, and what it keeps then is the amount: so the amount is at least the rent minimum, for any recipient
        if (!own && p.amount < rentMin) throw new Error(`The smallest private send is ${fmtUp(rentMin, 5)} SOL${parts.length > 1 ? ` (${shortAddr(p.to)})` : ""}.`);
        const q = own ? this.quoteSend(p.amount) : this.quotePay(p.amount);
        // a later payment isn't looked up now (that would show it before it goes): it just has to be big enough to open any address
        const k = kinds[i];
        const exists = later ? false : k ? k !== "new" && k !== "new-off-curve" : (await conn().getBalance(to, "confirmed")) > 0;
        if (!exists && q.toRecipient < rentMin) throw new Error(`A new address needs at least ${fmt(rentMin)} SOL to exist (${shortAddr(p.to)}).`);
        const dest: Dest = own
          ? { kind: "own", kp: own }
          : { kind: "pay", to, amount: q.toRecipient, mode: window === null ? "instant" : "scheduled", ...(p.offCurveOk ? { offCurveOk: true } : {}) };
        plans.push({ to, q, dest });
      }
      const total = plans.reduce((s, x) => s + x.q.withdraw, 0n);
      // this account's own Vision wallets among them: listed as soon as they're paid, and named in what's said after
      const mine = plans.map((x) => (x.dest.kind === "own" ? this.visionIndexOf(x.to.toBase58()) : null));
      const mineAll = mine.filter((i): i is number => i != null);
      // (a pinned note is checked on its own when it is picked)
      if (pin == null && (await this.stillShort(() => total > this.spendable()))) throw new Error("Not enough private balance for these payments, including fees.");
      if (window === null) {
        let last: Paid | null = null;
        for (const [i, { to, q, dest }] of plans.entries()) {
          current = i;
          if (n > 1) this.step("send", `Payment ${i + 1} of ${n}`);
          try {
            const paid =
              pin != null
                ? await this.proveAndPayout("send", await this.pinnedNote(pin, q.withdraw), dest, q.withdraw, q.relayerFee).catch((e) => {
                    throw e instanceof NotesHeld ? new PinnedNote("unsure") : e;
                  })
                : await this.withInputs("send", q.withdraw, (inputs) => this.proveAndPayout("send", inputs, dest, q.withdraw, q.relayerFee));
            last = paid;
            mark(i, "sent");
            this.logSent({ kind: "send", text: `Sent ${fmt(q.toRecipient)} SOL to ${this.addressName(to.toBase58())}`, sig: paid.sig || undefined, ...(paid.hop ? { delivery: { hop: paid.hop, to: to.toBase58() } } : {}) });
            // a Vision wallet of this account's is read straight away, so it's listed under Wallets at once
            const vi = mine[i];
            if (vi != null) await this.refreshVision([vi]).catch(() => {});
          } catch (e) {
            if (e instanceof MaybeSent) mark(i, "checking");
            throw e;
          }
        }
        const one = plans[0];
        const delivered = !!last?.hop && !!last.sig;
        const own = mineAll.length ? ownPaidText(mineAll, true) : "";
        this.done(
          n > 1 ? `${n} payments sent privately` : "Sent privately",
          n > 1
            ? `Each came from the pool in its own transaction, and your wallet is in none of them.${plans.some((x) => x.dest.kind === "pay") ? " Each arrives as a standard SOL transfer." : ""}${own ? ` ${own}` : ""}`
            : one.dest.kind === "pay"
              ? delivered
                ? `${fmt(one.q.toRecipient)} SOL arrived at ${shortAddr(one.to.toBase58())} as a standard SOL transfer.`
                : `${fmt(one.q.toRecipient)} SOL is on its way to ${shortAddr(one.to.toBase58())} as a standard SOL transfer. The app finishes it for you while it's open.`
              : own
                ? `${fmt(one.q.toRecipient)} SOL came from the pool, and your wallet is not part of the transaction. ${own}`
                : `${fmt(one.q.toRecipient)} SOL has arrived at ${shortAddr(one.to.toBase58())}. It came from the pool, and your wallet is not part of the transaction.`,
          n === 1 ? last?.sig || undefined : undefined,
          !!own,
        );
        return;
      }
      // later (or spread): every payment needs notes of its own, so each can go out at its own moment
      const exact = window !== "2m";
      let assigned =
        pin != null
          ? [await this.pinnedNote(pin, plans[0].q.withdraw)]
          : await this.prepareNotes(
              plans.map((x) => x.q.withdraw),
              exact,
            );
      for (let i = 0, held = 0; i < n; ) {
        const { q, dest } = plans[i];
        current = i;
        this.step("send", n > 1 ? `Scheduling payment ${i + 1} of ${n}` : "Scheduling your payment");
        try {
          mark(i, await this.scheduleOne(assigned[i], dest, q, window));
          i++;
        } catch (e) {
          // a pinned note held elsewhere (another tab or device of this account handed it over): never another note
          if (pin != null && e instanceof NotesHeld) throw new PinnedNote("unsure");
          // those notes belong to a payment scheduled on another device (set aside now): the rest get other notes
          if (!(e instanceof NotesHeld) || ++held > 2) throw e;
          assigned = [...assigned.slice(0, i), ...(await this.prepareNotes(plans.slice(i).map((x) => x.q.withdraw), exact))];
        }
      }
      const unsure = outcomes.filter((o) => o === "checking").length;
      // payments the person cancelled while they were being handed over aren't counted as on their way
      const cancelled = outcomes.filter((o) => o === "cancelled").length;
      if (cancelled === n) {
        this.done(n > 1 ? "Payments cancelled" : "Payment cancelled", `${n > 1 ? "They" : "It"} won't go out. That SOL is spendable again.`);
        return;
      }
      const going = n - cancelled;
      // (the ones cancelled meanwhile aren't going anywhere)
      const ownGoing = mine.filter((x, i): x is number => x != null && outcomes[i] !== "cancelled");
      const own = ownGoing.length ? ownPaidText(ownGoing, false) : "";
      this.done(
        window === "2m" ? (going > 1 ? `${going} payments on their way` : "Payment on its way") : going > 1 ? `${going} payments scheduled` : "Payment scheduled",
        (window === "2m"
          ? going > 1
            ? "They go out one by one at random moments over the next 2 minutes, so they don't land together."
            : "It goes out at a random moment over the next 2 minutes."
          : `${going > 1 ? "Each one goes" : "It goes"} out at a random moment within the next ${WINDOW_LABEL[window]}.`) +
          (cancelled ? ` The ${cancelled > 1 ? `${cancelled} you cancelled` : "one you cancelled"} won't go out.` : "") +
          (own ? ` ${own}` : "") +
          (unsure
            ? ` ${unsure === n ? (n > 1 ? "They" : "It") : `${unsure} of them`} may not have reached the relayer yet: keep this page open a moment so the app can hand ${unsure > 1 ? "them" : "it"} over again.`
            : window === "2m"
              ? " You can close this page."
              : " You can close this page, or cancel under Scheduled payments."),
        undefined,
        !!own,
      );
    } catch (e) {
      // a recipient for the sender to confirm: asked on the form, nothing sent yet (work running by
      // itself never asks there: its caller says so where it is listed)
      if (e instanceof NeedsConfirm) {
        if (this.bgTask) {
          this.bgTask = null;
          this.set({ busy: null });
        } else this.set({ busy: null, ask: e.ask });
        throw e;
      }
      // said like any failure, and kept as it is so the payment from the wallet knows what to ask
      if (e instanceof PinnedNote) {
        this.report(e);
        throw e;
      }
      // a split that stopped partway says who was paid, and which payment didn't go
      if (parts.length > 1 && current >= 0) this.fail(new Error(splitSummary(parts, outcomes, current, (e as Error)?.message ?? "no reason given")));
      this.fail(e);
    }
  }

  /**
   * What getting notes ready for later payments costs: one relayer fee per cut or join (see
   * prepStep). A later payment holds its notes until it goes out, so it gets a note of (nearly) its
   * own size: only what it sends is set aside, never the rest of the balance. Payments spread over
   * two minutes (`exact` off) may hold a bigger note for that short time, so only a missing note costs a cut.
   */
  prepCost(needs: bigint[], exact = true): bigint {
    return BigInt(this.prepPlan(needs, exact).steps) * this.relayerFee();
  }

  /** The cuts and joins later payments need from the notes free now, and whether they fit at all. */
  prepPlan(needs: bigint[], exact = true): { steps: number; ok: boolean } {
    return prepPlan(
      this.freeNotes().map((nt) => nt.amount),
      needs,
      this.relayerFee(),
      exact,
    );
  }

  /**
   * Gives each later payment notes of its own: a note is cut into one of exactly the amount needed
   * and the rest, or two are joined (each a private self-transfer inside the pool), until every
   * payment has one. Never more steps than the plan worked out before the first one (and one to
   * spare): if the balance changes under it, it stops rather than paying on. Returns the notes for
   * each payment, in order.
   */
  private async prepareNotes(needs: bigint[], exact = true): Promise<OwnedNote[][]> {
    const { pool } = this.need();
    if (!pool.relayer) throw new Error("No relayer is available right now. You can send it yourself below.");
    const fee = this.relayerFee();
    const short = "Not enough private balance for these payments, including fees.";
    let spent = 0;
    let allowed = -1;
    for (let round = 0; round < prepRounds(needs.length); round++) {
      await this.sync();
      // the cut just made may not show its new notes yet: they're waited for before the balance counts as short
      await this.stillShort(() => !this.prepPlan(needs, exact).ok);
      const free = this.freeNotes();
      if (allowed < 0) {
        // planned from the notes as they are now: nothing is spent on a plan that can't finish
        const plan = this.prepPlan(needs, exact);
        if (!plan.ok) throw new Error(short);
        allowed = spent + plan.steps + 1;
      }
      const st = prepStep(
        free.map((nt) => ({ id: nt.index, amount: nt.amount })),
        needs,
        fee,
        exact,
      );
      const note = (id: number) => free.find((nt) => nt.index === id)!;
      if (st.kind === "ready") return st.picks.map((id) => [note(id)]);
      if (st.kind === "short") throw new Error(short);
      if (spent >= allowed) throw new Error("Your private balance changed while the payments were being prepared. Nothing was scheduled; please try again.");
      try {
        this.step("send", "Preparing separate notes", "One private transfer inside the pool per payment, so each can go out on its own.");
        if (st.kind === "cut") {
          const big = note(st.note);
          await this.proveAndPayout("send", [big], { kind: "fee" }, fee, fee, [st.need, big.amount - st.need - fee]);
          this.log({ kind: "merge", text: `Set aside ${fmt(st.need)} SOL for a scheduled payment` });
        } else {
          await this.mergeOnce(st.notes.map(note));
        }
        spent++;
      } catch (e) {
        // those notes turned out to be held by a payment made on another device: they're set aside now, and it plans again
        if (e instanceof NotesHeld) {
          allowed = -1;
          continue;
        }
        throw e;
      }
    }
    throw new Error("The payments couldn't be prepared. Please try again.");
  }

  /** The token that lets this account (on any of its devices) cancel or refresh a scheduled payment. */
  private async jobToken(id: string): Promise<string> {
    const { keys } = this.need();
    const data = new Uint8Array([...keys.master, ...new TextEncoder().encode(`vs:sched:${id}`)]);
    return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  }

  /**
   * Proves one payment now and hands it to the relayer to send within `window`. "checking" when the
   * relayer's answer couldn't be had: the payment is kept here and handed over again while the app is open.
   * To an outside address, the hop's N2 transfer is signed here on a durable nonce the relayer leases
   * to this payment's id, so it is delivered as a standard SOL transfer while the page is closed.
   */
  private async scheduleOne(inputs: OwnedNote[], dest: Dest, q: ReturnType<Engine["quoteSend"]>, window: Window): Promise<PartOutcome> {
    const { pool } = this.need();
    const keys = this.keys;
    const id = hex(crypto.getRandomValues(new Uint8Array(12)));
    const token = await this.jobToken(id);
    // each payment proves against its own random recent root, so payments made together don't all name the same one
    // (notes cut a moment ago have no older root yet: those get a fresh proof shortly before they go, see needsProof)
    const p = await this.prove("send", inputs, dest, q.withdraw, q.relayerFee, pool.relayer!, undefined, false, true);
    this.step("send", "Handing it to the relayer for later");
    const to = dest.kind === "pay" ? dest.to.toBase58() : dest.kind === "own" ? dest.kp.publicKey.toBase58() : pool.relayer!;
    const body = await this.handOverBody(p.request, dest, p.hop, p.own, window, id, token);
    const job: Job = {
      id,
      token,
      to,
      amount: q.toRecipient.toString(),
      withdraw: q.withdraw.toString(),
      window,
      created: Date.now(),
      latest: Date.now() + WINDOW_MS[window],
      nullifiers: inputs.map((nt) => nfHex(nt.nullifier)),
      request: p.request,
      outs: p.request.commitments,
      status: "scheduled",
      ...(p.hop ? { hop: p.hop.publicKey.toBase58() } : {}),
      ...(p.own ? { own: p.own } : {}),
      ...(dest.kind === "pay" && dest.offCurveOk ? { offCurveOk: true } : {}),
    };
    if (p.hop) this.saveLeg({ hop: p.hop.publicKey.toBase58(), out0: p.request.commitments[0], to, amount: q.toRecipient.toString(), status: "proved", at: Date.now(), job: id });
    // kept before it is handed over: if the answer is lost, the next look hands it over again under the same id
    this.saveJobs([job, ...this.s.jobs]);
    let res: { latest?: number } | null;
    // while it is being handed over, a hand-back can't race it and a cancel knows to wait for the answer
    this.handing.add(id);
    // set when a try ended without a clear answer: only then may the relayer hold it after a refusal
    const seen = { unclear: false };
    try {
      res = await this.handOver(id, body, seen);
    } catch (e) {
      // they belong to a payment scheduled on another device: set aside, so other notes are picked
      if (e instanceof ApiError && e.data?.code === "held") {
        const cur = this.keys === keys ? this.s.jobs.find((x) => x.id === id) : undefined;
        const off = cancelledMeanwhile(cur, seen.unclear, true);
        if (off) {
          // cancelled while it was being handed over: never scheduled again under a new id, the cancel stands
          this.setAside(e.data);
          if (off === "cancelled") {
            this.patchJobs(id, { cancelPending: undefined }, ["cancelled"]);
            return "cancelled";
          }
          return this.callOffCancelled(job, keys, true);
        }
        this.saveJobs(this.s.jobs.filter((x) => x.id !== id));
        this.setAside(e.data);
        throw new NotesHeld();
      }
      if (this.keys !== keys) return "checking";
      const off = cancelledMeanwhile(this.s.jobs.find((x) => x.id === id), seen.unclear);
      if (off) {
        // cancelled meanwhile: refused on every clear answer, so the relayer holds nothing and the cancel stands
        if (off === "cancelled") {
          this.patchJobs(id, { cancelPending: undefined }, ["cancelled"]);
          return "cancelled";
        }
        return this.callOffCancelled(job, keys, true);
      }
      if (seen.unclear) {
        // an earlier try may have got there: it is called off there before it's called not sent
        const ended = await this.callOff(id, token);
        if (this.keys !== keys) return "checking";
        if (ended === "going") {
          this.patchJobs(id, { status: "sending" });
          return "checking";
        }
        // can't tell right now: kept, and the app keeps asking
        if (!ended) return "checking";
      }
      // refused: it isn't scheduled, so its notes are free again
      this.saveJobs(this.s.jobs.filter((x) => x.id !== id));
      throw e;
    } finally {
      this.handing.delete(id);
    }
    if (this.keys !== keys) return res ? "scheduled" : "checking";
    // cancelled (or cleared from the list) while it was being handed over: called off there too, never said to be scheduled
    const cur = this.s.jobs.find((x) => x.id === id);
    if (!cur || !isLive(cur.status)) return this.callOffCancelled(job, keys, !res);
    if (res?.latest) this.saveJobs(patchJob(this.s.jobs, id, { latest: res.latest }));
    this.log({ kind: "send", text: `Scheduled ${fmt(q.toRecipient)} SOL to ${this.nameWith(job.to, `within ${WINDOW_LABEL[window]}`)}` });
    return res ? "scheduled" : "checking";
  }

  /**
   * Hands a scheduled payment to the relayer under its id. Only a definite refusal is thrown: a lost
   * or unclear answer may hide one that got there, so the relayer is asked about that id, and the
   * same request goes again (same id and token, so it can never become two). Returns what the relayer
   * said (its deadline), {} when it turned out to be there already, or null when that can't be told yet.
   */
  private async handOver(id: string, body: Record<string, unknown>, seen = { unclear: false }): Promise<{ latest?: number } | null> {
    // `seen.unclear`: an earlier try ended without a clear answer, so it may have got there (the caller reads it too)
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        await sleep(2000 * attempt);
        // cancelled here meanwhile: not sent again (the caller calls it off there, in case a try got through)
        if (!this.s.jobs.some((j) => j.id === id && isLive(j.status))) return null;
        const r = await this.jobReplies([id]).catch(() => null);
        if (r?.[0] && r[0].status !== "unknown") return {};
      }
      try {
        return await api<{ latest: number }>("/api/relay/schedule", { json: body });
      } catch (e) {
        if (!(e instanceof ApiError) || !definite(e)) {
          seen.unclear = true;
          continue;
        }
        // it is there already and going (or gone) out: an earlier try made it
        if (e.data?.code === "going" || e.data?.code === "sent" || (e.status === 409 && /already (going|gone) out/i.test(e.message))) return {};
        // busy for a moment: wait as long as it asks, then go on
        if ((e.status === 429 || e.data?.code === "busy") && attempt < 3) {
          await sleep(Math.min(60, e.retryAfter ?? 20) * 1000);
          continue;
        }
        // the first try may still be being checked there: look again
        if (attempt > 0 && e.data?.code === "in_flight") continue;
        if (seen.unclear) {
          // a refusal now doesn't mean an earlier try didn't make it: asked once more
          const r = await this.jobReplies([id]).catch(() => null);
          if (!r) return null;
          const st = r[0]?.status;
          if (st === "scheduled" || st === "stale" || (st && goneOut(st))) return {};
        }
        throw e;
      }
    }
    return null;
  }

  /**
   * Asks the relayer to drop a job it may hold. "ended" when it doesn't (or no longer) hold it,
   * "going" when it is already going out, null when that can't be told right now.
   */
  private async callOff(id: string, token: string): Promise<"ended" | "going" | null> {
    try {
      const r = await api<{ status: Job["status"] | "unknown" }>("/api/relay/cancel", { json: { id, token } });
      return goneOut(r.status) ? "going" : "ended";
    } catch (e) {
      // the server's own refusal of the cancel (not one lost on the way, nor a busy moment) means it holds nothing to call off
      return e instanceof ApiError && definite(e) && e.status !== 429 && e.status < 500 ? "ended" : null;
    }
  }

  /** A cancel the relayer couldn't confirm: asked again. Settled once it says the job has ended, or that it is already going out. */
  private async settleCancel(j: Job) {
    const r = await this.callOff(j.id, j.token);
    if (r === "ended") this.patchJobs(j.id, { cancelPending: undefined }, ["cancelled"]);
    else if (r === "going") {
      this.patchJobs(j.id, { status: "sending", cancelPending: undefined }, ["cancelled"]);
      this.say({ error: `The payment of ${fmt(BigInt(j.amount))} SOL to ${this.addressName(j.to)} was already going out, so it couldn't be cancelled.` });
    }
  }

  /**
   * A payment cancelled (or cleared from the list) while it was being handed over: called off there
   * too, and never reported as scheduled. `unsure`: the hand-over had no clear answer, so it may yet
   * show up there, and the app keeps calling it off for a while even if the relayer holds nothing now.
   */
  private async callOffCancelled(job: Job, keys: Keys | null, unsure: boolean): Promise<PartOutcome> {
    const r = await this.callOff(job.id, job.token);
    if (this.keys !== keys) return "checking";
    const cur = this.s.jobs.find((x) => x.id === job.id);
    if (r === "going") {
      if (cur) this.patchJobs(job.id, { status: "sending", cancelPending: undefined }, ["cancelled"]);
      else this.saveJobs([{ ...job, status: "sending" }, ...this.s.jobs]);
      this.say({ error: `The payment of ${fmt(BigInt(job.amount))} SOL to ${this.addressName(job.to)} was already going out, so it couldn't be cancelled.` });
      return "scheduled";
    }
    if (!r || unsure) {
      // kept (listed again if it was cleared) as a cancel still to be confirmed: the next looks call it off
      if (cur) this.patchJobs(job.id, { cancelPending: true }, ["cancelled"]);
      else this.saveJobs([{ ...job, status: "cancelled", cancelPending: true }, ...this.s.jobs]);
      return "checking";
    }
    if (cur) this.patchJobs(job.id, { cancelPending: undefined }, ["cancelled"]);
    return "cancelled";
  }

  private saveJobs(jobs: Job[]) {
    // finished payments stay listed for two days, then only the activity list remembers them; one whose
    // delivery is still open (or whose cancel isn't confirmed yet) stays until it is done, for a month at most
    const now = Date.now();
    const keep = jobs.filter((j) => isLive(j.status) || ((isOpen(j.status) || j.cancelPending) && now - j.created < 30 * 86_400_000) || now - j.created < 48 * 3_600_000);
    // a payment to one of this account's Vision wallets that just went out: that wallet is read straight away, so it's listed at once
    const was = new Map(this.s.jobs.map((j) => [j.id, j.status]));
    const landed = keep.filter((j) => j.status === "sent" && was.has(j.id) && was.get(j.id) !== "sent");
    if (this.s.fingerprint) ls.set(`vs:jobs:${this.s.fingerprint}`, keep);
    this.set({ jobs: keep });
    this.refilter();
    const idx = landed.map((j) => this.visionIndexOf(j.to)).filter((i): i is number => i != null);
    if (idx.length) {
      for (const i of idx) this.landedAt.set(i, now);
      void this.refreshVision(idx).catch(() => {});
    }
  }
  /** Vision wallets a scheduled payment just reached (index -> when), until they're read: they show "Arriving" meanwhile. */
  private landedAt = new Map<number, number>();

  /**
   * Vision wallets with SOL on its way from a scheduled payment (the Wallets tab lists them from the
   * moment they're scheduled), and ones whose payment just went out that haven't been read yet.
   */
  visionArriving(): { index: number; amount: bigint; by: number }[] {
    const out: { index: number; amount: bigint; by: number }[] = [];
    for (const j of this.s.jobs) {
      if (!isLive(j.status) && j.status !== "sent") continue;
      const i = this.visionIndexOf(j.to);
      if (i == null) continue;
      // one that went out shows until its wallet has been read (2 minutes at most)
      if (!isLive(j.status) && !(Date.now() - (this.landedAt.get(i) ?? 0) < 120_000)) continue;
      out.push({ index: i, amount: BigInt(j.amount), by: j.latest });
    }
    return out;
  }

  /** Changes one job as it is now, only while it is still in one of `from` (a cancel is never undone). */
  private patchJobs(id: string, patch: Partial<Job>, from: readonly JobStatus[] = ["scheduled", "sending", "stale", "delivering", "waiting"]) {
    this.saveJobs(patchJob(this.s.jobs, id, patch, from));
  }

  private polling = false;
  /** Jobs being handed to the relayer for the first time right now (see scheduleOne). */
  private handing = new Set<string>();
  /** Asks the relayer how the scheduled payments are doing, and acts on what changed. One look at a time. */
  async pollJobs() {
    if (this.polling || !this.keys) return;
    this.polling = true;
    try {
      await this.pollJobsOnce();
    } finally {
      this.polling = false;
    }
  }

  /** What the relayer says about these scheduled payments, asked in the body so the ids never sit in a URL. */
  private jobReplies(ids: string[]): Promise<JobReply[]> {
    return api<JobReply[]>("/api/relay/jobs/status", { json: { ids } });
  }

  private async pollJobsOnce() {
    const keys = this.keys;
    const groups = pollGroups(this.s.jobs);
    if (!groups.length) return;
    const replies: JobReply[] = [];
    for (const ids of groups) {
      try {
        replies.push(...(await this.jobReplies(ids)));
      } catch {
        break;
      }
    }
    if (this.keys !== keys || !replies.length) return;
    // a sending address the relayer names is taken only when it is the job's own
    const m = mergeReplies(this.s.jobs, replies, (j, h) => this.ownJobHop(j, h));
    // a payment whose pool spend landed: its delivery is kept in the ledger like one sent now (until it is
    // done), before the list is saved, so one dropped from the list still leaves its leg to be finished
    for (const j of m.list) {
      if ((j.status !== "delivering" && j.status !== "waiting") || !j.hop) continue;
      if (this.legs().find((l) => l.hop === j.hop)?.status === "proved") this.patchLeg(j.hop, { status: "sent", ...(j.tx1 ? { tx1: j.tx1 } : {}) });
    }
    if (JSON.stringify(m.list) !== JSON.stringify(this.s.jobs)) this.saveJobs(m.list);
    let changed = m.changed.length > 0;
    // "sent" is said only once its notes are seen spent on-chain too
    for (const id of m.sent) {
      const j = this.s.jobs.find((x) => x.id === id);
      const r = replies.find((x) => x.id === id);
      if (!j || !r || !isOpen(j.status)) continue;
      const spent = await this.nullifiersSpent(j.nullifiers, 0);
      // locked or switched meanwhile: left live for its own account's next look
      if (this.keys !== keys) return;
      if (spent === false) {
        this.patchJobs(id, { status: "sending", signature: r.signature });
        continue;
      }
      const own = !!r.hop && this.ownJobHop(j, r.hop);
      const hop = own ? r.hop : j.hop;
      let signature = r.signature;
      // a delivery's Transaction ID is taken from its sending address's own history, never on the relayer's word
      // alone: the first transfer the address paid for itself, to this payment's recipient. One that paid elsewhere
      // first (this account moved its SOL into the private balance, or on to another address) was never delivered.
      if (hop) {
        const bal = await conn()
          .getBalance(new PublicKey(hop), "confirmed")
          .catch(() => null);
        if (this.keys !== keys) return;
        if (bal === null) continue;
        const tx1 = (own ? r.tx1 : undefined) ?? j.tx1;
        const by = await this.deliveredFrom(new PublicKey(hop), { tx1, to: j.to });
        if (this.keys !== keys) return;
        // its history couldn't be read: asked again next time
        if (by === undefined) continue;
        if (by === null && this.movedElsewhere(hop, tx1)) {
          this.patchJobs(id, { status: "failed", error: MOVED_ELSEWHERE, note: null });
          changed = true;
          continue;
        }
        if (by === null && BigInt(bal) >= (this.s.rent?.wallet ?? 0n) + DELIVERY_FEE) {
          // finished from here (see finishJobs)
          this.patchJobs(id, { status: "waiting" });
          changed = true;
          continue;
        }
        // the transfer the relayer named isn't in the address's history yet: asked again next time
        if (by === null && signature) continue;
        signature = by;
      }
      this.patchJobs(id, { status: "sent", signature, error: null, note: null });
      // a delivery's signature is the standard transfer the recipient sees: its Transaction ID
      if (hop && signature) this.patchLeg(hop, { status: "delivered", tx2: signature, done: Date.now() });
      if (hop && signature) this.logDelivery({ kind: "send", text: `Sent ${fmt(BigInt(j.amount))} SOL to ${this.nameWith(j.to, "scheduled")}`, sig: signature, delivery: { hop, to: j.to } });
      else this.log({ kind: "send", text: `Sent ${fmt(BigInt(j.amount))} SOL to ${this.nameWith(j.to, "scheduled")}`, sig: signature ?? undefined });
      changed = true;
    }
    // the relayer no longer knows these (lost, or forgotten long after they ended)
    for (const r of replies) {
      if (this.keys !== keys) return;
      const j = this.s.jobs.find((x) => x.id === r.id);
      // (one made a moment ago, or still being handed over, may still be on its way there)
      if (r.status === "unknown" && j && isLive(j.status) && !this.handing.has(j.id) && Date.now() - j.created > 30_000) await this.handBack(j).catch(() => {});
    }
    // cancels the relayer couldn't confirm: asked again while it may still hold the job
    for (const r of replies) {
      if (this.keys !== keys) return;
      const j = this.s.jobs.find((x) => x.id === r.id);
      if (!j?.cancelPending || isLive(j.status) || this.handing.has(j.id)) continue;
      if (r.status === "unknown") {
        // never there after all: once its deadline is well past, nothing can bring it back
        if (Date.now() > j.latest + 3_600_000) this.patchJobs(j.id, { cancelPending: undefined }, ["cancelled"]);
      } else if (isLive(r.status) || goneOut(r.status)) await this.settleCancel(j);
      else this.patchJobs(j.id, { cancelPending: undefined }, ["cancelled"]);
    }
    if (changed) {
      this.changedAt = Date.now();
      if (m.sent.length) void this.sync().catch(() => {});
    }
    // fresh proofs, one at a time, in the background
    void this.refreshJobs();
  }

  /**
   * A job the relayer doesn't hold: if its notes are unspent it is handed back under the same id,
   * keeping its deadline. If they are spent, the chain says whether it went (see settleSpentJob).
   */
  private async handBack(j: Job) {
    // locked or switched meanwhile: the job is left as it is, for its own account
    const keys = this.keys;
    const went = await this.nullifiersSpent(j.nullifiers, 0);
    if (this.keys !== keys) return;
    if (went === null) return; // can't tell right now: asked again next time
    if (went) return this.settleSpentJob(j);
    if (!j.request) return this.patchJobs(j.id, { status: "stale" });
    const now = Date.now();
    const window: Window = j.latest > now + 2 * 60_000 ? j.window : "15m";
    try {
      const body = await this.handBackBody(j, window, j.latest > now ? j.latest : undefined);
      // made before deliveries: it needs a fresh proof, which the app makes next
      if (!body) return this.patchJobs(j.id, { status: "stale" });
      const res = await api<{ id: string; token: string; latest: number }>("/api/relay/schedule", { json: body });
      await this.applyScheduled(j.id, res, { window }, keys);
    } catch (e) {
      if (!(e instanceof ApiError) || this.keys !== keys) return;
      if (e.data?.code === "stale" || /moved on|fee changed|did not check out|no longer covers/i.test(e.message)) this.patchJobs(j.id, { status: "stale" });
      else if (e.status === 403 || e.status === 451 || e.data?.code === "recipient") this.patchJobs(j.id, { status: "failed", error: e.message });
      // anything else: asked again next time
    }
  }

  /** A scheduled payment's recipient as a Dest: a wallet of this account's own, or an outside address (delivered). */
  private jobDest(j: Job, amount = BigInt(j.amount)): Dest {
    const own = this.ownKeypairFor(j.to);
    return own ? { kind: "own", kp: own } : { kind: "pay", to: new PublicKey(j.to), amount, mode: "scheduled", ...(j.offCurveOk ? { offCurveOk: true } : {}) };
  }

  /** What a scheduled payment is handed over with: its proof, with the hop's signed N2 (an outside address) or its own wallet's signature. */
  private async handOverBody(request: RelayRequestBody, dest: Dest, hop: Keypair | null, own: string | null, window: Window, id: string, token: string, until?: number) {
    const base = { v: 2, request, window, token, id, ...(until ? { until } : {}) };
    if (dest.kind === "pay" && hop) return { ...base, delivery: await this.signScheduled(request, dest, hop, id, token) };
    if (own) return { ...base, own: { sig: own } };
    return base;
  }

  /**
   * A scheduled payment's proof handed back as it is: its own wallet signs again, or its sending
   * address (made again from the proof's change note) signs a fresh N2 on the nonce the relayer
   * leases to it now. Null for one made before deliveries, which needs a fresh proof.
   */
  private async handBackBody(j: Job, window: Window, until?: number) {
    const { keys } = this.need();
    const req = j.request as RelayRequestBody;
    const own = this.ownKeypairFor(j.to);
    if (own) {
      if (req.recipient !== own.publicKey.toBase58()) return null;
      const sig = j.own ?? bs58.encode(signDelivery(ownMessage(req.nullifiers, own.publicKey), own));
      return this.handOverBody(req, { kind: "own", kp: own }, null, sig, window, j.id, j.token, until);
    }
    const hop = hopWallet(keys, BigInt("0x" + req.commitments[0]));
    if (hop.publicKey.toBase58() !== req.recipient) return null;
    return this.handOverBody(req, this.jobDest(j), hop, null, window, j.id, j.token, until);
  }
  /**
   * A scheduled payment whose notes are spent, and the relayer can't say how: did it go out itself?
   * Its send is looked up on the chain, then its own new notes in the pool data. "Spent in another
   * payment" is said only once this device's pool data covers the chain and holds none of the new
   * notes of any proof it was given; if that can't be told it says "check your activity", never "not sent".
   */
  private async settleSpentJob(j: Job) {
    let landed = false;
    if (j.signature) {
      const st = await conn()
        .getSignatureStatuses([j.signature], { searchTransactionHistory: true })
        .then((r) => r.value[0])
        .catch(() => undefined);
      if (st === undefined) return; // can't tell right now: asked again next time
      landed = !!st && !st.err && !!st.confirmationStatus;
    }
    let caughtUp = false;
    const outs = j.outs ?? (j.request as { commitments?: string[] } | undefined)?.commitments ?? [];
    if (!landed) {
      // the chain's leaf count is read after the notes were seen spent, so pool data that far holds the spend
      const a = await conn()
        .getAccountInfo(this.pool().tree, "confirmed")
        .catch(() => null);
      if (!a) return;
      const total = this.pool().decodeTree(a.data).nextIndex;
      await this.sync().catch(() => {});
      caughtUp = this.leafCount >= total;
    }
    const verdict = spentVerdict({
      landed,
      ownNotes: outs.length > 0 && this.anyLeaf(outs),
      caughtUp,
      // every proof it was given is known here (older jobs kept only the newest, so one never refreshed)
      allProofs: outs.length > 0 && (!!j.outs || !j.refreshed),
    });
    if (verdict === "sent" && j.hop) {
      // its pool payment landed: its delivery is looked at (and finished, if it needs it) on the next look at deliveries
      this.patchJobs(j.id, { status: "delivering", delivering: 0, error: null, note: null });
      this.hopsAt = 0;
    } else if (verdict === "sent") {
      this.patchJobs(j.id, { status: "sent", error: null, note: null });
      this.log({ kind: "send", text: `Sent ${fmt(BigInt(j.amount))} SOL to ${this.nameWith(j.to, "scheduled")}`, sig: j.signature ?? undefined });
    } else if (verdict === "other") {
      this.patchJobs(j.id, { status: "failed", error: "Not sent: this SOL was spent in another payment." });
    } else if (verdict === "unclear") {
      this.patchJobs(j.id, { status: "unclear", error: "Its SOL was spent, but this device can't tell whether by this payment. Check your activity before sending it again." });
    }
    // null: the pool data is still catching up, looked at again next time
  }

  /**
   * Takes in the relayer's answer for a job handed over again; if it was cancelled meanwhile, it is
   * cancelled there too. If the account was locked or switched meanwhile, the job is left as it is:
   * it still belongs to that account, which finds it scheduled when it opens again.
   */
  private async applyScheduled(id: string, res: { id: string; token: string; latest: number }, patch: Partial<Job>, keys: Keys | null) {
    if (this.keys !== keys) return;
    const cur = this.s.jobs.find((x) => x.id === id);
    if (!cur || !isLive(cur.status)) {
      await api("/api/relay/cancel", { json: { id: res.id, token: res.token } }).catch(() => {});
      return;
    }
    this.patchJobs(id, { ...patch, id: res.id, token: res.token, latest: res.latest, status: "scheduled", error: null, note: null });
  }

  private refreshing = false;
  /** One scheduled payment at a time gets a fresh proof, without holding up anything else on the page. */
  private async refreshJobs() {
    if (this.refreshing || this.s.busy || !this.keys) return;
    const now = Date.now();
    const next = this.s.jobs.map((j) => ({ j, why: needsProof(j, now) })).find((x) => x.why);
    if (!next) return;
    this.refreshing = true;
    this.set({ refreshingJob: next.j.id });
    try {
      await this.refreshJob(next.j, next.why!);
    } catch {
      // the proof itself couldn't be made: tried again later, never in a loop
      const tries = (next.j.tries ?? 0) + 1;
      this.patchJobs(next.j.id, { tries, nextTry: Date.now() + backoff(tries) });
    } finally {
      this.refreshing = false;
      this.set({ refreshingJob: null });
    }
  }

  /**
   * Makes a scheduled payment a fresh proof (it went stale, its root is getting old, or it goes out
   * soon) and hands it over under the same id: its window and deadline stay. A stale job that keeps
   * failing ends "not sent", which frees its SOL; a waiting one simply keeps its earlier proof.
   */
  private async refreshJob(j: Job, why: "stale" | "roots" | "timing", accept = false) {
    const { pool } = this.need();
    // locked or switched meanwhile: nothing more is done for it here (see applyScheduled)
    const keys = this.keys;
    const now = Date.now();
    // `accept`: the owner pressed "Send it", so a failure is said, not just tried again later
    const later = async (msg: string) => {
      const tries = (j.tries ?? 0) + 1;
      // the owner's own presses never give up on a payment they are trying to send
      if (why === "stale" && tries >= 6 && !accept) return this.endJob(j, `Not sent: a fresh proof couldn't be made (${msg})`, keys);
      this.patchJobs(j.id, { tries, nextTry: Date.now() + backoff(tries), note: why === "stale" ? msg : j.note });
      if (accept) throw new Error(`The payment wasn't handed over just now (${msg.replace(/\.$/, "")}). Try again in a moment.`);
    };
    if (!pool.relayer) return later("the relayer isn't available right now");
    const inputs = this.s.notes.filter((nt) => j.nullifiers.includes(nfHex(nt.nullifier)));
    if (inputs.length !== j.nullifiers.length) {
      // a stale proof can't land, so its notes being gone means another payment spent them
      if (why === "stale" && (await this.nullifiersSpent(j.nullifiers, 0)) === true) return this.keys === keys ? this.settleSpentJob(j) : undefined;
      // a waiting one may just have gone out: the next look at the relayer says
      this.patchJobs(j.id, { nextTry: Date.now() + 60_000 });
      if (accept) throw new Error("Your balance is still catching up. Try again in a moment.");
      return;
    }
    // the fee it was proved with, so the recipient gets exactly what was promised
    const req = j.request as { relayerFee?: string; maxFeeBps?: number } | undefined;
    let withdraw = BigInt(j.withdraw);
    let fee = BigInt(req?.relayerFee ?? this.relayerFee());
    let amount = BigInt(j.amount);
    const cost = BigInt(pool.selfRelayCost ?? "0");
    const pay = !this.ownKeypairFor(j.to);
    if (pay) {
      // a delivery is signed for one exact amount, so its proof must make the hop's credit exactly that, at today's fee
      if (fee < cost) fee = this.relayerFee();
      await this.readTreasury();
      const credit = predictCredit(withdraw, fee, this.feeBps(), this.treasury?.view);
      if (credit > amount + DELIVERY_FEE) {
        // a lower fee (or a treasury that can't take one): a little less leaves the balance, the recipient gets the same
        withdraw = deliveryWithdraw(amount, fee, this.feeBps(), this.treasury?.view);
      } else if (credit < amount + DELIVERY_FEE) {
        const now2 = credit - DELIVERY_FEE;
        if (now2 < BigInt(this.s.rent?.wallet ?? 890_880n)) return later("the pool fee changed and the amount is now too small");
        // the recipient would get less: only once the owner says so
        if (!accept) return this.patchJobs(j.id, { confirm: { amount: now2.toString() } });
        amount = now2;
      }
    } else if (fee < cost || this.feeBps() > (req?.maxFeeBps ?? this.feeBps())) {
      if (fee < cost) fee = this.relayerFee();
      const now2 = splitWithdraw(withdraw, fee, this.feeBps()).toRecipient;
      // the recipient would get less: only once the owner says so
      if (now2 !== amount && !accept) return this.patchJobs(j.id, { confirm: { amount: now2.toString() } });
      amount = now2;
    }
    const dest = this.jobDest(j, amount);
    // a fresh proof for timing names a random recent root too (as scheduling did), so payments made together
    // don't all move onto the newest one; one that went stale or is running out of roots takes the newest, for the longest life
    const p = await this.prove("send", inputs, dest, withdraw, fee, pool.relayer, undefined, true, why === "timing");
    const request = p.request;
    // a proof made for an account that has since closed is never handed over: the earlier one stays there
    if (this.keys !== keys) return;
    // remembered before it is handed over: if the answer is lost, this proof may be the one that goes
    const prior = j.outs ?? (j.request as { commitments?: string[] } | undefined)?.commitments ?? [];
    this.patchJobs(j.id, { outs: [...prior, ...request.commitments].slice(-40) });
    if (p.hop) this.saveLeg({ hop: p.hop.publicKey.toBase58(), out0: request.commitments[0], to: j.to, amount: amount.toString(), status: "proved", at: Date.now(), job: j.id });
    const window: Window = j.latest > now + 2 * 60_000 ? j.window : "15m";
    let res: { id: string; token: string; latest: number };
    try {
      const body = await this.handOverBody(request, dest, p.hop, p.own, window, j.id, j.token, j.latest > now ? j.latest : undefined);
      res = await api("/api/relay/schedule", { json: body });
    } catch (e) {
      if (this.keys !== keys) return;
      const msg = (e as Error).message;
      if (e instanceof ApiError) {
        if (e.status === 409 && /going out/i.test(msg)) return this.patchJobs(j.id, { status: "sending" });
        // it went, or ended: the next look says how
        if (e.status === 409 && /already (gone out|ended)/i.test(msg)) return this.patchJobs(j.id, { refreshed: Date.now() });
        // a recipient that can't be paid (or an amount too small for it) won't change with a fresh proof
        if (e.status === 403 || e.status === 451 || e.data?.code === "recipient" || e.data?.code === "too_small" || /below the relayer fee/i.test(msg)) {
          if (why !== "stale") return this.patchJobs(j.id, { refreshed: Date.now() });
          await this.endJob(j, msg, keys);
          if (accept) throw new Error(msg);
          return;
        }
      }
      return later(msg || "the network is busy");
    }
    await this.applyScheduled(
      j.id,
      res,
      {
        request,
        amount: amount.toString(),
        withdraw: withdraw.toString(),
        window,
        refreshed: Date.now(),
        tries: 0,
        nextTry: undefined,
        confirm: null,
        hop: p.hop?.publicKey.toBase58(),
        own: p.own ?? undefined,
      },
      keys,
    );
  }

  /**
   * Ends a stale job on both sides: the relayer still holds its notes, so it is called off there
   * first, and only then is it "not sent" here (its notes free). If the relayer can't be asked it
   * stays stale and is tried again later; if it is already going out, it is followed as such.
   */
  private async endJob(j: Job, error: string, keys: Keys | null) {
    const r = await this.callOff(j.id, j.token);
    if (this.keys !== keys) return;
    if (r === "going") return this.patchJobs(j.id, { status: "sending" });
    if (r === "ended") return this.patchJobs(j.id, { status: "failed", error });
    const tries = (j.tries ?? 0) + 1;
    this.patchJobs(j.id, { tries, nextTry: Date.now() + backoff(tries) });
  }

  /** The owner agreed to the new fee: the payment gets its fresh proof now. */
  async confirmJob(id: string) {
    const j = this.s.jobs.find((x) => x.id === id);
    if (!j) return;
    try {
      this.step("send", "Making a fresh proof for your scheduled payment");
      await this.refreshJob(j, "stale", true);
      this.set({ busy: null });
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Cancels a scheduled payment that hasn't gone yet; its notes are free again. It never waits for
   * anything else that's running (a payment due soon must always be stoppable), and a second tap
   * on the same one does nothing.
   */
  async cancelJob(id: string) {
    const j = this.s.jobs.find((x) => x.id === id);
    if (!j || this.cancelling.has(id)) return;
    const keys = this.keys;
    this.cancelling.add(id);
    this.set({ cancellingJobs: [...this.cancelling] });
    try {
      // marked here first, so a fresh proof or a hand-back finishing meanwhile can't bring it back
      this.patchJobs(id, { status: "cancelled" });
      let r: { status: Job["status"] | "unknown" };
      try {
        r = await api<{ status: Job["status"] | "unknown" }>("/api/relay/cancel", { json: { id: j.id, token: j.token } });
      } catch (e) {
        if (this.keys === keys) this.patchJobs(id, { status: j.status }, ["cancelled"]);
        throw e;
      }
      if (this.keys !== keys) return;
      if (goneOut(r.status)) {
        // followed as it is going out (one already sent is reported once its notes are seen spent)
        this.patchJobs(id, { status: r.status === "sent" ? "sending" : (r.status as JobStatus) }, ["cancelled"]);
        throw new Error("It's already going out, so it can't be cancelled.");
      }
      if (r.status === "unknown") {
        // it may still be on its way there (or the relayer is still reading its list back in): asked again until it's sure
        this.patchJobs(id, { cancelPending: true }, ["cancelled"]);
        this.say({ notice: { title: "Cancelled", text: `The payment of ${fmt(BigInt(j.amount))} SOL to ${this.addressName(j.to)} won't go out. The app confirms it with the relayer in a moment, so keep this page open until it does.` } });
        return;
      }
      this.say({ notice: { title: "Cancelled", text: `The payment of ${fmt(BigInt(j.amount))} SOL to ${this.addressName(j.to)} won't go out. That SOL is spendable again.` } });
    } catch (e) {
      if (this.keys !== keys) return;
      const m = (e as Error)?.message || "Something went wrong.";
      this.say({ error: /failed to fetch|networkerror|load failed/i.test(m) ? "Can't reach the network right now. Check your connection and try again." : m });
    } finally {
      this.cancelling.delete(id);
      this.set({ cancellingJobs: [...this.cancelling] });
    }
  }
  private cancelling = new Set<string>();

  /** The result of something that ran beside another action: shown now if nothing is running, otherwise once it has finished. */
  private say(m: { notice?: Notice; error?: string }) {
    if (this.s.busy) this.enqueue(m);
    else this.set(m.error ? { error: m.error, notice: null } : { notice: m.notice ?? null, error: null });
  }

  /** Cancels the scheduled payments another device of this account made with the SOL set aside here. */
  async cancelAside() {
    try {
      const list = this.asideList();
      const ids = [...new Set(list.flatMap((a) => a.jobs))];
      if (!ids.length) return;
      this.step("send", "Cancelling the scheduled payment");
      const ended: string[] = [];
      for (const id of ids) {
        const r = await api<{ status: string }>("/api/relay/cancel", { json: { id, token: await this.jobToken(id) } }).catch((e) => {
          if (e instanceof ApiError && e.status === 403) throw new Error("That payment can only be cancelled on the device that scheduled it.");
          throw e;
        });
        if (r.status === "cancelled" || r.status === "unknown" || r.status === "failed") ended.push(id);
      }
      ls.set(
        this.asideKey(),
        list.filter((a) => !a.jobs.some((id) => ended.includes(id))),
      );
      this.refilter();
      this.done("Cancelled", ended.length === ids.length ? "That SOL is spendable again." : "Some of it is already going out; the rest is spendable again.");
    } catch (e) {
      this.fail(e);
    }
  }

  dismissJob(id: string) {
    // a cancel the relayer hasn't confirmed yet stays listed, so the app keeps calling it off
    if (this.s.jobs.find((x) => x.id === id)?.cancelPending) return;
    this.saveJobs(this.s.jobs.filter((x) => x.id !== id));
  }

  /** Sends a payment that wasn't sent again, the same way (the person pressed "Try again"). */
  async retryJob(id: string) {
    const j = this.s.jobs.find((x) => x.id === id);
    if (!j || j.status !== "failed") return;
    // the same address the sender already checked (and confirmed, if it needed that) when it was scheduled
    const part: Part = { to: j.to, amount: BigInt(j.amount), lookalikeOk: true, ...(j.offCurveOk ? { offCurveOk: true } : {}) };
    try {
      await this.sendMany([part], j.window === "2m" ? "now" : j.window);
    } catch (e) {
      // a question no form shows here is said instead, never left hanging
      if (e instanceof NeedsConfirm) {
        this.set({ ask: null, busy: null, notice: { title: "Check the recipient", text: `${e.ask.text} Send it again from the Send form.` } });
        return;
      }
      throw e;
    }
    this.dismissJob(id);
  }

  // ─── private orders ───
  private saveOrders(list: Order[]) {
    if (this.s.fingerprint) ls.set(`vs:orders:${this.s.fingerprint}`, list);
    this.set({ orders: list });
  }

  /** Changes one order as the list is now (other changes may have landed meanwhile). */
  private markOrder(id: string, patch: Partial<Order>) {
    this.saveOrders(this.s.orders.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  /** An order action is running (set before anything is awaited, so a second tap does nothing). */
  private ordering = false;
  private limits: OrderLimits | null = null;
  private limitsAskedAt = 0;

  /** True (and says so) while another order step is still running, so a tap is never silently dropped. */
  private orderBusy(): boolean {
    if (!this.ordering) return false;
    this.set({ notice: { title: "One moment", text: "Finishing another order step. Try again in a moment." } });
    return true;
  }

  /** The keeper's bounds as known now (the server's once they've arrived, the usual ones until then). */
  orderLimits(): OrderLimits {
    if (!this.limits && Date.now() - this.limitsAskedAt > 60_000) {
      this.limitsAskedAt = Date.now();
      void api<OrderLimits>("/api/orders/limits").then(
        (l) => {
          this.limits = { ...ORDER_LIMITS, ...l };
          this.set({});
        },
        () => {},
      );
    }
    return this.limits ?? ORDER_LIMITS;
  }

  private orderKeysFor: Keys | null = null;
  private orderKeyAddr = new Map<number, string>();
  /** The address of order key #n, the one an order's approval names. */
  orderDelegate(keyN: number): string {
    const keys = this.need().keys;
    if (this.orderKeysFor !== keys) {
      this.orderKeysFor = keys;
      this.orderKeyAddr.clear();
    }
    let a = this.orderKeyAddr.get(keyN);
    if (!a) {
      a = orderKey(keys, keyN).publicKey.toBase58();
      this.orderKeyAddr.set(keyN, a);
    }
    return a;
  }

  /** Which of this wallet's order keys an approval names, if it's one of them. */
  private ownSlot(vision: number, delegate: string): number | null {
    for (const n of keySlots(vision)) if (this.orderDelegate(n) === delegate) return n;
    return null;
  }

  /** The account an order trades from: the tokens for a sell, the wrapped SOL for a buy or DCA. */
  private orderInput(o: Pick<Order, "kind" | "vision" | "mint" | "program">): PublicKey {
    const owner = this.visionKeypair(o.vision).publicKey;
    return o.kind === "sell" ? ataOf(owner, new PublicKey(o.mint), new PublicKey(o.program)) : ataOf(owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM));
  }

  /** A token account's balance and approval, read from the chain; null when the account doesn't exist. */
  private async readApproval(account: PublicKey): Promise<{ amount: bigint; delegate: string | null; delegated: bigint } | null> {
    const a = await conn().getAccountInfo(account, "confirmed");
    if (!a) return null;
    return { amount: tokenAmount(a.data), ...tokenDelegate(a.data) };
  }

  /** A key for a new order in this wallet that no order known here uses (on this device or on-chain). */
  private async freshOrderKey(o: Pick<Order, "kind" | "vision" | "mint" | "program">): Promise<number> {
    const taken = this.s.orders.filter((x) => x.vision === o.vision && x.keyN != null).map((x) => x.keyN!);
    const seen = (this.s.vision.find((v) => v.index === o.vision)?.tokens ?? []).flatMap((t) => (t.delegate ? [t.delegate] : []));
    if (o.kind === "sell") {
      const a = await this.readApproval(this.orderInput(o)).catch(() => null);
      if (a?.delegate) seen.push(a.delegate);
    }
    for (const d of seen) {
      const n = this.ownSlot(o.vision, d);
      if (n != null) taken.push(n);
    }
    return pickKeyN(o.vision, taken);
  }

  /** Signs and sends a Vision wallet's own transaction (approvals, revokes), topping it up for fees if needed. */
  private async visionTx(index: number, kind: Activity["kind"], ixs: TransactionInstruction[], needs: bigint) {
    const kp = this.visionKeypair(index);
    const have = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
    if (have < needs) await this.topUpVision(index, kind, needs - have);
    const tx = new Transaction().add(...computeBudget(CLEANUP_CU, OWN_PRICE), ...ixs);
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
    tx.sign(kp);
    return sendAndConfirm(tx, "order");
  }

  private activating = new Set<string>();
  private activateTried = new Map<string, number>();

  /** Asks the keeper to start an order whose approval was sent, again while the chain catches up. */
  private async activateOrder(id: string): Promise<Order["status"]> {
    if (this.activating.has(id)) return "pending";
    this.activating.add(id);
    try {
      for (let i = 0; ; i++) {
        const o = this.s.orders.find((x) => x.id === id);
        if (!o) return "cancelled";
        try {
          const r = await api<{ status: Order["status"] }>("/api/orders/activate", { json: { id: o.id, token: o.token } });
          this.markOrder(id, { status: r.status, error: null });
          return r.status;
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && /on-chain yet/.test(e.message) && i < 2) continue;
          // the Vision wallet no longer holds what the order needs: it can't start
          if (e instanceof ApiError && e.status === 409 && /holds/.test(e.message)) this.markOrder(id, { status: "failed", error: e.message, release: true });
          throw e;
        }
      }
    } finally {
      this.activating.delete(id);
    }
  }

  /**
   * Describes an order to the keeper, approves its key on-chain from the Vision wallet, and starts it.
   * The order is kept on this device from the moment the keeper knows it, so an approval that lands
   * while something else goes wrong is never lost. A buy's Vision wallet is funded (`fund`) only
   * once the keeper has accepted the order, so a refused order never strands any SOL.
   */
  private async startOrder(
    o: Omit<Order, "id" | "token" | "status" | "fills" | "created" | "expires" | "keyN">,
    days: number,
    approve: (delegate: PublicKey) => TransactionInstruction[],
    needs: bigint,
    extra: Record<string, unknown>,
    fund?: () => Promise<void>,
  ): Promise<Order> {
    const kind = o.kind === "sell" ? "sell" : "buy";
    const kp = this.visionKeypair(o.vision);
    this.step(kind, "Setting up your order");
    const keyN = await this.freshOrderKey(o);
    const prep = await api<{ id: string; token: string; delegate: string; price: number | null; expires?: number }>("/api/orders/prepare", {
      json: {
        secret: bs58.encode(orderKey(this.need().keys, keyN).secretKey),
        kind: o.kind,
        owner: kp.publicKey.toBase58(),
        mint: o.mint,
        amount: o.amount,
        tpUsd: o.legs ? undefined : o.tpUsd,
        slUsd: o.slUsd,
        trailPct: o.trailPct,
        slSlippageBps: o.slSlippageBps,
        buyBelowUsd: o.buyBelowUsd,
        count: o.dca?.count,
        every: o.dca?.every,
        exact: o.dca?.exact,
        slippageBps: o.slippageBps,
        days,
        ...extra,
      },
    });
    const order: Order = { ...o, id: prep.id, token: prep.token, keyN, status: "pending", fills: [], created: Date.now(), expires: prep.expires ?? Date.now() + days * 86_400_000, lastPrice: prep.price };
    this.saveOrders([order, ...this.s.orders]);
    if (fund) {
      try {
        await fund();
      } catch (e) {
        // nothing was set aside: the keeper forgets the order (it would lapse in minutes anyway)
        void api("/api/orders/cancel", { json: { id: prep.id, token: prep.token } }).catch(() => {});
        this.saveOrders(this.s.orders.filter((x) => x.id !== prep.id));
        throw e;
      }
    }
    this.step(kind, "Approving the order", `Vision wallet #${o.vision + 1} allows this order to trade exactly ${o.kind === "sell" ? "these tokens" : "this SOL"}, nothing more.`);
    let sig: string | undefined;
    try {
      sig = await this.visionTx(o.vision, kind, approve(new PublicKey(prep.delegate)), needs);
    } catch (e) {
      // it may have landed all the same (a confirmation that timed out): the account says
      const a = await this.readApproval(this.orderInput(order)).catch(() => undefined);
      if (a === undefined) throw new Error(`${(e as Error).message} If the approval landed, the order starts by itself; if not, cancel it under Orders.`);
      if (a?.delegate !== prep.delegate) await this.approvalFailed(order, e);
    }
    if (sig) this.markOrder(order.id, { approveSig: sig });
    this.log({ kind, text: `Placed ${orderName(order)} on ${o.symbol} in Vision wallet #${o.vision + 1}`, sig });
    this.step(kind, "Starting the order");
    try {
      await this.activateOrder(order.id);
    } catch (e) {
      // refused for good: said as it is (a short hiccup instead leaves it starting by itself on the next look)
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 404 && e.status !== 429 && !/on-chain yet|trading right now/.test(e.message)) throw e;
    }
    const now = this.s.orders.find((x) => x.id === order.id) ?? order;
    // one approval per account: an older order on the same tokens was replaced, and says so at once
    if (now.status === "active") {
      const acc = this.orderInput(now).toBase58();
      this.saveOrders(
        this.s.orders.map((x) =>
          x.id !== now.id && (x.status === "active" || x.status === "pending" || x.status === "failed") && this.orderInput(x).toBase58() === acc
            ? { ...x, status: "cancelled", error: "Replaced by a newer order on the same tokens.", release: undefined }
            : x,
        ),
      );
    }
    return now;
  }

  /**
   * The approval of a new order didn't go through: the keeper forgets it, and a buy's SOL (still
   * plain SOL, since wrapping it was part of the approval) goes straight back to the private balance.
   */
  private async approvalFailed(order: Order, e: unknown): Promise<never> {
    void api("/api/orders/cancel", { json: { id: order.id, token: order.token } }).catch(() => {});
    this.markOrder(order.id, { status: "failed", error: "The approval didn't go through, so the order didn't start." });
    const why = ((e as Error)?.message || "it didn't go through").replace(/\.$/, "");
    if (order.kind === "sell") throw new Error(`The approval didn't go through (${why}), so the order didn't start. Nothing changed: try again in a moment.`);
    const n = order.vision + 1;
    const moved = await this.sweepInner(order.vision, true).catch(() => undefined);
    if (moved) this.markOrder(order.id, { error: "The approval didn't go through, so the order didn't start. Its SOL went back to your private balance." });
    throw new Error(
      moved
        ? `The approval didn't go through (${why}), so the order didn't start. Its SOL is on its way back to your private balance.`
        : `The approval didn't go through (${why}), so the order didn't start. Its SOL is in Vision wallet #${n}: "Move back to private balance" in the Wallets tab brings it back.`,
    );
  }

  /** What placing an order ends with. */
  private placed(order: Order, text: string) {
    if (order.status === "active") this.done("Order placed", text);
    else this.done("Order almost ready", `The approval is in. ${orderName(order)} on ${order.symbol} starts by itself in a moment: watch it under Orders.`);
  }

  /**
   * Take-profit (one price, or up to 4 steps each selling part of it), stop-loss and/or trailing
   * stop on tokens a Vision wallet holds. Proceeds land in that wallet as SOL, then move into the
   * private balance by themselves.
   */
  async placeSellOrder(p: {
    vision: number;
    mint: string;
    symbol: string;
    decimals: number;
    program: string;
    amount: bigint;
    tpUsd?: number;
    legs?: { tpUsd: number; amount: bigint }[];
    slUsd?: number;
    trailPct?: number;
    slippageBps: number;
    slSlippageBps?: number;
    days: number;
  }): Promise<boolean> {
    if (this.orderBusy()) return false;
    this.ordering = true;
    try {
      // busy straight away, so a second tap can't start another order meanwhile
      this.step("sell", "Setting up your order");
      const owner = this.visionKeypair(p.vision).publicKey;
      const mint = new PublicKey(p.mint);
      const prog = new PublicKey(p.program);
      const source = ataOf(owner, mint, prog);
      // one price for all of it, or steps of their own (a single step may cover only part)
      const legs = p.legs?.length && (p.legs.length > 1 || p.legs[0].amount < p.amount) ? p.legs.map((l) => ({ tpUsd: l.tpUsd, amount: l.amount.toString() })) : undefined;
      const tpUsd = legs ? Math.min(...legs.map((l) => l.tpUsd)) : (p.legs?.[0]?.tpUsd ?? p.tpUsd);
      const order = await this.startOrder(
        {
          kind: "sell",
          vision: p.vision,
          mint: p.mint,
          symbol: p.symbol,
          decimals: p.decimals,
          program: p.program,
          amount: p.amount.toString(),
          tpUsd,
          legs,
          slUsd: p.slUsd,
          trailPct: p.trailPct,
          slippageBps: p.slippageBps,
          slSlippageBps: p.slSlippageBps,
        },
        p.days,
        // the wallet's wrapped-SOL account is where the sale's SOL lands
        (delegate) => [createAtaIx(owner, owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM)), approveCheckedIx(source, mint, delegate, owner, p.amount, p.decimals, prog)],
        TOKEN_ACCOUNT_RENT + 1_500_000n,
        legs ? { legs } : {},
      );
      this.placed(order, `${orderName(order)} on ${p.symbol} is live. It runs on its own, even with this page closed. When it sells, the SOL moves into your private balance by itself the next time VisionSwap is open.`);
      return true;
    } catch (e) {
      // resolves false, never rejects: the form keeps what was typed, and the error is on screen
      this.report(e);
      return false;
    } finally {
      this.ordering = false;
    }
  }

  /**
   * A limit buy or a DCA, from a fresh Vision wallet. The keeper accepts the order first; only then
   * is the wallet funded from the private balance, approved and started.
   */
  async placeBuyOrder(p: {
    mint: string;
    symbol: string;
    decimals: number;
    program: string;
    sol: bigint;
    buyBelowUsd?: number;
    dca?: { count: number; every: number; exact?: boolean };
    slippageBps: number;
    days: number;
  }): Promise<boolean> {
    if (this.orderBusy()) return false;
    this.ordering = true;
    try {
      // busy straight away, so a second tap can't start another order meanwhile
      this.step("buy", "Checking the pool");
      if (!p.program) throw new Error("This token's details are still loading. Pick it again in a moment.");
      const lim = this.orderLimits();
      if (p.dca && p.sol / BigInt(p.dca.count) < BigInt(lim.minDcaBuyLamports)) throw new Error(`Each buy needs at least ${fmt(BigInt(lim.minDcaBuyLamports))} SOL: spend more, or make fewer buys.`);
      if (!p.dca && p.sol < BigInt(lim.minBuyLamports)) throw new Error(`Orders start at ${fmt(BigInt(lim.minBuyLamports))} SOL.`);
      const reserve = visionReserve(p.program);
      const deliver = p.sol + reserve;
      const q = this.quoteSend(deliver);
      if (await this.stillShort(() => q.withdraw > this.spendable())) throw new Error("Not enough private balance for that, including fees.");
      const idx = await this.freshVisionIndex();
      const kp = this.visionKeypair(idx);
      const owner = kp.publicKey;
      const mint = new PublicKey(p.mint);
      const prog = new PublicKey(p.program);
      const wsolAcc = ataOf(owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM));
      const order = await this.startOrder(
        {
          kind: p.dca ? "dca" : "buy",
          vision: idx,
          mint: p.mint,
          symbol: p.symbol,
          decimals: p.decimals,
          program: p.program,
          amount: p.sol.toString(),
          buyBelowUsd: p.buyBelowUsd,
          dca: p.dca ? { count: p.dca.count, every: p.dca.every, done: 0, next: Date.now() + 120_000, ...(p.dca.exact ? { exact: true } : {}) } : undefined,
          slippageBps: p.slippageBps,
        },
        p.dca ? Math.ceil((p.dca.count * p.dca.every) / 86_400) + 7 : p.days,
        (delegate) => [
          createAtaIx(owner, owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM)),
          createAtaIx(owner, owner, mint, prog),
          SystemProgram.transfer({ fromPubkey: owner, toPubkey: wsolAcc, lamports: p.sol }),
          syncNativeIx(wsolAcc),
          approveCheckedIx(wsolAcc, new PublicKey(WSOL), delegate, owner, p.sol, 9, new PublicKey(TOKEN_PROGRAM)),
        ],
        p.sol + 1_000_000n,
        // the first buy about two minutes from now: the wallet is funded in between
        p.dca ? { firstIn: 120 } : {},
        async () => {
          this.markVision(idx);
          const sig1 = (await this.withInputs("buy", q.withdraw, (inputs) => this.proveAndPayout("buy", inputs, { kind: "own", kp }, q.withdraw, q.relayerFee))).sig;
          this.log({ kind: "buy", text: `Funded Vision wallet #${idx + 1} with ${fmt(deliver)} SOL for an order`, sig: sig1 || undefined });
          await this.waitForLamports(kp.publicKey, deliver);
        },
      );
      this.placed(
        order,
        p.dca
          ? `Your DCA buys ${p.symbol} ${p.dca.count} times, from Vision wallet #${idx + 1}, a fresh address funded from the pool. It runs on its own; pause or cancel it any time under Orders.`
          : `${orderName(order)} for ${p.symbol} is live in Vision wallet #${idx + 1}, a fresh address funded from the pool. Change or cancel it any time under Orders.`,
      );
      return true;
    } catch (e) {
      // resolves false, never rejects: the form keeps what was typed, and the error is on screen
      this.report(e);
      return false;
    } finally {
      this.ordering = false;
    }
  }

  /** Whether an order's permission is still on-chain, by what this device last read of its Vision wallet. */
  orderLeft(o: Order): { permission: boolean; sol: bigint } {
    if (!this.keys) return { permission: false, sol: 0n };
    const v = this.s.vision.find((x) => x.index === o.vision);
    const input = v?.tokens.find((t) => t.mint === (o.kind === "sell" ? o.mint : WSOL));
    const permission = !!input?.delegate && (o.keyN != null ? !!this.keys && input.delegate === this.orderDelegate(o.keyN) : !this.liveOn(o));
    return { permission, sol: o.kind !== "sell" && input ? input.amount : 0n };
  }

  /** Another live order of this device on the same account as `o`. */
  private liveOn(o: Order): boolean {
    const acc = this.orderInput(o).toBase58();
    return this.s.orders.some((x) => x.id !== o.id && (x.status === "active" || x.status === "pending") && this.orderInput(x).toBase58() === acc);
  }

  /** Takes an order's permission back on-chain, only when the account still names this order's key. */
  private async revokeOrder(o: Order): Promise<{ revoked: boolean; other: string | null }> {
    const account = this.orderInput(o);
    const a = await this.readApproval(account);
    if (!a?.delegate) return { revoked: false, other: null };
    const mine = o.keyN != null ? a.delegate === this.orderDelegate(o.keyN) : !this.liveOn(o);
    // a newer order on the same tokens holds it now: that one keeps it
    if (!mine) return { revoked: false, other: a.delegate };
    const owner = this.visionKeypair(o.vision).publicKey;
    await this.visionTx(o.vision, o.kind === "sell" ? "sell" : "buy", [revokeIx(account, owner, new PublicKey(o.kind === "sell" ? o.program : TOKEN_PROGRAM))], 50_000n);
    return { revoked: true, other: null };
  }

  /**
   * Successful transactions an order's key signed since the order was placed, apart from its
   * approval: its trades (the key signs nothing else). Read 10 at a time (the most the gateway
   * gives) and a few pages back at most; `whole` says the order's start was reached, and
   * `approval` is the approval's transaction when that is how it was found.
   */
  private async orderTrades(o: Order): Promise<{ trades: { t: number; sig: string }[]; whole: boolean; approval?: string }> {
    if (o.keyN == null) return { trades: [], whole: true };
    const key = new PublicKey(this.orderDelegate(o.keyN));
    const from = o.created - 120_000;
    const seen: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    let whole = false;
    for (let page = 0; page < 6 && !whole; page++) {
      const sigs = await conn().getSignaturesForAddress(key, { limit: 10, before }, "confirmed");
      seen.push(...sigs);
      const last = sigs[sigs.length - 1];
      whole = sigs.length < 10 || (last.blockTime != null && last.blockTime * 1000 < from);
      before = last?.signature;
    }
    const since = seen.filter((s) => !s.err && (s.blockTime == null || s.blockTime * 1000 >= from)).reverse();
    // the approval names the key too: the first one since the order began (the key is new to it), once that far back was read
    const approval = o.approveSig ?? (whole ? since[0]?.signature : undefined);
    const trades = since.filter((s) => s.signature !== approval);
    return { trades: trades.map((s) => ({ t: s.blockTime ? s.blockTime * 1000 : Date.now(), sig: s.signature })), whole, approval: o.approveSig ? undefined : approval };
  }

  /** How many buys a DCA has made, from how much of its SOL is gone (the key's history may not reach back that far). */
  private dcaBuysFrom(o: Order, held: bigint | null): number {
    if (!o.dca || held == null) return 0;
    const total = BigInt(o.amount);
    const per = total / BigInt(o.dca.count);
    if (per <= 0n) return 0;
    const gone = total > held ? total - held : 0n;
    return Math.min(o.dca.count, Number((gone + per / 2n) / per));
  }

  /**
   * An order the keeper had lost whose permission is gone: it traded (its key signed the trades,
   * or a DCA's SOL went down) or its permission was withdrawn. Null when the chain can't say just now.
   */
  private async lostOutcome(o: Order, a: { amount: bigint } | null): Promise<Partial<Order> | null> {
    let found: Awaited<ReturnType<Engine["orderTrades"]>>;
    try {
      found = await this.orderTrades(o);
    } catch {
      return null;
    }
    const fills = this.withTrades(o, found.trades);
    const known = found.approval ? { approveSig: found.approval } : {};
    const n = o.vision + 1;
    if (o.dca) {
      const done = Math.min(o.dca.count, Math.max(o.dca.done, fills.length, this.dcaBuysFrom(o, a ? a.amount : null)));
      const all = done >= o.dca.count || (!!a && a.amount < BigInt(o.amount) / BigInt(o.dca.count) / 2n);
      if (all) return { ...known, status: "filled", fills, dca: { ...o.dca, done: o.dca.count }, error: null, release: true };
      return {
        ...known,
        status: "cancelled",
        fills,
        dca: { ...o.dca, done },
        error: done
          ? `The approval was withdrawn after ${done} of ${o.dca.count} buys, so the DCA stopped.`
          : o.status === "pending"
            ? `The DCA didn't start: its approval never went through. Its SOL is in Vision wallet #${n}: "Move back to private balance" in the Wallets tab brings it back.`
            : "The approval was withdrawn or the SOL moved, so the DCA stopped.",
        release: true,
      };
    }
    if (fills.length > o.fills.length) return { ...known, status: "filled", fills, error: null, sweep: o.kind === "sell" || undefined, release: o.kind !== "sell" || undefined };
    return {
      ...known,
      status: "cancelled",
      error:
        o.status === "pending"
          ? o.kind === "sell"
            ? "The order didn't start: its approval never went through."
            : `The order didn't start: its approval never went through. Its SOL is in Vision wallet #${n}: "Move back to private balance" in the Wallets tab brings it back.`
          : "The approval was withdrawn or the tokens moved, so the order stopped.",
      release: o.kind !== "sell" || undefined,
    };
  }

  /** Known fills plus trades found on-chain that the keeper's record doesn't have (amounts unknown). */
  private withTrades(o: Order, trades: { t: number; sig: string }[]): Order["fills"] {
    const known = new Set(o.fills.map((f) => f.sig));
    return [...o.fills, ...trades.filter((t) => !known.has(t.sig)).map((t) => ({ t: t.t, sig: t.sig, spent: "", got: "" }))];
  }

  /**
   * Cancels a live order, or cleans up after one that ended: the keeper stops, and the Vision
   * wallet takes back the permission on-chain, only while it's still this order's (a newer order on
   * the same tokens keeps its own). With `home`, a buy's or DCA's SOL then goes back into the
   * private balance in the same tap. `task` is set when the app runs this by itself (tidyOrders):
   * the token of its background lock (see bgBegin), and it stays quiet once it no longer holds it.
   */
  async cancelOrder(id: string, home = false, task: object | null = null) {
    const o = this.s.orders.find((x) => x.id === id);
    if (!o || this.orderBusy()) return;
    this.ordering = true;
    const kind = o.kind === "sell" ? "sell" : "buy";
    const live = o.status === "active" || o.status === "pending";
    // a cleanup that started by itself and outlived its account (locked or switched) stops, quietly
    const gone = () => !!task && this.bgTask !== task;
    try {
      // (one that started by itself already shows its own status line)
      if (!task) this.step(kind, live ? "Cancelling the order" : o.kind === "sell" ? "Removing its permission" : "Getting the SOL back");
      let settling = false;
      let lost = false;
      if (live || o.settling) {
        const r = await api<{ status: Order["status"]; settling?: boolean }>("/api/orders/cancel", { json: { id: o.id, token: o.token } }).catch(() => ({ status: "unknown" as const, settling: false }));
        if (r.status === "filled") {
          this.markOrder(id, { status: "filled", settling: false, sweep: o.kind === "sell" || undefined });
          throw new Error("It has already filled, so there's nothing to cancel.");
        }
        settling = !!r.settling;
        lost = r.status === "unknown";
      }
      const { revoked, other } = await this.revokeOrder(o);
      if (gone()) return;
      if (lost && !revoked && !other) {
        // the keeper had lost it, and its permission is gone: it may have filled meanwhile
        const out = await this.lostOutcome(o, await this.readApproval(this.orderInput(o)));
        if (!out) throw new Error("Couldn't check this order on-chain just now. Try again in a moment.");
        if (out.status === "filled") {
          this.markOrder(id, { ...out, release: undefined });
          throw new Error("It had already filled, so there's nothing to cancel.");
        }
        if (out.dca) this.markOrder(id, { dca: out.dca, fills: out.fills });
        if (gone()) return;
      }
      const error = other
        ? "A newer order on these tokens holds the permission now, so it was left in place."
        : settling
          ? "A trade was already on its way. If it lands, this order shows as filled."
          : live
            ? null
            : (o.error ?? null);
      this.markOrder(id, { status: live ? "cancelled" : o.status, settling, release: false, error });
      if (live) this.log({ kind, text: `Cancelled ${orderName(o)} on ${o.symbol}` });
      let moved: string | undefined;
      if (home && o.kind !== "sell") {
        moved = await this.sweepInner(o.vision, true);
      } else if (revoked) await this.refreshVision([o.vision]);
      if (gone()) return;
      const n = o.vision + 1;
      this.done(
        live ? "Order cancelled" : o.kind === "sell" ? "Permission removed" : "SOL back",
        o.kind === "sell"
          ? `The order can no longer touch your ${o.symbol}. It stays in Vision wallet #${n}.`
          : moved
            ? `The order can no longer spend its SOL, and the SOL from Vision wallet #${n} is in the waiting room. It joins your private balance in about ${this.waitLabel()}.`
            : home
              ? `The order can no longer spend its SOL. It stays in Vision wallet #${n}: it's below the smallest deposit, so "Send to an address" in the Wallets tab can move it.`
              : `The order can no longer spend its SOL. Tap "Get SOL back" under Orders, or "Move back to private balance" on Vision wallet #${n} in the Wallets tab, to bring it into your private balance.`,
      );
    } catch (e) {
      if (gone()) return;
      this.fail(e);
    } finally {
      this.ordering = false;
    }
  }

  /**
   * Changes a live order's terms with no new approval: prices, take-profit steps, trailing stop,
   * price room, end date, a lower amount, or pausing a DCA. Resolves true once it's changed.
   */
  async updateOrder(id: string, patch: OrderPatch): Promise<boolean> {
    const o = this.s.orders.find((x) => x.id === id);
    if (!o || this.orderBusy()) return false;
    this.ordering = true;
    try {
      this.step(o.kind === "sell" ? "sell" : "buy", patch.paused != null ? (patch.paused ? "Pausing the DCA" : "Resuming the DCA") : "Changing the order");
      const base = BigInt(o.base?.spent ?? "0");
      const r = await api<OrderReply>("/api/orders/update", {
        json: {
          id: o.id,
          token: o.token,
          ...patch,
          // the keeper counts from its own start: what traded before a hand-back isn't part of it
          amount: patch.amount != null ? (patch.amount - base).toString() : undefined,
          legs: patch.legs?.map((l) => ({ tpUsd: l.tpUsd, amount: l.amount.toString() })),
        },
      });
      const local: Partial<Order> = {};
      if (patch.slUsd !== undefined) local.slUsd = patch.slUsd ?? undefined;
      if (patch.trailPct !== undefined) local.trailPct = patch.trailPct || undefined;
      if (patch.buyBelowUsd !== undefined) local.buyBelowUsd = patch.buyBelowUsd;
      if (patch.slSlippageBps !== undefined) local.slSlippageBps = patch.slSlippageBps ?? undefined;
      if (patch.tpUsd !== undefined && !patch.legs) local.tpUsd = patch.tpUsd;
      if (o.dca && (patch.exact !== undefined || patch.paused !== undefined))
        local.dca = { ...o.dca, ...(patch.exact !== undefined ? { exact: patch.exact || undefined } : {}), ...(patch.paused !== undefined ? { paused: patch.paused } : {}) };
      this.saveOrders(this.s.orders.map((x) => (x.id === id ? mergeReply({ ...x, ...local }, r) : x)));
      this.done(
        patch.paused != null ? (patch.paused ? "DCA paused" : "DCA resumed") : "Order changed",
        patch.paused != null
          ? patch.paused
            ? `No buys until you resume it. The SOL stays set aside in Vision wallet #${o.vision + 1}.`
            : `${r.dca?.next ? (inTime(r.dca.next) === "any moment" ? "The next buy goes out any moment" : `The next buy is ${inTime(r.dca.next)}`) : "Buying carries on"}, and the end date moved later by the time it was paused.`
          : `${orderName({ ...o, ...local })} on ${o.symbol} runs with the new terms from now on. No new approval was needed.`,
      );
      return true;
    } catch (e) {
      // resolves false, never rejects: the form keeps what was typed, and the error is on screen
      this.report(e);
      return false;
    } finally {
      this.ordering = false;
    }
  }

  /**
   * What a manual sale of `amount` from Vision wallet `index` does to a live order there, if
   * anything, in plain words: a take-profit/stop-loss is lowered to what's left (or ends if too
   * little is), and a DCA or limit buy in that wallet ends, since the sale unwraps its SOL.
   */
  orderClash(index: number, mint: string, amount: bigint): { order: Order; plan: "lower" | "cancel"; keep: bigint; text: string } | null {
    const held = this.s.vision.find((v) => v.index === index)?.tokens.find((t) => t.mint === mint);
    if (!held) return null;
    const c = sellClash(this.s.orders, index, mint, held.amount, amount, this.orderLimits().minSellUsd);
    if (!c) return null;
    const o = c.order;
    const n = index + 1;
    const name = orderName(o).toLowerCase();
    const text =
      o.kind !== "sell"
        ? `Vision wallet #${n} runs a ${o.kind === "dca" ? "DCA" : "limit buy"} into ${o.symbol}. Selling from it ends that order, and its SOL goes back to your private balance with the sale.`
        : c.plan === "lower"
          ? `Vision wallet #${n} has a ${name} on ${o.symbol}. This sale leaves ${formatUnits(c.keep, o.decimals, 4)}, so the order is lowered to that and keeps protecting it.`
          : `Vision wallet #${n} has a ${name} on ${o.symbol}. This sale leaves too little for it, so the order ends.`;
    return { ...c, text };
  }

  /**
   * Before a manual sale: a DCA or limit buy in the wallet ends, since the sale unwraps the SOL it
   * spends. A take-profit/stop-loss is left alone until the sale lands (the keeper never sells more
   * than the wallet holds), then lowered or ended by lowerAfterSale. Says what changed, for an error.
   */
  private async endForSale(index: number, mint: string, amount: bigint, agreed: boolean): Promise<string | null> {
    const c = this.orderClash(index, mint, amount);
    if (!c) return null;
    if (!agreed) throw new Error(c.text);
    const o = c.order;
    if (o.kind === "sell") return null;
    this.step("buy", "Ending the order first");
    const r = await api<{ status: Order["status"]; settling?: boolean }>("/api/orders/cancel", { json: { id: o.id, token: o.token } }).catch(() => ({ status: "unknown" as const, settling: false }));
    const name = orderName(o).toLowerCase();
    if (r.status === "filled") {
      this.markOrder(o.id, { status: "filled" });
      throw new Error(`The ${name} has just filled. Nothing was sold: check the wallet, then try again.`);
    }
    if (r.settling) throw new Error(`The ${name} is trading right now. Nothing was sold: try again in a minute.`);
    await this.revokeOrder(o);
    this.markOrder(o.id, { status: "cancelled", release: false, error: "Ended for a sale from its Vision wallet." });
    this.log({ kind: "buy", text: `Cancelled ${orderName(o)} on ${o.symbol} before selling` });
    return `The ${name} in Vision wallet #${index + 1} was ended before the sale, but the sale didn't go through. Its SOL is still in that wallet: "Get SOL back" under Orders brings it home.`;
  }

  /**
   * After a manual sale landed: a take-profit/stop-loss in that wallet is lowered to what the wallet
   * holds now, or ends when too little is left, by the keeper's own count of what it has sold.
   */
  private async lowerAfterSale(index: number, mint: string) {
    const first = this.s.orders.find((x) => x.vision === index && x.kind === "sell" && x.mint === mint && (x.status === "active" || x.status === "pending"));
    if (!first) return;
    // fresh from the keeper (it may have sold a step since the last look) and from the chain
    const [r] = await api<OrderReply[]>("/api/orders/status", { json: { ids: [first.id] } });
    if (!r || r.status === "unknown") return; // handed back on the next look, at what the wallet holds
    this.saveOrders(this.s.orders.map((x) => (x.id === first.id ? mergeReply(x, r) : x)));
    const a = await this.readApproval(this.orderInput(first));
    const c = sellClash(this.s.orders, index, mint, a?.amount ?? 0n, 0n, this.orderLimits().minSellUsd);
    if (!c || c.order.id !== first.id) return;
    const o = c.order;
    if (c.plan === "lower") {
      const rest = leftOf(o);
      const open = (o.legs ?? []).filter((l) => !l.filled && l.tpUsd != null).map((l) => ({ tpUsd: l.tpUsd!, amount: l.amount }));
      const u = await api<OrderReply>("/api/orders/update", {
        json: {
          id: o.id,
          token: o.token,
          // the keeper counts from its own start: what traded before a hand-back isn't part of it
          amount: (BigInt(r.spent ?? "0") + c.keep).toString(),
          legs: stepsKept(open, rest) ? shrinkLegs(open, rest, c.keep) : undefined,
        },
      });
      this.saveOrders(this.s.orders.map((x) => (x.id === o.id ? mergeReply(x, u) : x)));
      this.log({ kind: "sell", text: `Lowered ${orderName(o)} on ${o.symbol} to ${formatUnits(c.keep, o.decimals, 4)} after a sale` });
      return;
    }
    const e = await api<{ status: Order["status"]; settling?: boolean }>("/api/orders/cancel", { json: { id: o.id, token: o.token } });
    if (e.status === "filled" || e.settling) return; // it sold what was left: the next look shows it
    await this.revokeOrder(o).catch(() => {});
    this.markOrder(o.id, { status: "cancelled", release: false, error: "Ended after a sale from its Vision wallet left too little for it." });
    this.log({ kind: "sell", text: `Cancelled ${orderName(o)} on ${o.symbol} after a sale` });
  }

  /**
   * A take-profit/stop-loss sells into the wallet's wrapped-SOL account, which a manual sale closes
   * when it unwraps its own SOL: opened again straight after, paid from the sale's SOL.
   */
  private async keepSaleAccount(index: number, mint: string, sold: bigint) {
    const owner = this.visionKeypair(index).publicKey;
    const wsol = ataOf(owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM));
    const local = this.s.orders.some((o) => o.vision === index && o.kind === "sell" && (o.status === "active" || o.status === "pending"));
    // an order from another device counts too (as the wallet was last read, less what was just sold)
    const onChain = !!this.s.vision.find((v) => v.index === index)?.tokens.some((t) => t.mint !== WSOL && !!t.delegate && t.amount > (t.mint === mint ? sold : 0n));
    if (!local && !onChain) return;
    if (await conn().getAccountInfo(wsol, "confirmed")) return;
    await this.visionTx(index, "sell", [createAtaIx(owner, owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM))], TOKEN_ACCOUNT_RENT + 50_000n);
  }

  /**
   * Gives an order back to the keeper after it lost it (as after a server update): the on-chain
   * approval still names the order's key, which comes from this account, so the order carries on
   * with what's left of it. One whose approval is gone either traded (its key signed the trades:
   * it filled) or was withdrawn. When the chain can't say just now, it waits for the next look.
   */
  private async reRegister(o: Order) {
    const mark = (patch: Partial<Order>) => this.markOrder(o.id, patch);
    const a = await this.readApproval(this.orderInput(o));
    const mine = !!a?.delegate && (o.keyN != null ? a.delegate === this.orderDelegate(o.keyN) : false);
    if (!mine) {
      if (a?.delegate) {
        // another order holds the permission now
        let found: Awaited<ReturnType<Engine["orderTrades"]>>;
        try {
          found = await this.orderTrades(o);
        } catch {
          return;
        }
        const fills = this.withTrades(o, found.trades);
        const newer = o.keyN == null || this.ownSlot(o.vision, a.delegate) != null;
        mark({
          status: "cancelled",
          fills,
          error: o.keyN == null ? "The order service lost this order. Remove its permission, then place it again." : newer ? "Replaced by a newer order on the same tokens." : "Another order on these tokens holds the permission now.",
          sweep: (o.kind === "sell" && fills.length > o.fills.length) || undefined,
        });
        return;
      }
      const out = await this.lostOutcome(o, a);
      if (!out) return;
      mark(out);
      if (out.status === "filled") {
        const all = out.fills ?? o.fills;
        this.log({ kind: o.kind === "sell" ? "sell" : "buy", text: `${orderName(o)} filled on ${o.symbol}`, sig: all[all.length - 1]?.sig });
      }
      return;
    }
    if (Date.now() > o.expires) {
      mark({ status: "expired", error: null, release: true });
      return;
    }
    const found = await this.orderTrades(o).catch(() => ({ trades: [], whole: false, approval: undefined }));
    const fills = this.withTrades(o, found.trades);
    const held = a!.delegated < a!.amount ? a!.delegated : a!.amount;
    const base: NonNullable<Order["base"]> = {
      fills,
      spent: (BigInt(o.amount) - held > 0n ? BigInt(o.amount) - held : 0n).toString(),
      // counted from the SOL that's gone: the key's history may not reach back over every buy
      buys: o.dca ? Math.max(o.dca.done, this.dcaBuysFrom(o, held)) : 0,
      legs: (o.legs ?? []).filter((l) => l.filled),
    };
    const left = o.dca ? o.dca.count - base.buys : 0;
    if (o.dca && left <= 0) {
      mark({ status: "filled", fills, dca: { ...o.dca, done: o.dca.count }, error: null, release: true });
      return;
    }
    const open = (o.legs ?? []).filter((l) => !l.filled && l.tpUsd != null).map((l) => ({ tpUsd: l.tpUsd!, amount: l.amount }));
    const sum = open.reduce((s, l) => s + BigInt(l.amount), 0n);
    // steps of their own (or one step for part of it) stay that way, resized to what's left
    const partial = open.length === 1 && BigInt(open[0].amount) < held;
    const legs = open.length > 1 || partial ? (sum > held ? scaleLegs(open, held) : open) : undefined;
    let prep: { id: string; token: string; status: Order["status"]; expires?: number };
    try {
      prep = await api("/api/orders/prepare", {
        json: {
          secret: bs58.encode(orderKey(this.need().keys, o.keyN!).secretKey),
          kind: o.kind,
          owner: this.visionKeypair(o.vision).publicKey.toBase58(),
          mint: o.mint,
          amount: held.toString(),
          tpUsd: legs ? undefined : (open[0]?.tpUsd ?? o.tpUsd),
          legs,
          slUsd: o.slUsd,
          trailPct: o.trailPct,
          slSlippageBps: o.slSlippageBps,
          buyBelowUsd: o.buyBelowUsd,
          // a DCA with one buy left goes on with that one
          count: o.dca ? left : undefined,
          every: o.dca?.every,
          exact: o.dca?.exact,
          // a paused one starts as late as it can, and is paused again straight away
          firstIn: o.dca ? (o.dca.paused ? o.dca.every : Math.min(o.dca.every, Math.max(0, Math.round((o.dca.next - Date.now()) / 1000)))) : undefined,
          slippageBps: o.slippageBps,
          days: Math.max(1, Math.ceil((o.expires - Date.now()) / 86_400_000)),
        },
      });
    } catch (e) {
      // refused for good (too little left, say): the order ends, and its permission comes back by itself
      if (e instanceof ApiError && e.status === 400) mark({ status: "failed", error: e.message, fills, release: true });
      throw e;
    }
    mark({
      id: prep.id,
      token: prep.token,
      status: prep.status === "active" ? "active" : "pending",
      error: null,
      base,
      fills,
      ...(found.approval ? { approveSig: found.approval } : {}),
      ...(prep.expires ? { expires: prep.expires } : {}),
    });
    if (prep.status !== "active") await this.activateOrder(prep.id).catch(() => {});
    // a paused DCA stays paused
    if (o.dca?.paused) await api("/api/orders/update", { json: { id: prep.id, token: prep.token, paused: true } }).catch(() => {});
  }

  /** Forgets an ended order on this device. */
  dismissOrder(id: string) {
    this.saveOrders(this.s.orders.filter((x) => x.id !== id));
  }

  /** Pauses or resumes a DCA. */
  pauseOrder(id: string, paused: boolean) {
    return this.updateOrder(id, { paused });
  }

  /**
   * Order permissions on this account's Vision wallets that no order on this device stands for:
   * orders placed on another device (their key comes from this account), or ones this device
   * forgot. Read from the wallets as last seen.
   */
  orderPermissions(): { vision: number; mint: string; program: string; account: string; amount: bigint; held: bigint; decimals: number; ours: boolean }[] {
    if (!this.keys) return [];
    const out: ReturnType<Engine["orderPermissions"]> = [];
    for (const v of this.s.vision) {
      for (const t of v.tokens) {
        if (!t.delegate) continue;
        const known = this.s.orders.some(
          (o) =>
            o.vision === v.index &&
            (o.keyN != null ? this.orderDelegate(o.keyN) === t.delegate : (o.status === "active" || o.status === "pending") && this.orderInput(o).toBase58() === t.account),
        );
        if (known) continue;
        out.push({ vision: v.index, mint: t.mint, program: t.program, account: t.account, amount: t.delegated ?? 0n, held: t.amount, decimals: t.decimals, ours: this.ownSlot(v.index, t.delegate) != null });
      }
    }
    return out;
  }

  /**
   * Takes back an order permission no order on this device stands for (one from another device,
   * say): that order stops at once. For wrapped SOL, `home` then brings the SOL into the private balance.
   */
  async removePermission(vision: number, account: string, home = false) {
    if (this.orderBusy()) return;
    const t = this.s.vision.find((v) => v.index === vision)?.tokens.find((x) => x.account === account);
    if (!t) return;
    this.ordering = true;
    const kind = t.mint === WSOL ? "buy" : "sell";
    try {
      this.step(kind, "Removing the order's permission");
      const owner = this.visionKeypair(vision).publicKey;
      const a = await this.readApproval(new PublicKey(account));
      if (a?.delegate) await this.visionTx(vision, kind, [revokeIx(new PublicKey(account), owner, new PublicKey(t.program))], 50_000n);
      this.log({ kind, text: `Removed an order's permission in Vision wallet #${vision + 1}` });
      const moved = home && t.mint === WSOL ? await this.sweepInner(vision, true) : undefined;
      if (!moved) await this.refreshVision([vision]);
      this.done(
        "Permission removed",
        moved
          ? `No order can spend that SOL now, and it's in the waiting room. It joins your private balance in about ${this.waitLabel()}.`
          : `No order can trade from that account in Vision wallet #${vision + 1} now.`,
      );
    } catch (e) {
      this.fail(e);
    } finally {
      this.ordering = false;
    }
  }

  private pollingOrders = false;
  private tidyTries = new Map<string, number>();

  /** How the orders are doing; a sale's SOL goes back into the private balance by itself, and an ended order's leftovers are cleaned up. */
  async pollOrders() {
    if (this.pollingOrders || !this.keys) return;
    this.pollingOrders = true;
    try {
      await this.pollOrdersInner();
    } finally {
      this.pollingOrders = false;
    }
    await this.tidyOrders();
  }

  private async pollOrdersInner() {
    const live = this.s.orders.filter((o) => o.status === "active" || o.status === "pending" || o.settling);
    if (!live.length) return;
    const list: OrderReply[] = [];
    try {
      for (const part of chunk(
        live.map((o) => o.id),
        200,
      ))
        list.push(...(await api<OrderReply[]>("/api/orders/status", { json: { ids: part } })));
    } catch {
      // including "orders are still loading" after a server start: never handed back on that
      return;
    }
    // the keeper lost these (a server update): hand them back while their approvals still stand
    // (not one being placed right now: its approval may not have gone out yet)
    const lost = live.filter((o) => list.find((x) => x.id === o.id)?.status === "unknown" && !(this.ordering && o.status === "pending"));
    for (const o of lost) await this.reRegister(o).catch(() => {});
    let changed = false;
    const touched = new Set<number>();
    const next = this.s.orders.map((o) => {
      const r = list.find((x) => x.id === o.id);
      if (!r || r.status === "unknown" || lost.some((l) => l.id === o.id)) return o;
      const upd = mergeReply(o, r);
      if (!replyChanged(o, upd)) return o;
      changed = true;
      const fresh = upd.fills.slice(o.fills.length);
      for (const f of fresh) this.log({ kind: o.kind === "sell" ? "sell" : "buy", text: `${orderName(o)} filled on ${o.symbol}`, sig: f.sig });
      // every sale's SOL goes home, a step at a time too
      if (fresh.length) {
        touched.add(o.vision);
        if (o.kind === "sell") upd.sweep = true;
      }
      const ended = (upd.status === "expired" || upd.status === "cancelled" || upd.status === "failed") && (o.status === "active" || o.status === "pending" || o.settling);
      // ended on the keeper's side: its permission (and a buy's SOL) is cleaned up by itself
      if (ended && !/^Replaced/.test(upd.error ?? "")) {
        upd.release = true;
        touched.add(o.vision);
      }
      return upd;
    });
    if (changed) {
      this.changedAt = Date.now();
      this.saveOrders(next);
      if (touched.size) await this.refreshVision([...touched]).catch(() => {});
    }
    // an order whose approval went out is started again now and then, until the keeper takes it
    for (const o of this.s.orders) {
      if (this.ordering || o.status !== "pending" || list.find((x) => x.id === o.id)?.status !== "pending") continue;
      if (Date.now() - o.created < 20_000 || Date.now() - (this.activateTried.get(o.id) ?? 0) < 30_000) continue;
      this.activateTried.set(o.id, Date.now());
      void this.activateOrder(o.id).catch(() => {});
    }
  }

  /**
   * Once nothing else runs: a sale's SOL goes back into the private balance, and an order that
   * ended with its permission (or a buy's SOL) still in its Vision wallet is cleaned up. A wallet
   * too low on SOL for the fee is left for the button, so nothing is taken from the private balance unasked.
   * Both run as background work (see bgBegin): a status line, never in place of a message the
   * person is reading, and quiet once the account is locked or switched meanwhile.
   */
  private async tidyOrders() {
    if (this.s.busy || this.ordering || !this.keys) return;
    const keys = this.keys;
    // a buy waiting in a wallet is the person's plan for its SOL: it stays for "Finish the buy"
    for (const i of new Set(this.s.orders.filter((x) => x.sweep && this.buyIntent(x.vision)).map((x) => x.vision))) this.dropSweep(i);
    // a few tries a visit each; a sale's SOL keeps its flag for the next visit until it has moved
    const due = (x: Order) => (this.tidyTries.get(x.id) ?? 0) < 3;
    // a wallet not read yet can't say what's left in it: its cleanup waits until it is
    const read = (x: Order) => this.s.vision.some((v) => v.index === x.vision);
    let o: Order | undefined;
    const sweeps = this.s.orders.filter((x) => x.sweep && due(x));
    // sales' SOL goes back one Vision wallet at a time, a random 1 to 6 min apart (and apart from
    // deposit-address moves), so wallets whose orders filled together can't be grouped by timing.
    // The plan is tidied on every visit: a wallet with nothing left to move (moved by hand, too little
    // to move, given up on) leaves it, so it never keeps the syncs quick
    const now = Date.now();
    const last = this.lastMove();
    const vs = this.vmoveState();
    const plan = planMoves(now, [...new Set(sweeps.map((x) => x.vision))], vs.plan, last, MOVE_GAP);
    if (sweeps.length || Object.keys(vs.plan).length) ls.set(this.vmoveKey(), { plan, last: vs.last });
    if (sweeps.length) {
      const i = dueMove(now, plan, last, MOVE_GAP[0]);
      if (i != null) o = sweeps.find((x) => x.vision === i);
    }
    o ??= this.s.orders.find((x) => x.release && due(x) && read(x));
    if (!o) return;
    const tries = (this.tidyTries.get(o.id) ?? 0) + 1;
    this.tidyTries.set(o.id, tries);
    const n = o.vision + 1;
    if (o.sweep) {
      // the lock is taken before the first await, so a tap can't start something in between
      const task = this.bgBegin("sweep", "An order sold: moving its SOL back into your private balance");
      if (!task) return;
      // locked or switched to another account meanwhile: this stops, quietly
      const gone = () => this.keys !== keys || this.bgTask !== task;
      // a later order on this wallet may still be trading: its sale lands in the same account
      this.ordering = true;
      try {
        const moved = await this.sweepInner(o.vision, true);
        if (this.keys !== keys) return;
        // a move that went decided the flag itself: kept only while a deposit's worth is still there (more arrived meanwhile)
        if (!moved) this.markOrder(o.id, { sweep: undefined });
        else this.tidyTries.delete(o.id);
        // nothing moved: said only if the SOL really is still there (the person may have moved it already)
        let stays = false;
        if (!moved) {
          const v = this.s.vision.find((x) => x.index === o.vision);
          const keep = v?.tokens.some((t) => t.mint !== WSOL) ? VISION_RESERVE : 0n;
          const held = BigInt(await conn().getBalance(this.visionKeypair(o.vision).publicKey, "confirmed").catch(() => 0));
          stays = held > keep + 5_000n;
        }
        if (gone()) return;
        if (moved) this.done(`${orderName(o)} sold`, `Your ${o.symbol} sold, and the SOL is in the waiting room. It joins your private balance in about ${this.waitLabel()}.`, moved);
        else if (stays) this.done(`${orderName(o)} sold`, `Your ${o.symbol} sold. The SOL waits in Vision wallet #${n}: it's below the smallest deposit for now.`);
      } catch {
        if (gone()) return;
        this.bgEnd(task);
        // a passing problem shows nothing; the visit's last try says where the SOL is
        if (tries >= 3)
          this.bgSay({
            notice: {
              title: `${orderName(o)} sold`,
              text: `Your ${o.symbol} sold. The SOL is in Vision wallet #${n}. It moves into your private balance by itself the next time VisionSwap is open, or use "Move back to private balance" in the Wallets tab.`,
            },
          });
      } finally {
        this.ordering = false;
        this.bgEnd(task);
      }
      return;
    }
    const left = this.orderLeft(o);
    const v = this.s.vision.find((x) => x.index === o.vision);
    // nothing left behind, or not enough SOL in the wallet for the fee: the row's button is there
    if ((!left.permission && left.sol === 0n) || (v?.lamports ?? 0n) < 60_000n) {
      this.markOrder(o.id, { release: undefined });
      return;
    }
    const task = this.bgBegin(o.kind === "sell" ? "sell" : "buy", o.kind === "sell" ? "An order ended: removing its permission" : "An order ended: bringing its SOL back");
    if (!task) return;
    try {
      await this.cancelOrder(o.id, o.kind !== "sell", task).catch(() => {});
    } finally {
      this.bgEnd(task);
    }
    // it ran: whatever happened, the row's button covers the rest
    if (this.keys === keys) this.markOrder(o.id, { release: undefined });
  }

  /**
   * The person moved, sent or spent a Vision wallet's SOL themselves (or it went home): no filled
   * sell order there has SOL left to bring home by itself.
   */
  private dropSweep(index: number) {
    if (this.s.orders.some((o) => o.vision === index && o.sweep)) this.saveOrders(this.s.orders.map((o) => (o.vision === index && o.sweep ? { ...o, sweep: undefined } : o)));
  }

  // ─── when the relayer is down: send it yourself ───
  private gasKey() {
    return `vs:gas:${this.s.fingerprint}`;
  }
  /**
   * This account's fee wallets: `next` is the first one never used (nor funded), `used` those that
   * submitted a payment from this device, `seen` those another device (or a funding) left a trace on.
   */
  private gasState(): GasState {
    return ls.get<GasState>(this.gasKey(), { next: 0, used: [] });
  }

  /** The fee wallet the next payment you send yourself uses: a new one each time, so those payments don't share a payer. */
  gasIndex(): number {
    return this.gasState().next;
  }

  gasAddress(i = this.gasIndex()): string {
    return gasWallet(this.need().keys, i).publicKey.toBase58();
  }

  /**
   * This account's fee wallets that hold SOL, with the next fresh one first. Every time, the ones
   * past `next` are looked at on-chain (another device of this account may have sent with them
   * since), so a used one is never taken for a fresh one. One that was only funded is still fresh.
   * Each is read on its own, a moment apart. Used ones each paid for an earlier payment, so they
   * aren't read together (that would tie those payments to one person): they show what they held
   * when last read, and one at a time is read again, oldest reading first; one seen empty stays so.
   */
  async feeWallets(): Promise<{ index: number; address: string; lamports: bigint; used: boolean }[]> {
    const keys = this.need().keys;
    let st = this.gasState();
    try {
      const seen: number[] = [];
      const r = await gapScan(
        st.next,
        async (i) => {
          const t = await this.gasTrace(gasWallet(keys, i).publicKey);
          if (t === "funded") seen.push(i);
          return t === "sent";
        },
        5,
        2,
      );
      if (this.keys !== keys) return [];
      st = this.gasState();
      st = { ...st, next: Math.max(st.next, r.next), used: [...new Set([...st.used, ...r.found])], seen: [...new Set([...(st.seen ?? []), ...seen])] };
      ls.set(this.gasKey(), st);
    } catch (e) {
      // the network couldn't be asked: a device that looked before goes on what it knows
      if (!st.scanned && !st.used.length) throw e;
    }
    const bal = { ...(st.bal ?? {}) };
    const used = st.used.filter((i) => i !== st.next);
    // fresh ones (the next, and any only funded) are read every time; of the used ones, only the one read longest ago
    const again = used.filter((i) => bal[i]?.l !== "0").sort((a, b) => (bal[a]?.t ?? 0) - (bal[b]?.t ?? 0))[0];
    const fresh = shuffle((st.seen ?? []).filter((i) => i !== st.next && !st.used.includes(i)));
    const read = [st.next, ...shuffle([...fresh, ...(again !== undefined ? [again] : [])])];
    for (const [k, i] of read.entries()) {
      if (k > 0) await sleep(randInt(1000, 3000));
      const l = await conn()
        .getBalance(gasWallet(keys, i).publicKey, "confirmed")
        .catch(() => null);
      if (l !== null) bal[i] = { l: String(l), t: Date.now() };
    }
    if (this.keys !== keys) return [];
    ls.set(this.gasKey(), { ...this.gasState(), bal });
    const out = [];
    const earlier = [...new Set([...st.used, ...(st.seen ?? [])])].filter((i) => i !== st.next).sort((a, b) => b - a);
    for (const i of [st.next, ...earlier.slice(0, 6)]) {
      const lamports = BigInt(bal[i]?.l ?? "0");
      if (i === st.next || lamports > 0n) out.push({ index: i, address: gasWallet(keys, i).publicKey.toBase58(), lamports, used: st.used.includes(i) });
    }
    return out;
  }

  /** Whether a fee wallet sent anything itself (it paid for a transaction), was only funded, or was never touched. */
  private async gasTrace(who: PublicKey): Promise<"sent" | "funded" | "none"> {
    try {
      const sigs = await conn().getSignaturesForAddress(who, { limit: 3 }, "confirmed");
      if (!sigs.length) return "none";
      for (const s of sigs) {
        const tx = await conn().getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
        if (!tx || tx.transaction.message.staticAccountKeys[0]?.equals(who)) return "sent";
      }
      return "funded";
    } catch {
      throw new Error("Can't reach the network right now. Check your connection and try again.");
    }
  }

  private markGasUsed(i: number) {
    const st = this.gasState();
    // what it held before paying is out of date: it is the first used one read again
    const bal = { ...(st.bal ?? {}) };
    delete bal[i];
    ls.set(this.gasKey(), { ...st, next: Math.max(st.next, i + 1), used: [...new Set([...st.used, i])], bal });
  }

  /** What a payment's own fee payer must hold up front (it's paid back in the same transaction). */
  selfCost(): bigint {
    return BigInt(this.s.pool?.selfRelayCost ?? "1800000");
  }

  /**
   * A private payment submitted by the person's own fee payer instead of the relayer. The proof
   * names that payer, which gets its costs back from the payment itself, so nothing else is
   * needed. Joining notes, when needed, is done by the same payer, so the relayer isn't needed at
   * all. The recipient is always checked first; nothing is sent if that check can't run.
   */
  async sendSelf(recipient: string, amount: bigint, payer: SelfPayer, confirmed: Pick<Part, "offCurveOk" | "lookalikeOk"> = {}) {
    try {
      this.set({ ask: null });
      this.step("send", "Checking the recipient");
      const { keys } = this.need();
      const to = new PublicKey(recipient);
      const own = this.ownKeypairFor(to.toBase58());
      if (!own) this.deliveryGate();
      const kinds = await this.checkRecipients([{ to: to.toBase58(), amount, ...confirmed }], false, true);
      const cost = this.selfCost();
      await this.readTreasury();
      const rentMin = BigInt(await conn().getMinimumBalanceForRentExemption(0));
      // the one-time sending address pays its own fee, and must keep nothing or the rent minimum once that is taken (see sendMany)
      if (!own && amount < rentMin) throw new Error(`The smallest private send is ${fmtUp(rentMin, 5)} SOL.`);
      const withdraw = own ? grossUp(amount, cost, this.feeBps()) : this.quotePay(amount, cost).withdraw;
      // joins, when needed, are sent by the same fee payer at the same cost each: an amount they can't make fit is refused before any is paid
      if (await this.stillShort(() => !this.mergePlan(withdraw, cost).ok)) {
        const most = this.maxSelfSendable();
        throw new Error(
          most >= 1_000n
            ? `Send it yourself can spend at most ${fmt(most - (most % 1_000n), 6)} SOL at once. Send that much now and the rest in a second payment.`
            : "Not enough private balance for that amount, including fees.",
        );
      }
      const k = kinds[0];
      const exists = k ? k !== "new" && k !== "new-off-curve" : (await conn().getBalance(to, "confirmed")) > 0;
      if (!exists && amount < rentMin) throw new Error(`A new address needs at least ${fmt(rentMin)} SOL to exist.`);
      const kp = payer.kind === "vision" ? this.visionKeypair(payer.index) : gasWallet(keys, payer.index);
      // a fee wallet counts as used from the moment it sends anything, whatever comes of it, so it is never offered as new again
      const used = payer.kind === "gas" ? () => this.markGasUsed(payer.index) : undefined;
      const inputs = await this.inputsFor(
        "send",
        withdraw,
        async () => {
          const two = [...this.freeNotes()].sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, 2);
          if (two.length < 2) throw new Error("Not enough private balance.");
          await this.selfTransact("merge", two, kp, { kind: "fee" }, cost, cost, used);
          this.log({ kind: "merge", text: "Joined two notes yourself" });
        },
        cost,
      );
      const dest: Dest = own ? { kind: "own", kp: own } : { kind: "pay", to, amount, mode: "self", ...(confirmed.offCurveOk ? { offCurveOk: true } : {}) };
      const paid = await this.selfTransact("send", inputs, kp, dest, withdraw, cost, used);
      this.log({ kind: "send", text: `Sent ${fmt(amount)} SOL to ${shortAddr(to.toBase58())} yourself`, sig: paid.sig || undefined, ...(paid.hop ? { delivery: { hop: paid.hop, to: to.toBase58() } } : {}) });
      this.done(
        "Sent",
        !paid.hop
          ? `${fmt(amount)} SOL has arrived at ${shortAddr(to.toBase58())}. Your fee payer submitted it and got its costs back.`
          : paid.sig
            ? `${fmt(amount)} SOL arrived at ${shortAddr(to.toBase58())} as a standard SOL transfer. Your fee payer submitted it and got its costs back.`
            : `${fmt(amount)} SOL is on its way to ${shortAddr(to.toBase58())} as a standard SOL transfer. The app finishes it for you while it's open. Your fee payer submitted it and got its costs back.`,
        paid.sig || undefined,
      );
      return paid.sig || paid.tx1;
    } catch (e) {
      if (e instanceof NeedsConfirm) {
        this.set({ busy: null, ask: e.ask });
        throw e;
      }
      this.fail(e);
    }
  }

  /**
   * One spend submitted and paid for by `kp`, which the proof names as its relayer and pays back
   * `cost`. Every recipient signs it too (the site's RPC sends no pool payment whose recipient
   * doesn't): the fee payer itself for a join, one's own wallet, or a payment's one-time sending
   * address, which then passes the payment on to its recipient in a standard transfer.
   */
  private async selfTransact(
    kind: Activity["kind"],
    inputs: OwnedNote[],
    kp: Keypair,
    dest: Dest,
    withdraw: bigint,
    cost: bigint,
    beforeSend?: () => void,
  ): Promise<Paid> {
    const { pool } = this.need();
    const have = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
    if (have < cost + 1_000_000n) {
      throw new Error(`The fee payer needs at least ${fmtUp(cost + 1_000_000n, 4)} SOL to submit this (it gets the fee back in the same transaction). It holds ${fmt(have, 6)} SOL.`);
    }
    const { r, hop, request } = await this.prove(kind, inputs, dest, withdraw, cost, kp.publicKey.toBase58(), undefined, false, true);
    // the recipient co-signs: the hop, one's own wallet, or (a join) the fee payer itself
    const cosigner = hop ?? (dest.kind === "own" ? dest.kp : null);
    const recipient = new PublicKey(request.recipient);
    this.step(kind, kind === "merge" ? "Joining two notes yourself" : "Sending it yourself", "Your fee payer submits it directly, without the relayer.");
    const sp = {
      proof: unb64(r.proof),
      root: BigInt("0x" + r.root),
      nullifiers: [BigInt("0x" + r.nullifiers[0]), BigInt("0x" + r.nullifiers[1])] as [bigint, bigint],
      commitments: [BigInt("0x" + r.commitments[0]), BigInt("0x" + r.commitments[1])] as [bigint, bigint],
      ext: { recipient, relayer: kp.publicKey, withdraw, relayerFee: cost, maxFeeBps: pool.feeBps, meta0: unb64(r.meta0), meta1: unb64(r.meta1) },
    };
    const ix = this.pool().transact(sp, new PublicKey(pool.treasury));
    if (cosigner) ix.keys[1].isSigner = true;
    const tx = new Transaction().add(...computeBudget(TRANSACT_CU, 0), ix);
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...(cosigner ? [kp, cosigner] : [kp]));
    const leg: HopLeg | null =
      hop && dest.kind === "pay"
        ? { hop: hop.publicKey.toBase58(), out0: r.commitments[0], to: dest.to.toBase58(), amount: dest.amount.toString(), status: "proved", at: Date.now(), self: true }
        : null;
    // written down before it is sent: a delivery cut short is finished from here
    if (leg) this.saveLeg(leg);
    beforeSend?.();
    let sig: string;
    try {
      sig = await sendAndConfirm(tx, "payment");
    } catch (e) {
      // it may still land: its notes stay out of the balance until the chain says; anything else is a
      // send that certainly didn't land (refused, dropped, or failed on-chain), so its hop needs no looking after
      if (e instanceof StillPending) inputs.forEach((n) => this.pendingSpent.set(n.nullifier, Date.now()));
      else if (leg) this.dropLeg(leg.hop);
      throw e;
    }
    if (!leg) {
      await this.afterSpend(kind, inputs, sig, r.commitments, withdraw);
      return { sig, tx1: sig };
    }
    this.patchLeg(leg.hop, { status: "sent", tx1: sig });
    this.step(kind, "Delivering to the recipient", "A standard SOL transfer from a one-time sending address.");
    const tx2 = await this.finishLeg({ ...leg, status: "sent", tx1: sig }, true).catch(() => null);
    await this.afterSpend(kind, inputs, sig, r.commitments, withdraw);
    return { sig: tx2 ?? "", tx1: sig, hop: leg.hop };
  }

  /** Funds one of this account's fee wallets from the private balance (the pool pays it directly: it is this account's own). */
  async fundFeeWallet(index: number, amount: bigint) {
    try {
      this.step("send", "Checking the pool");
      const kp = gasWallet(this.need().keys, index);
      const q = this.quoteSend(amount);
      const paid = await this.withInputs("send", q.withdraw, (inputs) => this.proveAndPayout("send", inputs, { kind: "own", kp }, q.withdraw, q.relayerFee));
      const who = shortAddr(kp.publicKey.toBase58());
      this.log({ kind: "send", text: `Funded fee wallet #${index + 1} (${who}) with ${fmt(q.toRecipient)} SOL`, sig: paid.sig });
      this.done("Fee wallet funded", `${fmt(q.toRecipient)} SOL has arrived at fee wallet #${index + 1}. It came from the pool, and your wallet is not part of the transaction.`, paid.sig);
      return paid.sig;
    } catch (e) {
      this.fail(e);
    }
  }

  nextVisionIndex(): number {
    const used = new Set(this.s.vision.map((v) => v.index));
    let i = 0;
    while (used.has(i) || i < this.knownVision()) i++;
    return i;
  }

  visionKeypair(i: number): Keypair {
    return this.kp("v", i);
  }

  /** Private balance -> fresh Vision wallet -> any token. */
  async buy(mint: string, solAmount: bigint, slippageBps: number, auto = false, program?: string | null, o: TradeOpts = {}) {
    try {
      this.step("buy", "Checking the pool");
      const speed = speedOf(o.speed);
      const reserve = await this.reserveFor(mint, program);
      const deliver = solAmount + reserve;
      const q = this.quoteSend(deliver);
      const short = () => {
        const plan = this.mergePlan(q.withdraw);
        return !plan.ok || q.withdraw + plan.cost > this.spendable();
      };
      if (await this.stillShort(short)) throw new Error(this.tooMuchText(reserve));
      const idx = (await this.unusedVision(o.index)) ?? (await this.freshVisionIndex());
      o.onIndex?.(idx);
      const kp = this.visionKeypair(idx);
      const p: SwapParams = { inputMint: WSOL, outputMint: mint, amount: solAmount, slippageBps, side: "buy", speed, minOut: o.minOut };
      // the route first: when Jupiter is busy or the route can't work, nothing has been spent yet
      this.step("buy", "Getting the best route from Jupiter");
      await this.precheckBuy(idx, p);
      // remembered before the SOL can land, so even a closed tab comes back to "Finish the buy"
      const intent: BuyIntent = { mint, amount: solAmount.toString(), slippageBps, auto, speed, at: Date.now() };
      // notes a scheduled payment on another device holds are set aside and others picked (withInputs)
      const sig1 = await this.withInputs("buy", q.withdraw, async (inputs) => {
        try {
          return (await this.proveAndPayout("buy", inputs, { kind: "own", kp }, q.withdraw, q.relayerFee, undefined, () => this.saveIntent(idx, intent))).sig;
        } catch (e) {
          // the relayer surely refused it: nothing went out, so there is nothing to finish (an unclear outcome keeps the buy)
          if (e instanceof NotesHeld || (e instanceof ApiError && e.status >= 400 && e.status < 500 && definite(e))) this.clearIntent(idx);
          throw e;
        }
      });
      this.log({ kind: "buy", text: `Funded Vision wallet #${idx + 1} with ${fmt(deliver)} SOL`, sig: sig1 || undefined });
      this.step("buy", `Vision wallet #${idx + 1} is funded`, "Waiting for the SOL to land.");
      await this.waitForLamports(kp.publicKey, deliver);
      this.step("buy", "Getting the best route from Jupiter");
      let r: SwapResult;
      try {
        r = await this.swapFrom(idx, p);
      } catch (e) {
        await this.refreshVision([idx]);
        throw this.buyStopped(idx, e, deliver);
      }
      await this.boughtDone(idx, r, solAmount);
      return r.sig;
    } catch (e) {
      this.fail(e);
    }
  }

  /** "Not enough", with the real most a buy can spend when there is one. */
  private tooMuchText(reserve: bigint): string {
    const most = this.maxSpend(reserve);
    return most >= 1_000n
      ? `Not enough private balance for that, including fees. The most you can spend is ${fmt(most - (most % 1_000n), 6)} SOL.`
      : "Not enough private balance for that, including fees.";
  }

  /**
   * Builds a buy's route once before any SOL moves and checks it like the real one, so a busy
   * Jupiter, a route that can't work or a price that ran away since the quote costs nothing.
   */
  private async precheckBuy(index: number, p: SwapParams) {
    // the swap's first look at the wallet, made now: a token this network doesn't have stops here, before any SOL moves
    await this.tokenHeld(this.visionKeypair(index).publicKey, p.outputMint).catch((e) => {
      if (/could not find mint|invalid mint/i.test((e as Error)?.message ?? "")) throw new Error(NO_MARKET);
      throw e;
    });
    let b: SwapBuild;
    try {
      b = await this.buildWithin(index, p, 0, 25_000);
    } catch (e) {
      // a refusal about a wallet that isn't funded yet says nothing about the route: the buy goes on (and stays resumable)
      if (e instanceof ApiError && e.status === 400 && !/route|token address|amount/i.test(e.message)) return;
      if ((e as Error)?.message === PRICE_MOVED) {
        throw new Error("The price has moved past your price tolerance since the quote. Nothing was spent: check the new price and try again.");
      }
      throw e;
    }
    await this.checkedSwap(b, this.visionKeypair(index).publicKey, p);
  }

  /** What to tell the person when a funded buy's swap didn't happen. */
  private buyStopped(index: number, e: unknown, deliver: bigint): Error {
    const n = index + 1;
    if (e instanceof StillPending) {
      return new Error(`The swap is taking longer than usual. It may still go through: check Vision wallet #${n} and your activity in a minute before trying again.`);
    }
    if (isFinal(e)) return e as Error;
    const moved = isPriceMoved(e);
    const it = this.buyIntent(index);
    if (it) this.saveIntent(index, { ...it, why: moved ? "price" : "other" });
    return new Error(
      moved
        ? `The price moved past your price tolerance before the swap could land. Your ${fmt(deliver)} SOL is safe in Vision wallet #${n}: use "Finish the buy" there to try again, with the same or a little more price room, or move it back into the pool.`
        : `The swap didn't go through: ${(e as Error)?.message || "no reason given"} Your ${fmt(deliver)} SOL is safe in Vision wallet #${n}: use "Finish the buy" there to try again, or move it back into the pool.`,
    );
  }

  /** A buy that went through: tidy the wallet and say what arrived. */
  private async boughtDone(index: number, r: SwapResult, sol: bigint) {
    this.clearIntent(index);
    this.log({ kind: "buy", text: `Bought with ${fmt(sol)} SOL in Vision wallet #${index + 1}`, sig: r.sig || undefined });
    await this.closeLeftovers(index);
    await this.refreshVision([index]);
    const got = r.got != null && r.got > 0n && r.decimals != null ? `${formatUnits(r.got, r.decimals, 6)} tokens arrived` : "Your tokens are";
    this.done(
      "Bought privately",
      `${got} in Vision wallet #${index + 1}, a fresh address funded from the pool. Sell them from the Sell tab whenever you like.`,
      r.sig || undefined,
    );
  }

  private intentKey(index: number) {
    return `vs:intent:${this.s.fingerprint}:${index}`;
  }

  private saveIntent(index: number, it: BuyIntent) {
    ls.set(this.intentKey(index), it);
  }

  private clearIntent(index: number) {
    ls.set(this.intentKey(index), null);
  }

  /** A buy whose Vision wallet was funded but whose swap hasn't happened yet. Kept on this device only. */
  buyIntent(index: number): BuyIntent | null {
    return this.s.fingerprint ? ls.get<BuyIntent | null>(this.intentKey(index), null) : null;
  }

  /** Vision wallets with a buy waiting to finish. */
  private intentIndexes(): number[] {
    return range(this.knownVision() + 2).filter((i) => this.buyIntent(i));
  }

  /**
   * The unfinished buy "Finish the buy" can pick up in this Vision wallet, or null: none, already
   * bought, no SOL here, or its last try was sent a moment ago and may still land.
   */
  finishable(v: VisionView): BuyIntent | null {
    const it = this.buyIntent(v.index);
    if (!it || v.lamports === 0n || v.tokens.some((t) => t.mint === it.mint)) return null;
    if (it.sig && Date.now() - (it.sigAt ?? 0) < 120_000) return null;
    return it;
  }

  /** The price tolerance "Finish the buy" offers after the price ran away: a little more room than last time. */
  finishSlippage(it: BuyIntent): number {
    return Math.min(MAX_SLIPPAGE, Math.max(it.slippageBps + 100, Math.ceil((it.slippageBps * 1.6) / 50) * 50));
  }

  /**
   * Retries just the swap of an unfinished buy; the pool fee was already paid when the wallet was
   * funded. It first makes sure the buy hasn't happened already: the last try's outcome, then the
   * wallet itself. `widen` uses finishSlippage, which the button names.
   */
  async finishBuy(index: number, widen = false) {
    const n = index + 1;
    try {
      const it = this.buyIntent(index);
      if (!it) throw new Error("There's no unfinished buy for this Vision wallet.");
      const owner = this.visionKeypair(index).publicKey;
      this.step("buy", `Checking Vision wallet #${n}`);
      if (it.sig) {
        const state = await signatureState(it.sig, it.lvh);
        if (state === "landed") return await this.alreadyBought(index, it.sig);
        if (state === "unknown") throw final(`The last try for Vision wallet #${n} may still go through. Check again in a minute.`);
      }
      const [lamports, held] = await Promise.all([conn().getBalance(owner, "confirmed").then(BigInt), this.tokenHeld(owner, it.mint)]);
      if (held.raw > 0n) return await this.alreadyBought(index);
      // the wallet keeps its reserve for fees; what is left is what this buy can still spend
      const room = lamports - (await this.reserveFor(it.mint));
      const want = BigInt(it.amount);
      if (room < (want * 9n) / 10n) {
        throw final(`Vision wallet #${n} holds ${fmt(lamports, 6)} SOL, less than this buy needs. It may have bought already, or its SOL moved: check your activity before trying again.`);
      }
      const amount = room < want ? room : want;
      const slippageBps = widen ? this.finishSlippage(it) : it.slippageBps;
      this.step("buy", "Getting the best route from Jupiter");
      // a retry: it pays a little more priority to land
      const r = await this.swapFrom(index, { inputMint: WSOL, outputMint: it.mint, amount, slippageBps, side: "buy", speed: speedOf(it.speed) }, 1);
      await this.boughtDone(index, r, amount);
      return r.sig;
    } catch (e) {
      if (e instanceof StillPending || isFinal(e)) this.fail(e);
      const it = this.buyIntent(index);
      const moved = isPriceMoved(e);
      // the wider room the person chose is kept only when the price ran away from it too, so the next offer goes further
      if (it) this.saveIntent(index, { ...it, why: moved ? "price" : "other", ...(widen && moved ? { slippageBps: this.finishSlippage(it) } : {}) });
      this.fail(new Error(`The swap didn't go through: ${(e as Error)?.message || "no reason given"} The SOL is still in Vision wallet #${n}; try again in a moment.`));
    }
  }

  /**
   * A Vision wallet holding only SOL, with no buy of this device waiting in it (funded on another
   * device, or before this browser's data was cleared): its SOL can buy from there, without paying
   * the pool fee again.
   */
  buyable(v: VisionView): boolean {
    const pool = this.s.pool;
    if (!pool || v.tokens.length || this.buyIntent(v.index)) return false;
    return v.lamports >= BigInt(pool.minDeposit) + VISION_RESERVE;
  }

  /** Buys with the SOL already in Vision wallet `index` (see buyable); it keeps its reserve for fees. */
  async buyFrom(index: number, mint: string, solAmount: bigint, slippageBps: number, auto = false, program?: string | null, o: TradeOpts = {}) {
    const n = index + 1;
    try {
      if (this.buyIntent(index)) throw new Error(`Vision wallet #${n} has a buy waiting: use "Finish the buy" there.`);
      this.step("buy", `Checking Vision wallet #${n}`);
      const owner = this.visionKeypair(index).publicKey;
      const [lamports, reserve] = await Promise.all([conn().getBalance(owner, "confirmed").then(BigInt), this.reserveFor(mint, program)]);
      if (solAmount + reserve > lamports) {
        const most = lamports > reserve ? lamports - reserve : 0n;
        throw new Error(`Vision wallet #${n} can spend at most ${fmt(most - (most % 1_000n), 6)} SOL: it keeps ${fmt(reserve, 4)} SOL for its fees.`);
      }
      const speed = speedOf(o.speed);
      const p: SwapParams = { inputMint: WSOL, outputMint: mint, amount: solAmount, slippageBps, side: "buy", speed, minOut: o.minOut };
      this.step("buy", "Getting the best route from Jupiter");
      await this.precheckBuy(index, p);
      // remembered before the swap, like any buy, so a closed tab comes back to "Finish the buy"
      this.saveIntent(index, { mint, amount: solAmount.toString(), slippageBps, auto, speed, at: Date.now() });
      // this wallet's SOL now goes into the buy, not back into the pool
      this.dropSweep(index);
      let r: SwapResult;
      try {
        r = await this.swapFrom(index, p);
      } catch (e) {
        // no pool fee rides on a buy from the wallet's own SOL: when its swap surely never went out,
        // there's nothing to finish and the wallet simply buys again (an unclear outcome keeps "Finish the buy")
        const clear = !(e instanceof StillPending) && !isFinal(e) && !this.buyIntent(index)?.sig;
        if (clear) this.clearIntent(index);
        await this.refreshVision([index]);
        if (!clear) throw this.buyStopped(index, e, lamports);
        throw new Error(
          isPriceMoved(e)
            ? `The price moved past your price tolerance before the swap could land. The SOL is still in Vision wallet #${n}: check the new price and try again.`
            : `The swap didn't go through: ${((e as Error)?.message || "no reason given").replace(/\.?$/, ".")} The SOL is still in Vision wallet #${n}.`,
        );
      }
      await this.boughtDone(index, r, solAmount);
      return r.sig;
    } catch (e) {
      this.fail(e);
    }
  }

  /** An unfinished buy whose swap went through after all: nothing more is bought. */
  private async alreadyBought(index: number, sig?: string) {
    this.clearIntent(index);
    await this.refreshVision([index]);
    this.done("Already bought", `Vision wallet #${index + 1}'s earlier swap went through, so nothing more was bought. Your tokens are there.`, sig);
    return sig;
  }

  /** Vision wallet token -> SOL -> back into the private balance. */
  async sell(index: number, mint: string, amount: bigint, slippageBps: number, _auto = false, o: TradeOpts = {}) {
    try {
      this.step("sell", "Getting the best route from Jupiter");
      // a live order in this wallet changes as the person agreed, never left quietly broken: a buy
      // ends first, a take-profit/stop-loss is lowered (or ends) once the sale has landed
      const ended = await this.endForSale(index, mint, amount, !!o.orders);
      this.step("sell", "Getting the best route from Jupiter");
      let r: Awaited<ReturnType<Engine["swapFrom"]>>;
      try {
        r = await this.swapFrom(index, { inputMint: mint, outputMint: WSOL, amount, slippageBps, side: "sell", speed: speedOf(o.speed), minOut: o.minOut, onSwap: o.onSwap });
      } catch (e) {
        if (ended) throw new Error(`${((e as Error)?.message || "The sale didn't go through.").replace(/\.?$/, ".")} ${ended}`);
        throw e;
      }
      // a sale shows any buy in this wallet went through
      this.clearIntent(index);
      this.log({ kind: "sell", text: `Sold from Vision wallet #${index + 1}`, sig: r.sig || undefined });
      if (o.orders) await this.lowerAfterSale(index, mint).catch(() => {}); // until it's lowered, the keeper sells only what's there
      // the sale closed the wrapped-SOL account a live take-profit/stop-loss sells into: open again, whatever the move below does
      await this.keepSaleAccount(index, mint, amount).catch(() => {});
      let moved: string | undefined;
      let later: string | null = null;
      try {
        moved = await this.sweepInner(index, true);
      } catch (e) {
        later = (e as Error)?.message || "it didn't go through";
      }
      // a sweep that went through has already looked at the wallet
      if (!moved) await this.refreshVision([index]);
      const tokensLeft = this.s.vision.find((v) => v.index === index)?.tokens.some((t) => t.mint !== WSOL) ?? false;
      this.done(
        "Sold privately",
        later
          ? `The SOL is in Vision wallet #${index + 1}. Moving it into your private balance didn't work just now (${later.replace(/\.$/, "")}). Use "Move back to private balance" in the Wallets tab to try again; nothing is lost.`
          : moved
            ? `The SOL from Vision wallet #${index + 1} is in the waiting room and joins your private balance in about ${this.waitLabel()}.`
            : tokensLeft
              ? `The SOL stays in Vision wallet #${index + 1} for now: it's below the smallest deposit. Sell more, then use "Move back to private balance" in the Wallets tab.`
              : `The SOL stays in Vision wallet #${index + 1}: it's less than the smallest deposit, so it can't go back into the pool on its own. "Send to an address" in the Wallets tab moves it wherever you like.`,
        r.sig || undefined,
      );
      return r.sig;
    } catch (e) {
      this.fail(e);
    }
  }

  /** Moves a Vision wallet's SOL back into the pool. */
  async sweep(index: number, quiet = false) {
    try {
      // busy straight away, so a second tap can't start a second move meanwhile
      this.step("sweep", "Moving the SOL back into your private balance");
      return await this.sweepInner(index, quiet);
    } catch (e) {
      this.fail(e);
    }
  }

  /** The network fee of a Vision wallet's move into the pool (with account closes it gets a bigger compute budget). */
  private sweepTxFee(closes: boolean): bigint {
    return closes ? 5_000n * (this.s.pool?.requireAttestation ? 2n : 1n) + ownPriority(SWEEP_CU) : this.depositTxFee();
  }

  /** The least a Vision wallet holding nothing else must have for "Move back to private balance" to work. */
  sweepMin(): bigint | null {
    const pool = this.s.pool;
    const rent = this.s.rent;
    if (!pool || !rent) return null;
    const min = BigInt(pool.minDeposit);
    return min + this.depositFee(min) + rent.pending + this.sweepTxFee(false);
  }

  /**
   * What a sale would put back into the pool, worked out the way the move itself does: the
   * wallet's SOL plus the sale's proceeds, less the swap's usual fee, the waiting-room rent and the
   * reserve it keeps while tokens remain. 0 when that is below the smallest deposit (the SOL
   * would stay in the Vision wallet); null while the numbers aren't known.
   */
  sellPreview(index: number, mint: string, sell: bigint, proceeds: bigint, speed: Speed = "normal"): bigint | null {
    const pool = this.s.pool;
    const rent = this.s.rent;
    const v = this.s.vision.find((x) => x.index === index);
    if (!pool || !rent || !v) return null;
    const after = v.tokens.filter((t) => t.mint !== WSOL && (t.mint !== mint || t.amount > sell));
    const reserve = after.length ? (after.some((t) => t.program === TOKEN_2022) ? VISION_RESERVE_2022 : VISION_RESERVE) : 0n;
    // selling all of it closes the token account, and its rent comes back (Token-2022 accounts vary, so they count nothing)
    const sold = v.tokens.find((t) => t.mint === mint);
    const reclaim = sold && sold.amount <= sell && sold.program === TOKEN_PROGRAM ? TOKEN_ACCOUNT_RENT : 0n;
    // in as many deposits as the pool's per-deposit limit needs, each paying its own costs
    return sweepParts({
      lamports: v.lamports + proceeds - 5_000n - speedEstimate(speed),
      reclaim,
      txFee: this.sweepTxFee(reclaim > 0n),
      rentPending: rent.pending,
      reserve,
      feeBps: this.depositFeeBps(),
      min: BigInt(pool.minDeposit),
      max: BigInt(pool.maxDeposit),
    }).reduce((t, a) => t + a, 0n);
  }

  private async sweepInner(index: number, quiet: boolean): Promise<string | undefined> {
    // busy before the first await, so nothing else can start in between
    this.step("sweep", "Moving the SOL back into your private balance");
    await this.loadPool(); // the latest fee rules decide how much fits
    const { pool, keys } = this.need();
    const kp = this.visionKeypair(index);
    const n = index + 1;
    // emptied token accounts close for their rent; more than fit beside the deposit close first, on their own
    let left = await this.emptyAccounts(kp.publicKey);
    if (left.units.length > SWEEP_CLOSES) {
      await this.closeAccounts(kp, left.units);
      left = await this.emptyAccounts(kp.publicKey);
    }
    const closes = left.units.flatMap((u) => u.ixs);
    // Solana won't leave a wallet with less than its rent minimum, so it ends at exactly zero or,
    // while it still holds tokens, keeps a reserve that pays for selling them later.
    const rent = await this.rentNow();
    const rentPending = BigInt(await conn().getMinimumBalanceForRentExemption(Pool.PENDING_SPACE));
    const lamports = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
    const reserve = left.holds.length ? (left.holds.includes(TOKEN_2022) ? VISION_RESERVE_2022 : VISION_RESERVE) : 0n;
    const txFee = this.sweepTxFee(closes.length > 0);
    const min = BigInt(pool.minDeposit);
    const max = BigInt(pool.maxDeposit);
    const feeBps = this.depositFeeBps();
    // the pool takes at most a set amount per deposit: a big sale goes back in several
    const parts = sweepParts({ lamports, reclaim: left.reclaim, txFee, rentPending, reserve, feeBps, min, max });
    if (!parts.length) {
      // nothing to move, but empty accounts still give their rent back to the wallet
      if (closes.length) await this.closeAccounts(kp, left.units).catch(() => {});
      if (!quiet) {
        const sizes = { lamports, reclaim: left.reclaim, txFee, rentPending, minDeposit: min, fit: (b: bigint) => this.maxDepositFor(b) };
        throw new Error(
          reserve > 0n && sweepAmount({ ...sizes, reserve: 0n }).amount > 0n
            ? `Vision wallet #${n} keeps ${fmt(reserve)} SOL to pay for selling the tokens it still holds, and the rest is below the smallest deposit. Sell those tokens (or clear ones you won't sell) first.`
            : `Vision wallet #${n} holds less than the smallest deposit.`,
        );
      }
      return undefined;
    }
    const room = pool.tvlRoom != null ? BigInt(pool.tvlRoom) : null;
    if (room != null && parts.reduce((t, a) => t + a, 0n) > room) {
      throw new Error(`The pool is at its deposit limit right now. The SOL is safe in Vision wallet #${n}; try again later.`);
    }
    const before = this.waitingFrom(kp.publicKey.toBase58());
    let total = 0n;
    let sig = "";
    let sent = 0;
    // more arrived meanwhile than the last part could take: the rest moves on a later try
    let rest = false;
    for (let k = 0; k < parts.length; k++) {
      if (parts.length > 1) this.step("sweep", `Deposit ${k + 1} of ${parts.length}`, "The pool takes at most a set amount per deposit, so this goes in parts.");
      const first = k === 0;
      let amount = parts[k];
      let dust = 0n;
      if (k === parts.length - 1) {
        // the last part is planned from what is really there now, and carries the rounding dust
        const fresh = first ? lamports + left.reclaim : BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
        const fee = first ? txFee : this.depositTxFee();
        ({ amount, dust } = lastPart({ lamports: fresh, txFee: fee, rentPending, reserve, feeBps, max, rentWallet: rent.wallet }));
        // it changed meanwhile: what's left is below the smallest deposit, so it stays in the wallet
        if (amount < min) break;
        rest = leftOver({ lamports: fresh, txFee: fee, rentPending, reserve, feeBps, amount, dust, nextTxFee: this.depositTxFee(), min, max });
      }
      // the note must belong to the account this Vision wallet belongs to
      if (this.keys !== keys) throw new Error("Your account was locked, so this stopped. Nothing more was sent.");
      const { ixs: dep } = await this.depositIxs(kp.publicKey, amount);
      if (dust > 0n) {
        const pendingAccount = dep[dep.length - 1].keys[4].pubkey;
        dep.push(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: pendingAccount, lamports: dust }));
      }
      // only the first part closes accounts; the attestation must sit right before the deposit
      const withCloses = first && closes.length > 0;
      const tx = new Transaction().add(
        ...computeBudget(withCloses ? SWEEP_CU : DEPOSIT_CU, OWN_PRICE),
        ...(withCloses ? closes : []),
        ...dep.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)),
      );
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
      if (withCloses && !fits(tx)) {
        // too big after all: close the accounts on their own, then move what's there
        await this.closeAccounts(kp, left.units);
        return this.sweepInner(index, quiet);
      }
      tx.sign(kp);
      sig = await sendAndConfirm(tx, "deposit");
      sent++;
      total += amount;
      if (first) this.clearIntent(index);
      this.log({ kind: "sweep", text: `Moved ${fmt(amount)} SOL from Vision wallet #${n} into the pool`, sig });
    }
    // an order's sale keeps its flag while a deposit's worth is still there, so the rest moves on a later try
    if (!rest) this.dropSweep(index);
    // the next automatic move into the pool waits its gap after this one
    if (sent) ls.set(this.vmoveKey(), { plan: afterMove(Date.now(), this.vmoveState().plan, index, MOVE_GAP), last: Date.now() });
    await Promise.all([this.awaitWaiting(kp.publicKey.toBase58(), before, sent), this.refreshVision([index])]);
    if (!quiet)
      this.done(
        "Moved back",
        `${fmt(total)} SOL from Vision wallet #${n} is in the waiting room${sent > 1 ? ` (in ${sent} deposits, the most the pool takes at once)` : ""}. It joins your private balance in about ${this.waitLabel()}.${rest ? ` More SOL arrived meanwhile: use "Move back to private balance" again.` : ""}`,
        sig,
      );
    return sig;
  }

  /**
   * A Vision wallet's emptied token accounts, ready to close for their rent, each as one unit (a
   * Token-2022 account first hands any transfer tax it collected to the mint, since it can't close
   * holding it). Also says which token programs it still holds tokens under; an account its
   * token's issuer froze can neither be sold nor closed, so it holds nothing back.
   */
  private async emptyAccounts(owner: PublicKey): Promise<{ units: CloseUnit[]; reclaim: bigint; holds: string[] }> {
    const units: CloseUnit[] = [];
    const holds: string[] = [];
    const lists: [string, Awaited<ReturnType<Connection["getParsedTokenAccountsByOwner"]>>][] = [];
    for (const prog of [TOKEN_PROGRAM, TOKEN_2022]) lists.push([prog, await conn().getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(prog) }, "confirmed")]);
    const infoOf = (a: (typeof lists)[number][1]["value"][number]) => (a.account.data as { parsed: { info: TokenAccountInfo } }).parsed.info;
    // a live order needs its accounts kept: a sale's SOL lands in the wrapped-SOL account, a buy's tokens in its token account
    // (an approval on-chain counts too: the order may come from another device)
    const mine = this.s.orders.filter((o) => (o.status === "active" || o.status === "pending") && this.keys && this.visionKeypair(o.vision).publicKey.equals(owner));
    const all = lists.flatMap(([, r]) => r.value.map(infoOf));
    const sellLive = mine.some((o) => o.kind === "sell") || all.some((i) => i.mint !== WSOL && !!i.delegate && i.tokenAmount.amount !== "0");
    const buyLive = mine.some((o) => o.kind !== "sell") || all.some((i) => i.mint === WSOL && !!i.delegate && i.tokenAmount.amount !== "0");
    const wsolAta = ataOf(owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM));
    let hasWsolAta = false;
    for (const [prog, r] of lists) {
      for (const a of r.value) {
        const info = infoOf(a);
        const isWsolAta = a.pubkey.equals(wsolAta);
        if (isWsolAta) hasWsolAta = true;
        if (info.state === "frozen") continue;
        const lamports = BigInt(a.account.lamports);
        if (info.mint === WSOL && info.tokenAmount.amount !== "0" && !info.delegate) {
          // wrapped SOL: closing it hands every lamport back as plain SOL; a live sale's account opens again, empty
          if (sellLive && isWsolAta) units.push({ ixs: [closeAccountIx(a.pubkey, owner, new PublicKey(prog)), createAtaIx(owner, owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM))], lamports: lamports - TOKEN_ACCOUNT_RENT });
          else units.push({ ixs: [closeAccountIx(a.pubkey, owner, new PublicKey(prog))], lamports });
        } else if (info.tokenAmount.amount === "0" && ((sellLive && isWsolAta) || (buyLive && info.mint !== WSOL))) {
          // kept for a live order
        } else if (info.tokenAmount.amount === "0") {
          const ixs: TransactionInstruction[] = [];
          const withheld = info.extensions?.find((x) => x.extension === "transferFeeAmount")?.state?.withheldAmount;
          if (prog === TOKEN_2022 && withheld && BigInt(withheld) > 0n) ixs.push(harvestWithheldIx(new PublicKey(info.mint), a.pubkey));
          ixs.push(closeAccountIx(a.pubkey, owner, new PublicKey(prog)));
          units.push({ ixs, lamports });
        } else if (!holds.includes(prog)) {
          holds.push(prog);
        }
      }
    }
    // a live sale's account closed meanwhile (a manual sale unwraps it): opened again
    if (sellLive && !hasWsolAta) units.push({ ixs: [createAtaIx(owner, owner, new PublicKey(WSOL), new PublicKey(TOKEN_PROGRAM))], lamports: -TOKEN_ACCOUNT_RENT });
    return { units, reclaim: units.reduce((s, u) => s + u.lamports, 0n), holds };
  }

  /**
   * Closes token accounts in transactions of their own, as many units as fit in each (a harvest
   * stays with its close), one after another. The rent lands back in the wallet.
   */
  private async closeAccounts(kp: Keypair, units: CloseUnit[]) {
    let rest = [...units];
    while (rest.length) {
      let take = rest.length;
      let tx: Transaction;
      const bh = (await conn().getLatestBlockhash("confirmed")).blockhash;
      for (;;) {
        tx = new Transaction().add(...computeBudget(CLEANUP_CU, OWN_PRICE), ...rest.slice(0, take).flatMap((u) => u.ixs));
        tx.feePayer = kp.publicKey;
        tx.recentBlockhash = bh;
        if (fits(tx) || take === 1) break;
        take--;
      }
      tx.sign(kp);
      await sendAndConfirm(tx, "cleanup");
      rest = rest.slice(take);
    }
  }

  /**
   * After a buy, the route's temporary token accounts sit empty in the Vision wallet holding
   * rent. Closing them puts that SOL back in the wallet, ready for the fees of selling later.
   * Never fails the buy: it's housekeeping.
   */
  private async closeLeftovers(index: number) {
    try {
      const kp = this.visionKeypair(index);
      const { units } = await this.emptyAccounts(kp.publicKey);
      if (units.length) await this.closeAccounts(kp, units);
    } catch {
      /* the next sweep closes them */
    }
  }

  /**
   * Burns all of a token a Vision wallet holds and closes its account, so the account's rent comes
   * back as SOL. For a token that can't be sold (no route, a spam airdrop, a rug); it can't be undone.
   */
  async clearToken(index: number, mint: string) {
    const n = index + 1;
    try {
      const kp = this.visionKeypair(index);
      const owner = kp.publicKey;
      this.step("sweep", "Clearing the token");
      const r = await conn().getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, "confirmed");
      if (!r.value.length) throw new Error(`Vision wallet #${n} doesn't hold this token any more.`);
      const ixs: TransactionInstruction[] = [];
      let reclaim = 0n;
      for (const a of r.value) {
        const info = (a.account.data as { parsed: { info: TokenAccountInfo } }).parsed.info;
        const prog = a.account.owner;
        if (info.state === "frozen") {
          throw new Error("This token's issuer has frozen it, so it can't be cleared. It doesn't hold back any SOL: \"Move back to private balance\" works without it.");
        }
        const amount = BigInt(info.tokenAmount.amount);
        if (amount > 0n) ixs.push(burnIx(a.pubkey, new PublicKey(mint), owner, amount, prog));
        const withheld = info.extensions?.find((x) => x.extension === "transferFeeAmount")?.state?.withheldAmount;
        if (prog.toBase58() === TOKEN_2022 && withheld && BigInt(withheld) > 0n) ixs.push(harvestWithheldIx(new PublicKey(mint), a.pubkey));
        ixs.push(closeAccountIx(a.pubkey, owner, prog));
        reclaim += BigInt(a.account.lamports);
      }
      const fee = 5_000n + ownPriority(CLEANUP_CU);
      if (BigInt(await conn().getBalance(owner, "confirmed")) < fee) {
        throw new Error(`Vision wallet #${n} needs a tiny bit of SOL (${fmtUp(fee, 6)}) for the network fee first.`);
      }
      const tx = new Transaction().add(...computeBudget(CLEANUP_CU, OWN_PRICE), ...ixs);
      tx.feePayer = owner;
      tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
      tx.sign(kp);
      const sig = await sendAndConfirm(tx, "cleanup");
      this.log({ kind: "sweep", text: `Cleared a token from Vision wallet #${n}`, sig });
      await this.refreshVision([index]);
      this.done("Token cleared", `Its account's ${fmt(reclaim, 6)} SOL rent is back in Vision wallet #${n}. "Move back to private balance" in the Wallets tab brings the SOL home.`, sig);
      return sig;
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * Sends everything a Vision wallet holds to another wallet as an ordinary (public) transfer,
   * closing its empty token accounts on the way: for SOL too little to move into the pool.
   */
  async sendFromVision(index: number, to: string) {
    const n = index + 1;
    try {
      let dest: PublicKey;
      try {
        dest = new PublicKey(to.trim());
      } catch {
        throw new Error("That doesn't look like a Solana address.");
      }
      const kp = this.visionKeypair(index);
      if (dest.equals(kp.publicKey)) throw new Error("That's this Vision wallet itself.");
      this.step("send", `Sending from Vision wallet #${n}`);
      let left = await this.emptyAccounts(kp.publicKey);
      if (left.holds.length) throw new Error(`Vision wallet #${n} still holds tokens. Sell them (or clear ones you won't sell) first, so nothing is left behind.`);
      // more accounts than fit beside the transfer close first, on their own: once it's sent, nothing is left to pay for closing them
      if (left.units.length > SWEEP_CLOSES) {
        await this.closeAccounts(kp, left.units);
        left = await this.emptyAccounts(kp.publicKey);
      }
      const units = left.units.slice(0, SWEEP_CLOSES);
      const reclaim = units.reduce((s, u) => s + u.lamports, 0n);
      const amount = BigInt(await conn().getBalance(kp.publicKey, "confirmed")) + reclaim - 5_000n - ownPriority(CLEANUP_CU);
      if (amount <= 0n) throw new Error("There's nothing to send from this Vision wallet.");
      const { wallet: rentMin } = await this.rentNow();
      const exists = (await conn().getBalance(dest, "confirmed")) > 0;
      if (!exists && amount < rentMin) throw new Error(`A new address needs at least ${fmt(rentMin, 6)} SOL to exist. Send it to a wallet that already holds SOL.`);
      const tx = new Transaction().add(
        ...computeBudget(CLEANUP_CU, OWN_PRICE),
        ...units.flatMap((u) => u.ixs),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports: amount }),
      );
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
      tx.sign(kp);
      const sig = await sendAndConfirm(tx, "transfer");
      this.clearIntent(index);
      this.dropSweep(index);
      this.log({ kind: "send", text: `Sent ${fmt(amount)} SOL from Vision wallet #${n} to ${this.addressName(dest.toBase58())}`, sig });
      await this.refreshVision([index]);
      this.done("Sent", `${fmt(amount)} SOL is on its way to ${this.addressName(dest.toBase58())}.`, sig);
      return sig;
    } catch (e) {
      this.fail(e);
    }
  }

  /** The SOL a Vision wallet keeps for fees when it buys `mint`. */
  private async reserveFor(mint: string, program?: string | null): Promise<bigint> {
    if (program) return visionReserve(program);
    const info = await conn()
      .getAccountInfo(new PublicKey(mint), "confirmed")
      .catch(() => null);
    return visionReserve(info?.owner.toBase58());
  }

  /** How much of `mint` a wallet holds (raw units), and the token's decimals. */
  private async tokenHeld(owner: PublicKey, mint: string): Promise<{ raw: bigint; decimals: number }> {
    const r = await conn().getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, "confirmed");
    let raw = 0n;
    let decimals = 0;
    for (const a of r.value) {
      const t = (a.account.data as { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } }).parsed.info.tokenAmount;
      raw += BigInt(t.amount);
      decimals = t.decimals;
    }
    return { raw, decimals };
  }

  /**
   * A Vision wallet short of SOL for a trade's fees and temporary token accounts gets a top-up
   * from the private balance (through the pool, so nothing links it). What isn't used comes back
   * with the rest when the wallet is emptied. Only ever fee-sized: a bigger gap means the wallet
   * no longer holds what the trade needs, and topping that up could pay for a trade twice.
   */
  private async topUpVision(index: number, kind: Activity["kind"], short: bigint) {
    if (short > TOPUP_MAX) {
      throw final(
        `Vision wallet #${index + 1} would need ${fmtUp(short, 4)} SOL more for this, far more than its fees. Nothing more was sent: check your activity, then try again.`,
      );
    }
    const kp = this.visionKeypair(index);
    const deliver = short + 3_000_000n < 5_000_000n ? 5_000_000n : short + 3_000_000n;
    const q = this.quoteSend(deliver);
    if (q.withdraw > this.spendable()) {
      throw new Error(
        `Vision wallet #${index + 1} needs about ${fmtUp(deliver, 4)} SOL more for this trade's network fees and temporary token accounts (most of it comes back afterwards). Your private balance can't cover that right now: shield a little more SOL, then try again.`,
      );
    }
    this.step(kind, `Adding ${fmt(deliver, 4)} SOL for fees`, `This trade opens temporary token accounts. The SOL comes from your private balance and returns with the rest.`);
    const before = BigInt(await conn().getBalance(kp.publicKey, "confirmed"));
    const sig = (await this.withInputs(kind, q.withdraw, (inputs) => this.proveAndPayout(kind, inputs, { kind: "own", kp }, q.withdraw, q.relayerFee))).sig;
    this.log({ kind, text: `Added ${fmt(deliver, 4)} SOL to Vision wallet #${index + 1} for trading fees`, sig: sig || undefined });
    await this.waitForLamports(kp.publicKey, before + deliver);
  }

  /** The key that made a waiting deposit, when this account holds it (a Vision wallet or a deposit address). */
  private sourceKeypair(w: Waiting): Keypair | null {
    if (w.vision !== null) return this.visionKeypair(w.vision);
    if (w.deposit !== null) return this.depositKeypair(w.deposit);
    if (w.hop) return this.hopKeypair(w.depositor);
    return null;
  }

  /** Takes a waiting deposit back to the wallet or address it came from. */
  async refund(w: Waiting, wallet: WalletLike | null) {
    try {
      this.step("refund", "Taking the deposit back");
      const pending = this.pool().pending(BigInt("0x" + w.inner));
      const depositor = new PublicKey(w.depositor);
      const ix = this.pool().refund(depositor, pending, depositor);
      const tx = new Transaction().add(ix);
      const own = this.sourceKeypair(w);
      let sig: string;
      // an address that can't pay the fee and still stay open (it put everything into its deposit): it signs a request and the guard pays
      if (own && BigInt(await conn().getBalance(own.publicKey, "confirmed")) < (await this.rentNow()).wallet + 10_000n) {
        const req = signRefundRequest(own, new PublicKey(this.need().pool.programId), w.inner);
        sig = (await api<{ signature: string }>("/api/refund", { json: { inner: w.inner, signature: b64(req) } })).signature;
      } else if (own) {
        tx.feePayer = own.publicKey;
        tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
        tx.sign(own);
        sig = await sendAndConfirm(tx, "refund");
      } else {
        if (!wallet || !wallet.publicKey.equals(depositor)) throw new Error("Connect the wallet that made this deposit.");
        tx.feePayer = depositor;
        tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
        sig = await sendAndConfirm(await wallet.signTransaction(tx), "refund");
      }
      if (w.deposit !== null) this.setHeld(w.deposit, "returned");
      // a payment from the wallet this deposit was for won't go
      for (const p of this.s.pays) if (p.inner === w.inner) this.patchPay(p.id, { status: "cancelled", text: "The deposit was taken back to your wallet, so nothing was sent." }, ["paying", "waiting", "needs-you"]);
      this.log({ kind: "refund", text: `Took back ${fmt(w.amount)} SOL from the waiting room`, sig });
      // only where it went back to
      await Promise.all([
        this.refreshWaiting(),
        w.vision !== null ? this.refreshVision([w.vision]) : w.deposit !== null ? this.refreshDeposits({ only: [w.deposit] }) : this.refreshPublic(),
      ]);
      this.done(
        "Taken back",
        w.deposit !== null
          ? `${fmt(w.amount)} SOL is back at your deposit address. Send it to any wallet from Deposit addresses, or move it into the pool again.`
          : w.hop
            ? `${fmt(w.amount)} SOL is back at the sending address it came from, listed under Deliveries.`
            : `${fmt(w.amount)} SOL is back in the wallet it came from.`,
        sig,
      );
    } catch (e) {
      this.fail(e);
    }
  }

  /**
   * A statement of this account's notes for an exchange, accountant or
   * auditor. With the viewing key it also lets them recognise future notes,
   * but never spend anything.
   */
  statement(includeViewKey: boolean): string {
    const { keys, pool } = this.need();
    const h = (x: bigint) => hex(toBE(x));
    return JSON.stringify(
      {
        kind: "visionswap-statement",
        version: 1,
        createdAt: new Date().toISOString(),
        network: pool.network,
        programId: pool.programId,
        account: {
          fingerprint: this.s.fingerprint,
          pubKey: h(keys.pubKey),
          ...(includeViewKey ? { viewKey: hex(keys.viewKey) } : {}),
        },
        balanceLamports: (this.s.balance - this.s.arriving).toString(),
        notes: this.s.notes.map((n) => ({
          index: n.index,
          amountLamports: n.amount.toString(),
          leaf: h(n.leaf),
          nonce: hex(n.nonce),
          blinding: h(n.blinding),
        })),
        activity: this.s.activity,
        howToVerify:
          "Each note is a leaf of the pool's Merkle tree: leaf = Poseidon(amount, Poseidon(pubKey, blinding)) on BN254. " +
          "Recompute it from the values above and find it at its index in the program's Spent or DepositSettled events. " +
          "Activity lists the Solana transactions that moved funds in and out.",
      },
      null,
      2,
    );
  }

  /** Moves an overdue deposit into the pool yourself (normally the server does this). */
  async settleNow(w: Waiting, wallet: WalletLike | null) {
    try {
      this.step("shield", "Adding your deposit to the pool");
      const pending = this.pool().pending(BigInt("0x" + w.inner));
      const tx = new Transaction().add(this.pool().settle(pending, new PublicKey(w.depositor), new PublicKey(this.need().pool.treasury)));
      const own = this.sourceKeypair(w);
      // settling is open to anyone, but the fee payer shows on-chain next to the depositor: a Vision
      // wallet or deposit address pays for itself (or the server does), never the connected wallet
      const payer = settlePayer({
        fromAddress: own !== null,
        ownLamports: own ? BigInt(await conn().getBalance(own.publicKey, "confirmed")) : null,
        rentWallet: own ? (await this.rentNow()).wallet : 0n,
        depositor: w.depositor,
        wallet: wallet ? wallet.publicKey.toBase58() : null,
      });
      let sig: string;
      if (payer === "own" && own) {
        tx.feePayer = own.publicKey;
        tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
        tx.sign(own);
        sig = await sendAndConfirm(tx, "settlement");
      } else if (payer === "wallet" && wallet) {
        tx.feePayer = wallet.publicKey;
        tx.recentBlockhash = (await conn().getLatestBlockhash("confirmed")).blockhash;
        sig = await sendAndConfirm(await wallet.signTransaction(tx), "settlement");
      } else {
        try {
          sig = (await api<{ signature: string }>("/api/settle", { json: { inner: w.inner } })).signature;
        } catch (e) {
          // the server's own answer (already added, still waiting, can't be added) is passed on, with the list brought up to date
          if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && typeof e.data?.error === "string") {
            await this.sync().catch(() => {});
            throw e;
          }
          // the server can't settle right now (unreachable, busy, or not offering it)
          throw new Error("Your deposit is safe in the waiting room. It joins the pool as soon as the server catches up, or you can take it back.");
        }
      }
      await this.sync();
      this.done("Added to the pool", `${fmt(w.amount)} SOL is now part of your private balance.`, sig);
    } catch (e) {
      this.fail(e);
    }
  }

  exportVision(i: number): string {
    return bs58.encode(this.visionKeypair(i).secretKey);
  }

  private async waitForLamports(who: PublicKey, atLeast: bigint) {
    const started = Date.now();
    while (Date.now() - started < 90_000) {
      const l = BigInt(await conn().getBalance(who, "confirmed"));
      if (l >= atLeast) return;
      // it normally lands within seconds; after that, look less often
      await sleep(Date.now() - started < 15_000 ? 1200 : 2500);
    }
    throw new Error("The Vision wallet hasn't received its SOL yet. It is safe; check Vision wallets in a minute.");
  }

  /**
   * One swap from Vision wallet `index`: a fresh route each try, retries that pay a little more
   * priority to land, and a top-up from the private balance when the route needs a little more
   * SOL for fees than the wallet holds. Before any retry it looks at the wallet: a swap that went
   * through is never made twice, and a swap whose outcome is still unknown is never followed by
   * another. A fresh route promising less than the least the person was shown isn't signed, and
   * the price tolerance never grows on its own.
   */
  private async swapFrom(index: number, p: SwapParams, attempt0 = 0): Promise<SwapResult> {
    const kp = this.visionKeypair(index);
    const owner = kp.publicKey;
    // what the wallet holds before: the output for a buy, the input for a sale
    const watch = p.side === "buy" ? p.outputMint : p.inputMint;
    const start = await this.tokenHeld(owner, watch);
    let topUps = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0 || topUps > 0) {
        const done = await this.retryGuard(index, p, start);
        if (done) return done;
      }
      const b = await this.buildWithin(index, p, attempt0 + attempt, p.side === "buy" ? 90_000 : 30_000);
      const short = BigInt(b.shortfall ?? "0");
      if (short > 0n) {
        // a buy short of SOL may simply have bought already: look before adding any
        if (p.side === "buy") {
          const done = await this.retryGuard(index, p, start);
          if (done) return done;
        }
        if (topUps >= 2) throw new Error(`Vision wallet #${index + 1} still lacks about ${fmtUp(short, 4)} SOL for this route's fees. Try again in a moment, or with a smaller amount.`);
        await this.topUpVision(index, p.side, short);
        topUps++;
        attempt--;
        continue;
      }
      const tx = await this.checkedSwap(b, owner, p);
      tx.sign([kp]);
      const sig = signatureOf(tx);
      // an unfinished buy remembers its try, so "Finish the buy" can see whether it landed
      if (p.side === "buy") this.noteSwapSent(index, { sig, lvh: b.lastValidBlockHeight });
      p.onSwap?.({ sig, lvh: b.lastValidBlockHeight });
      this.step(p.side, "Swapping");
      try {
        await sendAndConfirm(tx, "swap", { lastValidBlockHeight: b.lastValidBlockHeight, minContextSlot: b.minContextSlot });
      } catch (e) {
        if (e instanceof StillPending) throw e;
        // anything else is certain: it was refused, failed on-chain, or expired without landing
        if (p.side === "buy") this.noteSwapSent(index, null);
        const moved = isPriceMoved(e);
        const dropped = /dropped it before it ran|expired/i.test((e as Error)?.message ?? "");
        // one fresh route at the same tolerance; a try the network dropped gets a second, paying more to land
        if (!(attempt === 0 || (attempt === 1 && dropped && !moved))) throw e;
        this.step(p.side, moved ? "The price moved, trying once more with a fresh route" : "Trying again with a higher network priority");
        continue;
      }
      const after = await this.tokenHeld(owner, watch).catch(() => null);
      return { sig, got: after && p.side === "buy" ? after.raw - start.raw : undefined, decimals: after?.decimals };
    }
    throw new Error("Swap failed.");
  }

  /**
   * Before a swap is tried again: a buy whose tokens already arrived is done, a buy whose wallet
   * no longer holds its SOL stops, and a sale whose tokens already went stops.
   */
  private async retryGuard(index: number, p: SwapParams, start: { raw: bigint }): Promise<SwapResult | null> {
    const owner = this.visionKeypair(index).publicKey;
    const n = index + 1;
    let now: { raw: bigint; decimals: number };
    let lamports: bigint;
    try {
      [now, lamports] = await Promise.all([this.tokenHeld(owner, p.side === "buy" ? p.outputMint : p.inputMint), conn().getBalance(owner, "confirmed").then(BigInt)]);
    } catch {
      throw final(`Couldn't look at Vision wallet #${n} before trying again. Check your activity in a minute, then try again.`);
    }
    if (p.side === "buy") {
      if (now.raw > start.raw) return { sig: "", got: now.raw - start.raw, decimals: now.decimals };
      if (lamports < p.amount) {
        throw final(`Vision wallet #${n} no longer holds the SOL for this buy: an earlier try may have gone through. Check your activity before trying again.`);
      }
    } else if (now.raw < start.raw) {
      throw final(
        now.raw === 0n
          ? `Vision wallet #${n} no longer holds this token: it may already have sold. Your activity list shows the latest.`
          : `Vision wallet #${n} holds less of this token than before: part of it may already have sold. Check your activity, then try again.`,
      );
    }
    return null;
  }

  /** Remembers (or forgets) the swap an unfinished buy just sent. */
  private noteSwapSent(index: number, sent: { sig: string; lvh: number } | null) {
    const it = this.buyIntent(index);
    if (!it) return;
    const { sig: _s, lvh: _l, sigAt: _a, ...rest } = it;
    this.saveIntent(index, sent ? { ...rest, sig: sent.sig, lvh: sent.lvh, sigAt: Date.now() } : rest);
  }

  /**
   * The server's build for a swap. Jupiter's shared allowance can be busy for a moment, and the
   * network can hiccup: within `patienceMs` those are waited out rather than failed (the SOL stays
   * where it is meanwhile).
   */
  private async buildFor(index: number, p: SwapParams, attempt: number, patienceMs: number): Promise<SwapBuild> {
    const started = Date.now();
    const json = {
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount.toString(),
      slippageBps: p.slippageBps,
      side: p.side,
      taker: this.visionKeypair(index).publicKey.toBase58(),
      speed: speedOf(p.speed),
      attempt,
    };
    for (let tries = 0; ; tries++) {
      try {
        return await api<SwapBuild>("/api/swap/build", { json });
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 0;
        const passing = [429, 502, 503, 504].includes(status) || (!(e instanceof ApiError) && /failed to fetch|networkerror|load failed/i.test((e as Error)?.message ?? ""));
        const wait = e instanceof ApiError && e.retryAfter ? e.retryAfter * 1000 : Math.min(10_000, 3000 + tries * 2000);
        if (!passing || Date.now() - started + wait > patienceMs) throw e;
        this.step(p.side, "Jupiter is busy, trying again", "Your SOL stays where it is in the meantime.");
        await sleep(wait);
      }
    }
  }

  /**
   * A build whose on-chain minimum is at least the least the person was shown (p.minOut). A fresh
   * route a little worse than the quote is built once more with just enough less price room; one
   * that can't keep that promise isn't used.
   */
  private async buildWithin(index: number, p: SwapParams, attempt: number, patienceMs: number): Promise<SwapBuild> {
    const b = await this.buildFor(index, p, attempt, patienceMs);
    if (p.minOut == null || BigInt(b.quote.minOut) >= p.minOut) return b;
    const bps = roomFor(BigInt(b.quote.outAmount), p.minOut);
    if (bps == null) throw new Error(PRICE_MOVED);
    const t = await this.buildFor(index, { ...p, slippageBps: bps }, attempt, patienceMs);
    if (BigInt(t.quote.minOut) < p.minOut) throw new Error(PRICE_MOVED);
    return t;
  }

  /**
   * The swap transaction from a build, checked before anything signs it: the SDK's structural
   * check, then the amounts (priority fee within the chosen speed's cap, no more SOL than the
   * trade) and that the tokens land in this Vision wallet.
   */
  private async checkedSwap(b: SwapBuild, owner: PublicKey, p: SwapParams): Promise<VersionedTransaction> {
    const tx = VersionedTransaction.deserialize(unb64(b.tx));
    checkSwapTx(tx, owner);
    const tables: AddressLookupTableAccount[] = await Promise.all(
      tx.message.addressTableLookups.map(async (l) => {
        const t = (await conn().getAddressLookupTable(l.accountKey, { commitment: "confirmed" })).value;
        if (!t) throw new Error("Couldn't check the swap just now. Please try again.");
        return t;
      }),
    );
    checkSwapSpend(tx, tables, { owner, outputMint: p.outputMint, lamportsIn: p.side === "buy" ? p.amount : 0n, speed: speedOf(p.speed) });
    return tx;
  }

  /** Ends an action with its error shown, in plain words; the message is returned for a caller that goes on. */
  private report(e: unknown): string {
    const m = (e as Error)?.message || "Something went wrong.";
    const msg = walletDeclined(e)
      ? "Cancelled in your wallet."
      : /failed to fetch|networkerror|load failed/i.test(m)
        ? "Can't reach the network right now. Check your connection and try again."
        : m;
    if (this.spotEnd({ ok: false, title: "Didn't go through", text: msg })) return msg;
    if (this.bgTask) {
      this.bgTask = null;
      this.set({ busy: null });
      this.bgSay({ error: msg });
    } else this.set({ busy: null, error: msg });
    return msg;
  }

  /** The same, for an action whose caller hears of the failure by a rejected promise. */
  private fail(e: unknown): never {
    throw new Error(this.report(e));
  }

  clearError() {
    this.set({ error: null });
    this.nextQueued();
  }

  clearNotice() {
    this.set({ notice: null });
    this.nextQueued();
  }

  /** Forgets this device's activity list. Nothing on-chain changes. */
  clearActivity() {
    if (this.s.fingerprint) ls.set(`vs:act:${this.s.fingerprint}`, []);
    this.set({ activity: [] });
  }

  reportError(message: string) {
    this.set({ error: message });
  }
}

// ─────────────────────────── helpers ───────────────────────────

/**
 * Whether locking (or signing out) waits: only for an action the person started, which finishes on
 * this account first. Work running by itself in the background stops quietly instead (see closeKeyAccount).
 */
export const lockWaits = (st: Pick<State, "busy" | "spots">) => (!!st.busy && (!st.busy.bg || !!st.busy.spot)) || st.spots.length > 0;

/** An order in plain words. */
export function orderName(o: Pick<Order, "kind" | "tpUsd" | "slUsd"> & { trailPct?: number }): string {
  if (o.kind === "dca") return "DCA";
  if (o.kind === "buy") return "Limit buy";
  const stop = o.slUsd || o.trailPct;
  return o.tpUsd && stop ? "Take-profit + stop-loss" : o.tpUsd ? "Take-profit" : o.trailPct ? "Trailing stop" : "Stop-loss";
}

const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
/** The associated token account of `owner` for `mint`, under the mint's token program. */
export function ataOf(owner: PublicKey, mint: PublicKey, program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), program.toBytes(), mint.toBytes()], ATA_PROGRAM_ID)[0];
}
function createAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, program: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataOf(owner, mint, program), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}
/** ApproveChecked (13): `delegate` may move up to `amount` from `account`, and nothing else. */
function approveCheckedIx(account: PublicKey, mint: PublicKey, delegate: PublicKey, owner: PublicKey, amount: bigint, decimals: number, program: PublicKey): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = 13;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}
/** Revoke (5): the account's delegate loses every permission. */
function revokeIx(account: PublicKey, owner: PublicKey, program: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([5]),
  });
}
/** SyncNative (17): wrapped SOL's token balance catches up with the lamports sent to it. */
function syncNativeIx(account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: new PublicKey(TOKEN_PROGRAM), keys: [{ pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
}

/** A nullifier as 64 hex characters (how proofs and the relayer write them). */
export const nfHex = (n: bigint) => n.toString(16).padStart(64, "0");

/** Notes picked for a spend turned out to be held by a scheduled payment made on another device; they're set aside now. */
class NotesHeld extends Error {
  constructor() {
    super("Some of your SOL is set aside for a scheduled payment made on another device. Try a smaller amount, or cancel that payment under Scheduled payments.");
  }
}

/** A payment from the wallet whose own note can't pay it: gone or held elsewhere ("unsure"), or short of today's fees ("fees"). Nothing was sent. */
class PinnedNote extends Error {
  constructor(readonly ask: "unsure" | "fees") {
    super(
      ask === "fees"
        ? "The fees went up since you paid, so nothing was sent. Its SOL is in your private balance: pick what to do under Payments on their way."
        : "Its SOL isn't free in your private balance right now (it may have gone from another tab or device), so nothing was sent. Check your activity before sending again.",
    );
  }
}

export { MaybeSent };

/** An error that says for sure the payment didn't go: refused by the relayer, or told so (never one that may still land). */
const nothingSpent = (e: unknown) =>
  !(e instanceof MaybeSent) && (e instanceof NotesHeld || (e instanceof ApiError && definite(e)) || /nothing was spent/i.test((e as Error)?.message ?? ""));
const shortAddr = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
/** What a payment from the wallet asks while it waits to go (each row counts down its own wait). */
export const PAY_OPEN_TEXT = "Keep this page open until it says Handed to the relayer. If you close it sooner, it picks up next time you open VisionSwap on this device.";

export type BuyIntent = {
  mint: string;
  amount: string;
  slippageBps: number;
  auto?: boolean;
  speed?: Speed;
  /** when the buy began funding its Vision wallet */
  at?: number;
  /** the last swap try sent, its blockhash's last valid block height, and when it went */
  sig?: string;
  lvh?: number;
  sigAt?: number;
  /** why the last try didn't go through: the price ran away, or anything else */
  why?: "price" | "other";
};

/** Options a buy or sale carries from the form: the speed picked, and the least the quote shown said would arrive. */
export type TradeOpts = {
  speed?: Speed;
  minOut?: bigint;
  /** a buy into a new Vision wallet: this one, if it's still unused (a batch's retry), else the next fresh one */
  index?: number;
  /** a buy into a new Vision wallet: told which wallet it took, before anything is paid */
  onIndex?: (index: number) => void;
  /** the person agreed to what the sale does to a live order in the same Vision wallet (see orderClash) */
  orders?: boolean;
  /** a sale: told each swap as it goes out (a batch looks it up before trying again) */
  onSwap?: (sent: { sig: string; lvh: number }) => void;
};
type SwapParams = {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
  side: "buy" | "sell";
  speed?: Speed;
  minOut?: bigint;
  onSwap?: TradeOpts["onSwap"];
};
type SwapQuote = { inAmount: string; outAmount: string; minOut: string; priceImpactPct: number; route: string[] };
type SwapBuild = { tx: string; lastValidBlockHeight: number; minContextSlot?: number; shortfall?: string; quote: SwapQuote; priorityLamports?: string };
/** A swap that went through; `sig` is empty when an earlier try turned out to have landed. */
type SwapResult = { sig: string; got?: bigint; decimals?: number };
/** Token accounts closed together: a Token-2022 harvest stays with its close. */
type CloseUnit = { ixs: TransactionInstruction[]; lamports: bigint };

/** An error that already says everything (no "try again" advice may be added to it). */
const final = (message: string) => Object.assign(new Error(message), { final: true });
const isFinal = (e: unknown) => !!(e as { final?: boolean })?.final;

/** Empty accounts closed beside a deposit; more than this close first, in transactions of their own. */
const SWEEP_CLOSES = 6;
/** Compute for the app's own small transactions (closes, burns, approvals): roomy, and cheap at OWN_PRICE. */
const CLEANUP_CU = 200_000;
/** The rent a standard token account holds (it comes back when the account closes). */
const TOKEN_ACCOUNT_RENT = 2_039_280n;

/** Whether a legacy transaction fits in one network packet (feePayer and blockhash set). */
function fits(tx: Transaction): boolean {
  try {
    const msg = tx.compileMessage();
    return 1 + 64 * msg.header.numRequiredSignatures + msg.serialize().length <= 1232;
  } catch {
    return false;
  }
}

/** The most price tolerance a swap may use (the server allows the same). */
export const MAX_SLIPPAGE = 2500;

/**
 * "Auto" price tolerance for a token: thin markets move fast, so they get more room, and a
 * transfer tax adds its own share in case a route prices it loosely.
 */
export function autoSlippage(t: { liquidity?: number | null } | null | undefined, transferFeeBps = 0): number {
  const liq = t?.liquidity ?? null;
  const base = liq == null ? 500 : liq < 50_000 ? 1000 : liq < 250_000 ? 600 : liq < 2_000_000 ? 300 : 100;
  return Math.min(2000, base + Math.max(0, transferFeeBps));
}

/** True when a swap failed because the price moved past its tolerance (Jupiter's or a market's own slippage check). */
export function isPriceMoved(e: unknown): boolean {
  const err = e as { message?: string; logs?: string[] };
  const text = `${err?.message ?? ""} ${(err?.logs ?? []).join(" ")}`;
  return /price moved more than|price has moved past|JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed: custom program error: 0x1771|SlippageToleranceExceeded/i.test(text);
}

type TokenAccountInfo = {
  mint: string;
  delegate?: string;
  state?: string;
  tokenAmount: { amount: string };
  extensions?: { extension: string; state?: { withheldAmount?: string | number } }[];
};

/** Burn (8): destroys `amount` of the account's tokens (it works on any token the owner holds, frozen ones aside). */
function burnIx(account: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint, programId: PublicKey): TransactionInstruction {
  const data = new Uint8Array(9);
  data[0] = 8;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

/** Token-2022: moves the transfer tax an account collected over to the mint. Anyone may call it. */
function harvestWithheldIx(mint: PublicKey, account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(TOKEN_2022),
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
    ],
    // TransferFeeExtension (26) -> HarvestWithheldTokensToMint (4)
    data: Buffer.from([26, 4]),
  });
}

/**
 * True only when the person said no in their wallet. A network that refused a
 * transaction ("rejected") is a different problem and must be reported as such.
 */
function walletDeclined(e: unknown): boolean {
  const name = (e as Error)?.name ?? "";
  const m = (e as Error)?.message ?? "";
  if (/user rejected|rejected the request|request rejected|user denied|denied by (the )?user|user cancell?ed|cancell?ed by (the )?user|user declined/i.test(m)) return true;
  return /^Wallet\w*Error$/.test(name) && /reject|cancel|denied|declined/i.test(m);
}

export function fmt(l: bigint, digits = 4): string {
  return (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Like fmt, but never rounds down: "send at least X more" must really be enough. */
export function solText(l: bigint): string {
  const whole = l / 1_000_000_000n;
  const frac = (l % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function fmtUp(l: bigint, digits = 6): string {
  const step = 10n ** BigInt(9 - digits);
  return fmt(((l + step - 1n) / step) * step, digits);
}

/** Like fmt, but never rounds up: "the most is X" must really be payable. */
export function fmtDown(l: bigint, digits = 6): string {
  return fmt(l - (l % 10n ** BigInt(9 - digits)), digits);
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function closeAccountIx(account: PublicKey, owner: PublicKey, programId: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

export const engine = new Engine();
// development builds only: lets automated tests drive the very engine the page uses
if (import.meta.env.DEV) (window as unknown as { __vsEngine?: Engine }).__vsEngine = engine;
export { b64, toBE };
