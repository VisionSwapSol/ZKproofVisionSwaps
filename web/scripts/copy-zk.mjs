// Copies the proving artifacts into public/zk with content-hashed names, so
// browsers can cache them forever and a new ceremony can never be mixed up
// with an old cached file.
//
// The files must be exactly the ones pinned in the app (sdk/src/provingfiles.ts,
// VS-54): the app refuses anything else before proving, so a build with other
// files would only make an app that can't send. It stops here instead.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { provingPins } from "./proving-pins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "circuits", "artifacts");
const dst = join(here, "..", "public", "zk");
const pins = provingPins();
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(dst)) rmSync(join(dst, f));
const out = {};
for (const name of ["transaction.wasm", "transaction.zkey"]) {
  const buf = readFileSync(join(src, name));
  const full = createHash("sha256").update(buf).digest("hex");
  const [base, ext] = name.split(".");
  const pin = pins[ext];
  if (full !== pin.sha256 || buf.length !== pin.size) {
    console.error(`zk artifacts: ${name} (sha256 ${full.slice(0, 12)}…, ${buf.length} bytes) is not the pinned file (${pin.sha256.slice(0, 12)}…, ${pin.size} bytes). See sdk/src/provingfiles.ts.`);
    process.exit(1);
  }
  const h = full.slice(0, 12);
  const file = `${base}-${h}.${ext}`;
  copyFileSync(join(src, name), join(dst, file));
  out[ext] = `/zk/${file}`;
}
writeFileSync(join(dst, "manifest.json"), JSON.stringify(out));
console.log("zk artifacts (pinned):", out);
