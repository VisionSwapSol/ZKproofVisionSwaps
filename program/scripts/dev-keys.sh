#!/usr/bin/env bash
# Local-only keypairs for tests. Never used on mainnet.
set -euo pipefail
mkdir -p ~/vs/keys
cd ~/vs/program
[ -f ~/vs/keys/dev-program.json ] || cp target/deploy/vision_pool-keypair.json ~/vs/keys/dev-program.json
for k in dev-admin dev-guard dev-relayer dev-treasury dev-user dev-user2; do
  [ -f ~/vs/keys/$k.json ] || solana-keygen new --no-bip39-passphrase -s -o ~/vs/keys/$k.json >/dev/null
done
for k in dev-program dev-admin dev-guard dev-relayer dev-treasury dev-user dev-user2; do
  echo "$k $(solana-keygen pubkey ~/vs/keys/$k.json)"
done
