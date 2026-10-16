import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "./field.ts";

/**
 * The proving files every VisionSwap app uses, pinned by their SHA-256 (VS-54). They are the ones
 * the trusted setup's record names (circuits/artifacts/TRANSCRIPT.json: `wasmSha256` and
 * `finalZkeySha256`), and the verification key the program was deployed with is the one inside that
 * proving key. The app checks every file against these before it proves anything with it, and the
 * website's and the extension's builds refuse to package any other files. A new setup changes these
 * values in the source, where a reviewer sees it.
 *
 * The program checks every proof against its own fixed verification key, so a wrong file can never
 * move funds: it would only make proofs that fail. The pin stops a swapped file from doing anything
 * at all, and makes the files the app runs the ones the setup's record describes.
 */
export const PROVING_FILES = {
  wasm: { name: "transaction.wasm", sha256: "e2ef150c56a9ffcb534eb84a11fd923ca02d3815a97039789c4c6fcf1424b0b2", size: 2_523_325 },
  zkey: { name: "transaction.zkey", sha256: "def9e70c4df55211f043444369a421272fb13a08294bda3ce64c033c7f7b88c6", size: 9_160_175 },
} as const;

/** The verification key's SHA-256 (circuits/artifacts/verification_key.json, the one in TRANSCRIPT.json). */
export const VERIFICATION_KEY_SHA256 = "1cfd5fcb0455d41369766b616afb4f24a2871a1e4905b558bf58243bd7570995";

export type ProvingFile = keyof typeof PROVING_FILES;

/** The name a build gives a proving file: its content hash's first 12 characters, so caches can keep it for good. */
export function provingFileName(kind: ProvingFile): string {
  const p = PROVING_FILES[kind];
  const [base, ext] = p.name.split(".");
  return `${base}-${p.sha256.slice(0, 12)}.${ext}`;
}

/** SHA-256 of some bytes, in hex (a browser can use its own crypto.subtle instead: the result is the same). */
export function sha256Hex(bytes: Uint8Array): string {
  return hex(sha256(bytes));
}

/**
 * Why a proving file can't be used, or null when it is exactly the pinned one: `digest` is its
 * SHA-256 in hex (worked out by the caller, so a browser can hash with crypto.subtle), `size` its length.
 */
export function provingFileProblem(kind: ProvingFile, digest: string, size: number): string | null {
  const p = PROVING_FILES[kind];
  if (size !== p.size) return `the ${kind} file is ${size} bytes, not ${p.size}`;
  if (digest.toLowerCase() !== p.sha256) return `the ${kind} file's SHA-256 is ${digest.slice(0, 12)}…, not ${p.sha256.slice(0, 12)}…`;
  return null;
}
