// A full rehearsal of the ceremony tooling on throwaway files.
//   node scripts/ceremony-selftest.mjs [--keep] [--check-bitcoin]
// Runs init, two contributions (the first fully verified), a stale contribution that must be
// refused, the beacon, the full verification, and tampered copies that must fail. Everything is
// written to a new temporary folder (removed at the end unless --keep); circuits/artifacts is
// only read. Takes about ten minutes, most of it snarkjs verifying keys.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CIRCUITS } from "./ceremony-lib.mjs";

const keep = process.argv.includes("--keep");
const checkBitcoin = process.argv.includes("--check-bitcoin");
const root = mkdtempSync(join(tmpdir(), "vs-ceremony-"));
const dir = join(root, "ceremony");
const scripts = join(CIRCUITS, "scripts");
// block 969748 is the beacon of the setup in use; any past block will do for a rehearsal
const BEACON_HEIGHT = 969748;
const BEACON_HASH = "00000000000000000000045a37b23193fe70e237ddddf4b28c761d75534f909b";

let failures = 0;
/** Runs one step; a step expected to fail must also say why (`because`, a phrase of its output). */
function run(label, script, args, expectOk = true, because = "") {
  const t = Date.now();
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", cwd: CIRCUITS });
  const ok = r.status === 0;
  const pass = ok === expectOk && (r.stdout + r.stderr).includes(because);
  if (!pass) failures++;
  console.log(`${pass ? "  pass" : "  FAIL"}  ${label} (${((Date.now() - t) / 1000).toFixed(0)} s, exit ${r.status})`);
  if (!pass || process.env.VERBOSE) console.log((r.stdout + r.stderr).replace(/^/gm, "        "));
  return r.stdout + r.stderr;
}

console.log(`  rehearsal folder ${root}`);
try {
  run("coordinator init", "coordinator.mjs", ["init", "--dir", dir]);
  run("coordinator init again is refused", "coordinator.mjs", ["init", "--dir", dir], false, "already has tx_0000.zkey");

  const c1 = join(root, "alice");
  mkdirSync(c1);
  copyFileSync(join(dir, "tx_0000.zkey"), join(c1, "tx_0000.zkey"));
  run("contributor 1 (verifies before and after)", "contribute.mjs", ["--in", join(c1, "tx_0000.zkey"), "--out", join(c1, "tx_0001.zkey"), "--name", "Rehearsal Alice"]);
  run("coordinator accepts #1", "coordinator.mjs", ["accept", "--dir", dir, "--zkey", join(c1, "tx_0001.zkey"), "--attestation", join(c1, "tx_0001.attestation.json")]);

  const c2 = join(root, "bob");
  mkdirSync(c2);
  copyFileSync(join(dir, "tx_0001.zkey"), join(c2, "tx_0001.zkey"));
  run("contributor 2", "contribute.mjs", ["--in", join(c2, "tx_0001.zkey"), "--out", join(c2, "tx_0002.zkey"), "--name", "Rehearsal Bob", "--skip-verify"]);

  const c3 = join(root, "carol");
  mkdirSync(c3);
  copyFileSync(join(dir, "tx_0001.zkey"), join(c3, "tx_0001.zkey"));
  run("contributor 3 also starts from #1", "contribute.mjs", ["--in", join(c3, "tx_0001.zkey"), "--out", join(c3, "tx_0002.zkey"), "--name", "Rehearsal Carol", "--skip-verify"]);

  run("coordinator accepts #2 (Bob)", "coordinator.mjs", ["accept", "--dir", dir, "--zkey", join(c2, "tx_0002.zkey"), "--attestation", join(c2, "tx_0002.attestation.json")]);
  run("Carol's key, made from #1, is refused", "coordinator.mjs", ["accept", "--dir", dir, "--zkey", join(c3, "tx_0002.zkey")], false, "is not tx_0002.zkey plus one contribution");
  run("finalize before any announcement is refused", "coordinator.mjs", ["finalize", "--dir", dir, "--beacon-hash", BEACON_HASH], false, "No beacon block was announced");
  if (checkBitcoin) {
    run("announcing a block that already exists is refused", "coordinator.mjs", ["announce", "--dir", dir, "--height", String(BEACON_HEIGHT)], false, "already exists");
  }
  // the rehearsal reuses a past block on purpose; a real ceremony announces a future one
  run("announce the beacon block", "coordinator.mjs", ["announce", "--dir", dir, "--height", String(BEACON_HEIGHT), "--allow-mined"]);
  run("announcing again is refused", "coordinator.mjs", ["announce", "--dir", dir, "--height", String(BEACON_HEIGHT + 1)], false, "it cannot change");
  run("finalize with the beacon", "coordinator.mjs", ["finalize", "--dir", dir, "--beacon-hash", BEACON_HASH]);
  run("accepting after the beacon is refused", "coordinator.mjs", ["accept", "--dir", dir, "--zkey", join(c3, "tx_0002.zkey")], false, "the ceremony is closed");

  const verifyArgs = ["--dir", dir, "--require-attestations", ...(checkBitcoin ? ["--check-bitcoin"] : [])];
  run("verify-ceremony on the folder", "verify-ceremony.mjs", verifyArgs);
  run("verify-ceremony on the final key and its transcript", "verify-ceremony.mjs", ["--final", join(dir, "tx_final.zkey"), "--transcript", join(dir, "TRANSCRIPT.json")]);

  // tampered copies
  const bad1 = join(root, "bad-attestation");
  cpSync(dir, bad1, { recursive: true });
  const att = JSON.parse(readFileSync(join(bad1, "tx_0002.attestation.json"), "utf8"));
  att.contributionHash = "00" + att.contributionHash.slice(2);
  writeFileSync(join(bad1, "tx_0002.attestation.json"), JSON.stringify(att));
  run("a wrong attestation fails", "verify-ceremony.mjs", ["--dir", bad1], false, "FAIL  tx_0002.zkey: attestation");

  const bad2 = join(root, "bad-beacon");
  cpSync(dir, bad2, { recursive: true });
  const m = JSON.parse(readFileSync(join(bad2, "manifest.json"), "utf8"));
  m.beacon.hash = "11" + m.beacon.hash.slice(2);
  writeFileSync(join(bad2, "manifest.json"), JSON.stringify(m));
  run("a beacon other than the recorded one fails", "verify-ceremony.mjs", ["--dir", bad2], false, "FAIL  beacon hash is");

  const bad3 = join(root, "bad-swap");
  cpSync(dir, bad3, { recursive: true });
  copyFileSync(join(c3, "tx_0002.zkey"), join(bad3, "tx_0002.zkey"));
  run("a swapped-in key (Carol's) fails", "verify-ceremony.mjs", ["--dir", bad3], false, "FAIL  tx_final.zkey is not the last numbered key plus one step");

  const bad4 = join(root, "bad-gap");
  cpSync(dir, bad4, { recursive: true });
  rmSync(join(bad4, "tx_0001.zkey"));
  run("a missing key fails", "verify-ceremony.mjs", ["--dir", bad4], false, "the chain has a gap");
} finally {
  if (!keep) rmSync(root, { recursive: true, force: true });
}
console.log(failures ? `\n  ${failures} step(s) did not behave as expected.\n` : "\n  The rehearsal behaved as expected.\n");
process.exit(failures ? 1 : 0);
