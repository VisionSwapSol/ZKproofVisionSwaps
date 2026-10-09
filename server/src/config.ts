import { hkdfSync } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "./log.ts";

/** The server package folder; relative paths in settings resolve against it. */
export const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** All settings come from the environment (a .env file next to the server, or Replit Secrets). */
loadDotEnv();
loadBundle();

/**
 * VISIONSWAP_CONFIG lets a host like Replit carry every setting in a single
 * secret: base64 of "NAME=value" lines. Values set individually still win.
 */
function loadBundle() {
  const raw = process.env.VISIONSWAP_CONFIG;
  if (!raw) return;
  let text = "";
  try {
    text = Buffer.from(raw.trim(), "base64").toString("utf8");
  } catch {
    throw new Error("VISIONSWAP_CONFIG is not valid base64");
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (process.env[m[1]] === undefined || process.env[m[1]] === "") process.env[m[1]] = m[2];
  }
}

function loadDotEnv() {
  for (const p of [resolve(SERVER_DIR, ".env"), resolve(SERVER_DIR, "..", ".env"), resolve(process.cwd(), ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trimStart().startsWith("#")) continue;
      const v = m[2].replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
    break;
  }
}

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};

/**
 * A SOL amount setting: whole lamports, or SOL with a decimal point ("0.05").
 * Anything else keeps the default (a typo must not stop the server).
 */
export function lamportsSetting(raw: string | undefined, d: bigint, name = "setting"): bigint {
  const v = (raw ?? "").trim();
  if (!v) return d;
  if (/^\d+$/.test(v)) return BigInt(v);
  const m = /^(\d*)\.(\d{1,9})$/.exec(v);
  if (m) return BigInt(m[1] || "0") * 1_000_000_000n + BigInt(m[2].padEnd(9, "0"));
  log(`${name} ignored: expected lamports (like 50000000) or SOL (like 0.05)`);
  return d;
}

function keypair(name: string): Keypair | null {
  const raw = env(name);
  if (!raw) return null;
  try {
    if (raw.trim().startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    const path = resolve(SERVER_DIR, raw);
    if (existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
    return Keypair.fromSecretKey(bs58.decode(raw.trim()));
  } catch {
    throw new Error(`${name} is not a valid secret key (base58, JSON array, or a path to a keypair file)`);
  }
}

/**
 * The key that signs for the relayer's durable nonces (deliveries sent while the owner's page is
 * closed): HKDF-SHA256 of the relayer's secret, so there is no extra secret to keep. It never holds
 * SOL and only ever signs to make, advance and initialize its own nonces. A new relayer key means a
 * new nonce authority: scheduled deliveries signed for the old one can't be sent any more, so they
 * turn stale and the owner's app signs them again.
 */
export function nonceAuthorityFrom(relayerSecret: Uint8Array): Keypair {
  return Keypair.fromSeed(new Uint8Array(hkdfSync("sha256", relayerSecret, "visionswap", "vs:nonce-authority:v1", 32)));
}

export type Network = "mainnet" | "devnet" | "localnet";

const network = (env("NETWORK", "localnet") as Network) ?? "localnet";
const relayer = keypair("RELAYER_SECRET");
const jupiterKey = env("JUPITER_API_KEY", "")!;
const jupiterRpm = posInt(env("JUPITER_RPM"), jupiterKey ? 60 : 30);
const defaultRpc =
  network === "mainnet"
    ? "https://api.mainnet-beta.solana.com"
    : network === "devnet"
      ? "https://api.devnet.solana.com"
      : "http://127.0.0.1:8899";

export const config = {
  network,
  port: Number(env("PORT", "8787")),
  host: env("HOST", "0.0.0.0")!,
  publicOrigin: env("PUBLIC_ORIGIN", ""),
  rpcUrl: env("RPC_URL", defaultRpc)!,
  /** optional second upstream, tried when the first fails */
  rpcFallbackUrl: env("RPC_FALLBACK_URL", network === "mainnet" ? "https://api.mainnet-beta.solana.com" : ""),
  /** the exposure check always reads Solana mainnet, whatever network the pool is on */
  exposureRpcUrl: env("EXPOSURE_RPC_URL", network === "mainnet" ? env("RPC_URL", "https://api.mainnet-beta.solana.com")! : "https://api.mainnet-beta.solana.com")!,
  programId: new PublicKey(env("PROGRAM_ID", "FehJfeaYSzjfM8JK73FXgUHmvqAofAR3hwZChbQjnpiZ")!),
  relayer,
  /** signs for the relayer's durable nonces only (derived from the relayer's secret, holds no SOL) */
  nonceAuthority: relayer ? nonceAuthorityFrom(relayer.secretKey) : null,
  guard: keypair("GUARD_SECRET"),
  /** extra lamports on top of the network cost of a spend */
  relayerMarginLamports: BigInt(env("RELAYER_MARGIN_LAMPORTS", "150000")!),
  priorityMicroLamports: Number(env("PRIORITY_MICROLAMPORTS", "20000")),
  attestationTtlSlots: BigInt(env("ATTESTATION_TTL_SLOTS", "450")!),
  jupiterKey,
  /** Jupiter calls a minute the plan allows: 60 with a free key, 30 without; set it for a paid plan */
  jupiterRpm,
  /** the most the server will use when Jupiter's replies show a bigger plan than JUPITER_RPM */
  jupiterRpmMax: Math.max(jupiterRpm, posInt(env("JUPITER_RPM_MAX"), jupiterKey ? 600 : jupiterRpm)),
  jupiterBase: env("JUPITER_BASE", ""),
  /** which Jupiter swap API to build with: "v2" (the default with a key) or "v1" (the default without) */
  jupiterSwapApi: env("JUPITER_SWAP_API", ""),
  /**
   * Optional extra Jupiter platform fee on private sells, in bps. Off by default:
   * a sell's SOL goes back into the pool, and that deposit already pays the pool
   * fee. (The older SELL_FEE_BPS setting is ignored on purpose.)
   */
  sellFeeBps: Number(env("SELL_SWAP_FEE_BPS", "0")),
  /** optional: a wSOL token account to collect sell fees in, instead of the treasury's own */
  sellFeeAccount: env("SELL_FEE_ACCOUNT", ""),
  rangeKey: env("RANGE_API_KEY", ""),
  /** addresses to refuse on top of the sanctions list (comma or space separated) */
  blockedAddresses: (env("BLOCKED_ADDRESSES", "") ?? "").split(/[\s,]+/).filter(Boolean),
  blockedCountries: (env("BLOCKED_COUNTRIES", "CU,IR,KP,SY,AE") ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
  dataDir: resolve(SERVER_DIR, env("DATA_DIR", "data")!),
  /**
   * Where orders and scheduled payments are kept besides this machine's disk: "auto" (Replit App
   * Storage when running on Replit), "replit" or "disk". Replit resets a published app's files on
   * every publish, so there they also go to App Storage.
   */
  stateStore: env("STATE_STORE", "auto")!,
  /** optional: the App Storage bucket to use instead of the project's default one */
  replitBucketId: env("REPLIT_BUCKET_ID", ""),
  webDist: resolve(SERVER_DIR, env("WEB_DIST", "../web/dist")!),
  artifactsDir: resolve(SERVER_DIR, env("ARTIFACTS_DIR", "../circuits/artifacts")!),
  /**
   * How many public proxy addresses the host writes into X-Forwarded-For after the visitor's own
   * (private-network and Google front-end addresses are skipped on top). Replit: 1, its load
   * balancer. null ("off") when visitors connect straight to this server.
   */
  trustProxyHops: proxyHops(),
  /** browser RPC calls a second the /api/rpc gateway passes on, for everyone together (the rest of the plan is the server's own) */
  rpcProxyPerSecond: posInt(env("RPC_PROXY_PER_SECOND"), 30),
  /**
   * below this, /api/health answers 503: the relayer can't pay for payments (lamports, or SOL like 0.02;
   * 0 means the default). RELAYER_LOW_LAMPORTS, higher, is the early warning.
   */
  relayerMinLamports: lamportsSetting(env("RELAYER_MIN_LAMPORTS"), 20_000_000n, "RELAYER_MIN_LAMPORTS") || 20_000_000n,
  crank: env("CRANK", "on") !== "off",
  /** below these balances /api/health warns and the log says so once (lamports, or SOL with a decimal point) */
  relayerLowLamports: lamportsSetting(env("RELAYER_LOW_LAMPORTS"), 50_000_000n, "RELAYER_LOW_LAMPORTS"),
  guardLowLamports: lamportsSetting(env("GUARD_LOW_LAMPORTS"), 5_000_000n, "GUARD_LOW_LAMPORTS"),
  contactEmail: env("CONTACT_EMAIL", ""),
  /** public source repository, shown in the footer once set */
  repoUrl: env("REPO_URL", ""),
  /** the $VSWAP token's mint address, shown on the Tokenomics page once set */
  tokenMint: validMint(env("TOKEN_MINT", "")!),
  /**
   * optional: shows /api/health's full operator details (queues, Jupiter use, prices) to whoever
   * sends it, in an x-health-token header or ?token=. Without it, health shows only the summary.
   */
  healthToken: env("HEALTH_TOKEN", "")!,
  /**
   * Payments delivered while the owner's page is closed (send later, split payments) go out on a
   * durable nonce. "off" turns that off: those choices are then not offered, and payments sent now
   * are delivered on a recent blockhash only.
   */
  deliveryNonce: env("DELIVERY_NONCE", "on") !== "off",
  /** the fewest nonce accounts kept ready, and the most there may ever be (each holds about 0.00145 SOL of rent, given back when an unneeded one is closed) */
  noncePoolMin: posInt(env("NONCE_POOL_MIN"), 32),
  noncePoolMax: Math.min(6000, posInt(env("NONCE_POOL_MAX"), 6000)),
};

if (config.relayerMinLamports > config.relayerLowLamports) {
  log("RELAYER_MIN_LAMPORTS is above RELAYER_LOW_LAMPORTS: the early warning comes after /api/health already fails");
}

mkdirSync(config.dataDir, { recursive: true });

function posInt(v: string | undefined, d: number): number {
  const n = Math.floor(Number(v));
  return v && Number.isFinite(n) && n > 0 ? n : d;
}

function proxyHops(): number | null {
  const v = env("TRUST_PROXY_HOPS", "")!.toLowerCase();
  if (v === "off" || (!v && env("TRUST_PROXY", "") === "false")) return null;
  const n = Number(v);
  // the older TRUST_PROXY=true trusted every hop, which let visitors pick their own address: it is ignored
  return v && Number.isInteger(n) && n >= 0 && n <= 5 ? n : 1;
}

function validMint(v: string): string {
  if (!v) return "";
  try {
    return new PublicKey(v.trim()).toBase58();
  } catch {
    return "";
  }
}

export function jupiterBase(): string {
  if (config.jupiterBase) return config.jupiterBase.replace(/\/$/, "");
  // api.jup.ag answers keyless calls too, at 30 a minute (lite-api.jup.ag is being retired;
  // jupiter.ts moves to it only if keyless calls are ever refused)
  return "https://api.jup.ag";
}
