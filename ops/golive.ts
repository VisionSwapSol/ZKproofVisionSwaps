// Step 2: put VisionSwap on Solana. Every step checks what is already done, so
// running it again after an interruption simply carries on.
//   node --import tsx ops/golive.ts [--devnet | --localnet]
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Pool, fetchConfig, fetchTree, type ConfigParams } from "@visionswap/sdk";
import {
  ROOT,
  ask,
  banner,
  isAddress,
  keyFile,
  loadKey,
  loadSettings,
  netFromArgs,
  rpcFor,
  saveSettings,
  secretB58,
  send,
  sol,
  wsl,
  wslPath,
} from "./common.ts";
import { doneAsking, limitsText, treasuryReady } from "./common.ts";

const net = netFromArgs();
const s = loadSettings(net);
banner(`VisionSwap go-live (${net})`);

const program = loadKey("program", net);
const deployer = loadKey("deployer", net);
const relayer = loadKey("relayer", net);
const guard = loadKey("guard", net);
if (!program || !deployer || !relayer || !guard) {
  console.log("  Keys are missing. Run 1-MAKE-KEYS first.");
  process.exit(1);
}

// ─── settings the creator must choose ───
if (net === "localnet" && !s.treasury) {
  s.treasury = (loadKey("treasury", net) ?? (await import("./common.ts")).ensureKey("treasury", net)).publicKey.toBase58();
}
while (!isAddress(s.treasury)) {
  s.treasury = await ask("  Which wallet should receive the fees? Paste its Solana address: ");
}
if (net === "mainnet" && !s.rpcUrl) {
  const r = await ask(
    "  Paste a private RPC URL (Helius, Triton, QuickNode...) or press Enter to use Solana's public endpoint: ",
  );
  if (r.startsWith("https://")) s.rpcUrl = r;
}
saveSettings(net, s);
const rpc = rpcFor(net, s);
const conn = new Connection(rpc, "confirmed");
const pool = new Pool(program.publicKey);
const treasury = new PublicKey(s.treasury);

console.log(`
  Network      ${net}  (${rpc.replace(/api-key=[^&]+/, "api-key=…")})
  Program      ${program.publicKey.toBase58()}
  Deployer     ${deployer.publicKey.toBase58()}
  Treasury     ${treasury.toBase58()}  (fees go here)
`);

// ─── 1. build ───
banner("1/6  Building the program");
const soPath = join(ROOT, "program", "build", "vision_pool.so");
const libRs = readFileSync(join(ROOT, "program", "programs", "vision_pool", "src", "lib.rs"), "utf8");
const builtFor = /declare_id!\("([^"]+)"\)/.exec(libRs)?.[1];
if (builtFor !== program.publicKey.toBase58() || !existsSync(soPath) || process.argv.includes("--rebuild")) {
  wsl(`bash '${wslPath(join(ROOT, "program", "scripts", "build.sh"))}' ${program.publicKey.toBase58()}`);
} else {
  console.log("  Already built for this address.");
}
const soSize = statSync(soPath).size;
const soHash = createHash("sha256").update(readFileSync(soPath)).digest("hex");
console.log(`  vision_pool.so  ${(soSize / 1024).toFixed(0)} KB  sha256 ${soHash.slice(0, 16)}…`);

// ─── 2. money check ───
banner("2/6  Checking the deployer's balance");
const deployed = (await conn.getAccountInfo(program.publicKey))?.executable === true;
const programRent = BigInt(await conn.getMinimumBalanceForRentExemption(soSize + 45));
const floats = BigInt(Math.round((s.relayerFloatSol + s.guardFloatSol) * LAMPORTS_PER_SOL));
const need = (deployed ? 0n : 2n * programRent) + floats + 60_000_000n;
let bal = BigInt(await conn.getBalance(deployer.publicKey));
if (net === "localnet" && bal < need) {
  await conn.confirmTransaction(await conn.requestAirdrop(deployer.publicKey, Number(need - bal) + LAMPORTS_PER_SOL), "confirmed");
  bal = BigInt(await conn.getBalance(deployer.publicKey));
}
console.log(`  Balance ${sol(bal)} SOL, needed about ${sol(need)} SOL${deployed ? " (program already deployed)" : ""}.`);
if (bal < need) {
  console.log(`\n  Please send at least ${sol(need - bal)} more SOL to ${deployer.publicKey.toBase58()} and run this again.`);
  process.exit(1);
}

// ─── 3. deploy ───
banner("3/6  Uploading the program");
if (deployed && !process.argv.includes("--upgrade")) {
  console.log("  Already on-chain. (Use --upgrade to push a new build.)");
} else {
  const prio = net === "mainnet" ? "--with-compute-unit-price 20000" : "";
  const kp = `--keypair '${wslPath(keyFile("deployer", net))}' --url '${rpc}'`;
  // an earlier upload that stopped halfway leaves a buffer holding SOL: take it back first
  try {
    wsl(`solana program close --buffers ${kp} --bypass-warning`, { quiet: true });
  } catch {
    /* nothing to close */
  }
  const deploy = (extra: string) =>
    wsl(
      `solana program deploy '${wslPath(soPath)}' --program-id '${wslPath(keyFile("program", net))}' ` +
        `${kp} ${prio} --max-sign-attempts 80 ${extra}`,
    );
  try {
    // first try sending straight to the validators, the fastest route
    deploy("");
  } catch {
    console.log("\n  The direct route didn't finish. Taking back the partial upload and trying through your RPC instead...");
    try {
      wsl(`solana program close --buffers ${kp} --bypass-warning`, { quiet: true });
    } catch {
      /* nothing to close */
    }
    deploy("--use-rpc");
  }
  console.log("  Uploaded.");
}

// ─── 4. initialize ───
banner("4/6  Setting up the pool");
const slotsPerMinute = 150; // ~400 ms slots
const params: ConfigParams = {
  guard: guard.publicKey,
  treasury,
  feeBps: s.feeBps,
  minDeposit: BigInt(Math.round(s.minDepositSol * LAMPORTS_PER_SOL)),
  maxDeposit: BigInt(Math.round(s.maxDepositSol * LAMPORTS_PER_SOL)),
  tvlCap: BigInt(Math.round(s.tvlCapSol * LAMPORTS_PER_SOL)),
  depositDelay: BigInt(Math.round(s.depositDelayMinutes * slotsPerMinute)),
  requireAttestation: s.requireAttestation,
  depositsPaused: false,
};
if (await conn.getAccountInfo(pool.config)) {
  console.log("  Pool already set up. (Use 3-ADMIN to change settings.)");
} else {
  // a freshly uploaded program only becomes callable a slot or two later
  for (let i = 0; ; i++) {
    try {
      await send(conn, [pool.initialize(deployer.publicKey, params)], [deployer]);
      break;
    } catch (e) {
      if (i < 20 && /not deployed|Unsupported program id/i.test(String((e as Error).message))) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
  console.log("  Pool created.");
}
const cfg = await fetchConfig(conn, pool);
const tree = await fetchTree(conn, pool);

// ─── 5. treasury, relayer and guard ───
banner("5/6  Fee account, relayer and guard");
// the treasury the pool pays now (3-ADMIN may have changed it since SETTINGS named one)
const ixs: TransactionInstruction[] = await treasuryReady(conn, deployer.publicKey, cfg.treasury);
for (const [kp, floatSol] of [
  [relayer, s.relayerFloatSol],
  [guard, s.guardFloatSol],
] as const) {
  const want = BigInt(Math.round(floatSol * LAMPORTS_PER_SOL));
  const have = BigInt(await conn.getBalance(kp.publicKey));
  if (have < want / 2n) ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: want - have }));
}
if (ixs.length) {
  await send(conn, ixs, [deployer]);
  console.log("  Done.");
} else {
  console.log("  Already in place.");
}

// ─── 6. server settings ───
banner("6/6  Server settings");
const env = [
  `NETWORK=${net}`,
  `RPC_URL=${rpc}`,
  `PROGRAM_ID=${program.publicKey.toBase58()}`,
  `RELAYER_SECRET=${secretB58(relayer)}`,
  `GUARD_SECRET=${secretB58(guard)}`,
];
if (net === "localnet") {
  writeFileSync(join(ROOT, "server", ".env.localnet-golive"), env.join("\n") + "\nPORT=8788\nDATA_DIR=./data-golive\n");
} else {
  const out = join(ROOT, "keys", net === "mainnet" ? "REPLIT-SECRETS.txt" : `REPLIT-SECRETS.${net}.txt`);
  const bundle = Buffer.from(env.join("\n") + "\n", "utf8").toString("base64");
  writeFileSync(
    out,
    [
      "Replit needs ONE secret for VisionSwap.",
      "",
      "  Name:  VISIONSWAP_CONFIG",
      "  Value: the long line below (copy all of it, it has no spaces)",
      "",
      bundle,
      "",
      "It holds your Helius connection, the program address, and the relayer and guard keys.",
      "Keep it private: never post it or paste it into a chat.",
      "",
      "Optional extra secrets: CONTACT_EMAIL (legal contact shown on the Terms page),",
      "PUBLIC_ORIGIN (your own domain, once you have one), JUPITER_API_KEY, RANGE_API_KEY, REPO_URL.",
      "On Helius's free plan, also add RPC_PROXY_PER_SECOND with the value 5 (see docs/REPLIT.md, step 2).",
      "",
      "The same settings one per line, for reference:",
      ...env,
      "",
    ].join("\r\n"),
  );
  console.log(`  Wrote ${out}`);
}

console.log(`
  VisionSwap is live on ${net}.
    Program     ${program.publicKey.toBase58()}
    Pool fee    ${cfg.feeBps / 100}% to ${cfg.treasury.toBase58()}
    Deposits    ${limitsText(cfg)}, waiting room ${(Number(cfg.depositDelay) / 150).toFixed(1)} min
    Notes       ${tree.nextIndex}
    Upgrade key ${deployer.publicKey.toBase58()} (keep keys/deployer.json safe)
`);

doneAsking();
