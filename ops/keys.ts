// Step 1: make the keys VisionSwap needs. Safe to run again: existing keys are kept.
//   node --import tsx ops/keys.ts [--devnet | --localnet]
import { existsSync } from "node:fs";
import { banner, ensureKey, keyFile, loadKey, netFromArgs, wsl, wslPath } from "./common.ts";

const net = netFromArgs();
banner(`VisionSwap keys (${net})`);

// The program's address. Prefer a "VSw…" vanity address if one was found.
if (!loadKey("program", net)) {
  let used = false;
  try {
    const found = wsl("ls ~/vsgrind/VSw*.json 2>/dev/null | head -1", { quiet: true }).trim();
    if (found && net === "mainnet") {
      const dest = keyFile("program", net);
      wsl(`cp ${found} ${wslPath(dest)}`, { quiet: true });
      used = existsSync(dest);
    }
  } catch {
    /* no WSL or no vanity key: fine */
  }
  if (!used) ensureKey("program", net);
}

const program = loadKey("program", net)!;
const deployer = ensureKey("deployer", net);
const relayer = ensureKey("relayer", net);
const guard = ensureKey("guard", net);

console.log(`
  Program address     ${program.publicKey.toBase58()}
  Deployer (admin)    ${deployer.publicKey.toBase58()}
  Relayer             ${relayer.publicKey.toBase58()}
  Guard (screening)   ${guard.publicKey.toBase58()}

  The keys are saved in the "keys" folder next to this file. Keep that folder
  private and backed up: the deployer key controls the program and its settings.
`);
if (net === "mainnet") {
  console.log(`  Next: send about 5 SOL to the DEPLOYER address above, then run
  2-GO-LIVE-MAINNET.bat. Roughly 2.3 SOL stays locked as the program's storage
  deposit (you get it back if the program is ever closed), about 0.3 SOL goes to
  the relayer and guard so they can pay network fees, and the rest is returned
  to the deployer when the upload finishes.
`);
}
