// Checks a phase-2 trusted setup for the transaction circuit, end to end. Anyone can run it.
//
// A ceremony folder (as coordinator.mjs writes it):
//   node scripts/verify-ceremony.mjs --dir <folder> [--check-bitcoin] [--require-attestations]
//        [--r1cs build/transaction.r1cs] [--ptau ptau/ppot_0080_15.ptau] [--vk a.json,b.json]
// The setup in use today (one final zkey and its transcript):
//   node scripts/verify-ceremony.mjs --final artifacts/transaction.zkey --transcript artifacts/TRANSCRIPT.json
//        [--check-bitcoin] [--vk artifacts/verification_key.json,../server/zk/verification_key.json]
//
// Folder mode checks: the r1cs and ptau are the expected ones; tx_0000.zkey is exactly the
// initial key for them; every tx_NNNN.zkey verifies and extends the one before it by exactly
// one contribution; tx_final.zkey adds exactly one beacon, from the block height announced in
// manifest.json (with --check-bitcoin, the hash is fetched from two public explorers); each
// attestation names the right hashes; the exported verification key equals every --vk file.
// Exit code 0 when everything holds, 1 otherwise.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as snarkjs from "snarkjs";
import {
  BEACON_ITERATIONS_EXP,
  CIRCUITS,
  DEFAULTS,
  EXPECTED,
  FINAL,
  arg,
  bitcoinBlockHash,
  chainFiles,
  collectingLogger,
  flag,
  readContributions,
  readJson,
  sha256File,
} from "./ceremony-lib.mjs";

const short = (h) => `${h.slice(0, 8)}…${h.slice(-8)}`;

/** Exported VK as the setup writes it (JSON, 2-space indent), and its sha256. */
async function exportVk(zkey) {
  const vk = await snarkjs.zKey.exportVerificationKey(zkey);
  const text = JSON.stringify(vk, null, 2);
  return { vk, text, sha256: createHash("sha256").update(text).digest("hex") };
}

function compareVkFiles(report, vk, files) {
  for (const f of files) {
    if (!existsSync(f)) {
      report.fail(`verification key file ${f} not found`);
      continue;
    }
    const same = JSON.stringify(JSON.parse(readFileSync(f, "utf8"))) === JSON.stringify(vk);
    (same ? report.ok : report.fail)(`verification key equals ${f}`);
  }
}

function makeReport(quiet = false) {
  const r = { problems: [], warnings: [] };
  r.ok = (m) => quiet || console.log(`  ok    ${m}`);
  r.fail = (m) => {
    r.problems.push(m);
    if (!quiet) console.log(`  FAIL  ${m}`);
  };
  r.warn = (m) => {
    r.warnings.push(m);
    if (!quiet) console.log(`  note  ${m}`);
  };
  r.info = (m) => quiet || console.log(`  info  ${m}`);
  return r;
}

async function checkInputs(report, r1cs, ptau, want = EXPECTED) {
  const r1csSha = await sha256File(r1cs);
  const ptauSha = await sha256File(ptau);
  (r1csSha === want.r1csSha256 ? report.ok : report.fail)(`r1cs sha256 ${short(r1csSha)} (expected ${short(want.r1csSha256)})`);
  (ptauSha === want.ptauSha256 ? report.ok : report.fail)(`ptau sha256 ${short(ptauSha)} (expected ${short(want.ptauSha256)})`);
  return { r1csSha, ptauSha };
}

/**
 * Verifies a ceremony folder. Returns { problems, warnings, contributions, beacon, final }.
 * Used by this script and by coordinator.mjs.
 */
export async function verifyCeremonyDir(dir, opts = {}) {
  const r1cs = opts.r1cs ?? DEFAULTS.r1cs;
  const ptau = opts.ptau ?? DEFAULTS.ptau;
  const report = makeReport(opts.quiet);
  const manifest = readJson(join(dir, "manifest.json"), {});
  console.log(`\n  Ceremony folder ${dir}`);
  await checkInputs(report, r1cs, ptau);

  const files = chainFiles(dir);
  if (!files.length) {
    report.fail("no tx_0000.zkey");
    return report;
  }
  // the initial key: exactly what anyone gets from the r1cs and the ptau
  const initLog = collectingLogger();
  const initOk = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, files[0], initLog);
  (initOk ? report.ok : report.fail)(`tx_0000.zkey is the initial key for this r1cs and ptau`);
  const initSha = await sha256File(files[0]);
  if (manifest.initZkeySha256 && manifest.initZkeySha256 !== initSha) report.fail(`tx_0000.zkey sha256 differs from manifest.json`);

  let prev = [];
  const shas = [initSha];
  const contributions = [];
  for (let i = 0; i < files.length; i++) {
    const name = basename(files[i]);
    const mpc = await readContributions(files[i]);
    if (mpc.circuitHash !== EXPECTED.circuitHash) report.fail(`${name}: circuit hash ${short(mpc.circuitHash)} is not the transaction circuit's`);
    const list = mpc.contributions;
    if (list.length !== i) report.fail(`${name} holds ${list.length} contributions, expected ${i}`);
    if (list.some((c) => c.type !== "contribution")) report.fail(`${name} holds a beacon before the end`);
    if (prev.some((c, k) => list[k]?.hash !== c.hash)) report.fail(`${name} does not continue ${basename(files[i - 1])}`);
    if (i > 0) {
      const ok = await snarkjs.zKey.verifyFromInit(files[0], ptau, files[i], collectingLogger());
      (ok ? report.ok : report.fail)(`${name} verifies (contribution #${i}: ${list[i - 1]?.name || "unnamed"}, hash ${short(list[i - 1]?.hash ?? "")})`);
      shas.push(await sha256File(files[i]));
      contributions.push({ index: i, name: list[i - 1]?.name ?? "", hash: list[i - 1]?.hash ?? "", file: name, sha256: shas[i] });
      // the contributor's attestation, when it is here
      const att = readJson(join(dir, name.replace(/\.zkey$/, ".attestation.json")));
      if (!att) {
        (opts.requireAttestations ? report.fail : report.warn)(`${name}: no attestation file`);
      } else {
        const good = att.index === i && att.contributionHash === list[i - 1]?.hash && att.output?.sha256 === shas[i] && att.input?.sha256 === shas[i - 1];
        (good ? report.ok : report.fail)(`${name}: attestation names this contribution, its input and its output`);
      }
    }
    prev = list;
  }
  if (contributions.length === 0) report.warn("no contributions yet");

  // the beacon
  const finalPath = join(dir, FINAL);
  let beacon = null;
  let final = null;
  if (existsSync(finalPath)) {
    const mpc = await readContributions(finalPath);
    const list = mpc.contributions;
    const last = list[list.length - 1];
    if (list.length !== prev.length + 1 || prev.some((c, k) => list[k].hash !== c.hash)) {
      report.fail(`${FINAL} is not the last numbered key plus one step`);
    }
    if (last?.type !== "beacon") report.fail(`${FINAL}: the last step is not a beacon`);
    else {
      beacon = { hash: last.beaconHash, iterationsExp: last.numIterationsExp };
      const announced = manifest.beacon?.announced?.height ?? opts.beaconHeight;
      const expectHash = opts.beaconHash ?? manifest.beacon?.hash;
      if (last.numIterationsExp !== BEACON_ITERATIONS_EXP) report.fail(`beacon iterations 2^${last.numIterationsExp}, expected 2^${BEACON_ITERATIONS_EXP}`);
      if (!announced) report.fail("no beacon block height was announced (manifest.json beacon.announced.height)");
      if (expectHash) (expectHash === last.beaconHash ? report.ok : report.fail)(`beacon hash is ${short(last.beaconHash)} as recorded`);
      if (announced && opts.checkBitcoin) {
        const h = await bitcoinBlockHash(announced);
        (h === last.beaconHash ? report.ok : report.fail)(`beacon hash is Bitcoin block ${announced}'s hash`);
      } else if (announced) report.warn(`beacon block ${announced}: run with --check-bitcoin to compare it with the chain`);
    }
    const ok = await snarkjs.zKey.verifyFromInit(files[0], ptau, finalPath, collectingLogger());
    (ok ? report.ok : report.fail)(`${FINAL} verifies against the r1cs and the ptau`);
    const { vk, sha256 } = await exportVk(finalPath);
    final = { file: FINAL, sha256: await sha256File(finalPath), verificationKeySha256: sha256 };
    const dirVk = join(dir, "verification_key.json");
    compareVkFiles(report, vk, [...(existsSync(dirVk) ? [dirVk] : []), ...(opts.vk ?? [])]);
  } else report.warn(`no ${FINAL} yet (the beacon has not been applied)`);

  return { ...report, contributions, beacon, final, initZkeySha256: initSha, circuitHash: EXPECTED.circuitHash };
}

/** Verifies a single final zkey against its transcript (the setup in use today). */
export async function verifyFinalWithTranscript(zkey, transcriptPath, opts = {}) {
  const r1cs = opts.r1cs ?? DEFAULTS.r1cs;
  const ptau = opts.ptau ?? DEFAULTS.ptau;
  const report = makeReport();
  const t = JSON.parse(readFileSync(transcriptPath, "utf8"));
  console.log(`\n  Final key ${zkey} with ${transcriptPath}`);
  await checkInputs(report, r1cs, ptau, { r1csSha256: t.r1csSha256, ptauSha256: t.phase1.sha256 });
  if (t.r1csSha256 !== EXPECTED.r1csSha256 || t.phase1.sha256 !== EXPECTED.ptauSha256) report.warn("this transcript is for another r1cs or ptau than the ones in ceremony-lib.mjs");

  const ok = await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, zkey, collectingLogger());
  (ok ? report.ok : report.fail)("the zkey verifies against the r1cs and the ptau (snarkjs zkey verify)");
  const zsha = await sha256File(zkey);
  (zsha === t.finalZkeySha256 ? report.ok : report.fail)(`zkey sha256 ${short(zsha)} is the transcript's`);

  const mpc = await readContributions(zkey);
  if (mpc.circuitHash !== EXPECTED.circuitHash) report.fail("circuit hash is not the transaction circuit's");
  const list = mpc.contributions;
  const want = t.contributions ?? [];
  const steps = list.filter((c) => c.type === "contribution");
  const same = steps.length === want.length && steps.every((c, i) => c.hash === want[i].hash);
  (same ? report.ok : report.fail)(`${steps.length} contributions, hashes as in the transcript`);
  const last = list[list.length - 1];
  if (last?.type !== "beacon" || list.filter((c) => c.type === "beacon").length !== 1) report.fail("the last step is not the one beacon");
  else {
    (last.beaconHash === t.beacon?.hash && last.numIterationsExp === t.beacon?.iterationsExp ? report.ok : report.fail)(
      `beacon ${short(last.beaconHash)}, 2^${last.numIterationsExp} iterations, as in the transcript (${t.beacon?.source ?? "no source"})`,
    );
    const height = /Bitcoin block (\d+)/.exec(t.beacon?.source ?? "")?.[1];
    if (height && opts.checkBitcoin) {
      const h = await bitcoinBlockHash(Number(height));
      (h === last.beaconHash ? report.ok : report.fail)(`beacon hash is Bitcoin block ${height}'s hash`);
    }
    if (!t.beacon?.announcedHeight) {
      report.warn(`no beacon block was announced in advance: the beacon shows only that the key was finished after block ${height ?? "?"}, not that the last step was run once`);
    } else if (Number(height) !== t.beacon.announcedHeight) {
      report.fail(`the beacon came from block ${height ?? "?"}, but block ${t.beacon.announcedHeight} was announced`);
    }
  }
  const { vk, sha256 } = await exportVk(zkey);
  (sha256 === t.verificationKeySha256 ? report.ok : report.fail)(`exported verification key sha256 ${short(sha256)} is the transcript's`);
  compareVkFiles(report, vk, opts.vk ?? []);
  if (steps.length < 2) report.warn("fewer than two contributions");
  report.info(`contributions named in the zkey: ${steps.map((c) => c.name || "unnamed").join(", ")}`);
  return { ...report, contributions: steps, beacon: last, verificationKeySha256: sha256 };
}

async function main() {
  const vk = (arg("--vk", "") || "").split(",").filter(Boolean);
  const common = { r1cs: arg("--r1cs"), ptau: arg("--ptau"), vk, checkBitcoin: flag("--check-bitcoin") };
  let res;
  if (arg("--dir")) {
    res = await verifyCeremonyDir(arg("--dir"), {
      ...common,
      requireAttestations: flag("--require-attestations"),
      beaconHeight: arg("--beacon-height") ? Number(arg("--beacon-height")) : undefined,
      beaconHash: arg("--beacon-hash"),
    });
  } else if (arg("--final")) {
    res = await verifyFinalWithTranscript(arg("--final"), arg("--transcript", join(CIRCUITS, "artifacts", "TRANSCRIPT.json")), common);
  } else {
    console.log("  Give --dir <ceremony folder>, or --final <zkey> --transcript <TRANSCRIPT.json>.");
    process.exit(2);
  }
  console.log(res.problems.length ? `\n  ${res.problems.length} problem(s): the setup does NOT check out.\n` : "\n  Everything checks out.\n");
  process.exit(res.problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`  ${e.stack ?? e.message}`);
    process.exit(1);
  });
}
