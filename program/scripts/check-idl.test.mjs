// node --test program/scripts/check-idl.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Keypair, PublicKey } from "@solana/web3.js";
import { checkIdlAccount, checkIdlFile, idlAddress, sourceInstructions } from "./check-idl.mjs";
import { PROGRAM_DIR } from "./releases.mjs";

const ID = new PublicKey("VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6");
const libRs = readFileSync(join(PROGRAM_DIR, "programs", "vision_pool", "src", "lib.rs"), "utf8");
const disc = (kind, name) => [...createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8)];

const goodIdl = () => ({
  address: ID.toBase58(),
  metadata: { name: "vision_pool", version: "1.0.0", spec: "0.1.0" },
  instructions: sourceInstructions(libRs).map((name) => ({ name, discriminator: disc("global", name), accounts: [], args: [] })),
  accounts: ["Config", "Nullifier", "Pending", "Tree", "Vault"].map((name) => ({ name, discriminator: disc("account", name) })),
  events: ["ConfigUpdated", "DepositQueued", "DepositRefunded", "DepositSettled", "Spent"].map((name) => ({ name, discriminator: disc("event", name) })),
});

test("the program's instructions are read from its source", () => {
  assert.deepEqual(sourceInstructions(libRs), ["accept_admin", "deposit", "initialize", "refund", "settle", "transact", "transfer_admin", "update_config"]);
});

test("the IDL account address is the one Anchor derives (EA2s…HgQb for the mainnet program)", async () => {
  assert.equal((await idlAddress(ID)).toBase58(), "EA2sKm6mJp6komCxqvbYpMY1rhcEomHcsQSenrL8HgQb");
});

test("an IDL file is checked against the program and the SDK's discriminators", () => {
  assert.deepEqual(checkIdlFile(goodIdl(), ID, libRs), []);

  const wrongAddress = { ...goodIdl(), address: "11111111111111111111111111111111" };
  assert.match(checkIdlFile(wrongAddress, ID, libRs).join("\n"), /address is/);

  const missing = goodIdl();
  missing.instructions = missing.instructions.filter((i) => i.name !== "refund");
  assert.match(checkIdlFile(missing, ID, libRs).join("\n"), /instructions are/);

  const forged = goodIdl();
  forged.instructions[0].discriminator = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.match(checkIdlFile(forged, ID, libRs).join("\n"), /non-standard discriminator/);

  const badEvent = goodIdl();
  badEvent.events[4].discriminator = disc("event", "Other");
  assert.match(checkIdlFile(badEvent, ID, libRs).join("\n"), /event Spent/);
});

test("the on-chain IDL account: who controls it and what it holds", () => {
  const owner = Keypair.generate().publicKey;
  const account = (authority, idl, programOwner = ID.toBase58()) => {
    const body = deflateSync(Buffer.from(JSON.stringify(idl)));
    const len = Buffer.alloc(4);
    len.writeUInt32LE(body.length);
    return { owner: programOwner, data: Buffer.concat([Buffer.alloc(8, 7), authority.toBuffer(), len, body, Buffer.alloc(16)]) };
  };

  // not created yet: reported, and a failure only when something was expected
  assert.deepEqual(checkIdlAccount(null, ID).problems, []);
  assert.match(checkIdlAccount(null, ID, { authority: owner.toBase58() }).problems.join("\n"), /does not exist/);
  assert.match(checkIdlAccount(null, ID, { idl: goodIdl() }).problems.join("\n"), /does not exist/);

  const ours = checkIdlAccount(account(owner, goodIdl()), ID, { authority: owner.toBase58(), idl: goodIdl() });
  assert.deepEqual(ours.problems, []);
  assert.equal(ours.authority, owner.toBase58());
  assert.equal(ours.idlMatches, true);

  // someone else claimed it first: the watcher's check fails
  const squatter = Keypair.generate().publicKey;
  assert.match(checkIdlAccount(account(squatter, goodIdl()), ID, { authority: owner.toBase58() }).problems.join("\n"), /controlled by/);
  assert.equal(checkIdlAccount(account(squatter, goodIdl()), ID).authority, squatter.toBase58());

  const other = { ...goodIdl(), instructions: [] };
  assert.match(checkIdlAccount(account(owner, other), ID, { idl: goodIdl() }).problems.join("\n"), /differs from the file/);
  assert.match(checkIdlAccount(account(owner, goodIdl(), squatter.toBase58()), ID).problems.join("\n"), /owned by/);
  assert.match(checkIdlAccount({ owner: ID.toBase58(), data: Buffer.alloc(20) }, ID, { authority: owner.toBase58() }).problems.join("\n"), /too short/);
  const cut = account(owner, goodIdl());
  cut.data = cut.data.subarray(0, 60);
  assert.match(checkIdlAccount(cut, ID, { idl: goodIdl() }).problems.join("\n"), /can't be read/);
});
