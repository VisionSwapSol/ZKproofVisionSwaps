// One contribution to the VisionSwap phase-2 ceremony, made on your own machine.
//
//   node scripts/contribute.mjs --in tx_0004.zkey --out tx_0005.zkey --name "Alice (github.com/alice)"
//        [--r1cs build/transaction.r1cs] [--ptau ptau/ppot_0080_15.ptau] [--ask-entropy] [--skip-verify]
//
// 1. Checks the key you received: it must verify against the circuit (r1cs) and phase 1 (ptau),
//    and hold only contributions, no beacon yet. It prints the contributions already in it, so
//    you can compare them with the ones the coordinator published.
// 2. Adds your contribution. The randomness is 64 fresh bytes from the operating system, plus
//    (with --ask-entropy) anything you type; snarkjs mixes in 64 more bytes of its own. The script
//    never prints it or writes it to disk (what you type is shown on screen as you type it, so clear
//    the terminal afterwards): only the new key is written.
// 3. Checks the new key the same way.
// 4. Prints your contribution hash and both files' sha256, and writes <out>.attestation.json and
//    <out>.attestation.md: fill in the .md, sign it, publish it, and send the coordinator the new
//    key with the .json.
// Then close this window and restart (better: power off) the machine, so the randomness that was
// in memory is gone.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import * as snarkjs from "snarkjs";
import {
  DEFAULTS,
  EXPECTED,
  arg,
  collectingLogger,
  flag,
  formatHash,
  hex,
  readContributions,
  sha256File,
  snarkjsVersion,
} from "./ceremony-lib.mjs";

const stop = (m) => {
  console.error(`\n  ${m}\n`);
  process.exit(1);
};

const input = arg("--in");
const output = arg("--out");
const name = (arg("--name", "") || "").trim();
const r1cs = arg("--r1cs", DEFAULTS.r1cs);
const ptau = arg("--ptau", DEFAULTS.ptau);
const verifyKeys = !flag("--skip-verify");
if (!input || !output) stop("Usage: node scripts/contribute.mjs --in <received.zkey> --out <new.zkey> --name \"<your name or handle>\"");
if (!name) stop('Give --name "<your name or handle>": it is stored in the key and shown in every later check.');
// snarkjs keeps only the first 64 characters of a name (zkey_utils writeMPCParams), so a longer
// one would come back changed and the check after contributing would refuse the new key
if (name.length > 64) stop(`--name is too long (${name.length} characters): the key stores at most 64.`);
if (!existsSync(input)) stop(`${input} not found`);
if (existsSync(output)) stop(`${output} already exists; choose a new file name`);
if (verifyKeys && (!existsSync(r1cs) || !existsSync(ptau))) {
  stop(`To check the keys, give --r1cs and --ptau (expected sha256 ${EXPECTED.r1csSha256.slice(0, 16)}… and ${EXPECTED.ptauSha256.slice(0, 16)}…), or pass --skip-verify.`);
}

console.log("\n  1/4  Checking the key you received");
const inSha = await sha256File(input);
console.log(`       sha256 ${inSha}`);
const before = await readContributions(input);
if (before.circuitHash !== EXPECTED.circuitHash) stop("This key is not for the VisionSwap transaction circuit (its circuit hash differs).");
if (before.contributions.some((c) => c.type !== "contribution")) stop("This key already has a beacon: the ceremony is closed, so it takes no more contributions.");
for (const [i, c] of before.contributions.entries()) console.log(`       #${i + 1}  ${c.name || "unnamed"}\n${formatHash(c.hash)}`);
if (!before.contributions.length) console.log("       no contributions yet: you are the first");
if (verifyKeys) {
  const r1csSha = await sha256File(r1cs);
  const ptauSha = await sha256File(ptau);
  if (r1csSha !== EXPECTED.r1csSha256) stop(`${r1cs} is not the ceremony's circuit (sha256 ${r1csSha})`);
  if (ptauSha !== EXPECTED.ptauSha256) stop(`${ptau} is not the ceremony's phase-1 file (sha256 ${ptauSha})`);
  console.log("       verifying against the circuit and phase 1 (about a minute)...");
  if (!(await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, input, collectingLogger()))) stop("The key you received does NOT verify. Do not contribute; tell the coordinator.");
  console.log("       it verifies");
} else console.log("       (not verified: --skip-verify)");

const askedEntropy = flag("--ask-entropy");
let typed = "";
if (askedEntropy) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  typed = await rl.question("\n  Type some random text (it is mixed in, never stored), then Enter: ");
  rl.close();
}

console.log(`\n  2/4  Adding your contribution as "${name}"`);
let entropy = randomBytes(64).toString("hex") + typed;
const hash = hex(await snarkjs.zKey.contribute(input, output, name, entropy, collectingLogger()));
entropy = "";
typed = "";

console.log("\n  3/4  Checking the new key");
const after = await readContributions(output);
const mine = after.contributions[after.contributions.length - 1];
const extendsInput = after.contributions.length === before.contributions.length + 1 && before.contributions.every((c, i) => after.contributions[i].hash === c.hash);
if (!extendsInput || mine.hash !== hash || mine.name !== name) stop("The new key does not hold exactly the old contributions plus yours. Do not send it.");
if (verifyKeys) {
  console.log("       verifying against the circuit and phase 1 (about a minute)...");
  if (!(await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, output, collectingLogger()))) stop("The new key does NOT verify. Do not send it; tell the coordinator.");
  console.log("       it verifies");
}
const outSha = await sha256File(output);

const index = after.contributions.length;
const attestation = {
  ceremony: "VisionSwap transaction circuit, phase 2",
  circuitHash: after.circuitHash,
  index,
  name,
  contributionHash: hash,
  input: { file: basename(input), sha256: inSha },
  output: { file: basename(output), sha256: outSha },
  previous: before.contributions.map((c) => c.hash),
  verified: verifyKeys,
  software: { snarkjs: snarkjsVersion, node: process.version, os: `${platform()} ${release()} ${arch()}` },
  date: new Date().toISOString(),
};
const base = output.replace(/\.zkey$/, "");
writeFileSync(`${base}.attestation.json`, JSON.stringify(attestation, null, 2) + "\n");
writeFileSync(
  `${base}.attestation.md`,
  `# VisionSwap phase-2 ceremony: contribution #${index}

Contributor: ${name}
Date (UTC): ${attestation.date}

Contribution hash (as snarkjs prints it):

\`\`\`
${formatHash(hash).replace(/\t/g, "")}
\`\`\`

| | sha256 |
|---|---|
| Key I received (${attestation.input.file}) | \`${inSha}\` |
| Key I produced (${attestation.output.file}) | \`${outSha}\` |

Software: snarkjs ${snarkjsVersion}, Node ${process.version}, ${attestation.software.os}.
The received key ${verifyKeys ? "was" : "was NOT"} verified against the circuit and phase 1 before contributing, and the new key ${verifyKeys ? "was" : "was NOT"} verified after.

Fill in, and delete what does not apply:

- Machine: <your own laptop / desktop / a fresh cloud VM you rented>, <operating system>.
- Network: <it was offline while contributing / it was online>.
- Randomness: 64 bytes from the operating system${askedEntropy ? " plus text I typed" : ""}, mixed by snarkjs with 64 more bytes of its own.
- Afterwards I <closed the program and powered the machine off / wiped the VM>.
- I did not copy, record or share the randomness, and I am not aware of anyone else having access to this machine while I contributed.

Signature: publish this file from an account people know is yours, or sign it
(for example \`gpg --clearsign ${basename(base)}.attestation.md\`, or
\`ssh-keygen -Y sign -n file -f <your key> ${basename(base)}.attestation.md\`),
and send the signed file to the coordinator.
`,
);

console.log(`
  4/4  Done. Your contribution hash:
${formatHash(hash)}

  ${basename(output)}  sha256 ${outSha}

  Wrote ${basename(base)}.attestation.json and ${basename(base)}.attestation.md.
  Next: fill in and sign the .md, publish it, and send the coordinator ${basename(output)}
  and ${basename(base)}.attestation.json. Then close this window and restart or power off this machine.
`);
process.exit(0);
