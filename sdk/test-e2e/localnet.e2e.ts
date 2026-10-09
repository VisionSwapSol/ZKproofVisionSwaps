// End-to-end tests against a local validator running the real program.
//   1. start it:  wsl bash ~/vs/localnet.sh
//   2. run:       node --import tsx --test sdk/test-e2e/localnet.e2e.ts
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  Pool,
  attestationMessage,
  computeBudget,
  fetchConfig,
  fetchTree,
  fetchPending,
  scanPoolHistory,
  leavesFromEvents,
  spentSet,
  scanNotes,
  selectInputs,
  keysFromSignature,
  noteInner,
  encodeMeta,
  randomNonce,
  MerkleTree,
  splitWithdraw,
  depositFee,
  FIELD,
  TRANSACT_CU,
  type ConfigParams,
} from "../src/index.ts";
import { proveSpend, type SpendProof } from "../src/prover.ts";

const here = dirname(fileURLToPath(import.meta.url));
const art = join(here, "..", "..", "circuits", "artifacts");
const wasm = join(art, "transaction.wasm");
const zkey = join(art, "transaction.zkey");
const KEYS = process.env.VS_KEYS ?? "keys";
const kp = (n: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(KEYS, `${n}.json`), "utf8"))));

const conn = new Connection(process.env.VS_RPC ?? "http://127.0.0.1:8899", "confirmed");
const admin = kp("dev-admin");
const guard = kp("dev-guard");
const relayer = kp("dev-relayer");
const treasury = kp("dev-treasury");
const user = kp("dev-user");
const user2 = kp("dev-user2");
const user3 = Keypair.generate();
const pool = new Pool(kp("dev-program").publicKey);
const SOL = BigInt(LAMPORTS_PER_SOL);
const DELAY = 3n;

const userKeys = keysFromSignature(ed25519.sign(new TextEncoder().encode("test account"), user.secretKey.slice(0, 32)));
const user2Keys = keysFromSignature(ed25519.sign(new TextEncoder().encode("test account"), user2.secretKey.slice(0, 32)));
const user3Keys = keysFromSignature(ed25519.sign(new TextEncoder().encode("test account"), user3.secretKey.slice(0, 32)));

const params = (o: Partial<ConfigParams> = {}): ConfigParams => ({
  guard: guard.publicKey,
  treasury: treasury.publicKey,
  feeBps: 80,
  minDeposit: SOL / 100n,
  maxDeposit: 100n * SOL,
  tvlCap: 1000n * SOL,
  depositDelay: DELAY,
  requireAttestation: true,
  depositsPaused: false,
  ...o,
});

async function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  try {
    return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  } catch (e) {
    const logs = (e as { logs?: string[]; transactionLogs?: string[] }).logs ?? (e as { transactionLogs?: string[] }).transactionLogs;
    const msg = (e as Error).message + (logs ? "\n" + logs.join("\n") : "");
    throw new Error(msg);
  }
}

async function expectFail(p: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(p, (e: Error) => {
    assert.match(e.message, pattern);
    return true;
  });
}

async function airdrop(to: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function attest(depositor: PublicKey, signer = guard, ttl = 150n) {
  const expiry = BigInt(await conn.getSlot("confirmed")) + ttl;
  const sig = ed25519.sign(attestationMessage(depositor, expiry), signer.secretKey.slice(0, 32));
  return { ix: pool.attestationInstruction(signer.publicKey, sig, depositor, expiry), expiry };
}

async function deposit(who: Keypair, keys: typeof userKeys, amount: bigint, maxFeeBps = 80) {
  const nonce = randomNonce();
  const inner = noteInner(keys, nonce);
  const a = await attest(who.publicKey);
  await send(
    [
      a.ix,
      pool.deposit({ depositor: who.publicKey, amount, inner, meta: encodeMeta(keys, nonce, amount), attestationExpiry: a.expiry, maxFeeBps }),
    ],
    [who],
  );
  return { inner, nonce };
}

async function waitSlots(n: bigint) {
  const start = BigInt(await conn.getSlot("confirmed"));
  while (BigInt(await conn.getSlot("confirmed")) < start + n) await new Promise((r) => setTimeout(r, 200));
}

/** Settles whatever is still waiting; a running server crank may have beaten us to some. */
async function settleAll() {
  const pend = await fetchPending(conn, pool);
  for (const p of pend) {
    await send([pool.settle(p.address, p.depositor, treasury.publicKey)], [relayer]).catch((e: Error) => {
      if (!/AccountNotInitialized|3012|0xbc4/i.test(e.message)) throw e;
    });
  }
  for (let i = 0; i < 40 && (await fetchPending(conn, pool)).length; i++) await new Promise((r) => setTimeout(r, 250));
}

async function syncTree() {
  const hist = await scanPoolHistory(conn, pool);
  const events = hist.flatMap((h) => h.events);
  const leaves = leavesFromEvents(events);
  const tree = new MerkleTree(leaves.map((l) => l.leaf));
  return { events, leaves, tree, spent: spentSet(events) };
}

async function relay(sp: SpendProof, signer = relayer) {
  return send([...computeBudget(TRANSACT_CU, 0), pool.transact(sp, treasury.publicKey)], [signer]);
}

const bal = async (k: PublicKey) => BigInt(await conn.getBalance(k, "confirmed"));

test("setup: fund test wallets", async () => {
  await Promise.all([
    airdrop(admin.publicKey, 20),
    airdrop(guard.publicKey, 2),
    airdrop(relayer.publicKey, 10),
    airdrop(user.publicKey, 50),
    airdrop(user2.publicKey, 20),
    airdrop(user3.publicKey, 5),
    airdrop(treasury.publicKey, 1),
  ]);
});

test("only the upgrade authority can initialize", async () => {
  await expectFail(send([pool.initialize(user.publicKey, params())], [user]), /NotUpgradeAuthority|0x1783|6019/);
  await send([pool.initialize(admin.publicKey, params())], [admin]);
  const c = await fetchConfig(conn, pool);
  assert.equal(c.feeBps, 80);
  assert.equal(c.admin.toBase58(), admin.publicKey.toBase58());
  const t = await fetchTree(conn, pool);
  assert.equal(t.nextIndex, 0);
  assert.equal(t.currentRoot, new MerkleTree().root(), "empty root matches the client");
});

test("deposits need a fresh attestation from the guard", async () => {
  const nonce = randomNonce();
  const inner = noteInner(userKeys, nonce);
  const meta = encodeMeta(userKeys, nonce, SOL);
  await expectFail(
    send([pool.deposit({ depositor: user.publicKey, amount: SOL, inner, meta, attestationExpiry: 10n ** 9n, maxFeeBps: 80 })], [user]),
    /MissingAttestation/,
  );
  const wrong = await attest(user.publicKey, user2);
  await expectFail(
    send([wrong.ix, pool.deposit({ depositor: user.publicKey, amount: SOL, inner, meta, attestationExpiry: wrong.expiry, maxFeeBps: 80 })], [user]),
    /BadAttestation/,
  );
  // attestation for someone else
  const other = await attest(user2.publicKey);
  await expectFail(
    send([other.ix, pool.deposit({ depositor: user.publicKey, amount: SOL, inner, meta, attestationExpiry: other.expiry, maxFeeBps: 80 })], [user]),
    /BadAttestation/,
  );
  const slot = BigInt(await conn.getSlot("confirmed"));
  const expiredSig = ed25519.sign(attestationMessage(user.publicKey, slot - 1n), guard.secretKey.slice(0, 32));
  await expectFail(
    send(
      [
        pool.attestationInstruction(guard.publicKey, expiredSig, user.publicKey, slot - 1n),
        pool.deposit({ depositor: user.publicKey, amount: SOL, inner, meta, attestationExpiry: slot - 1n, maxFeeBps: 80 }),
      ],
      [user],
    ),
    /AttestationExpired/,
  );
  await expectFail(
    (async () => {
      const a = await attest(user.publicKey);
      await send([a.ix, pool.deposit({ depositor: user.publicKey, amount: SOL / 1000n, inner, meta, attestationExpiry: a.expiry, maxFeeBps: 80 })], [user]);
    })(),
    /AmountOutOfRange/,
  );
});

test("waiting room: settle waits, refunds go only to the depositor", async () => {
  await deposit(user, userKeys, 2n * SOL);
  await deposit(user, userKeys, SOL / 2n);
  await deposit(user2, user2Keys, SOL);
  const pend = await fetchPending(conn, pool);
  assert.equal(pend.length, 3);
  await expectFail(send([pool.settle(pend[0].address, pend[0].depositor, treasury.publicKey)], [relayer]), /StillWaiting/);

  // a deposit its owner takes back
  const mine = await deposit(user2, user2Keys, SOL / 5n);
  const p1 = pool.pending(mine.inner);
  await expectFail(send([pool.refund(user.publicKey, p1, user2.publicKey)], [user]), /NotAllowed/);
  const before = await bal(user2.publicKey);
  await send([pool.refund(user2.publicKey, p1, user2.publicKey)], [user2]);
  const after = await bal(user2.publicKey);
  assert.ok(after >= before + SOL / 5n + depositFee(SOL / 5n, 80), "depositor got the deposit, its fee and the rent back");

  // a deposit the guard sends back
  const flagged = await deposit(user2, user2Keys, SOL / 4n);
  const before2 = await bal(user2.publicKey);
  await send([pool.refund(guard.publicKey, pool.pending(flagged.inner), user2.publicKey)], [guard]);
  assert.ok((await bal(user2.publicKey)) >= before2 + SOL / 4n, "guard refund lands with the depositor");

  await waitSlots(DELAY + 1n);
  await settleAll();
  const t = await fetchTree(conn, pool);
  assert.equal(t.nextIndex, 3);
  assert.equal(t.pendingLamports, 0n);
  const { tree } = await syncTree();
  assert.equal(tree.root(), t.currentRoot, "client tree matches the chain");
});

test("the deposit fee is paid on top, waits with the deposit, and reaches the treasury at settlement", async () => {
  await expectFail(deposit(user3, user3Keys, SOL / 10n, 50), /FeeAboveLimit/);
  const fee = depositFee(SOL / 10n, 80);
  const u0 = await bal(user3.publicKey);
  const d = await deposit(user3, user3Keys, SOL / 10n);
  const pa = await conn.getAccountInfo(pool.pending(d.inner), "confirmed");
  const rent = BigInt(await conn.getMinimumBalanceForRentExemption(pa!.data.length));
  assert.equal(BigInt(pa!.lamports), rent + fee, "the fee waits in the pending account");
  assert.ok(u0 - (await bal(user3.publicKey)) >= SOL / 10n + fee + rent, "the fee is paid on top of the deposit");
  await waitSlots(DELAY + 1n);
  const t0 = await bal(treasury.publicKey);
  const before = await bal(user3.publicKey);
  await expectFail(send([pool.settle(pool.pending(d.inner), user3.publicKey, user2.publicKey)], [relayer]), /NotAllowed|0x1775|6005/);
  await send([pool.settle(pool.pending(d.inner), user3.publicKey, treasury.publicKey)], [relayer]);
  assert.equal((await bal(treasury.publicKey)) - t0, fee, "the treasury gets exactly the fee");
  assert.equal((await bal(user3.publicKey)) - before, rent, "the depositor gets the rent back");
  const { leaves, spent } = await syncTree();
  assert.equal(scanNotes(user3Keys, leaves, spent).total, SOL / 10n, "the note is worth the full deposit");
});

let changeNote = 0n;

test("a private withdrawal pays recipient, relayer and treasury exactly", async () => {
  const { leaves, tree, spent } = await syncTree();
  const mine = scanNotes(userKeys, leaves, spent);
  assert.equal(mine.total, 2n * SOL + SOL / 2n);
  assert.equal(scanNotes(user2Keys, leaves, spent).total, SOL);

  const recipient = Keypair.generate().publicKey;
  const withdraw = (3n * SOL) / 4n;
  const relayerFee = 2_000_000n;
  const input = selectInputs(mine.notes, withdraw)!;
  assert.equal(input.length, 1);
  const sp = await proveSpend({
    keys: userKeys,
    tree,
    inputs: input,
    outputs: [
      { amount: input[0].amount - withdraw, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient, relayer: relayer.publicKey, withdraw, relayerFee, maxFeeBps: 80 },
    wasm,
    zkey,
  });
  changeNote = input[0].amount - withdraw;

  // tampering is caught by the proof
  await expectFail(relay({ ...sp, ext: { ...sp.ext, recipient: Keypair.generate().publicKey } }), /InvalidProof/);
  await expectFail(relay({ ...sp, ext: { ...sp.ext, relayerFee: relayerFee + 1n } }), /InvalidProof/);
  await expectFail(relay({ ...sp, root: 12345n }), /UnknownRoot/);
  await expectFail(relay({ ...sp, nullifiers: [sp.nullifiers[0] + FIELD, sp.nullifiers[1]] }), /NotInField|out of range|0x/);

  const t0 = await bal(treasury.publicKey);
  const r0 = await bal(relayer.publicKey);
  const sig = await relay(sp);
  const split = splitWithdraw(withdraw, relayerFee, 80);
  assert.equal(await bal(recipient), split.toRecipient);
  assert.equal((await bal(treasury.publicKey)) - t0, split.protocolFee);
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const cu = tx?.meta?.computeUnitsConsumed;
  const size = tx ? tx.transaction.message.serialize().length + 1 + 64 : 0;
  console.log(`  transact used ${cu} CU, ${size} bytes; relayer net ${(await bal(relayer.publicKey)) - r0} lamports`);
  assert.ok((cu ?? 0) < TRANSACT_CU);

  // the same proof can never be used twice
  await expectFail(relay(sp), /already in use|custom program error: 0x0/);
});

test("the fee cap the user signed is enforced", async () => {
  const { leaves, tree, spent } = await syncTree();
  const notes = scanNotes(userKeys, leaves, spent).notes;
  const input = selectInputs(notes, SOL / 10n)!;
  const sp = await proveSpend({
    keys: userKeys,
    tree,
    inputs: input,
    outputs: [
      { amount: input.reduce((s, n) => s + n.amount, 0n) - SOL / 10n, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient: Keypair.generate().publicKey, relayer: relayer.publicKey, withdraw: SOL / 10n, relayerFee: 0n, maxFeeBps: 50 },
    wasm,
    zkey,
  });
  await expectFail(relay(sp), /FeeAboveLimit/);
});

test("an emptied treasury never blocks users: fees it can't hold are skipped", async () => {
  const empty = Keypair.generate().publicKey;
  await send([pool.updateConfig(admin.publicKey, params({ treasury: empty }))], [admin]);
  const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(0));

  // a small deposit: its fee alone could not keep the empty treasury alive, so it goes back to the depositor
  const small = SOL / 20n;
  assert.ok(depositFee(small, 80) < rentMin);
  const d = await deposit(user3, user3Keys, small);
  await waitSlots(DELAY + 1n);
  const before = await bal(user3.publicKey);
  await send([pool.settle(pool.pending(d.inner), user3.publicKey, empty)], [relayer]);
  assert.equal(await bal(empty), 0n, "nothing was sent to an account that could not hold it");
  assert.ok((await bal(user3.publicKey)) - before >= depositFee(small, 80), "the skipped fee went back to the depositor");

  // a small withdrawal settles without a protocol fee
  const { leaves, tree, spent } = await syncTree();
  const notes = scanNotes(user3Keys, leaves, spent).notes;
  const input = selectInputs(notes, SOL / 20n)!;
  const recipient = Keypair.generate().publicKey;
  const withdraw = SOL / 20n;
  const sp = await proveSpend({
    keys: user3Keys,
    tree,
    inputs: input,
    outputs: [
      { amount: input.reduce((s, n) => s + n.amount, 0n) - withdraw, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient, relayer: relayer.publicKey, withdraw, relayerFee: 2_000_000n, maxFeeBps: 80 },
    wasm,
    zkey,
  });
  await send([...computeBudget(TRANSACT_CU, 0), pool.transact(sp, empty)], [relayer]);
  assert.equal(await bal(recipient), withdraw - 2_000_000n, "the recipient gets the whole net amount");
  assert.equal(await bal(empty), 0n);

  // a fee big enough to open the account is paid
  const big = SOL / 5n;
  assert.ok(depositFee(big, 80) >= rentMin);
  const d2 = await deposit(user3, user3Keys, big);
  await waitSlots(DELAY + 1n);
  await send([pool.settle(pool.pending(d2.inner), user3.publicKey, empty)], [relayer]);
  assert.equal(await bal(empty), depositFee(big, 80));
  await send([pool.updateConfig(admin.publicKey, params())], [admin]);
});

test("two notes merge into one withdrawal, and a pre-funded nullifier cannot block it", async () => {
  const { leaves, tree, spent } = await syncTree();
  const notes = scanNotes(userKeys, leaves, spent).notes;
  assert.equal(notes.length, 2, "the change note and the 0.5 SOL note");
  const total = notes[0].amount + notes[1].amount;
  assert.equal(total, changeNote + SOL / 2n);
  const recipient = Keypair.generate().publicKey;
  const sp = await proveSpend({
    keys: userKeys,
    tree,
    inputs: notes,
    outputs: [
      { amount: 0n, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient, relayer: relayer.publicKey, withdraw: total, relayerFee: 2_000_000n, maxFeeBps: 80 },
    wasm,
    zkey,
  });
  // griefing attempt: someone sends lamports to the nullifier address first
  await send(
    [SystemProgram.transfer({ fromPubkey: user2.publicKey, toPubkey: pool.nullifier(sp.nullifiers[0]), lamports: 1_000_000 })],
    [user2],
  );
  await relay(sp);
  assert.equal(await bal(recipient), splitWithdraw(total, 2_000_000n, 80).toRecipient);
  const after = await syncTree();
  assert.equal(scanNotes(userKeys, after.leaves, after.spent).total, 0n);
  assert.equal(scanNotes(user2Keys, after.leaves, after.spent).total, SOL, "other people's notes are untouched");
});

test("admin limits: fee cap, pause, deposit cap, admin handover", async () => {
  await expectFail(send([pool.updateConfig(user.publicKey, params())], [user]), /NotAllowed|ConstraintHasOne|2001/);
  await expectFail(send([pool.updateConfig(admin.publicKey, params({ feeBps: 101 }))], [admin]), /FeeAboveLimit/);
  await send([pool.updateConfig(admin.publicKey, params({ depositsPaused: true }))], [admin]);
  await expectFail(deposit(user, userKeys, SOL), /DepositsPaused/);
  const vaultHeld = (await bal(pool.vault)) - 1_000_000n;
  await send([pool.updateConfig(admin.publicKey, params({ tvlCap: vaultHeld > 0n ? vaultHeld : SOL / 100n }))], [admin]);
  await expectFail(deposit(user, userKeys, SOL), /PoolFull/);
  await send([pool.updateConfig(admin.publicKey, params())], [admin]);
  await send([pool.transferAdmin(admin.publicKey, user2.publicKey)], [admin]);
  await expectFail(send([pool.acceptAdmin(user.publicKey)], [user]), /NotAllowed|2003|Constraint/);
  await send([pool.acceptAdmin(user2.publicKey)], [user2]);
  assert.equal((await fetchConfig(conn, pool)).admin.toBase58(), user2.publicKey.toBase58());
  await send([pool.transferAdmin(user2.publicKey, admin.publicKey)], [user2]);
  await send([pool.acceptAdmin(admin.publicKey)], [admin]);
});

test("no limits: a deposit far above the old caps settles and leaves in one withdrawal", async () => {
  const NO_LIMIT = 2n ** 64n - 1n; // what 3-ADMIN option 15 sets: no largest deposit, no pool cap
  await send([pool.updateConfig(admin.publicKey, params({ maxDeposit: NO_LIMIT, tvlCap: 0n }))], [admin]);
  const c = await fetchConfig(conn, pool);
  assert.equal(c.maxDeposit, NO_LIMIT);
  assert.equal(c.tvlCap, 0n);

  const whale = Keypair.generate();
  const whaleKeys = keysFromSignature(ed25519.sign(new TextEncoder().encode("test account"), whale.secretKey.slice(0, 32)));
  await airdrop(whale.publicKey, 1_100);
  const big = 1_000n * SOL; // 10x the test pool's old largest deposit, and the pool passes its old 1,000 SOL cap
  const d = await deposit(whale, whaleKeys, big);
  await waitSlots(DELAY + 1n);
  const t0 = await bal(treasury.publicKey);
  await send([pool.settle(pool.pending(d.inner), whale.publicKey, treasury.publicKey)], [relayer]);
  assert.equal((await bal(treasury.publicKey)) - t0, depositFee(big, 80), "the deposit fee reached the treasury");

  const { leaves, tree, spent } = await syncTree();
  const mine = scanNotes(whaleKeys, leaves, spent);
  assert.equal(mine.total, big);
  const recipient = Keypair.generate().publicKey;
  const sp = await proveSpend({
    keys: whaleKeys,
    tree,
    inputs: mine.notes,
    outputs: [
      { amount: 0n, nonce: randomNonce() },
      { amount: 0n, nonce: randomNonce() },
    ],
    ext: { recipient, relayer: relayer.publicKey, withdraw: big, relayerFee: 2_000_000n, maxFeeBps: 80 },
    wasm,
    zkey,
  });
  await relay(sp);
  assert.equal(await bal(recipient), splitWithdraw(big, 2_000_000n, 80).toRecipient);
  const after = await syncTree();
  assert.equal(scanNotes(whaleKeys, after.leaves, after.spent).total, 0n);
  await send([pool.updateConfig(admin.publicKey, params())], [admin]);
});

test("the vault always covers every note", async () => {
  const { leaves, spent } = await syncTree();
  const t = await fetchTree(conn, pool);
  const a = await conn.getAccountInfo(pool.vault);
  const rentMin = BigInt(await conn.getMinimumBalanceForRentExemption(a!.data.length));
  const live = scanNotes(user2Keys, leaves, spent).total + scanNotes(user3Keys, leaves, spent).total;
  assert.equal(BigInt(a!.lamports) - rentMin - t.pendingLamports, live, "vault = rent + pending + live notes");
});

after(async () => {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  await g.curve_bn128?.terminate();
});
