# OmniBounty NEAR contract

Owns the Reclaim verification boundary, the bounty registry, replay-safe
claims, and EIP-712 voucher authorization via Chain Signatures (MPC).

## Layout

- `src/lib.rs` — state, admin, bounties, claim flow, MPC callback, views.
- `src/error.rs` — stable `CODE: detail` errors; no panics on user input.
- `src/normalize.rs` — strict hex parsing (H1): optional single `0x`,
  exact length, case-insensitive, lowercase canonical output.
- `src/canon.rs` — canonical JSON compatible with `canonicalize@2.1.0`
  (verified by oracle fixtures, including UTF-16 key order).
- `src/reclaim.rs` — identifier binding, EIP-191 sign-data, secp256k1
  recovery, pinned-witness-set matching.
- `src/template.rs` — GitHub PR binding: exact URL, well-formed matchers,
  and the `merged=true` + author/repo/number predicate.
- `src/voucher.rs` — EIP-712 domain/struct/digest (byte-matched with the
  Solidity escrow and `testdata/eip712.json`).
- `src/mpc.rs` — Chain Signatures request/response parsing and the
  on-chain signer self-check.

## Build & test

```sh
cargo test        # hermetic unit + adversarial suite (uses ../../testdata fixtures)
cargo test --features xsuite   # + near-workspaces cross-contract suite
                               #   (tests/cross_contract.rs; sandbox needs Linux/macOS)
cargo build --target wasm32-unknown-unknown --release   # deployable artifact
cargo near build non-reproducible-wasm                  # standard artifact + ABI
```

`Cargo.lock` + `rust-toolchain.toml` (1.86.0) are committed. Rust 1.86.0 is
required for NEAR builds (`cargo-near` refuses newer toolchains for near-sdk
5.1); unit tests also run on recent stable toolchains.

## Key behaviors

- The deployed Reclaim verifier is never called; witnesses are pinned per
  epoch under owner governance (`upsert_epoch`).
- `claim` verifies, reserves (`Pending`), and requests an MPC signature over
  the voucher digest. `on_voucher_signed` re-derives the signer and requires
  the configured MPC address before finalizing (`Claimed` + nullifier).
- MPC failure returns `Rejected(code)` with a successful receipt so the
  release to `Open` COMMITS (a panic would roll it back and wedge the
  bounty — see `VoucherCallbackOutcome`). Retries are safe and
  double-claims are impossible (pending marker + identifier nullifier).
- `dry_run` executes the full pipeline read-only for preflight checks.
- Payout always goes to the proof owner (`RECIPIENT_MISMATCH` otherwise),
  so frontrunning a claim cannot steal funds.
