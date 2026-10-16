#!/usr/bin/env bash
# Rebuilds vision_pool from this checkout in a fresh folder that holds no keys,
# and says which program/RELEASES.json entry the result is.
#   bash program/scripts/verify-build.sh            # may download the locked crates
#   VS_OFFLINE=1 bash program/scripts/verify-build.sh
# Check out the entry's source commit first, or a later commit with the same
# program code (program/BUILD.md, "Rebuilding it yourself", explains this for
# 1.0.0). Exits 1 when the rebuilt bytes match no entry.
# Uses program/scripts/build.sh, so it needs the toolchain in program/toolchain.env.
# program/BUILD.md also covers the Docker-based solana-verify route.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/program"
cp "$SRC/Cargo.toml" "$SRC/Cargo.lock" "$SRC/toolchain.env" "$SRC/RELEASES.json" "$WORK/program/"
cp -r "$SRC/scripts" "$SRC/programs" "$WORK/program/"
VS_BUILD_DIR="$WORK/build-dir" bash "$WORK/program/scripts/build.sh"

python3 - "$WORK/program/build/vision_pool.build.json" "$SRC/RELEASES.json" <<'PY'
import json, sys
info = json.load(open(sys.argv[1]))
rel = json.load(open(sys.argv[2]))["releases"]
hits = [r for r in rel if r["sha256"] == info["sha256"] and r["programId"] == info["programId"]]
print()
print(f"  rebuilt sha256          {info['sha256']}")
print(f"  rebuilt executable hash {info['executableHash']}")
if not hits:
    print("  NO MATCH: these bytes are not a release in program/RELEASES.json")
    sys.exit(1)
for r in hits:
    print(f"  MATCH: version {r['version']} ({r['status']}, {r['cluster']}), source commit {r['source']['commit'][:12]}")
PY
