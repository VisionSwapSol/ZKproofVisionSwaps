// Phase-2 trusted setup for the transaction circuit, run on one machine.
//
//   phase 1: Perpetual Powers of Tau, file ppot_0080_15.ptau (the 0080 branch:
//            61 public contributions plus a beacon), sha256 4a8eb5a7...
//   phase 2: N contributions made in this one process, each from fresh OS randomness
//            that this script never writes to disk, then a beacon from the CURRENT Bitcoin
//            tip unless --beacon is given, then a full verification against the circuit
//            and the phase-1 file.
//
// The deployed key (circuits/artifacts/TRANSCRIPT.json, 2026-10-03) was made this way.
// For a multi-party ceremony, with contributors on their own machines and a beacon
// announced in advance, use coordinator.mjs, contribute.mjs and verify-ceremony.mjs.
//
// Usage: node scripts/setup.mjs [--contributions 3] [--beacon <hex>] [--names "a,b,c"]

import * as snarkjs from "snarkjs";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const build = join(root, "build");
const out = join(root, "artifacts");
const r1cs = join(build, "transaction.r1cs");
const wasm = join(build, "transaction_js", "transaction.wasm");
const ptau = join(root, "ptau", "ppot_0080_15.ptau");

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const nContrib = Number(arg("--contributions", "3"));
const names = (arg("--names", "") || "").split(",").filter(Boolean);

const log = { info: (m) => console.log("  " + m), warn: console.warn, error: console.error, debug: () => {} };
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

async function beaconHash() {
  const given = arg("--beacon", "");
  if (given) return { hash: given, source: "supplied on the command line" };
  const h = (await (await fetch("https://blockstream.info/api/blocks/tip/hash")).text()).trim();
  const height = (await (await fetch("https://blockstream.info/api/blocks/tip/height")).text()).trim();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("could not read a Bitcoin block hash for the beacon");
  return { hash: h, source: `Bitcoin block ${height}` };
}

if (!existsSync(r1cs)) throw new Error("build the circuit first (npm run build)");
mkdirSync(out, { recursive: true });
const tmp = join(build, "zkey-tmp");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const transcript = {
  circuit: "transaction.circom (levels 26, 2 in, 2 out)",
  r1csSha256: sha(r1cs),
  phase1: { file: "ppot_0080_15.ptau", sha256: sha(ptau), source: "PSE Perpetual Powers of Tau, contribution 80" },
  contributions: [],
  beacon: null,
  finalZkeySha256: null,
  verificationKeySha256: null,
  createdAt: new Date().toISOString(),
};

console.log("phase 2: initial zkey");
let prev = join(tmp, "tx_0000.zkey");
await snarkjs.zKey.newZKey(r1cs, ptau, prev, log);

for (let i = 1; i <= nContrib; i++) {
  const next = join(tmp, `tx_${String(i).padStart(4, "0")}.zkey`);
  const entropy = randomBytes(64).toString("hex") + randomBytes(64).toString("base64");
  const name = names[i - 1] || `VisionSwap contribution ${i}`;
  console.log(`phase 2: contribution ${i} (${name})`);
  const hash = await snarkjs.zKey.contribute(prev, next, name, entropy, log);
  transcript.contributions.push({ name, hash: Buffer.from(hash).toString("hex") });
  rmSync(prev);
  prev = next;
}

const b = await beaconHash();
console.log(`phase 2: beacon from ${b.source}`);
const final = join(out, "transaction.zkey");
await snarkjs.zKey.beacon(prev, final, "Final beacon", b.hash, 10, log);
rmSync(prev);
transcript.beacon = { hash: b.hash, iterationsExp: 10, source: b.source };

console.log("verifying the final zkey against the circuit and phase 1");
const ok = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, final, log);
if (!ok) throw new Error("zkey verification FAILED");

const vk = await snarkjs.zKey.exportVerificationKey(final);
writeFileSync(join(out, "verification_key.json"), JSON.stringify(vk, null, 2));
copyFileSync(wasm, join(out, "transaction.wasm"));
transcript.finalZkeySha256 = sha(final);
transcript.verificationKeySha256 = sha(join(out, "verification_key.json"));
transcript.wasmSha256 = sha(join(out, "transaction.wasm"));
writeFileSync(join(out, "TRANSCRIPT.json"), JSON.stringify(transcript, null, 2));
rmSync(tmp, { recursive: true, force: true });
console.log("done:", JSON.stringify({ zkey: transcript.finalZkeySha256, vk: transcript.verificationKeySha256 }));
process.exit(0);
