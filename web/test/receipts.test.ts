/**
 * Payment receipts, the app's side (P1-1, behind RECEIPTS_ENABLED): to build a receipt the app
 * downloads the pool's whole transaction index, every chunk in order, never one chosen by its own
 * note's position; and the switch is off unless the build turns it on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import { TX_CHUNK, encodeLeafTx, encodeNfTx } from "@visionswap/sdk";
import { downloadTxIndex, historyFrom } from "../src/lib/receipts.ts";
import { RECEIPTS_ENABLED } from "../src/lib/features.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const sig = (n: number) => bs58.encode(new Uint8Array(64).map((_, i) => (i * 3 + n * 17 + 1) & 0xff));

test("receipts are off unless the build switches them on", () => {
  assert.equal(RECEIPTS_ENABLED, false);
  const vite = readFileSync(join(web, "vite.config.ts"), "utf8");
  assert.match(vite, /__VS_RECEIPTS__: JSON\.stringify\(process\.env\.VITE_RECEIPTS === "1"\)/);
  const ext = readFileSync(join(web, "..", "extension", "scripts", "build.mjs"), "utf8");
  assert.match(ext, /define\.__VS_RECEIPTS__ = JSON\.stringify\(process\.env\.VITE_RECEIPTS === "1"\);/);
  // nothing public mentions them while off: the page and panel only reach the receipt code through the switch
  const panels = readFileSync(join(web, "src", "components", "app", "Panels.tsx"), "utf8");
  const SWITCH = /typeof __VS_RECEIPTS__ === "boolean" && __VS_RECEIPTS__ \? lazy\(/;
  assert.match(panels, new RegExp(`const ReceiptMaker = ${SWITCH.source}`));
  const verify = readFileSync(join(web, "src", "pages", "VerifyPage.tsx"), "utf8");
  assert.match(verify, new RegExp(`const ReceiptCheck = ${SWITCH.source}`));
  for (const f of ["CompliancePage.tsx", "DocsPage.tsx", "PrivacyPage.tsx", "Landing.tsx"]) {
    assert.doesNotMatch(readFileSync(join(web, "src", "pages", f), "utf8"), /payment receipt|proof of source/i, f);
  }
});

test("building a receipt downloads every chunk of the transaction index, never one picked by a note", async () => {
  const leaves = 2 * TX_CHUNK + 5;
  const nfs = TX_CHUNK + 1;
  const asked: string[] = [];
  const fetchBin = async (path: string) => {
    asked.push(path);
    const u = new URL(path, "https://x");
    const kind = u.searchParams.get("kind");
    const from = Number(u.searchParams.get("from"));
    const limit = Number(u.searchParams.get("limit"));
    assert.equal(limit, TX_CHUNK);
    assert.equal(from % TX_CHUNK, 0, "only aligned chunks");
    const total = kind === "leaves" ? leaves : nfs;
    const n = Math.max(0, Math.min(TX_CHUNK, total - from));
    const parts: Uint8Array[] = [];
    for (let i = from; i < from + n; i++) {
      parts.push(kind === "leaves" ? encodeLeafTx(i === 7 ? { tx: sig(1), slot: 5, depositTx: sig(2) } : { tx: sig(3), slot: 9, depositTx: null }) : encodeNfTx({ tx: sig(3), slot: 9 }));
    }
    const data = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
      data.set(p, o);
      o += p.length;
    }
    return { data, total };
  };
  const index = await downloadTxIndex(fetchBin);
  assert.deepEqual(asked, [
    `/api/pool/txs?kind=leaves&from=0&limit=${TX_CHUNK}`,
    `/api/pool/txs?kind=leaves&from=${TX_CHUNK}&limit=${TX_CHUNK}`,
    `/api/pool/txs?kind=leaves&from=${2 * TX_CHUNK}&limit=${TX_CHUNK}`,
    `/api/pool/txs?kind=nullifiers&from=0&limit=${TX_CHUNK}`,
    `/api/pool/txs?kind=nullifiers&from=${TX_CHUNK}&limit=${TX_CHUNK}`,
  ]);
  assert.equal(index.leaves.length, leaves);
  assert.equal(index.nullifiers.length, nfs);
  const h = historyFrom(index, (i) => BigInt(i + 1));
  assert.deepEqual(h.leafTx(7), { tx: sig(1), depositTx: sig(2) });
  const s = h.spend(sig(3));
  assert.equal(s?.nullifiers.length, nfs);
  assert.equal(s?.outputs.length, leaves - 1, "every leaf a spend made (all but the deposit's)");
  assert.equal(h.spend(sig(9)), null);
});

test("the engine builds receipts from the full download only, and never looks a note's deposit up through the gateway", () => {
  const engine = readFileSync(join(web, "src", "lib", "engine.ts"), "utf8");
  const at = engine.indexOf("async receiptFor(a: Activity");
  assert.ok(at > 0);
  const body = engine.slice(at, at + 3000);
  assert.match(body, /if \(!\(typeof __VS_RECEIPTS__ === "boolean" && __VS_RECEIPTS__\)\) throw/);
  assert.match(body, /await downloadTxIndex\(apiBinary\)/);
  assert.doesNotMatch(body, /getSignaturesForAddress|getTransaction|conn\(\)/, "no per-note lookups");
});
