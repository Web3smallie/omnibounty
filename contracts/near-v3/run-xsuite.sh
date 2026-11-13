#!/usr/bin/env bash
# V3 cross-contract verification in one command: fresh fixtures, both
# WASM builds, canonicalization gates, and the xsuite suite. Fails
# immediately on any failure (nothing is skipped silently).
#
# Prerequisites (checked below, install once per machine):
#   rustup toolchain install stable 1.86.0 --target wasm32-unknown-unknown
#   python3 (canonicalizer)
set -euo pipefail
cd "$(dirname "$0")"
# Loopback RPC must bypass any sandbox proxy (see tests/README.md).
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost

command -v cargo >/dev/null || { echo "missing cargo/rustup"; exit 1; }
rustup toolchain list 2>/dev/null | grep -q "1.86.0" || {
  echo "missing toolchain 1.86.0 (run the rustup line above)"; exit 1; }
rustup target list --toolchain 1.86.0 --installed 2>/dev/null | grep -q "wasm32-unknown-unknown" || {
  echo "missing wasm32 target on 1.86.0 (run the rustup line above)"; exit 1; }
command -v python3 >/dev/null || { echo "missing python3"; exit 1; }

echo "==> unit tests"
cargo test --locked --lib
echo "==> regen fresh claim fixture (7-day proofs)"
cargo test --locked --lib regen_xsuite_fixture -- --ignored --nocapture --exact tests::regen_xsuite_fixture
echo "==> build both WASMs (Rust 1.86)"
cargo +1.86.0 build --locked --target wasm32-unknown-unknown --release
cargo +1.86.0 build --locked --target wasm32-unknown-unknown --release \
  --manifest-path tests/mock-mpc/Cargo.toml
echo "==> canonicalize + verify"
python3 ../../tools/canon_leb.py target/wasm32-unknown-unknown/release/omnibounty_v3.wasm target/wasm32-unknown-unknown/release/omnibounty_v3.wasm
python3 ../../tools/canon_leb.py tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm
python3 ../../tools/canon_leb.py --check target/wasm32-unknown-unknown/release/omnibounty_v3.wasm
python3 ../../tools/canon_leb.py --check tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm
echo "==> xsuite (sandbox)"
cargo test --locked --features xsuite --test xsuite
echo "ALL GREEN"
