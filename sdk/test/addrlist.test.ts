import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { ADDR_DEPOSITED, ADDR_PAID, ADDR_PAYER, ADDR_REC, encodeAddrRec, listScan, readAddrList } from "../src/addrlist.ts";

test("records read back, and an address's records are ORed together", () => {
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const data = new Uint8Array([...encodeAddrRec(a, ADDR_PAID), ...encodeAddrRec(b, ADDR_PAYER), ...encodeAddrRec(a, ADDR_DEPOSITED)]);
  assert.equal(data.length, 3 * ADDR_REC);
  const m = readAddrList(data);
  assert.equal(m.get(a.toBase58()), ADDR_PAID | ADDR_DEPOSITED);
  assert.equal(m.get(b.toBase58()), ADDR_PAYER);
  // a record cut off at the end (a download that stopped mid-way) is left out
  assert.equal(readAddrList(data.slice(0, ADDR_REC + 10)).size, 1);
  assert.throws(() => encodeAddrRec(a, 0));
});

test("the list scan finds every used index up to a gap, looking past each one found", () => {
  const used = new Set([0, 1, 2, 5, 24, 60]);
  // 24 is within 20 of 5; 60 is 36 past 24, beyond the gap
  assert.deepEqual(listScan(0, (i) => used.has(i)), { next: 25, found: [0, 1, 2, 5, 24] });
  // a device that already knows of 3 still lists the earlier ones it finds (they were used), and never goes back below what it knew
  assert.deepEqual(listScan(30, (i) => used.has(i)).next, 30);
  assert.deepEqual(listScan(0, () => false), { next: 0, found: [] });
  // the gap is counted from where the device's own knowledge ends
  assert.deepEqual(listScan(10, (i) => i === 25), { next: 26, found: [25] });
});
