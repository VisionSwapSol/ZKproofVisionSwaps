// Read-only checks for the program's Anchor IDL.
//   node program/scripts/check-idl.mjs [--idl vision_pool.json] [--authority <expected authority>]
//        [--rpc https://api.mainnet-beta.solana.com] [--program <id>]
//
// With --idl, first checks that the file describes this program: its address,
// every instruction of the program's source, and the instruction, account and
// event discriminators the SDK and the server use (sha256("<kind>:<Name>")[0..8]).
// Then reads the program's on-chain IDL account (the address Anchor derives)
// and prints whether it exists, who controls it and, with --idl, whether its
// content equals the file. With --authority (what a watcher passes once the
// account is claimed), the account must exist and be controlled by that key.
// Sends nothing and signs nothing.
// Exit code: 0 when every check passed, 1 otherwise. Without --idl or
// --authority, a missing account is reported but is not a failure.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_DIR } from "./releases.mjs";

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const RPC = arg("--rpc", "https://api.mainnet-beta.solana.com");
const PROGRAM = new PublicKey(arg("--program", "VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6"));
const IDL_FILE = arg("--idl", "");
const AUTHORITY = arg("--authority", "") ? new PublicKey(arg("--authority")).toBase58() : "";

let ok = true;
const bad = (m) => {
  ok = false;
  console.log(`  FAIL  ${m}`);
};
const good = (m) => console.log(`  ok    ${m}`);
const disc = (kind, name) => [...createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8)];
/** JSON with object keys sorted, so two IDLs compare by content whatever their key order */
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** Instruction handlers in the program's source: `pub fn name(ctx: Context<...>` */
export function sourceInstructions(libRs) {
  return [...libRs.matchAll(/pub fn (\w+)\(\s*ctx: Context</g)].map((m) => m[1]).sort();
}

/** The address Anchor's IdlCreateAccount uses: createWithSeed(PDA([]), "anchor:idl", program). */
export async function idlAddress(program) {
  const [base] = PublicKey.findProgramAddressSync([], program);
  return PublicKey.createWithSeed(base, "anchor:idl", program);
}

const ACCOUNTS = ["Config", "Nullifier", "Pending", "Tree", "Vault"];
const EVENTS = ["ConfigUpdated", "DepositQueued", "DepositRefunded", "DepositSettled", "Spent"];

export function checkIdlFile(idl, program, libRs) {
  const problems = [];
  if (idl.address !== program.toBase58()) problems.push(`address is ${idl.address}, not ${program.toBase58()}`);
  if (idl.metadata?.name !== "vision_pool") problems.push(`metadata.name is ${idl.metadata?.name}`);
  const want = sourceInstructions(libRs);
  const have = (idl.instructions ?? []).map((i) => i.name).sort();
  if (!same(want, have)) problems.push(`instructions are [${have}], the source has [${want}]`);
  for (const i of idl.instructions ?? []) {
    if (!same(i.discriminator, disc("global", i.name))) problems.push(`instruction ${i.name} has a non-standard discriminator`);
  }
  const accounts = (idl.accounts ?? []).map((a) => a.name).sort();
  if (!same(accounts, ACCOUNTS)) problems.push(`accounts are [${accounts}], expected [${ACCOUNTS}]`);
  for (const a of idl.accounts ?? []) if (!same(a.discriminator, disc("account", a.name))) problems.push(`account ${a.name} discriminator differs`);
  const events = (idl.events ?? []).map((e) => e.name).sort();
  if (!same(events, EVENTS)) problems.push(`events are [${events}], expected [${EVENTS}]`);
  for (const e of idl.events ?? []) if (!same(e.discriminator, disc("event", e.name))) problems.push(`event ${e.name} discriminator differs`);
  return problems;
}

/**
 * Checks the on-chain IDL account: `acc` is { owner, data } or null when it does not exist.
 * Anchor's layout is an 8-byte discriminator, the authority (32 bytes), a u32 length, then
 * the zlib-compressed IDL JSON. With `authority`, the account must exist and be controlled
 * by that key; with `idl`, it must exist and hold that IDL.
 * Returns { exists, authority, compressedLength, idlMatches, problems }.
 */
export function checkIdlAccount(acc, program, { authority = "", idl = null } = {}) {
  const problems = [];
  if (!acc) {
    if (authority || idl) problems.push("the IDL account does not exist yet");
    return { exists: false, authority: null, compressedLength: 0, idlMatches: false, problems };
  }
  if (acc.owner !== program.toBase58()) problems.push(`owned by ${acc.owner}, not the program`);
  if (acc.data.length < 44) {
    problems.push(`its data is ${acc.data.length} bytes, too short for an IDL account`);
    return { exists: true, authority: null, compressedLength: 0, idlMatches: false, problems };
  }
  const current = new PublicKey(acc.data.subarray(8, 40)).toBase58();
  const len = acc.data.readUInt32LE(40);
  if (authority && current !== authority) problems.push(`controlled by ${current}, not ${authority}`);
  let idlMatches = false;
  if (idl) {
    let onchain = null;
    try {
      if (44 + len > acc.data.length) throw new Error(`length ${len} runs past the account's data`);
      onchain = JSON.parse(inflateSync(acc.data.subarray(44, 44 + len)).toString("utf8"));
    } catch (e) {
      problems.push(`the on-chain IDL can't be read (${e.message})`);
    }
    if (onchain) {
      idlMatches = same(onchain, idl);
      if (!idlMatches) problems.push("the on-chain IDL differs from the file");
    }
  }
  return { exists: true, authority: current, compressedLength: len, idlMatches, problems };
}

async function rpc(method, params) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      continue;
    }
    const j = await res.json();
    if (j.error) throw new Error(JSON.stringify(j.error));
    return j.result;
  }
  throw new Error("the RPC keeps saying it is busy; try again or pass --rpc");
}

async function main() {
  let fileIdl = null;
  if (IDL_FILE) {
    console.log(`\n  IDL file ${IDL_FILE}`);
    fileIdl = JSON.parse(readFileSync(IDL_FILE, "utf8"));
    const libRs = readFileSync(join(PROGRAM_DIR, "programs", "vision_pool", "src", "lib.rs"), "utf8");
    const problems = checkIdlFile(fileIdl, PROGRAM, libRs);
    if (problems.length) problems.forEach(bad);
    else good("address, instructions, accounts and events match the program and the SDK's discriminators");
  }

  const address = await idlAddress(PROGRAM);
  console.log(`\n  On-chain IDL account ${address.toBase58()}`);
  const value = (await rpc("getAccountInfo", [address.toBase58(), { encoding: "base64", commitment: "confirmed" }])).value;
  const acc = value ? { owner: value.owner, data: Buffer.from(value.data[0], "base64") } : null;
  const res = checkIdlAccount(acc, PROGRAM, { authority: AUTHORITY, idl: fileIdl });
  if (!res.exists) console.log("  It does not exist yet.");
  else console.log(`  authority ${res.authority}   compressed IDL ${res.compressedLength} bytes`);
  res.problems.forEach(bad);
  if (res.exists && AUTHORITY && res.authority === AUTHORITY) good(`controlled by ${AUTHORITY}, as expected`);
  if (res.exists && fileIdl && res.idlMatches) good("the on-chain IDL equals the file");
  if (res.exists && !AUTHORITY) console.log("  note  pass --authority <key> to check who controls it");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(() => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((e) => {
      console.error(`  ${e.message}`);
      process.exitCode = 1;
    });
}
