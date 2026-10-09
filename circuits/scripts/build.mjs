// Compiles the circuit with full optimisation. Uses tools/circom(.exe) next to the repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const exe = join(root, "..", "tools", process.platform === "win32" ? "circom.exe" : "circom");
const circom = existsSync(exe) ? exe : "circom";
const build = join(root, "build");
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
execFileSync(circom, [join(root, "src", "transaction.circom"), "--O2", "--r1cs", "--wasm", "--sym", "-o", build], {
  stdio: "inherit",
});
