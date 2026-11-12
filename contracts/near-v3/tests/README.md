# V3 cross-contract suite (`tests/xsuite.rs`)

Sandbox-only tests for what unit tests cannot cover: the real
`finalize_claim` -> MPC `sign` -> `on_voucher_signed` promise machinery
(including outage/garbage/wrong-signer injection via the mock MPC),
storage-deposit enforcement (real accounting), `env::panic_str` paths
(auth, gas floor), and bounty-scoped nullifier reuse.

There is intentionally NO testnet mode: this repo forbids deployments and
live transactions from automation.

## Prerequisites (from `contracts/near-v3`)

```sh
# 0. Fresh claim proofs (valid 7d by criteria cap — snapshot, not golden).
cargo test regen_xsuite_fixture -- --ignored --nocapture

# 1. Release wasms with Rust 1.86 (`rustup toolchain install 1.86.0
#    --target wasm32-unknown-unknown` first if needed). Stable's
#    wasm-ld rejects the NEAR env.* host imports (rustc dropped
#    --allow-undefined from the default wasm32 link line after 1.86),
#    so bare `cargo build` (stable default) FAILS here by design.
cargo +1.86.0 build --target wasm32-unknown-unknown --release
cargo +1.86.0 build --target wasm32-unknown-unknown --release \
    --manifest-path tests/mock-mpc/Cargo.toml

# 2. Run on Linux/macOS (near-sandbox has no Windows binary; on Windows
#    every test fails loudly with this pointer instead of skipping).
cargo test --features xsuite --test xsuite
```

The `regen_xsuite_fixture` unit test writes
`testdata/v3/xsuite-claim.json` (bundles A–E + windowed criteria). Re-run
step 0 whenever the run is more than a few days after generation —
`generated_at` in the file tells you its age.

Determinism check (mirrors CI): with `XSUITE_FIXTURE_TIME` set, two
regens to different `XSUITE_FIXTURE_PATH` locations must be
byte-identical (`cmp`). Only timestamps/signatures vary between runs;
all identifiers, matchers, and extracted values are fixed.

## Layout

- `xsuite.rs` — the suite (5 tests, one fresh sandbox deploy each).
- `mock-mpc/` — test-only MPC signer (fixed key, v3.18.0 wire shapes,
  failure-injection modes). Verbatim copy of the proven V2 mock, kept
  independent so V3 collateral never depends on the frozen V2 tree.
