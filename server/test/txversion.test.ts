import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Solana carries version 1 transactions now. Asking for "up to version 0" makes the network refuse a
// whole read the moment one of them is in it: a wallet's history couldn't be screened, the pool's
// index couldn't follow it, a deposit address couldn't be read. Every read must accept version 1.
test("every transaction read accepts version 1 transactions", () => {
  const root = join(import.meta.dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|mts)$/.test(name)) files.push(p);
    }
  };
  for (const dir of ["server/src", "sdk/src", "web/src"]) walk(join(root, dir));
  assert.ok(files.length > 50, "found the sources");
  const old = files.filter((f) => /maxSupportedTransactionVersion:\s*0\b/.test(readFileSync(f, "utf8")));
  assert.deepEqual(old, [], "these still ask for version 0 only");
});
