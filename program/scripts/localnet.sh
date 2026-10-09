#!/usr/bin/env bash
# Local validator with the pool loaded as an upgradeable program (admin = upgrade authority).
set -euo pipefail
PROGRAM_ID=$(solana-keygen pubkey ~/vs/keys/dev-program.json)
ADMIN=$(solana-keygen pubkey ~/vs/keys/dev-admin.json)
exec solana-test-validator --reset --ledger ~/vs/ledger \
  --rpc-port 8899 --faucet-port 9900 \
  --upgradeable-program "$PROGRAM_ID" ~/vs/dev/vision_pool.so "$ADMIN" \
  --limit-ledger-size 50000000 --quiet
