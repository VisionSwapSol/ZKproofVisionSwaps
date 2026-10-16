// Records the build in program/build as a release candidate in program/RELEASES.json.
//   node program/scripts/record-release.mjs [--version 1.1.0] [--cluster mainnet-beta] [--notes "..."]
//
// Only a build that program/scripts/build.sh made from committed sources can be
// recorded: the program's files must have no uncommitted changes, and their
// fingerprint must equal the one build.sh recorded. Only a build listed here is
// uploaded to mainnet (program/BUILD.md, "Recording a release").
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAINNET, PROGRAM_DIR, addRelease, checkedBuild, readReleases, releaseEntry, sourceSha256, writeReleases } from "./releases.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const git = (...a) => execFileSync("git", ["-C", PROGRAM_DIR, ...a], { encoding: "utf8" }).trim();
const stop = (m) => {
  console.error(`\n  ${m}\n`);
  process.exit(1);
};

const built = checkedBuild(null);
if (built.error) stop(built.error);
const { info } = built;

const dirty = git("status", "--porcelain", "--", "Cargo.toml", "Cargo.lock", "toolchain.env", "programs");
if (dirty) stop(`The program's files have uncommitted changes, so no commit describes this build:\n${dirty}\n  Commit them, build again, then record.`);
const here = sourceSha256(PROGRAM_DIR);
if (here !== info.sourceSha256) {
  stop("The program's files differ from the ones this build was made from (build record sourceSha256). Build again from the committed files, then record.");
}

const crate = readFileSync(join(PROGRAM_DIR, "programs", "vision_pool", "Cargo.toml"), "utf8");
const version = arg("--version", /^version\s*=\s*"([^"]+)"/m.exec(crate)?.[1] ?? "0.0.0");
const commit = git("rev-parse", "HEAD");
const programTree = git("rev-parse", "HEAD:program/programs");
const entry = releaseEntry(info, { version, commit, programTree, cluster: arg("--cluster", MAINNET) });
entry.notes = arg("--notes", "");

let doc;
try {
  doc = addRelease(readReleases(), entry);
} catch (e) {
  stop(e.message);
}
writeReleases(doc);
console.log(`
  Recorded in program/RELEASES.json as a ${entry.cluster} candidate:
    version          ${entry.version}
    sha256           ${entry.sha256}
    executable hash  ${entry.executableHash}
    source commit    ${commit}
  Commit program/RELEASES.json. Once the program is upgraded to this build,
  the entry is marked "deployed" with the slot.
`);
