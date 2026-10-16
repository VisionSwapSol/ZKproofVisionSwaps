// The coordinator's steps of the VisionSwap phase-2 ceremony.
//
//   node scripts/coordinator.mjs init --dir <folder>              initial key tx_0000.zkey + manifest.json
//   node scripts/coordinator.mjs announce --dir <folder> --height <future bitcoin block height> [--allow-mined]
//   node scripts/coordinator.mjs accept --dir <folder> --zkey <received.zkey> [--attestation <file.json>]
//   node scripts/coordinator.mjs finalize --dir <folder> [--beacon-hash <hex>] [--fetch]
//
// announce asks two public explorers for the current Bitcoin height and refuses a block that
// already exists (its hash is known); --allow-mined skips that, for rehearsals only.
// Every step writes only inside <folder>, never into circuits/artifacts. The cutover to a new
// key is a separate, reviewed change.
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as snarkjs from "snarkjs";
import {
  BEACON_ITERATIONS_EXP,
  DEFAULTS,
  EXPECTED,
  FINAL,
  arg,
  bitcoinBlockHash,
  bitcoinTipHeight,
  chainFiles,
  collectingLogger,
  flag,
  readContributions,
  readJson,
  sha256File,
  snarkjsVersion,
  zkeyName,
} from "./ceremony-lib.mjs";
import { verifyCeremonyDir } from "./verify-ceremony.mjs";

const stop = (m) => {
  console.error(`\n  ${m}\n`);
  process.exit(1);
};
const cmd = process.argv[2];
const dir = arg("--dir");
if (!dir) stop("Give --dir <ceremony folder>.");
const r1cs = arg("--r1cs", DEFAULTS.r1cs);
const ptau = arg("--ptau", DEFAULTS.ptau);
const manifestPath = join(dir, "manifest.json");
const saveManifest = (m) => writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");

if (cmd === "init") {
  if (existsSync(join(dir, zkeyName(0)))) stop(`${dir} already has ${zkeyName(0)}`);
  mkdirSync(dir, { recursive: true });
  const r1csSha = await sha256File(r1cs);
  const ptauSha = await sha256File(ptau);
  if (r1csSha !== EXPECTED.r1csSha256) stop(`${r1cs} is not the transaction circuit in use (sha256 ${r1csSha})`);
  if (ptauSha !== EXPECTED.ptauSha256) stop(`${ptau} is not the phase-1 file in use (sha256 ${ptauSha})`);
  console.log("  Making the initial key from the circuit and phase 1 (about a minute)...");
  const init = join(dir, zkeyName(0));
  await snarkjs.zKey.newZKey(r1cs, ptau, init, collectingLogger());
  const mpc = await readContributions(init);
  if (mpc.circuitHash !== EXPECTED.circuitHash) stop("the initial key's circuit hash is not the transaction circuit's");
  const manifest = {
    ceremony: "VisionSwap transaction circuit, phase 2",
    circuit: "transaction.circom (levels 26, 2 in, 2 out), the same r1cs as the setup in use",
    r1csSha256: r1csSha,
    phase1: { file: basename(ptau), sha256: ptauSha, source: "PSE Perpetual Powers of Tau, contribution 80" },
    circuitHash: mpc.circuitHash,
    initZkeySha256: await sha256File(init),
    snarkjs: snarkjsVersion,
    createdAt: new Date().toISOString(),
    beacon: { iterationsExp: BEACON_ITERATIONS_EXP, announced: null, hash: null },
    contributions: [],
  };
  saveManifest(manifest);
  console.log(`  Wrote ${init} (sha256 ${manifest.initZkeySha256})\n  and ${manifestPath}. Publish both.`);
} else if (cmd === "announce") {
  const m = readJson(manifestPath) ?? stop("no manifest.json: run init first");
  const height = Number(arg("--height"));
  if (!Number.isInteger(height) || height <= 0) stop("Give --height <future Bitcoin block height>.");
  if (m.beacon.announced) stop(`The beacon was already announced as block ${m.beacon.announced.height}; it cannot change.`);
  // a block that already exists has a known hash, so it would be no beacon at all
  if (!flag("--allow-mined")) {
    const tip = await bitcoinTipHeight();
    if (tip === null) {
      console.log(`  Couldn't read the current Bitcoin height from the explorers: make sure block ${height} is still in the future.`);
    } else if (height <= tip) {
      stop(`Bitcoin block ${height} already exists (the chain is at ${tip}), so its hash is known. Pick a height after the last planned contribution, above ${tip}.`);
    } else {
      console.log(`  The chain is at block ${tip}; block ${height} is about ${Math.round((height - tip) / 144)} day(s) away.`);
    }
  }
  m.beacon.announced = { height, announcedAt: new Date().toISOString() };
  saveManifest(m);
  console.log(`  Recorded: the final beacon is Bitcoin block ${height}. Publish this now, before that block exists.`);
} else if (cmd === "accept") {
  // checks a contribution sent in, adds it as the next numbered key and records it
  const m = readJson(manifestPath) ?? stop("no manifest.json: run init first");
  if (existsSync(join(dir, FINAL))) stop("The beacon was applied: the ceremony is closed.");
  const received = arg("--zkey") ?? stop("Give --zkey <the key the contributor sent>.");
  const files = chainFiles(dir);
  const next = join(dir, zkeyName(files.length));
  const prevList = (await readContributions(files[files.length - 1])).contributions;
  const got = (await readContributions(received)).contributions;
  if (got.length !== prevList.length + 1 || prevList.some((c, i) => got[i].hash !== c.hash) || got[got.length - 1].type !== "contribution") {
    stop(`${received} is not ${basename(files[files.length - 1])} plus one contribution. It was made from another key, or someone else's contribution came first.`);
  }
  if (!(await snarkjs.zKey.verifyFromInit(files[0], ptau, received, collectingLogger()))) stop(`${received} does NOT verify.`);
  copyFileSync(received, next);
  const att = arg("--attestation");
  if (att) copyFileSync(att, next.replace(/\.zkey$/, ".attestation.json"));
  const c = got[got.length - 1];
  m.contributions.push({ index: got.length, name: c.name, hash: c.hash, sha256: await sha256File(next), acceptedAt: new Date().toISOString() });
  saveManifest(m);
  console.log(`  Accepted contribution #${got.length} (${c.name || "unnamed"}) as ${basename(next)}. Publish it; the next contributor starts from it.`);
} else if (cmd === "finalize") {
  const m = readJson(manifestPath) ?? stop("no manifest.json: run init first");
  if (existsSync(join(dir, FINAL))) stop(`${FINAL} already exists`);
  const height = m.beacon.announced?.height ?? stop("No beacon block was announced (announce --height). Announce one, wait for it, then finalize.");
  let hash = arg("--beacon-hash");
  if (process.argv.includes("--fetch")) {
    const fetched = await bitcoinBlockHash(height);
    if (hash && hash !== fetched) stop(`--beacon-hash differs from block ${height}'s hash ${fetched}`);
    hash = fetched;
  }
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) stop(`Give --fetch, or --beacon-hash <the 64-hex hash of Bitcoin block ${height}>.`);
  const files = chainFiles(dir);
  const last = files[files.length - 1];
  console.log(`  Applying the beacon (block ${height}) to ${basename(last)}...`);
  await snarkjs.zKey.beacon(last, join(dir, FINAL), `Beacon: Bitcoin block ${height}`, hash, BEACON_ITERATIONS_EXP, collectingLogger());
  m.beacon.hash = hash;
  saveManifest(m);
  const vk = await snarkjs.zKey.exportVerificationKey(join(dir, FINAL));
  writeFileSync(join(dir, "verification_key.json"), JSON.stringify(vk, null, 2));
  console.log("  Verifying the whole chain...");
  const res = await verifyCeremonyDir(dir, { r1cs, ptau });
  if (res.problems.length) {
    rmSync(join(dir, FINAL), { force: true });
    rmSync(join(dir, "verification_key.json"), { force: true });
    m.beacon.hash = null;
    saveManifest(m);
    stop(`The chain does not check out (${res.problems.length} problem(s)); ${FINAL} was removed.`);
  }
  const transcript = {
    circuit: m.circuit,
    r1csSha256: m.r1csSha256,
    phase1: m.phase1,
    circuitHash: m.circuitHash,
    initZkeySha256: m.initZkeySha256,
    contributions: res.contributions.map((c) => ({ name: c.name, hash: c.hash, zkeySha256: c.sha256 })),
    beacon: { hash, iterationsExp: BEACON_ITERATIONS_EXP, source: `Bitcoin block ${height}`, announcedHeight: height, announcedAt: m.beacon.announced.announcedAt },
    finalZkeySha256: res.final.sha256,
    verificationKeySha256: res.final.verificationKeySha256,
    snarkjs: snarkjsVersion,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "TRANSCRIPT.json"), JSON.stringify(transcript, null, 2));
  console.log(`
  Done: ${res.contributions.length} contributions and the beacon.
    ${FINAL}            sha256 ${transcript.finalZkeySha256}
    verification_key.json    sha256 ${transcript.verificationKeySha256}
  Publish the whole folder. Switching the program to this key is a separate, reviewed step.`);
} else {
  stop("Commands: init, announce, accept, finalize (see the top of this file).");
}
process.exit(0);
