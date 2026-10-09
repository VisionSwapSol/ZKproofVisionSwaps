// Copies the proving artifacts into public/zk with content-hashed names, so
// browsers can cache them forever and a new ceremony can never be mixed up
// with an old cached file.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "circuits", "artifacts");
const dst = join(here, "..", "public", "zk");
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(dst)) rmSync(join(dst, f));
const out = {};
for (const name of ["transaction.wasm", "transaction.zkey"]) {
  const buf = readFileSync(join(src, name));
  const h = createHash("sha256").update(buf).digest("hex").slice(0, 12);
  const [base, ext] = name.split(".");
  const file = `${base}-${h}.${ext}`;
  copyFileSync(join(src, name), join(dst, file));
  out[ext] = `/zk/${file}`;
}
writeFileSync(join(dst, "manifest.json"), JSON.stringify(out));
console.log("zk artifacts:", out);
