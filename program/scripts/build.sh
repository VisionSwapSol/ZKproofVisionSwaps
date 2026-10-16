#!/usr/bin/env bash
# Build the program inside WSL (fast native filesystem) and copy the .so back.
#   bash program/scripts/build.sh [PROGRAM_ID]
#
# The build fails closed (program/BUILD.md explains each rule):
#   - program/build/vision_pool.so is deleted first, so a failed build never
#     leaves an older binary behind for the deploy tools to pick up;
#   - the toolchain must be exactly the one in program/toolchain.env;
#   - crates come only from program/Cargo.lock (cargo --locked);
#   - a compile error stops the script; the full log is program/build/build.log;
#   - a "Stack offset ... exceeded" diagnostic stops the script when the
#     function it names is linked into the program;
#   - the result must be an SBF ELF of the pinned SBPF version that contains
#     the program id.
# On success it writes vision_pool.so, vision_pool.so.sha256 and
# vision_pool.build.json (what was built, from what, with what) into
# program/build/.
#
# VS_BUILD_DIR overrides the WSL work folder (default ~/vs/program).
# VS_OFFLINE=1 builds without network access (every locked crate must already
# be in the local cargo cache).
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${VS_BUILD_DIR:-$HOME/vs/program}"
OUT="$SRC/build"
LOG="$OUT/build.log"

fail() {
  echo "" >&2
  echo "BUILD FAILED: $*" >&2
  exit 1
}

# 1. never leave an older binary behind
mkdir -p "$OUT"
rm -f "$OUT/vision_pool.so" "$OUT/vision_pool.so.sha256" "$OUT/vision_pool.build.json" "$LOG"

# 2. the pinned toolchain
[ -f "$SRC/toolchain.env" ] || fail "program/toolchain.env is missing"
# shellcheck disable=SC1091
source "$SRC/toolchain.env"
[ -f "$SRC/Cargo.lock" ] || fail "program/Cargo.lock is missing; the build only uses locked crates"
command -v cargo-build-sbf >/dev/null || fail "cargo-build-sbf not found (install the Agave CLI $SOLANA_CLI_VERSION)"
command -v python3 >/dev/null || fail "python3 not found (used to check the result)"
TOOLS_LINE="$(cargo-build-sbf --version 2>&1 | head -n 1)"
case "$TOOLS_LINE" in
  *"cargo-build-sbf $SOLANA_CLI_VERSION") ;;
  *) fail "cargo-build-sbf is '$TOOLS_LINE', but program/toolchain.env pins $SOLANA_CLI_VERSION" ;;
esac
PT="$HOME/.cache/solana/$PLATFORM_TOOLS_VERSION/platform-tools"
READELF="$PT/llvm/bin/llvm-readelf"
SBF_RUSTC="$PT/rust/bin/rustc"

# 3. sources into the work folder (keys and old outputs are never copied)
mkdir -p "$DST"
rsync -a --delete --exclude target --exclude keys --exclude build "$SRC/" "$DST/"
cd "$DST"
if [ "${1:-}" != "" ]; then
  sed -i "s/^declare_id!(\".*\");/declare_id!(\"$1\");/" programs/vision_pool/src/lib.rs
  sed -i "s/^declare_id!(\".*\");/declare_id!(\"$1\");/" "$SRC/programs/vision_pool/src/lib.rs"
fi
PROGRAM_ID="$(sed -n 's/^declare_id!("\([^"]*\)");.*/\1/p' programs/vision_pool/src/lib.rs | head -n 1)"
[ -n "$PROGRAM_ID" ] || fail "no declare_id! in programs/vision_pool/src/lib.rs"

# 4. build with locked crates only; keep the whole log
rm -f target/deploy/vision_pool.so target/sbpf*-solana-solana/release/vision_pool.so
echo "Building vision_pool for $PROGRAM_ID (cargo-build-sbf $SOLANA_CLI_VERSION, platform-tools $PLATFORM_TOOLS_VERSION, arch $SBPF_ARCH)"
OFFLINE=()
[ "${VS_OFFLINE:-}" = 1 ] && OFFLINE=(--offline)
if ! cargo build-sbf ${OFFLINE[@]+"${OFFLINE[@]}"} --tools-version "$PLATFORM_TOOLS_VERSION" --arch "$SBPF_ARCH" -- --locked >"$LOG" 2>&1; then
  grep -E "^error" -A 8 "$LOG" | head -n 80 >&2 || true
  fail "cargo build-sbf failed; the full log is program/build/build.log"
fi
grep -E "^(warning|error)|Finished" -A 6 "$LOG" | grep -v "Stack offset" | head -n 40 || true
[ -f target/deploy/vision_pool.so ] || fail "the build finished but produced no target/deploy/vision_pool.so"
UNSTRIPPED="$(ls target/sbpf*-solana-solana/release/vision_pool.so 2>/dev/null | head -n 1)"
[ -n "$UNSTRIPPED" ] || fail "no unstripped vision_pool.so to check against"
[ -x "$READELF" ] || fail "llvm-readelf from platform-tools $PLATFORM_TOOLS_VERSION not found at $READELF"

# 5. oversized stack frames: fatal when the function is part of the program
#    (dependencies compile some large generic functions that are never linked)
SYMS="$("$READELF" -s -W "$UNSTRIPPED")" || fail "could not read the program's symbol table"
STACK_ALL=0
STACK_LINKED=0
while read -r fn; do
  [ -n "$fn" ] || continue
  STACK_ALL=$((STACK_ALL + 1))
  if grep -qF -- "$fn" <<<"$SYMS"; then
    echo "  linked function with an oversized stack frame: $fn" >&2
    STACK_LINKED=$((STACK_LINKED + 1))
  fi
done < <(grep -oE "Function [^ ]+ Stack offset of [0-9]+ exceeded" "$LOG" | awk '{print $2}' | sort -u)
[ "$STACK_LINKED" -eq 0 ] || fail "$STACK_LINKED function(s) in the program exceed the 4 KiB stack frame (see build.log)"
echo "Stack frames: $STACK_ALL oversized in dependency code that is not linked, 0 in the program"

# 6. the result: SBF ELF, pinned SBPF version, built for this program id
SO=target/deploy/vision_pool.so
RUSTC_VERSION="$("$SBF_RUSTC" --version 2>/dev/null | awk '{print $2}')" || RUSTC_VERSION=unknown
SOURCE_SHA="$( (find Cargo.toml Cargo.lock programs -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | awk '{print $1}')"
python3 - "$SO" "$PROGRAM_ID" "$SBPF_ARCH" "$OUT/vision_pool.build.json" \
  "$SOLANA_CLI_VERSION" "$PLATFORM_TOOLS_VERSION" "$RUSTC_VERSION" "$SOURCE_SHA" "$STACK_ALL" <<'PY' || fail "the built file did not pass the checks above"
import hashlib, json, struct, sys, datetime
so, pid, arch, out, cli, tools, rustc, source_sha, stack_all = sys.argv[1:]
b = open(so, "rb").read()
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for ch in pid:
    n = n * 58 + A.index(ch)
raw = n.to_bytes(32, "big")
if b[:4] != b"\x7fELF":
    sys.exit("  not an ELF file")
machine = struct.unpack_from("<H", b, 18)[0]
flags = struct.unpack_from("<I", b, 48)[0]
want_flags = {"v0": 0, "v1": 1, "v2": 2, "v3": 3, "v4": 4}[arch]
if machine != 263:
    sys.exit(f"  ELF machine is {machine}, not SBF (263)")
if flags != want_flags:
    sys.exit(f"  ELF e_flags is {flags}, but SBPF {arch} means {want_flags}")
if raw not in b:
    sys.exit(f"  the build does not contain the program id {pid}")
end = len(b)
while end > 0 and b[end - 1] == 0:
    end -= 1
lock = open("Cargo.lock", "rb").read()
info = {
    "programId": pid,
    "sha256": hashlib.sha256(b).hexdigest(),
    "executableHash": hashlib.sha256(b[:end]).hexdigest(),
    "size": len(b),
    "sbpfArch": arch,
    "elfFlags": flags,
    "cargoLockSha256": hashlib.sha256(lock).hexdigest(),
    "sourceSha256": source_sha,
    "toolchain": {"cargoBuildSbf": cli, "platformTools": tools, "rustc": rustc},
    "stackOffsetDiagnostics": {"total": int(stack_all), "linked": 0},
    "builtAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
json.dump(info, open(out, "w"), indent=2)
open(out, "a").write("\n")
print(f"  sha256          {info['sha256']}")
print(f"  executable hash {info['executableHash']}  (what solana-verify prints)")
PY

cp "$SO" "$OUT/vision_pool.so"
(cd "$OUT" && sha256sum vision_pool.so | tee vision_pool.so.sha256)
ls -la "$OUT/vision_pool.so"
