#!/usr/bin/env bash
# Build the program inside WSL (fast native filesystem) and copy the .so back.
#   bash program/scripts/build.sh [PROGRAM_ID]
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST=~/vs/program
mkdir -p "$DST"
rsync -a --delete --exclude target --exclude keys --exclude build "$SRC/" "$DST/"
cd "$DST"
if [ "${1:-}" != "" ]; then
  sed -i "s/^declare_id!(\".*\");/declare_id!(\"$1\");/" programs/vision_pool/src/lib.rs
  sed -i "s/^declare_id!(\".*\");/declare_id!(\"$1\");/" "$SRC/programs/vision_pool/src/lib.rs"
fi
cargo build-sbf 2>&1 | grep -E "^(error|warning: unused)|Finished" -A 6 || true
test -f target/deploy/vision_pool.so
mkdir -p "$SRC/build"
cp target/deploy/vision_pool.so "$SRC/build/vision_pool.so"
sha256sum target/deploy/vision_pool.so | tee "$SRC/build/vision_pool.so.sha256"
ls -la "$SRC/build/vision_pool.so"
