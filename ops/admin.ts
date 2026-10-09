// Step 3 (any time): see how the pool is doing and change its settings.
//   node --import tsx ops/admin.ts [--devnet | --localnet]
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { Pool, fetchConfig, fetchTree, type ConfigParams, type PoolConfig } from "@visionswap/sdk";
import { NO_LIMIT, ROOT, ask, banner, ensureKey, isAddress, limitsText, loadKey, loadSettings, netFromArgs, rpcFor, send, sol, wsl, wslPath, keyFile } from "./common.ts";
import { doneAsking, saveSettings, treasuryReady } from "./common.ts";

const net = netFromArgs();
const s = loadSettings(net);
const program = loadKey("program", net);
const deployer = loadKey("deployer", net);
if (!program || !deployer) {
  console.log("  Keys are missing. Run 1-MAKE-KEYS and 2-GO-LIVE first.");
  process.exit(1);
}
const conn = new Connection(rpcFor(net, s), "confirmed");
const pool = new Pool(program.publicKey);

async function status(): Promise<PoolConfig> {
  const cfg = await fetchConfig(conn, pool);
  const tree = await fetchTree(conn, pool);
  const v = await conn.getAccountInfo(pool.vault);
  const rentMin = await conn.getMinimumBalanceForRentExemption(v?.data.length ?? 8);
  const shielded = BigInt(v?.lamports ?? 0) - BigInt(rentMin) - tree.pendingLamports;
  const tBal = await conn.getBalance(cfg.treasury);
  const rent0 = await conn.getMinimumBalanceForRentExemption(0);
  const relayer = loadKey("relayer", net);
  const guard = loadKey("guard", net);
  const rBal = relayer ? await conn.getBalance(relayer.publicKey) : 0;
  const gBal = guard ? await conn.getBalance(guard.publicKey) : 0;
  banner(`VisionSwap pool (${net})`);
  console.log(`  Program            ${program!.publicKey.toBase58()}
  Shielded SOL       ${sol(shielded)}   (waiting room: ${sol(tree.pendingLamports)})
  Notes in the tree  ${tree.nextIndex}   deposits settled ${tree.deposits}, private spends ${tree.spends}
  Pool fee           ${cfg.feeBps / 100}%  ->  treasury ${cfg.treasury.toBase58()} (holds ${sol(tBal)} SOL)${tBal < rent0 ? `
                     <- below the rent minimum: fees under about 0.11 SOL are skipped, and waiting scheduled
                        payments need their owners to confirm them again. Choose 7 to top it up; keep at least ${sol(rent0 + 100_000)} SOL there.` : ""}
  Deposit limits     ${limitsText(cfg)}
  Waiting room       ${(Number(cfg.depositDelay) / 150).toFixed(1)} min
  Screening          ${cfg.requireAttestation ? "required" : "off"} (guard ${cfg.guard.toBase58()})
  Deposits           ${cfg.depositsPaused ? "PAUSED" : "open"}   (withdrawals can never be paused)
  Admin              ${cfg.admin.toBase58()} (deployer key holds ${sol(await conn.getBalance(deployer!.publicKey))} SOL)
  Relayer balance    ${sol(rBal)} SOL${rBal < 0.05e9 ? "   <- low: send it some SOL" : ""}
  Guard balance      ${sol(gBal)} SOL${gBal < 0.005e9 ? "   <- low: send it some SOL" : ""}`);
  return cfg;
}

function paramsOf(c: PoolConfig): ConfigParams {
  return {
    guard: c.guard,
    treasury: c.treasury,
    feeBps: c.feeBps,
    minDeposit: c.minDeposit,
    maxDeposit: c.maxDeposit,
    tvlCap: c.tvlCap,
    depositDelay: c.depositDelay,
    requireAttestation: c.requireAttestation,
    depositsPaused: c.depositsPaused,
  };
}

async function update(change: (p: ConfigParams) => void) {
  const c = await fetchConfig(conn, pool);
  const p = paramsOf(c);
  change(p);
  const sig = await send(conn, [pool.updateConfig(deployer!.publicKey, p)], [deployer!]);
  console.log(`  Saved. ${sig}`);
}

// ─── program upgrades ───

const SO_PATH = join(ROOT, "program", "build", "vision_pool.so");
const cliKeys = () => `--keypair '${wslPath(keyFile("deployer", net))}' --url '${rpcFor(net, s)}'`;

/** The program's storage account: its address, raw data and lamports. Header is 45 bytes. */
async function programData() {
  const info = await conn.getAccountInfo(program!.publicKey, "confirmed");
  if (!info?.executable) throw new Error("The program isn't on-chain yet. Run 2-GO-LIVE first.");
  const address = new PublicKey(info.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(address, "confirmed");
  if (!pd) throw new Error("Couldn't read the program's storage. Try again in a minute.");
  const authority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)) : null;
  return { address, data: pd.data, lamports: BigInt(pd.lamports), authority };
}

const matches = (onchain: Buffer, so: Buffer) =>
  onchain.length >= so.length && onchain.subarray(0, so.length).equals(so) && onchain.subarray(so.length).every((b) => b === 0);

/** Mainnet refuses to grow a program by less than this (Agave 4.x), unless to its maximum size. */
const MIN_EXTEND = 10_240;
const deployerFile = () => wslPath(keyFile("deployer", net));
const redact = (t: string) => t.replace(/api-key=[^&'"\s]+/g, "api-key=…");

/** Runs one Solana CLI step quietly; on failure, says which step and why, without printing the RPC key. */
function cli(step: string, cmd: string): string {
  try {
    return wsl(cmd, { quiet: true });
  } catch (e) {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string };
    const lines = redact(`${err.stderr ?? ""}\n${err.stdout ?? ""}`)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-4);
    throw new Error(`${step} didn't finish.${lines.length ? "\n    " + lines.join("\n    ") : ""}`);
  }
}

/**
 * Upgrades the program in three steps that can each be repeated safely:
 * make room (at least 10,240 bytes, mainnet's minimum), upload the code into
 * an upload account kept in keys/ (so an interrupted upload carries on where
 * it stopped), then switch the program over. The upload account's SOL comes
 * back with the switch.
 */
async function upgradeProgram() {
  if (!existsSync(SO_PATH)) throw new Error("There's no new build in program\\build yet.");
  const so = readFileSync(SO_PATH);
  const id = program!.publicKey;
  if (!so.includes(Buffer.from(id.toBytes()))) throw new Error(`That build wasn't made for ${id.toBase58()}, so it can't be used here.`);
  const pd = await programData();
  if (!pd.authority) throw new Error("The program is permanent and can no longer be upgraded.");
  if (!pd.authority.equals(deployer!.publicKey)) throw new Error(`Upgrades are controlled by ${pd.authority.toBase58()}, not by this deployer key.`);
  if (matches(pd.data.subarray(45), so)) {
    rmSync(keyFile("upgrade-buffer", net), { force: true });
    console.log("  The program on-chain is already exactly this build. Nothing to do.");
    return;
  }

  // room for the new code
  const room = pd.data.length - 45;
  const extendBy = so.length > room ? Math.max(so.length - room, MIN_EXTEND) : 0;
  const extendRent = extendBy ? BigInt(await conn.getMinimumBalanceForRentExemption(pd.data.length + extendBy)) - pd.lamports : 0n;

  // the upload account, kept between attempts
  const buffer = ensureKey("upgrade-buffer", net).publicKey;
  const bufSpace = 37 + so.length;
  let bufInfo = await conn.getAccountInfo(buffer, "confirmed");
  const stale = !!bufInfo && bufInfo.data.length !== bufSpace;
  const bufferRent = bufInfo && !stale ? 0n : BigInt(await conn.getMinimumBalanceForRentExemption(bufSpace));
  const fees = 20_000_000n;
  const need = bufferRent + (extendRent > 0n ? extendRent : 0n) + fees;
  const bal = BigInt(await conn.getBalance(deployer!.publicKey, "confirmed"));
  console.log(`
  New build          ${(so.length / 1024).toFixed(1)} KB   sha256 ${createHash("sha256").update(so).digest("hex").slice(0, 16)}…
  On-chain now       ${(room / 1024).toFixed(1)} KB of room
  Extra room         ${extendBy ? `${extendBy.toLocaleString("en-US")} bytes for ${sol(extendRent > 0n ? extendRent : 0n)} SOL, kept by the program (Solana's smallest step is 10,240)` : "none needed"}
  Upload account     ${bufInfo && !stale ? "already started earlier: it carries on where it stopped" : `${sol(bufferRent)} SOL set aside while uploading, returned at the end`}
  Network fees       about ${sol(fees)} SOL at most
  Deployer key holds ${sol(bal)} SOL`);
  if (bal < need) throw new Error(`Send at least ${sol(need - bal)} more SOL to ${deployer!.publicKey.toBase58()} first, then choose this again.`);
  const ok = await ask("\n  Type UPGRADE to replace the program with this build: ");
  if (ok !== "UPGRADE") return;

  if (stale) {
    console.log("\n  Clearing an upload of an older build first...");
    cli("Clearing the older upload", `solana program close ${buffer.toBase58()} --authority '${deployerFile()}' ${cliKeys()} --bypass-warning`);
    bufInfo = null;
  }
  if (extendBy) {
    console.log(`\n  1/3  Making room for the new code...`);
    cli("Making room", `solana program extend ${id.toBase58()} ${extendBy} ${cliKeys()}`);
  } else {
    console.log(`\n  1/3  There's already room for the new code.`);
  }

  console.log("  2/3  Uploading the new code. This takes a few minutes. If it stops, choose 13 again: it carries on.");
  const prio = net === "mainnet" ? "--with-compute-unit-price 20000" : "";
  const write = (extra: string) =>
    cli(
      "The upload",
      `solana program write-buffer '${wslPath(SO_PATH)}' --buffer '${wslPath(keyFile("upgrade-buffer", net))}' ` +
        `--buffer-authority '${deployerFile()}' ${cliKeys()} ${prio} --max-sign-attempts 80 ${extra}`,
    );
  try {
    write("");
  } catch {
    console.log("       The direct route didn't finish. Carrying on through your RPC instead...");
    write("--use-rpc");
  }
  const uploaded = await conn.getAccountInfo(buffer, "confirmed");
  if (!uploaded || !uploaded.data.subarray(37).equals(so)) {
    throw new Error("The upload isn't complete yet. Choose 13 again and it carries on where it stopped.");
  }

  console.log("  3/3  Switching the program to the new code...");
  cli("Switching to the new code", `solana program upgrade ${buffer.toBase58()} ${id.toBase58()} --upgrade-authority '${deployerFile()}' ${cliKeys()}`);
  const after = await programData();
  if (matches(after.data.subarray(45), so)) {
    rmSync(keyFile("upgrade-buffer", net), { force: true });
    console.log(`\n  Upgraded. The program on-chain now matches this build byte for byte.
  The deployer key holds ${sol(await conn.getBalance(deployer!.publicKey, "confirmed"))} SOL.`);
  } else {
    console.log("\n  The switch was sent but the on-chain code doesn't match yet. Choose 13 again in a minute to check.");
  }
}

async function reclaimBuffers() {
  const before = await conn.getBalance(deployer!.publicKey, "confirmed");
  try {
    wsl(`solana program close --buffers ${cliKeys()} --bypass-warning`, { quiet: true });
  } catch {
    /* the CLI exits non-zero when there is nothing to close */
  }
  const kept = loadKey("upgrade-buffer", net);
  if (kept && !(await conn.getAccountInfo(kept.publicKey, "confirmed"))) rmSync(keyFile("upgrade-buffer", net), { force: true });
  const after = await conn.getBalance(deployer!.publicKey, "confirmed");
  console.log(
    after > before
      ? `  Took back ${sol(after - before)} SOL. The deployer key now holds ${sol(after)} SOL.`
      : "  No interrupted uploads were holding SOL.",
  );
}

const solIn = async (q: string) => {
  const v = Number(await ask(q));
  if (!Number.isFinite(v) || v < 0) throw new Error("Not a number.");
  return BigInt(Math.round(v * LAMPORTS_PER_SOL));
};

for (;;) {
  try {
    const cfg = await status();
    console.log(`
  1  Change the pool fee            6  Turn screening ${cfg.requireAttestation ? "off" : "on"}
  2  Change deposit limits          7  Change the treasury (fee) wallet
  3  Change the pool cap            8  Hand the admin role to another wallet
  4  Change the waiting room time   9  Hand program upgrades to another wallet (e.g. a Squads multisig)
  5  ${cfg.depositsPaused ? "Re-open deposits " : "Pause new deposits"}             10 Make the program permanent (no more upgrades, cannot be undone)
  11 Send the deployer key's spare SOL to my own wallet
  12 Top up the relayer and guard from the deployer key
  13 Upgrade the program to the new build in this folder
  14 Take back SOL left by an interrupted upgrade
  15 Remove the deposit limits (no largest deposit, no pool cap)
  0  Exit`);
    const a = await ask("\n  Choose: ");
    if (a === "0" || a === "") break;
    if (a === "1") {
      const v = Number(await ask("  New fee in percent (0 to 1, e.g. 0.8): "));
      if (!(v >= 0 && v <= 1)) throw new Error("The fee can be 0% to 1%.");
      await update((p) => (p.feeBps = Math.round(v * 100)));
    } else if (a === "2") {
      const min = await solIn("  Smallest deposit in SOL (at least 0.001): ");
      const max = await solIn("  Largest single deposit in SOL (0 = no limit): ");
      if (min < 1_000_000n) throw new Error("The smallest deposit can't go below 0.001 SOL.");
      if (max !== 0n && max < min) throw new Error("The largest deposit can't be smaller than the smallest.");
      await update((p) => {
        p.minDeposit = min;
        p.maxDeposit = max === 0n ? NO_LIMIT : max;
      });
    } else if (a === "3") {
      const cap = await solIn("  Most SOL the pool may hold (0 = no limit): ");
      await update((p) => (p.tvlCap = cap));
    } else if (a === "4") {
      const m = Number(await ask("  Waiting room in minutes (0 to 10080): "));
      if (!(m >= 0 && m <= 10080)) throw new Error("Between 0 and 10080 minutes.");
      await update((p) => (p.depositDelay = BigInt(Math.round(m * 150))));
    } else if (a === "5") {
      await update((p) => (p.depositsPaused = !p.depositsPaused));
    } else if (a === "6") {
      await update((p) => (p.requireAttestation = !p.requireAttestation));
    } else if (a === "7") {
      const t = await ask("  New treasury wallet address: ");
      if (!isAddress(t)) throw new Error("That is not a Solana address.");
      const treasury = new PublicKey(t);
      // ready to take fees before the pool pays it: a wallet below the rent minimum skips small fees,
      // and scheduled payments proved with the fee would then no longer match
      const ready = await treasuryReady(conn, deployer.publicKey, treasury);
      if (ready.length) {
        await send(conn, ready, [deployer]);
        console.log("  The new treasury got the rent minimum and its fee account (paid from the deployer key).");
      }
      await update((p) => (p.treasury = treasury));
      s.treasury = treasury.toBase58();
      saveSettings(net, s);
    } else if (a === "8") {
      const t = await ask("  Wallet that should become admin: ");
      if (!isAddress(t)) throw new Error("That is not a Solana address.");
      await send(conn, [pool.transferAdmin(deployer.publicKey, new PublicKey(t))], [deployer]);
      console.log("  Proposed. That wallet must accept before the change takes effect.");
    } else if (a === "9") {
      const t = await ask("  Wallet or multisig vault that should control upgrades: ");
      if (!isAddress(t)) throw new Error("That is not a Solana address.");
      const ok = await ask(`  Type YES to hand upgrades of ${program.publicKey.toBase58()} to ${t}: `);
      if (ok === "YES")
        wsl(
          `solana program set-upgrade-authority ${program.publicKey.toBase58()} --new-upgrade-authority ${t} --skip-new-upgrade-authority-signer-check --keypair '${wslPath(keyFile("deployer", net))}' --url '${rpcFor(net, s)}'`,
        );
    } else if (a === "11") {
      const to = await ask("  Your wallet address (where the spare SOL should go): ");
      if (!isAddress(to)) throw new Error("That is not a Solana address.");
      const bal = await conn.getBalance(deployer.publicKey);
      const keep = 0.05 * LAMPORTS_PER_SOL; // enough for future admin changes
      const amount = bal - keep;
      if (amount <= 0) throw new Error("There is nothing spare to send.");
      const ok = await ask(`  Send ${sol(amount)} SOL from the deployer key to ${to}? Type YES: `);
      if (ok === "YES") {
        const sig = await send(conn, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: new PublicKey(to), lamports: amount })], [deployer]);
        console.log(`  Sent. ${sig}`);
      }
    } else if (a === "12") {
      const relayer = loadKey("relayer", net);
      const guard = loadKey("guard", net);
      const ixs = [];
      for (const [kp, want] of [
        [relayer, s.relayerFloatSol],
        [guard, s.guardFloatSol],
      ] as const) {
        if (!kp) continue;
        const have = await conn.getBalance(kp.publicKey);
        const target = Math.round(want * LAMPORTS_PER_SOL);
        if (have < target) ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: target - have }));
      }
      if (!ixs.length) console.log("  Both are already topped up.");
      else console.log(`  Done. ${await send(conn, ixs, [deployer])}`);
    } else if (a === "13") {
      await upgradeProgram();
    } else if (a === "14") {
      await reclaimBuffers();
    } else if (a === "15") {
      if (cfg.maxDeposit === NO_LIMIT && cfg.tvlCap === 0n) {
        console.log("  There are no deposit limits already. Nothing to do.");
        continue;
      }
      console.log(`
  Anyone will be able to deposit any amount, and the pool can grow without a cap.
  The smallest deposit stays ${sol(cfg.minDeposit)} SOL. You can put limits back any time with 2 and 3.`);
      const ok = await ask("  Type YES to remove the limits: ");
      if (ok === "YES") {
        await update((p) => {
          p.maxDeposit = NO_LIMIT;
          p.tvlCap = 0n;
        });
        const now = await fetchConfig(conn, pool);
        console.log(`  Deposit limits are now: ${limitsText(now)}.`);
      }
    } else if (a === "10") {
      const ok = await ask("  This can never be undone. Type MAKE IT PERMANENT to continue: ");
      if (ok === "MAKE IT PERMANENT")
        wsl(
          `solana program set-upgrade-authority ${program.publicKey.toBase58()} --final --keypair '${wslPath(keyFile("deployer", net))}' --url '${rpcFor(net, s)}'`,
        );
    }
  } catch (e) {
    console.log(`\n  ${(e as Error).message}`);
  }
}

doneAsking();
