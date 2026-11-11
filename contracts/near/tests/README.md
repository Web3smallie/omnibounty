# Cross-contract tests

`cross_contract.rs` (feature `xsuite`) drives the real promise machinery —
`claim` → MPC `sign` → `on_voucher_signed` — through `near-workspaces`
0.21 (sandbox 2.9.0, auto-downloaded at build time):

- Full lifecycle: deploy → configure → `dry_run` → `claim` →
  `voucher_signed` → field assertions → identifier nullified →
  cross-bounty replay rejected with `IDENTIFIER_REPLAY`.
- Failure injection (sandbox only): MPC panic, garbage response, and
  wrong-signer responses each return `Rejected` with the right code (the
  receipt SUCCEEDS so the release commits), release the bounty to `Open`,
  and allow a successful retry.

## Toolchain split

The xsuite dependency tree needs a newer rustc than the pinned 1.86.0
(edition-2024 crates), so the harness builds on stable Rust while the
wasms stay on 1.86.0 for byte-identical production artifacts:

```sh
cargo build --target wasm32-unknown-unknown --release          # 1.86.0
cargo build --target wasm32-unknown-unknown --release \
    --manifest-path tests/mock-mpc/Cargo.toml                  # 1.86.0
python ../../tools/canon_leb.py \                              # any Python 3
    target/wasm32-unknown-unknown/release/omnibounty.wasm \
    target/wasm32-unknown-unknown/release/omnibounty.wasm
python ../../tools/canon_leb.py \
    tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm \
    tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm
cargo +stable test --features xsuite                          # stable Rust
```

`canon_leb.py` rewrites LLVM's padded LEB128 immediates at
`call_indirect`/`memory.size`/`memory.grow` sites to canonical form.
nearcore's strict parser reads those immediates as single bytes and
rejects the padded encoding with `PrepareError(Deserialization)`; the
rewrite changes no semantics (verified: identical site list to the
reference parser, valid execution under V8, green suite). The
production testnet artifact needs no canonicalization (current
testnet accepts the padded encoding, proven by live claims).

## Networks

`OMNIBOUNTY_NETWORK=sandbox` (default) or `testnet`.

- **sandbox** needs `tests/mock-mpc` built (see above). The mock
  implements the exact deployed v3.18.0 wire shapes with a fixed test
  key; it is TEST-ONLY and must never be deployed outside sandbox.
  Sandbox runs on Linux/macOS only: the near-sandbox binary has no
  Windows build, and workspaces downloads it at *build* time (compile
  on Windows requires a dummy `NEAR_SANDBOX_BIN_PATH`, which only
  permits compilation — sandbox tests still cannot run there).
- **testnet** talks to the real `v1.signer-prod.testnet` through the
  same `dev_*` helpers (funded `*.testnet` subaccounts via the
  helper). Needs working Rust TLS.

Where sandbox and Rust TLS are both unavailable (this Windows sandbox),
the same live leg runs through Node instead:
`node tools/live_handshake.mjs` (near-api-js), which additionally exports
`testdata/live_voucher.json` for the Foundry `LiveVoucherTest`.

## Commands

```sh
cargo +stable test --features xsuite --test cross_contract                  # sandbox
OMNIBOUNTY_NETWORK=testnet cargo +stable test --features xsuite --test cross_contract
```
