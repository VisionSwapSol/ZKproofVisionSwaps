import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const KEYS = join(ROOT, "keys");
mkdirSync(KEYS, { recursive: true });

export type Net = "mainnet" | "devnet" | "localnet";

export function netFromArgs(): Net {
  if (process.argv.includes("--localnet")) return "localnet";
  if (process.argv.includes("--devnet")) return "devnet";
  return "mainnet";
}

export type Settings = {
  /** where the 0.8% pool fee and the sell fee go: the creator's own wallet */
  treasury: string;
  /** a keyed RPC URL (Helius, Triton, QuickNode...) for mainnet; the public one is a fallback */
  rpcUrl: string;
  feeBps: number;
  minDepositSol: number;
  maxDepositSol: number;
  tvlCapSol: number;
  depositDelayMinutes: number;
  requireAttestation: boolean;
  relayerFloatSol: number;
  guardFloatSol: number;
};

export const DEFAULT_SETTINGS: Settings = {
  treasury: "",
  rpcUrl: "",
  feeBps: 80,
  minDepositSol: 0.01,
  maxDepositSol: 25,
  tvlCapSol: 500,
  depositDelayMinutes: 10,
  requireAttestation: true,
  relayerFloatSol: 0.25,
  guardFloatSol: 0.02,
};

export function settingsPath(net: Net) {
  return join(ROOT, net === "mainnet" ? "SETTINGS.json" : `SETTINGS.${net}.json`);
}

export function loadSettings(net: Net): Settings {
  const p = settingsPath(net);
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
  return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(p, "utf8")) };
}

export function saveSettings(net: Net, s: Settings) {
  writeFileSync(settingsPath(net), JSON.stringify(s, null, 2));
}

export function rpcFor(net: Net, s: Settings): string {
  if (net === "localnet") return "http://127.0.0.1:8899";
  if (net === "devnet") return s.rpcUrl || "https://api.devnet.solana.com";
  return s.rpcUrl || "https://api.mainnet-beta.solana.com";
}

/** Keypair files live in keys/ and never leave this computer except as Replit secrets. */
export function keyFile(name: string, net: Net) {
  return join(KEYS, net === "mainnet" ? `${name}.json` : `${net}-${name}.json`);
}

export function loadKey(name: string, net: Net): Keypair | null {
  const p = keyFile(name, net);
  if (!existsSync(p)) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

export function saveKey(name: string, net: Net, kp: Keypair) {
  const p = keyFile(name, net);
  if (existsSync(p)) throw new Error(`${p} already exists; refusing to overwrite a key`);
  writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
}

export function ensureKey(name: string, net: Net): Keypair {
  const k = loadKey(name, net);
  if (k) return k;
  const kp = Keypair.generate();
  saveKey(name, net, kp);
  return kp;
}

export const sol = (l: number | bigint) => (Number(l) / LAMPORTS_PER_SOL).toLocaleString("en-US", { maximumFractionDigits: 6 });

/** The program's largest number: as a largest deposit it means "no limit" (a pool cap of 0 already does). */
export const NO_LIMIT = 2n ** 64n - 1n;

export const limitsText = (c: { minDeposit: bigint; maxDeposit: bigint; tvlCap: bigint }) =>
  `${sol(c.minDeposit)} SOL smallest, ${c.maxDeposit === NO_LIMIT ? "no largest" : `${sol(c.maxDeposit)} SOL largest`}, ` +
  `pool cap ${c.tvlCap === 0n ? "none" : sol(c.tvlCap) + " SOL"}`;

/** What the treasury keeps at least (on top of the rent minimum), so small fees always reach it. */
export const TREASURY_SPARE = 100_000n;

/**
 * What makes `treasury` ready to take fees, paid by `payer`: SOL up to the rent minimum (a wallet
 * below it can't take a fee smaller than that, so the program skips such fees, and scheduled payments
 * proved with the fee then no longer match), and its wrapped-SOL account. Empty when both are there.
 */
export async function treasuryReady(conn: Connection, payer: PublicKey, treasury: PublicKey): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  const rentZero = BigInt(await conn.getMinimumBalanceForRentExemption(0));
  if (BigInt(await conn.getBalance(treasury)) < rentZero) {
    ixs.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: treasury, lamports: rentZero + TREASURY_SPARE }));
  }
  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
  const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  const treasuryWsol = PublicKey.findProgramAddressSync([treasury.toBytes(), TOKEN.toBytes(), WSOL.toBytes()], ATA)[0];
  if (!(await conn.getAccountInfo(treasuryWsol))) {
    // CreateIdempotent: payer, ata, owner, mint, system, token
    ixs.push(
      new TransactionInstruction({
        programId: ATA,
        keys: [
          { pubkey: payer, isSigner: true, isWritable: true },
          { pubkey: treasuryWsol, isSigner: false, isWritable: true },
          { pubkey: treasury, isSigner: false, isWritable: false },
          { pubkey: WSOL, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([1]),
      }),
    );
  }
  return ixs;
}

export async function send(conn: Connection, ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", maxRetries: 8 });
}

let rl: ReturnType<typeof createInterface> | null = null;
const queued: string[] = [];
const waiters: ((line: string | null) => void)[] = [];
let closed = false;

/** One shared line reader, so typed and piped answers both arrive one per question. */
function reader() {
  if (rl) return rl;
  rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else queued.push(l);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });
  return rl;
}

export async function ask(q: string): Promise<string> {
  reader();
  process.stdout.write(q);
  const line = queued.length ? queued.shift()! : closed ? null : await new Promise<string | null>((r) => waiters.push(r));
  if (line === null) {
    console.log("\n  (no more input)");
    process.exit(0);
  }
  return line.trim();
}

export function doneAsking() {
  rl?.close();
}

export function isAddress(s: string) {
  try {
    new PublicKey(s);
    return s.length >= 32;
  } catch {
    return false;
  }
}

/** Windows path -> path inside WSL. */
export function wslPath(p: string) {
  const m = /^([A-Za-z]):\\(.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

export function wsl(cmd: string, opts: { quiet?: boolean } = {}): string {
  const out = execFileSync("wsl.exe", ["-d", "Ubuntu", "--", "bash", "-lc", cmd], {
    encoding: "utf8",
    stdio: opts.quiet ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

export function secretB58(kp: Keypair) {
  return bs58.encode(kp.secretKey);
}

export function banner(t: string) {
  const line = "─".repeat(Math.max(20, t.length + 4));
  console.log(`\n${line}\n  ${t}\n${line}`);
}
