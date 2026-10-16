// Types for releases.mjs, so TypeScript callers type-check without allowJs.

export declare const PROGRAM_DIR: string;
export declare const MAINNET: "mainnet-beta";

/** What program/scripts/build.sh writes to program/build/vision_pool.build.json. */
export interface BuildInfo {
  programId: string;
  sha256: string;
  executableHash: string;
  size: number;
  sbpfArch: string;
  elfFlags?: number;
  cargoLockSha256: string;
  sourceSha256: string;
  toolchain: { cargoBuildSbf: string; platformTools: string; rustc: string };
  stackOffsetDiagnostics: { total: number; linked: number };
  builtAt?: string;
}

export type ReleaseStatus = "candidate" | "deployed" | "superseded" | "withdrawn";

/** One entry of program/RELEASES.json. */
export interface Release {
  version: string;
  status: ReleaseStatus;
  cluster: string;
  programId: string;
  sha256: string;
  executableHash: string;
  size: number;
  sbpfArch: string;
  source: { commit: string; programTree: string; cargoLockSha256: string; sourceSha256: string };
  toolchain: BuildInfo["toolchain"];
  stackOffsetDiagnostics: BuildInfo["stackOffsetDiagnostics"];
  deployedSlot: number | null;
  deployedAt: string | null;
  reproduced: string | null;
  verifiedBuild: unknown;
  audited: boolean;
  notes: string;
}

export interface ReleasesDoc {
  about?: string;
  releases: Release[];
}

export declare function paths(dir?: string): { so: string; info: string; releases: string };
export declare function sha256(b: Uint8Array): string;
export declare function executableHash(b: Uint8Array): string;
export declare function sourceSha256(dir?: string): string;
export declare function checkedBuild(
  programId: string | null,
  dir?: string,
): { error: string; so?: undefined; sha256?: undefined; info?: undefined } | { error?: undefined; so: Buffer; sha256: string; info: BuildInfo };
export declare function readReleases(dir?: string): ReleasesDoc;
export declare function writeReleases(doc: ReleasesDoc, dir?: string): void;
export declare function findRelease(doc: ReleasesDoc, hash: string, programId: string, cluster?: string): Release | undefined;
export declare function releaseEntry(
  info: BuildInfo,
  opts: { version: string; commit: string; programTree: string; cluster?: string },
): Release;
export declare function addRelease(doc: ReleasesDoc, entry: Release): ReleasesDoc;
export declare function markDeployed(
  doc: ReleasesDoc,
  hash: string,
  programId: string,
  opts: { slot: number; at: string; cluster?: string },
): ReleasesDoc;
