// Build records for vision_pool: what program/scripts/build.sh made, and which
// builds program/RELEASES.json lists. Plain Node with no dependencies; used by
// record-release.mjs, check-deployed.mjs and the release tools.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** program/ in this repository */
export const PROGRAM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MAINNET = "mainnet-beta";
/** statuses an upload may use: a recorded candidate, or the build already live */
const UPLOADABLE = new Set(["candidate", "deployed"]);

export function paths(dir = PROGRAM_DIR) {
  return {
    so: join(dir, "build", "vision_pool.so"),
    info: join(dir, "build", "vision_pool.build.json"),
    releases: join(dir, "RELEASES.json"),
  };
}

export const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** sha256 of the code without its trailing zero bytes: what `solana-verify get-executable-hash` prints. */
export function executableHash(b) {
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return sha256(b.subarray(0, end));
}

/**
 * The same fingerprint of the program's sources that build.sh records as
 * sourceSha256: `sha256sum` of every file under Cargo.toml, Cargo.lock and
 * programs/, sorted by path, hashed again.
 */
export function sourceSha256(dir = PROGRAM_DIR) {
  const files = [];
  const walk = (rel) => {
    const abs = join(dir, rel);
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs)) walk(`${rel}/${name}`);
    } else files.push(rel);
  };
  for (const top of ["Cargo.toml", "Cargo.lock", "programs"]) if (existsSync(join(dir, top))) walk(top);
  // LC_ALL=C sort: plain byte order
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const lines = files.map((f) => `${sha256(readFileSync(join(dir, f)))}  ${f}\n`).join("");
  return sha256(Buffer.from(lines));
}

/**
 * The build in program/build, accepted only together with the record build.sh
 * wrote next to it (same bytes, same program id). Returns { so, sha256, info }
 * or { error } with a sentence saying what to do.
 */
export function checkedBuild(programId, dir = PROGRAM_DIR) {
  const p = paths(dir);
  if (!existsSync(p.so)) return { error: "There's no build in program\\build yet. Build it with program/scripts/build.sh." };
  if (!existsSync(p.info)) {
    return { error: "program\\build\\vision_pool.so has no build record next to it, so program/scripts/build.sh didn't make it. Build it again." };
  }
  let info;
  try {
    info = JSON.parse(readFileSync(p.info, "utf8"));
  } catch {
    return { error: "The build record program\\build\\vision_pool.build.json can't be read. Build it again." };
  }
  const so = readFileSync(p.so);
  const hash = sha256(so);
  if (info.sha256 !== hash) {
    return { error: "program\\build\\vision_pool.so isn't the file program/scripts/build.sh made (its sha256 differs from the build record). Build it again." };
  }
  if (programId && info.programId !== programId) {
    return { error: `That build was made for ${info.programId}, not ${programId}, so it can't be used here.` };
  }
  return { so, sha256: hash, info };
}

export function readReleases(dir = PROGRAM_DIR) {
  const file = paths(dir).releases;
  if (!existsSync(file)) return { releases: [] };
  const doc = JSON.parse(readFileSync(file, "utf8"));
  if (!doc || !Array.isArray(doc.releases)) throw new Error("program/RELEASES.json has no releases list");
  return doc;
}

export function writeReleases(doc, dir = PROGRAM_DIR) {
  writeFileSync(paths(dir).releases, JSON.stringify(doc, null, 2) + "\n");
}

/** The release entry an upload of this build may use, if any. */
export function findRelease(doc, hash, programId, cluster = MAINNET) {
  return doc.releases.find((r) => r.sha256 === hash && r.programId === programId && r.cluster === cluster && UPLOADABLE.has(r.status));
}

/** A new candidate entry for a build, from its build record and the commit its sources are at. */
export function releaseEntry(info, { version, commit, programTree, cluster = MAINNET }) {
  return {
    version,
    status: "candidate",
    cluster,
    programId: info.programId,
    sha256: info.sha256,
    executableHash: info.executableHash,
    size: info.size,
    sbpfArch: info.sbpfArch,
    source: { commit, programTree, cargoLockSha256: info.cargoLockSha256, sourceSha256: info.sourceSha256 },
    toolchain: info.toolchain,
    stackOffsetDiagnostics: info.stackOffsetDiagnostics,
    deployedSlot: null,
    deployedAt: null,
    reproduced: null,
    verifiedBuild: null,
    audited: false,
    notes: "",
  };
}

/** Adds an entry; a build already listed (same sha256, program and cluster) is refused. */
export function addRelease(doc, entry) {
  if (doc.releases.some((r) => r.sha256 === entry.sha256 && r.programId === entry.programId && r.cluster === entry.cluster)) {
    throw new Error(`a build with sha256 ${entry.sha256.slice(0, 16)}… is already listed`);
  }
  return { ...doc, releases: [...doc.releases, entry] };
}

/**
 * After an upgrade: this build becomes "deployed" with its slot and time, and
 * the build that was deployed before it becomes "superseded".
 */
export function markDeployed(doc, hash, programId, { slot, at, cluster = MAINNET }) {
  let found = false;
  const releases = doc.releases.map((r) => {
    if (r.programId !== programId || r.cluster !== cluster) return r;
    if (r.sha256 === hash) {
      found = true;
      return { ...r, status: "deployed", deployedSlot: slot, deployedAt: at };
    }
    return r.status === "deployed" ? { ...r, status: "superseded" } : r;
  });
  if (!found) throw new Error(`no release with sha256 ${hash.slice(0, 16)}… to mark as deployed`);
  return { ...doc, releases };
}
