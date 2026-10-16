// node --test program/scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAINNET,
  PROGRAM_DIR,
  addRelease,
  checkedBuild,
  executableHash,
  findRelease,
  markDeployed,
  readReleases,
  releaseEntry,
  sourceSha256,
} from "./releases.mjs";

const ID = "VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6";
const sha = (b) => createHash("sha256").update(b).digest("hex");

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "vs-releases-"));
  mkdirSync(join(dir, "build"));
  return dir;
}

test("a build is accepted only with the record build.sh wrote for it", (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.match(checkedBuild(ID, dir).error, /no build/);

  const so = Buffer.from("\x7fELF pretend program\0\0\0");
  writeFileSync(join(dir, "build", "vision_pool.so"), so);
  assert.match(checkedBuild(ID, dir).error, /no build record/);

  const info = { programId: ID, sha256: sha(so) };
  writeFileSync(join(dir, "build", "vision_pool.build.json"), JSON.stringify(info));
  const ok = checkedBuild(ID, dir);
  assert.equal(ok.error, undefined);
  assert.equal(ok.sha256, sha(so));
  assert.match(checkedBuild("11111111111111111111111111111111", dir).error, /made for/);

  // a different file dropped in after the build
  writeFileSync(join(dir, "build", "vision_pool.so"), Buffer.concat([so, Buffer.from([1])]));
  assert.match(checkedBuild(ID, dir).error, /isn't the file/);

  writeFileSync(join(dir, "build", "vision_pool.build.json"), "{ not json");
  assert.match(checkedBuild(ID, dir).error, /can't be read/);
});

test("the executable hash drops trailing zero bytes only", () => {
  const code = Buffer.from([1, 0, 2, 3]);
  assert.equal(executableHash(Buffer.concat([code, Buffer.alloc(9)])), sha(code));
  assert.equal(executableHash(code), sha(code));
  assert.equal(executableHash(Buffer.alloc(4)), sha(Buffer.alloc(0)));
});

test("the source fingerprint is sha256sum over Cargo.toml, Cargo.lock and programs/, in byte order", (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "programs", "p", "src"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  const files = {
    "Cargo.toml": "[workspace]\n",
    "Cargo.lock": "version = 4\n",
    "programs/p/Cargo.toml": "[package]\n",
    "programs/p/src/lib.rs": "pub fn a() {}\r\n",
    "programs/p/src/Z.rs": "// capital Z sorts before lower case\n",
  };
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  writeFileSync(join(dir, "scripts", "build.sh"), "not part of the fingerprint\n");
  const order = ["Cargo.lock", "Cargo.toml", "programs/p/Cargo.toml", "programs/p/src/Z.rs", "programs/p/src/lib.rs"];
  const expected = sha(order.map((f) => `${sha(files[f])}  ${f}\n`).join(""));
  assert.equal(sourceSha256(dir), expected);
});

test("release entries: only listed candidates or the deployed build may be uploaded, and deploying supersedes", () => {
  const info = {
    programId: ID,
    sha256: "aa".repeat(32),
    executableHash: "bb".repeat(32),
    size: 10,
    sbpfArch: "v0",
    cargoLockSha256: "cc".repeat(32),
    sourceSha256: "dd".repeat(32),
    toolchain: { cargoBuildSbf: "3.1.13", platformTools: "v1.52", rustc: "1.89.0-dev" },
    stackOffsetDiagnostics: { total: 0, linked: 0 },
  };
  const old = { ...releaseEntry({ ...info, sha256: "11".repeat(32) }, { version: "1.0.0", commit: "c0", programTree: "t0" }), status: "deployed" };
  let doc = { releases: [old] };
  const next = releaseEntry(info, { version: "1.1.0", commit: "c1", programTree: "t1" });
  assert.equal(next.status, "candidate");
  assert.equal(next.cluster, MAINNET);
  doc = addRelease(doc, next);
  assert.throws(() => addRelease(doc, next), /already listed/);

  assert.ok(findRelease(doc, info.sha256, ID));
  assert.equal(findRelease(doc, info.sha256, ID, "devnet"), undefined);
  assert.equal(findRelease(doc, info.sha256, "11111111111111111111111111111111"), undefined);
  assert.equal(findRelease(doc, "ee".repeat(32), ID), undefined);
  const withdrawn = { releases: doc.releases.map((r) => (r.sha256 === info.sha256 ? { ...r, status: "withdrawn" } : r)) };
  assert.equal(findRelease(withdrawn, info.sha256, ID), undefined, "a withdrawn entry can't be uploaded");

  const after = markDeployed(doc, info.sha256, ID, { slot: 123, at: "2026-11-01T00:00:00Z" });
  const byHash = Object.fromEntries(after.releases.map((r) => [r.sha256, r]));
  assert.equal(byHash[info.sha256].status, "deployed");
  assert.equal(byHash[info.sha256].deployedSlot, 123);
  assert.equal(byHash["11".repeat(32)].status, "superseded");
  assert.throws(() => markDeployed(doc, "ee".repeat(32), ID, { slot: 1, at: "x" }), /no release/);
});

test("RELEASES.json records the deployed mainnet build, and toolchain.env pins its toolchain", () => {
  const doc = readReleases(PROGRAM_DIR);
  const live = doc.releases.filter((r) => r.status === "deployed" && r.cluster === MAINNET && r.programId === ID);
  assert.equal(live.length, 1);
  const r = live[0];
  assert.equal(r.sha256, "2e6fb1f233a13436781ac43aa2ab10e283ab80b64b93389a19948d766b3739f4");
  assert.equal(r.executableHash, "7edb58080a4d73584cb70d0a46e041765a0052ce81fed3885fd7935006fd177d");
  assert.equal(r.deployedSlot, 453075865);
  assert.equal(r.source.cargoLockSha256, sha(readFileSync(join(PROGRAM_DIR, "Cargo.lock"))), "program/Cargo.lock is the deployed build's lock");

  const env = Object.fromEntries(
    readFileSync(join(PROGRAM_DIR, "toolchain.env"), "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split("=", 2)),
  );
  const newest = doc.releases[doc.releases.length - 1];
  assert.equal(env.SOLANA_CLI_VERSION, newest.toolchain.cargoBuildSbf);
  assert.equal(env.PLATFORM_TOOLS_VERSION, newest.toolchain.platformTools);
  assert.equal(env.SBPF_ARCH, newest.sbpfArch);
  for (const e of doc.releases) {
    assert.match(e.sha256, /^[0-9a-f]{64}$/);
    assert.match(e.executableHash, /^[0-9a-f]{64}$/);
    assert.ok(["candidate", "deployed", "superseded", "withdrawn"].includes(e.status), e.status);
  }
});
