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

# 2. Canonicalize the padded LEB128 immediates (mandatory, V2-proven).
#    LLVM 19+ pads code-section LEB128 immediates to 5 bytes; sandbox
#    2.9.0's strict parser reads the `call_indirect` table index and the
#    `memory.size`/`memory.grow` reserved byte as ONE byte and rejects
#    the module with `PrepareError(Deserialization)` on first call.
#    The rewrite changes no semantics (same procedure as V2).
python3 ../../tools/canon_leb.py \
    target/wasm32-unknown-unknown/release/omnibounty_v3.wasm \
    target/wasm32-unknown-unknown/release/omnibounty_v3.wasm
python3 ../../tools/canon_leb.py \
    tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm \
    tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm

# 3. Verify canonical form (exits non-zero if any padded site remains).
python3 ../../tools/canon_leb.py --check \
    target/wasm32-unknown-unknown/release/omnibounty_v3.wasm
python3 ../../tools/canon_leb.py --check \
    tests/mock-mpc/target/wasm32-unknown-unknown/release/mock_mpc.wasm

# 4. Run on Linux/macOS (near-sandbox has no Windows binary; on Windows
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

## Codespaces / proxied environments

If sandbox startup fails with `Failed to connect to RPC service
http://127.0.0.1:<port>/ within N seconds` while the node itself starts
fine, proxy variables are intercepting loopback RPC: HTTP clients route
`127.0.0.1` through the proxy unless bypassed. Export a loopback bypass
before running the suite:

```sh
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
```

## Layout

- `xsuite.rs` — the suite (6 tests, one fresh sandbox deploy each).
- `mock-mpc/` — test-only MPC signer (fixed key, v3.18.0 wire shapes,
  failure-injection modes). Verbatim copy of the proven V2 mock, kept
  independent so V3 collateral never depends on the frozen V2 tree.

## One command

`../run-xsuite.sh` runs everything in order and fails fast: sandbox-binary
provisioning (verified download, cached), unit tests, fixture regen, both
1.86 WASM builds, canonicalize + `--check`, then the sandbox suite (with
the loopback bypass). Same steps as above, nothing skipped.

## Sandbox binary provisioning

`near-workspaces` downloads the `neard` sandbox binary at compile time
with a proxy-blind HTTP client, which fails in sandboxed/proxied
environments even when the URL is alive. `run-xsuite.sh` therefore
exports `NEAR_SANDBOX_BIN_PATH` (the override the crate honors at build
and runtime) via `scripts/ensure-near-sandbox.sh`: curl download of
`near-sandbox 2.9.0`, SHA-256 verification of tarball and binary against
pinned digests, cached at `~/.cache/omnibounty/near-sandbox-2.9.0/`.
Re-runs re-verify the cached digest instead of re-downloading. An
already-exported `NEAR_SANDBOX_BIN_PATH` always wins (checked first).

## Security notes for operators and demos

- **Test witness key.** Fixture proofs are signed by the unit-test key
  `[0x11; 32]` (`src/lib.rs` test helpers, public in-repo). Anyone
  holding it can mint proofs accepted by ANY deployment whose pinned
  epoch contains its address — so never pin fixture witness addresses
  outside sandbox/CI, and never treat fixture-backed demos as live
  verification.
- **Bearer credentials.** An identity proof establishes possession of
  valid GitHub credentials/session at proof time. It does not
  independently establish the legal or personal identity of the human
  operating that session. Do not overstate what Reclaim proves.
- **Fixture freshness.** Claim proofs expire 7 days after `generated_at`;
  regen before any demo or suite run (`run-xsuite.sh` always regens).
- **Refund race.** A qualified-but-unpaid slot may remain refundable
  after the sponsor deadline: Base escrow cannot see pending NEAR
  claims, so nothing on-chain blocks `refundSlot` while a voucher is
  still unrelayed. Available mitigations today: the relayer's 30s poll,
  permissionless redemption (anyone, including the contributor, can
  submit the voucher), and sponsor deadlines set well beyond
  challenge-window + voucher-TTL + relay margin. These narrow the race;
  they do not eliminate it. A refund grace period or escrow-level
  pending-claim protection is recorded future work, not current
  behavior. Monitoring exists only as an unchecked deployment item.
- **Ordering semantics.** Identity binding prevents another person from
  claiming a developer's PR. Genuine races are ordered by the relay
  queue (verified authorship time, then bounty, then slot).
  Timestamp-based slot assignment is not implemented: slots still fill
  in qualification order.
- **What a fixture demo proves.** Recorded fixtures exercise the real
  contract verification path end to end (crypto, joins, rules,
  nullifiers, MPC dispatch shapes) — nothing is mocked except the MPC
  signer transport. They do not prove live GitHub session binding
  (test-witness signatures) and must never be presented as such.
