// Shared helpers for the phase-2 ceremony scripts.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import * as binFileUtils from "@iden3/binfileutils";

export const CIRCUITS = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULTS = {
  r1cs: join(CIRCUITS, "build", "transaction.r1cs"),
  ptau: join(CIRCUITS, "ptau", "ppot_0080_15.ptau"),
};

/**
 * The circuit and phase-1 file of the setup the program uses today
 * (circuits/artifacts/TRANSCRIPT.json). A new ceremony keeps both, so notes,
 * the tree and the wasm stay valid and only the proving and verification keys change.
 */
export const EXPECTED = {
  r1csSha256: "7291e7b10b61eca6e8a352e6642ab1289e3313a07856571b0bc21d909f1ac8f8",
  ptauSha256: "4a8eb5a754ed4710d6ad603c2e1a89c72325a448e4474f8694d2c71c7c272f3d",
  circuitHash:
    "7745977aba61bdeac0cc2d0bf44f50bb2231175d67e1545616bbaec57410983c51bce0732a00690c158fc6bf747acb99b66132db6cfe6632a9e3666c7fc49354",
};

/** Bitcoin block-hash beacon applied after the last contribution: 2^10 hash iterations, as in the first setup. */
export const BEACON_ITERATIONS_EXP = 10;

const require = createRequire(import.meta.url);
const snarkjsRoot = dirname(dirname(require.resolve("snarkjs")));
export const snarkjsVersion = JSON.parse(readFileSync(join(snarkjsRoot, "package.json"), "utf8")).version;
const internal = (file) => import(pathToFileURL(join(snarkjsRoot, "src", file)).href);

export async function sha256File(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

export const hex = (b) => Buffer.from(b).toString("hex");

/** A 64-byte hash the way snarkjs prints it: four lines of four 8-digit groups. */
export function formatHash(hexStr) {
  const groups = hexStr.match(/.{8}/g);
  return [0, 1, 2, 3].map((i) => "\t\t" + groups.slice(i * 4, i * 4 + 4).join(" ")).join("\n");
}

/**
 * Reads a Groth16 zkey's phase-2 record: the circuit hash and every contribution
 * (its snarkjs contribution hash, name, and for a beacon its hash and iterations).
 * It checks nothing; the snarkjs verification does that.
 */
export async function readContributions(zkeyPath) {
  const zkeyUtils = await internal("zkey_utils.js");
  const { getCurveFromQ } = await internal("curves.js");
  const { fd, sections } = await binFileUtils.readBinFile(zkeyPath, "zkey", 2);
  try {
    const header = await zkeyUtils.readHeader(fd, sections, false);
    if (header.protocol !== "groth16") throw new Error(`${zkeyPath} is not a Groth16 zkey`);
    const curve = await getCurveFromQ(header.q);
    const mpc = await zkeyUtils.readMPCParams(fd, curve, sections);
    const contributions = mpc.contributions.map((c) => {
      const hasher = blake2b.create({ dkLen: 64 });
      zkeyUtils.hashPubKey(hasher, curve, c);
      const out = { hash: hex(hasher.digest()), type: c.type === 1 ? "beacon" : "contribution", name: c.name ?? "" };
      if (c.type === 1) {
        out.beaconHash = hex(c.beaconHash);
        out.numIterationsExp = c.numIterationsExp;
      }
      return out;
    });
    return { circuitHash: hex(mpc.csHash), contributions };
  } finally {
    await fd.close();
  }
}

/** A logger for snarkjs that keeps its lines (quiet unless `echo`). */
export function collectingLogger(echo = false) {
  const lines = [];
  const push = (level) => (m) => {
    lines.push(`${level} ${m}`);
    if (echo) console.log(`    ${m}`);
  };
  return { lines, info: push("info"), warn: push("warn"), error: push("error"), debug: () => {} };
}

/** Ceremony folder layout: tx_0000.zkey (initial), tx_0001.zkey..., tx_final.zkey (after the beacon). */
export const zkeyName = (i) => `tx_${String(i).padStart(4, "0")}.zkey`;
export const FINAL = "tx_final.zkey";

/** The numbered zkeys in a ceremony folder, in order; refuses gaps. */
export function chainFiles(dir) {
  const nums = readdirSync(dir)
    .map((f) => /^tx_(\d{4})\.zkey$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  nums.forEach((n, i) => {
    if (n !== i) throw new Error(`${dir} has no ${zkeyName(i)} (the chain has a gap)`);
  });
  return nums.map((n) => join(dir, zkeyName(n)));
}

export function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}

export function arg(k, d) {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
}
export const flag = (k) => process.argv.includes(k);

/** Bitcoin block hash at a height, from two public explorers that must agree. */
export async function bitcoinBlockHash(height) {
  const sources = [`https://blockstream.info/api/block-height/${height}`, `https://mempool.space/api/block-height/${height}`];
  const seen = [];
  for (const url of sources) {
    const res = await fetch(url);
    const text = (await res.text()).trim();
    if (!res.ok || !/^[0-9a-f]{64}$/.test(text)) throw new Error(`${url} did not return a block hash (${res.status})`);
    seen.push(text);
  }
  if (seen[0] !== seen[1]) throw new Error(`the explorers disagree on block ${height}: ${seen.join(" vs ")}`);
  return seen[0];
}

/** The highest current Bitcoin block height either public explorer reports, or null when neither answers. */
export async function bitcoinTipHeight() {
  const sources = ["https://blockstream.info/api/blocks/tip/height", "https://mempool.space/api/blocks/tip/height"];
  let tip = null;
  for (const url of sources) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const n = Number((await res.text()).trim());
      if (res.ok && Number.isInteger(n) && n > 0) tip = Math.max(tip ?? 0, n);
    } catch {
      /* the other explorer may answer */
    }
  }
  return tip;
}
