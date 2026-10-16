// Writes the Terms of use in force to web/public/legal/terms-<version>.txt (the text the site shows
// with the default legal settings: none set, and the legal contact support@visionswap.net) and puts
// its SHA-256 into src/legal/archive.ts.
//
//   npm run terms:archive -w web
//
// Run it after changing the Terms (src/legal/terms-doc.ts) and deciding the version in
// src/lib/terms.ts: a material change gets a new major number (people accept again), a correction
// a new minor one. It refuses to overwrite the text of a version whose archived file differs, unless
// that version is the one in force and has not been released yet (pass --replace to confirm).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { termsDoc, termsText } from "../src/legal/terms-doc.ts";
import { DEFAULT_LEGAL_SETTINGS } from "../src/legal/settings.ts";
import { TERMS_VERSION } from "../src/lib/terms.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = termsText(termsDoc(DEFAULT_LEGAL_SETTINGS));
const sha = createHash("sha256").update(text, "utf8").digest("hex");
const file = join(web, "public", "legal", `terms-${TERMS_VERSION}.txt`);
mkdirSync(dirname(file), { recursive: true });
if (existsSync(file) && readFileSync(file, "utf8") !== text && !process.argv.includes("--replace")) {
  console.error(`terms-${TERMS_VERSION}.txt already holds different text. If version ${TERMS_VERSION} hasn't been published yet, run again with --replace; otherwise give the Terms a new version in src/lib/terms.ts.`);
  process.exit(1);
}
writeFileSync(file, text);

const archivePath = join(web, "src", "legal", "archive.ts");
const archive = readFileSync(archivePath, "utf8");
const row = new RegExp(`(version: "${TERMS_VERSION.replace(/\./g, "\\.")}",[\\s\\S]*?sha256: ")[0-9a-f]{64}(")`);
if (!row.test(archive)) {
  console.error(`src/legal/archive.ts has no row for version ${TERMS_VERSION}: add one first.`);
  process.exit(1);
}
writeFileSync(archivePath, archive.replace(row, `$1${sha}$2`));
console.log(`terms-${TERMS_VERSION}.txt: ${text.length} characters, sha256 ${sha}`);
