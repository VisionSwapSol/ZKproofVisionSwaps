# Building and checking the vision_pool program

This page says exactly which code runs on-chain, how it was built, and how
anyone can rebuild it and get the same bytes.

## What is deployed

| | |
|---|---|
| Program | `VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6` (mainnet) |
| Executable hash | `7edb58080a4d73584cb70d0a46e041765a0052ce81fed3885fd7935006fd177d` |
| File sha256 (`vision_pool.so`) | `2e6fb1f233a13436781ac43aa2ab10e283ab80b64b93389a19948d766b3739f4` (391,696 bytes) |
| Deployed | slot 453,075,865 (2026-10-03 23:03:58 UTC) |
| Source | commit `3c2a7d9`, with `program/Cargo.lock`; the sources in this repository build the same bytes |
| Toolchain | Agave CLI 3.1.13 (`cargo-build-sbf`), platform-tools v1.52, SBPF v0 |

The executable hash is the sha256 of the code without the zero bytes that pad
it; `solana-verify get-program-hash` prints it for the deployed program and
`solana-verify get-executable-hash` prints it for a file.

`program/RELEASES.json` is the record of every build deployed on mainnet, or
recorded as a candidate to deploy. The sources in this repository rebuild the
build above byte for byte, offline and with no keys in the build folder.

## The toolchain

`program/toolchain.env` pins it, and `program/scripts/build.sh` refuses any
other:

- **Agave CLI 3.1.13**, which provides `cargo-build-sbf 3.1.13`.
- **platform-tools v1.52** (its own `rustc 1.89.0-dev`), passed as
  `--tools-version v1.52`.
- **SBPF v0** (`--arch v0`; the ELF header's `e_flags` is 0).
- **Crates** exactly as in `program/Cargo.lock` (`cargo --locked`):
  anchor-lang 0.31.1 (with anchor-syn and the anchor-attribute crates at
  0.31.2), solana-bn254 2.2.2, solana-poseidon 2.2.1, bytemuck 1.25.2.

There is no `rust-toolchain.toml`. `cargo-build-sbf` compiles the program,
its build scripts and its macros with the platform-tools compiler chosen by
`--tools-version`, so the host Rust version does not change the bytes. The
host compiler only runs the unit tests (`cargo test`; 1.85.0 was used).
Anchor's CLI does not take part in the build; it is only needed to generate
the IDL.

## Building

On Linux or in WSL:

```
bash program/scripts/build.sh            # builds for the program id in lib.rs
bash program/scripts/build.sh <PROGRAM>  # localnet/devnet: rewrites declare_id! first
```

The script fails closed. It:

1. deletes `program/build/vision_pool.so` first, so a failed build never
   leaves an older binary behind;
2. checks `cargo-build-sbf` is the pinned version and `program/Cargo.lock` exists;
3. builds with `--tools-version`, `--arch` and `--locked`, keeping the whole
   log in `program/build/build.log`, and stops on any compile error;
4. stops when a "Stack offset ... exceeded" diagnostic names a function that
   is linked into the program (see below);
5. checks the result is an SBF ELF with the pinned SBPF version that contains
   the program id;
6. writes `vision_pool.so`, `vision_pool.so.sha256` and
   `vision_pool.build.json` (hashes, toolchain, lockfile and source
   fingerprints) into `program/build/`.

`VS_BUILD_DIR` picks another WSL work folder (default `~/vs/program`), and
`VS_OFFLINE=1` builds without network access.

### Stack frames

The SBF compiler warns when a function needs more than the 4 KiB stack frame
the runtime allows. Building this program prints 16 such warnings, all for
generic code in dependencies (`crypto_common` `SerializableState` for large
arrays, `hybrid_array::try_from_fn`) that the program never calls, so the
linker drops it. `build.sh` reads the program's symbol table and stops the
build if any warned function is actually in the program.

## Recording a release

1. Commit the program's code.
2. Build it: `bash program/scripts/build.sh`.
3. Record it: `node program/scripts/record-release.mjs [--version 1.1.0] [--notes "..."]`.
   This refuses when the program's files have uncommitted changes, or when they
   differ from the files the build was made from. It adds a `candidate` entry
   with the commit, the hashes and the toolchain.
4. Commit `program/RELEASES.json`.
5. Upgrade the program with that build. When the on-chain code matches, the
   entry is marked `deployed` with its slot and time and the previous one
   `superseded`. Commit `program/RELEASES.json` again.

## Checking the deployed program (anyone, read-only)

```
node program/scripts/check-deployed.mjs        # compares the chain with RELEASES.json
solana-verify get-program-hash -u https://api.mainnet-beta.solana.com VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6
```

Both print `7edb5808...177d` for the current deployment.
`check-deployed.mjs` also prints the upgrade authority and the slot of the
last deployment, and exits with 1 when the deployed code is not the entry
marked `deployed`.

## Rebuilding it yourself

### With the native toolchain (Linux or WSL)

Install the Agave CLI 3.1.13 (it brings `cargo-build-sbf`) and platform-tools
v1.52. The sources in this repository build the deployed 1.0.0 program: their
`program/programs` differs from its source commit `3c2a7d9` only by the test
file `adversarial_tests.rs` and its test-only declaration in `verifier.rs`,
which the program build never compiles, by two comment lines in `lib.rs`, and
by the `license` field of `programs/vision_pool/Cargo.toml`. Then:

```
bash program/scripts/verify-build.sh
```

It copies the sources (never `keys/` or `build/`) into a new temporary folder,
runs `build.sh` there and says which `RELEASES.json` entry the bytes are:

```
  MATCH: version 1.0.0 (deployed, mainnet-beta), source commit 3c2a7d977b59
```

### With Docker (solana-verify)

`program/toolchain.env` pins the matching image by digest:
`solanafoundation/solana-verifiable-build:3.1.13@sha256:1a0ea3dd...db31`. On a
machine with Docker and no keys, from `program/`:

```
solana-verify build --library-name vision_pool --base-image "solanafoundation/solana-verifiable-build:3.1.13@sha256:1a0ea3dd15017e57e9b17d67267e7d2d7ab4f083499f3f29c847ddd54f01db31"
solana-verify get-executable-hash target/deploy/vision_pool.so
```

The image has the same CLI and platform-tools, `cargo-build-sbf` strips
local folder names from the binary, and the crates come from the same
lockfile, so this prints `7edb5808...177d` as well. If the image tag with a
digest is refused, pull the tag and compare `docker image inspect` with the
digest.

### Unit tests

```
(cd program && cargo test --locked --lib)        # add --offline when the crates are cached
node --test program/scripts/releases.test.mjs program/scripts/check-idl.test.mjs
```

## Keeping keys away from builds

Every crate's build script and macro runs as your user while the program
builds. In WSL, `C:\` is mounted at `/mnt/c`, so that code could read any file
on the Windows side, keys included. The lockfile limits the crates to the
versions already reviewed, but the safer setup is to build where no keys are:

- a separate WSL distribution used only for builds, with `/etc/wsl.conf`
  containing `[automount]` `enabled=false` and `[interop]`
  `appendWindowsPath=false`, the sources copied in, and no keys anywhere in it;
- or the Docker route above, on a machine that holds no keys;
- and never the machine that holds the upgrade authority.

Review every change to `program/Cargo.lock` like code.

## SBPF version

The deployed program is SBPF v0. Its next release will be built for SBPF v3,
ahead of SIMD-0500 (which disables deploying SBPF v0, v1 and v2 programs once
it is active on mainnet), and recorded as a new entry in
`program/RELEASES.json`.
