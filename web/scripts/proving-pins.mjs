// The proving files' pinned SHA-256 and size (VS-54), read from the one place they are written down:
// sdk/src/provingfiles.ts. The website's build (copy-zk.mjs) and the extension's build refuse to
// package any other files.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function provingPins() {
  const text = readFileSync(join(here, "..", "..", "sdk", "src", "provingfiles.ts"), "utf8");
  const pin = (kind) => {
    const m = new RegExp(`${kind}: \\{ name: "[^"]+", sha256: "([0-9a-f]{64})", size: ([0-9_]+) \\}`).exec(text);
    if (!m) throw new Error(`no pin for the ${kind} file in sdk/src/provingfiles.ts`);
    return { sha256: m[1], size: Number(m[2].replace(/_/g, "")) };
  };
  return { wasm: pin("wasm"), zkey: pin("zkey") };
}
