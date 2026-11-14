#!/usr/bin/env bash
# OmniBounty canonical fresh-machine setup (Linux only).
#
# Installs user-level toolchains, installs JS dependencies, builds the
# escrow artifacts relayer tests need, generates disposable testnet
# identities, and smoke-checks RPC reachability. Sends no transactions,
# funds nothing, deploys nothing. Safe to re-run:
# every step skips work that already exists (except `npm ci`, which only
# runs when node_modules/ is missing).
#
# What this script does NOT do (operator steps, see JUDGES.md):
#   - system packages (prints the apt line if curl/git/python3/node are missing)
#   - Node.js itself (needs Node >= 22; install via your distro or nvm first)
#   - testnet funding (manual faucet/peer step after keygen)
#   - clean-machine testing (this script was developed incrementally, NOT
#     validated with a from-scratch run; report gaps rather than assuming)
#
# Usage: ./scripts/setup.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
note() { echo "NOTE: $1"; }

[ "$(uname -s)" = "Linux" ] || fail "Linux only (found $(uname -s))"

echo "==> 1/6 prerequisite commands"
for cmd in curl git python3 node npm; do
  command -v "$cmd" >/dev/null || fail "missing '$cmd' (Ubuntu/Debian: sudo apt-get install -y curl git python3; Node >= 22 via nvm or nodejs.org)"
done
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" \
  || fail "node >= 22 required (found $(node --version))"
pass "curl git python3 node($(node --version)) npm present"

echo "==> 2/6 Rust toolchains (stable + 1.86.0, wasm target, lint components)"
command -v rustup >/dev/null || fail "missing rustup (https://rustup.rs) - install it, then re-run"
for tc in stable 1.86.0; do
  rustup toolchain list 2>/dev/null | grep -q "^$tc" || rustup toolchain install "$tc"
done
for tc in stable 1.86.0; do
  rustup target list --toolchain "$tc" --installed 2>/dev/null | grep -q wasm32-unknown-unknown \
    || rustup target add --toolchain "$tc" wasm32-unknown-unknown
done
for comp in rustfmt clippy; do
  rustup component list --toolchain stable --installed 2>/dev/null | grep -q "^$comp" \
    || rustup component add --toolchain stable "$comp"
done
rustc +1.86.0 --version
rustc +stable --version
pass "rust toolchains ready"

echo "==> 3/6 Foundry (forge/cast/anvil)"
if ! command -v forge >/dev/null; then
  curl -sSL https://foundry.paradigm.xyz | bash
  export PATH="$PATH:$HOME/.foundry/bin"
fi
command -v forge >/dev/null || fail "forge still missing after install (check \$HOME/.foundry/bin on PATH)"
foundryup
forge --version
pass "foundry ready ($(forge --version | head -n1))"

echo "==> 4/7 JS dependencies"
for pkg in frontend relayer tools integration; do
  if [ -d "$pkg/node_modules" ]; then
    note "$pkg/node_modules present, skipping npm ci"
  else
    (cd "$pkg" && npm ci --no-audit --no-fund)
  fi
done
if [ ! -d contracts/base/lib/forge-std ]; then
  (cd contracts/base && forge install --no-git foundry-rs/forge-std)
else
  note "contracts/base/lib/forge-std present, skipping"
fi
pass "JS dependencies + legacy forge-std ready"

echo "==> 5/7 escrow build artifacts (needed by relayer tests)"
if [ -f contracts/base-v3/out/OmniEscrowV2.sol/OmniEscrowV2.json ]; then
  note "base-v3 artifacts present, skipping forge build"
else
  (cd contracts/base-v3 && forge build)
fi
pass "escrow artifacts ready"

echo "==> 6/7 disposable testnet identities"
if node scripts/keygen.mjs; then
  pass "fresh identities generated in secrets/ (0600, gitignored)"
else
  code=$?
  if [ "$code" = "2" ]; then
    note "secrets/agent-*.json already exist, keeping them (keygen --force to rotate)"
  else
    fail "keygen failed"
  fi
fi

echo "==> 7/7 RPC smoke check (read-only)"
code_hash="$(curl -s -m 25 -X POST https://rpc.testnet.near.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"setup","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"omnibounty-v3.testnet"}}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["code_hash"])')"
[ "$code_hash" = "8yGzesTCJSRu4egz4bBeS19ABLSb6Y6TJQpRHH7quiYj" ] \
  || fail "unexpected on-chain code hash: $code_hash"
pass "NEAR testnet reachable, deployed code hash matches"
echo "base escrow code: $(curl -s -m 25 -X POST https://sepolia.base.org -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767","latest"]}' \
  | python3 -c 'import json,sys; c=json.load(sys.stdin)["result"]; print(f"{len(c)//2-1} bytes")')"

echo ""
echo "SETUP COMPLETE. Next:"
echo "  1. Fund the disposable identities ONLY if you will send testnet transactions"
echo "     (NEAR testnet faucet/peer for the implicit account; Base Sepolia ETH +"
echo "     testnet USDC for the EVM address). Read-only verification needs no funds."
echo "  2. Run the read-only gate: ./scripts/verify.sh"
echo "  3. Follow JUDGES.md (human guide + terminal runbook)."
