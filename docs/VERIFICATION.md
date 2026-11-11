# OmniBounty verification report

Evidence log for independent Phase 1 verification. Every claim below is tied
to a command, a fixture, or an observed output. Nothing in this file is
aspirational: unproven items are listed under Outstanding.

## 1. Fixture integrity (`tools`)

- `node gen_fixtures.mjs`: regenerates `testdata/{reclaim,canon,normalize,eip712,e2e_claim}.json`
  from first principles with ethers v6 as oracle. Generator self-checks
  (identifier recomputation, witness recovery, MPC R-point validity) must
  pass or generation aborts. The e2e MPC response mirrors the exact
  deployed v3.18.0 envelope (scheme tag + compressed R point).
- `node check_equivalence.mjs`: recomputes every committed vector.
  Result: **all checks passed**.
- All keys in fixtures are fixed test-only values, documented in
  `tools/gen_fixtures.mjs`. Production code never embeds keys.
- `python tools/preflight.py`: live-network prerequisites (NEAR testnet
  status, MPC + Reclaim code hashes, Base chain ID + USDC presence,
  crates/GitHub/helper reachability). Result: **all checks passed**.

## 2. NEAR contract (`contracts/near`)

- `cargo test` (default features, hermetic): **44 passed, 0 failed** —
  normalization matrix (oracle), canonical-JSON matrix incl. UTF-16 key
  order (oracle), spike + steam verification vectors, synthetic merged-PR
  end-to-end claim (reserve → MPC apply → claimed → replay rejected),
  tamper cases (identifier, signature, witness, duplicates),
  non-canonical params/context handling, freshness (stale/future),
  admin/bounty guards, unknown epoch, MPC mismatch/release paths,
  MPC v3 request-serialization + tagged-envelope parsing, voucher digest
  cross-checks (oracle), U256 amount edges, real-callback regression
  matrix: success applies, garbage/wrong-signer/failed-promise return
  `Rejected` + release (never wedge), unknown digest + bad hex no-op,
  stale callback inert, retry-after-failure succeeds (§11).
- `cargo test --features xsuite`: additionally compiles
  `tests/cross_contract.rs` (near-workspaces 0.10): full promise/callback
  lifecycle plus MPC outage / garbage-response / wrong-signer failure
  injection against `tests/mock-mpc` (exact v3.18.0 wire shapes, fixed
  test key, sandbox-only). Sandbox mode runs on Linux/macOS; the
  near-sandbox binary has no Windows build (verified in
  `near-sandbox-utils-0.7.0/src/lib.rs`), and testnet mode needs working
  Rust TLS — both unavailable in this sandbox, so the live leg runs via
  `tools/live_handshake.mjs` instead (see §8).
- `cargo clippy --all-targets --features xsuite`: **zero warnings**.
- `cargo build --target wasm32-unknown-unknown --release`: **succeeds**,
  `omnibounty.wasm` (549,278 bytes), zero warnings.
- `cargo near build non-reproducible-wasm` (cargo-near 0.23.0, Rust
  1.86.0): **succeeds** — `target/near/omnibounty.wasm` (328,572 bytes,
  sha256 `abc845ea…2590`) + `omnibounty_abi.json` (26 functions, schema
  0.4.0); this exact artifact is deployed on testnet (§8b).
  `rust-toolchain.toml` pins 1.86.0 for byte-identical reviewer rebuilds.
- No-panic audit: `unwrap(`/`expect(`/`panic!`/`todo!` appear only inside
  `#[cfg(test)]` or the deployer-config `new` (verified by search over
  `contracts/near/src`). The only production failure mechanism is
  `env::panic_str` with stable `CODE: detail` strings. The MPC callback
  deliberately reads `env::promise_result` raw bytes: a typed
  `#[callback_result]` would panic inside the framework on any shape
  mismatch and wedge the bounty in `Pending` (observed live, then fixed).
- `Cargo.lock` pins near-sdk 5.1.0, k256 0.13.3 (`ecdsa` feature only),
  serde 1.0.229, serde_json 1.0.117, borsh 1.8.1, schemars 0.8.22,
  time 0.3.36, hex 0.4.3, near-workspaces 0.10.0 + tokio 1.38.0
  (feature `xsuite` only), with standard sparse URLs + checksums
  (via `tools/finalize_lock.py`).

## 3. Base escrow (`contracts/base`)

- `forge test` (solc 0.8.24, forge-std v1.17.0):
  **30 passed, 0 failed** — oracle typehash/struct-hash/digest
  cross-checks, e2e struct-hash cross-check, end-to-end claim, replay,
  tamper matrix (all 8 voucher fields), auth/expiry/fork guards,
  lifecycle, admin, token oddities (no-return/reverting), 2 fuzz suites
  (256 runs each), **plus `LiveVoucherTest`: a REAL testnet MPC signature
  over a REAL voucher digest settles end to end** (digest bit-equality vs
  NEAR, ecrecover vs the derived MPC signer, payout, single-use replay).
- Production sources lint-clean (one documented `block-timestamp`
  acceptance on the expiry check; remaining lints are forge-std's own).

## 4. Relayer (`relayer`)

- `npm test` (node:test, mocked transports): **23 passed, 0 failed** —
  config validation + secret redaction, voucher validation incl. oracle
  digest cross-check, NEAR RPC decoding/errors, state store round-trip +
  corrupt recovery, relay happy path, on-chain-used skip, invalid skip,
  revert-final vs transient-retry, full escrow-error finality matrix
  (S-04: every `OmniEscrow` custom error is final after one attempt),
  idempotent re-poll, poll-failure survival.

## 5. Frontend (`frontend`)

- `npm test`: **5 passed, 0 failed** (validation incl. real spike proof in
  both shapes, malformed rejection, bounty input).
- `npm run build` (Next 15.5.29): **production build succeeded**, 4 routes;
  the prerendered sponsor page contains every form label verbatim.
- Live-server smoke: **blocked by the sandbox** — `next start` fails with
  `listen EACCES: permission denied 0.0.0.0:<port>` (listening sockets are
  forbidden here; reproduced twice). Reviewers run `npm run dev` and open
  http://localhost:3000 (see README).

## 6. Cross-implementation equivalence (the trust triangle)

| Vector | ethers oracle | Rust | Solidity |
|---|---|---|---|
| EIP-712 typehash | gen | `constants_match_literals` | `testTypehashMatchesOracle` |
| structHash ×3 + e2e | gen | `oracle_fixture_digests_match` | `testStructHashMatchesOracle`, `testE2EStructHashMatchesOracle` |
| digest ×3 | gen | same test | `testDigestAssemblyMatchesEIP712` (assembly) |
| e2e digest | gen | `dry_run_matches_oracle_digest`, `full_claim_lifecycle` (exact) | via structHash + assembly |
| **live digest `0x8ec9…ecdf`** | **handshake recompute** | **on-chain self-check** | **`LiveVoucherTest` (bit equality)** |
| live sig ecrecover | handshake | self-check vs derived key | `claim` vs `mpcSigner` |
| spike id/sign-data/signer | gen+check | `spike_proof_verifies_with_sdk_native_forms` (byte equality) | n/a (NEAR-side) |
| canon JSON ×14 | gen+check | `oracle_fixture_matrix` (byte equality) | n/a |

## 7. Sandbox workarounds (local only, not part of the product)

- Cargo/curl TLS (schannel) is broken in this sandbox, so crates.io files
  were fetched with Python HTTPS (and rustup's own downloader, which
  works) into workspace-local `CARGO_HOME`/`RUSTUP_HOME`; resolution ran
  against a locally built file:// git registry mirror
  (`tools/vendor_crates.py`, `tools/local_registry.py`,
  `tools/mirror_extras.py`, gitignored
  `contracts/near/.cargo/config.toml`), and `tools/finalize_lock.py`
  converts the resulting lock to standard sparse URLs. Committed
  `Cargo.lock` files use standard sparse URLs + crates.io checksums;
  reviewers with working cargo networking build without any of this.
  Local sandbox rebuilds rewrite locks to mirror URLs; re-run
  `finalize_lock.py` afterwards (documented here, no hidden state).
- npm cache redirected into the workspace (`.npm-cache`, gitignored).
- solc 0.8.24 + cargo-near 0.23.0 binaries fetched directly (`.tool-bin`,
  gitignored, sha256-verified); `foundry.toml` pins solc so forge
  auto-installs it on reviewer machines.
- forge-std v1.17.0 fetched as a tarball into `contracts/base/lib`
  (gitignored); reviewers run the documented `forge install`.
- Linker temp + near-cli home redirected into the workspace (MSVC
  `link.exe` and near-cli config need writable homes).
- Rust-TLS breakage also affects `near-workspaces` testnet mode here, so
  the live leg runs through Node (`tools/live_handshake.mjs`, near-api-js)
  instead of the Rust testnet arm; both assert the same invariants.

## 8. Live MPC handshake (testnet, real transactions)

`node tools/live_handshake.mjs` (exit 0): deployed the contract to
`ob-live-ctr-20261108214633-004029.testnet`, derived the voucher signer
`0x48bb0e5a8cb09998245b36401afd536a68ede272` (KDF MATCH + direct RPC view
agreement), configured epoch/signer/freshness/bounty, ran `claim` against
the REAL `v1.signer-prod.testnet`, observed `claim_submitted` →
`voucher_signed`, recomputed the EIP-712 digest independently
(`0x8ec9…ecdf` — exact match), verified ecrecover equals the derived
signer, confirmed bounty `claimed` + identifier nullified, and confirmed
cross-bounty replay fails with `IDENTIFIER_REPLAY`. All transaction hashes
are recorded in `testdata/live_voucher.json` (claim:
`DjQ1xLSCfkLwoB7Wf6KbLGFiun4boNHdfFGQE3cfSNJL`).

Debugging trail (each fixed and re-verified, none hidden): the deployed
MPC rejects the legacy flat-arg/v1 request shape (`missing field
'request'`) and zero-deposit calls; it returns compressed R points, not
uncompressed; a typed `Vec<u8>` callback result panics in the framework
(`invalid type: map, expected a sequence`) — hence raw-bytes
`promise_result` parsing; `dry_run` and `claim` digests legitimately differ
by TTL seconds; the testnet helper can no longer create bare top-level
accounts (`CreateAccountOnlyByRegistrar` — `*.testnet` subaccounts used)
and rate-limits creation (HTTP 429 with backoff in the script).

## 8b. Production testnet deployment (`omnibounty.testnet`)

`node tools/deploy_production.mjs` (fresh run): the name was unclaimed
(RPC `UNKNOWN_ACCOUNT` before claiming), claimed it via the testnet
helper, and deployed the §2 cargo-near artifact — 328,572 bytes,
sha256 `abc845ea…2590` — in tx
`4QAMVHYTvTwSRMXFLk593ddVBDUEZwoSbdjSHxESmfDn`. It then configured
`new` (owner/mpc/escrow-placeholder/84532), epoch 1 with the confirmed
live witness `0x2448…9072`, MPC signer `0xc83b…b3cc` (KDF MATCH), and
production freshness (7d/5m/24h TTL), and created validation bounty #1
(react/react#1, $1 USDC terms). The fresh run crashed before writing
its record: `dry_run` PANICS on failure by design (fail-closed, like
`claim`), and near-api-js surfaces that as a thrown view error, not an
`ERR` string — the script now asserts on the panic's stable error code
and a `--resume` mode re-verifies without new transactions.

`node tools/deploy_production.mjs --resume` (exit 0): re-verified
everything read-only — on-chain `view_code` hash equals the local
artifact byte-for-byte, config/epoch/bounty match, and the NEGATIVE
`dry_run` with the real spike proof fails closed with
`PREDICATE_FAILED` (spike PR unmerged) — then wrote the public record
`testdata/production_testnet.json`. Deploy-key custody:
`secrets/omnibounty.testnet.json` (gitignored, operator backs up).

Provenance notes: (a) the local near-api-js `deployContract` action was
shown to carry the full 328,572 bytes; (b) RPC `tx` status for the
deploy tx returns `SuccessValue` with the `code` field shown as the
32-byte sha256 `abc845ea…2590` — i.e. the artifact hash, not a
different payload; (c) `view_code` confirms the stored bytes hash to
the same value. No other artifact was ever deployed to this account.

## 9. Outstanding (genuinely unproven)

- Base Sepolia escrow deployment + `set_escrow` update (NEAR side still
  points at the `0x1111…` placeholder), and the funded $1 end-to-end
  payout run in `docs/DEPLOYMENT.md` §5 (requires a funded Base EOA
  with Sepolia ETH + USDC and a real Reclaim proof — operator
  credentials, not code). Phase 5 implementation status: the deployment
  path is now scripted (`tools/deploy_escrow.mjs`: chain/USDC/KDF gates,
  immutable deploy, on-chain config + domain verification, public record;
  `tools/set_escrow.mjs`: owner wiring + verification, with read-only
  `--check-only` modes). Both scripts were gate-verified (fail-fast
  without keys, unreachable-RPC refusal, read-only preview against live
  testnet) but have NOT broadcast anything: no deployer key, no funded
  Base EOA, and no Reclaim credentials exist in this environment
  (verified by env + workspace sweep). No `testdata/base_sepolia.json`
  record exists — none was fabricated.
- `near-workspaces` SANDBOX execution (the suite compiles and its
  assertions mirror the live run, but the sandbox binary is Linux/macOS
  only — reviewers run `cargo test --features xsuite` there).
- Frontend live-server smoke (sandbox network restriction, §5).
- `cargo-near reproducible-wasm` (Docker-based; no Docker in this
  environment — the standard `cargo-near` build + ABI in §2 is done).

## Run log (final)

```
# tools
$ node check_equivalence.mjs
all fixture checks passed
$ python tools/preflight.py
preflight: all checks passed
$ node tools/mpc_derive.mjs omnibounty.testnet omnibounty-voucher-v1
kdfCheck: MATCH, voucherAddress: 0xc83b76aef4db9a14fcd4abcceb99b0fc27ebb3cc
$ node tools/live_handshake.mjs
LIVE HANDSHAKE COMPLETE (claim DjQ1xLSCfkLwoB7Wf6KbLGFiun4boNHdfFGQE3cfSNJL)
$ node tools/deploy_production.mjs --resume
PRODUCTION TESTNET DEPLOYMENT COMPLETE (omnibounty.testnet, deploy tx
4QAMVHYTvTwSRMXFLk593ddVBDUEZwoSbdjSHxESmfDn, negative dry_run PREDICATE_FAILED)

# contracts/near (workspace CARGO_HOME, file:// mirror)
$ cargo test
test result: ok. 37 passed; 0 failed
$ cargo test --features xsuite --test cross_contract --no-run
Finished test profile (compiles; sandbox runs on Linux/macOS)
$ cargo clippy --all-targets --features xsuite
(no warnings)
$ cargo build --target wasm32-unknown-unknown --release
Finished release profile ... omnibounty.wasm (549278 bytes)
$ cargo near build non-reproducible-wasm   # cargo-near 0.23.0, Rust 1.86.0
target/near/omnibounty.wasm (328572 bytes, sha256 abc845ea...2590) + ABI (see §2)

# contracts/base (solc 0.8.24)
$ forge test
Ran 2 test suites: 30 tests passed, 0 failed, 0 skipped

# relayer
$ npm test
tests 22, pass 22, fail 0

# frontend
$ npm test
tests 5, pass 5, fail 0
$ npm run build
Compiled successfully ... Generating static pages (4/4)
$ npm run start -- --port 3107
Error: listen EACCES: permission denied (sandbox restriction)
```

## 10. Phase 5 implementation (fresh runs, 2026-11-09)

S-04 fixed (relayer finality regex now names every `OmniEscrow` custom
error; new matrix test fails-before/passes-after), deployment path
scripted (`tools/deploy_escrow.mjs`, `tools/set_escrow.mjs`), Base README
test count corrected (28 → 30). No contract source changed. No
transactions broadcast (no keys — see §9). Tracked `Cargo.lock` verified
byte-identical (sha256 `8425b15e…cb6559`) before and after every cargo
invocation via backup/restore.

```
# relayer (S-04 fix; node --test)
$ npm test
tests 23, pass 23, fail 0

# frontend
$ npm test
tests 5, pass 5, fail 0
$ npm run build
Compiled successfully ... 4 routes

# tools + preflight
$ node check_equivalence.mjs
all fixture checks passed
$ python tools/preflight.py
preflight: all checks passed

# contracts/base (workspace-local solc 0.8.24: `forge test` alone fails
# here only because the sandbox blocks forge's solc auto-install; the
# pinned binary in .tool-bin is used instead — no config changed)
$ forge test --use ../../.tool-bin/solc-0.8.24.exe
Ran 2 test suites: 30 tests passed, 0 failed, 0 skipped

# contracts/near (workspace CARGO_HOME/RUSTUP_HOME/TMP redirect; lock guarded)
$ cargo test
test result: ok. 37 passed; 0 failed
$ NEAR_SANDBOX_BIN_PATH=<stub> cargo test --features xsuite --test cross_contract --no-run
Finished test profile (compiles; execution still needs Linux/macOS —
near-workspaces build script has no Windows sandbox binary)
$ cargo clippy --all-targets --features xsuite
Finished (no warnings)

# deploy-script gates (no keys present; nothing broadcast)
$ node tools/deploy_escrow.mjs
FAIL: missing env BASE_RPC_URL (exit 1)
$ node tools/set_escrow.mjs 0x1111... --check-only
FAIL: refusing to wire the placeholder address
$ node tools/set_escrow.mjs 0x0000...0001 --check-only
current escrow: 0x1111... (placeholder — unwired, as expected)
CHECK-ONLY COMPLETE: no transaction sent.
```

## 11. MPC-callback wedge fix (bounty #3 incident)

Live finding: a real MPC response failed strict parsing
(`MPC_BAD_RESPONSE: big_r prefix/recovery_id`), and bounty #3 wedged in
`Pending` permanently. Root cause: `on_voucher_signed` released the
bounty and then panicked — NEAR rolls back a panicking receipt's state
changes, discarding the release. (`#[handle_result] Result<..>` panics
on `Err` too, so it cannot fix this; verified in
`near-sdk-5.1.0/src/types/error.rs`.)

Fix (`contracts/near/src/lib.rs`, no storage changes, no migration):
`on_voucher_signed` keeps `#[private]` and now returns
`VoucherCallbackOutcome::{Applied, Rejected}` as DATA — the receipt
always succeeds, so releases commit. Every rejection keeps the stable
`CODE: detail` string and emits a `voucher_rejected` log. `claim()`
still panics only before any mutation (verified safe). Stale callbacks
(unknown digest) return `Rejected` with zero state change. MPC
timeout/absence (callback never runs) remains a documented residual:
no receipt executes, so no code can release; recovery from absence
would require a new privileged transition, deliberately not added
(MPC has always
responded; the incident was a malformed response, not absence).

```
$ cargo test
test result: ok. 44 passed; 0 failed   # 37 existing + 7 real-callback
$ NEAR_SANDBOX_BIN_PATH=<stub> cargo test --features xsuite --test cross_contract --no-run
Finished (compiles; failure test updated to assert Rejected + release)
$ cargo clippy --all-targets --features xsuite
Finished (no warnings)
```

Negative control: the 7 new tests run against the panic-version
callback abort with `GuestPanic("MPC_BAD_RESPONSE: ...")` — they fail
on the old code and pass on the new code. Tracked `Cargo.lock`
byte-identical throughout (backup/restore, sha256 verified).

Still open: xsuite sandbox EXECUTION needs Linux/macOS (no Windows
sandbox binary; reqwest pinned to native-tls/schannel, broken in this
sandbox, so testnet mode cannot run here either) — reviewers run
`cargo test --features xsuite` there. The MPC response anomaly itself
(one malformed response from unchanged v3.18.0) is unclassified
pending one retry data point on a fresh bounty. Bounty #3 is NOT
recoverable by this fix (already wedged; its $1 is refundable via
sponsor `cancelBounty` on Base). No redeploy performed; re-verify the
code hash after the authorized redeploy, since the artifact changes.

## 12. V2 frontend implementation (2026-11-11)

Marketplace UI built on the existing V2 backend (no contract or relayer
source changes; `Cargo.toml`/`Cargo.lock` verified byte-identical by
sha256 after the regression runs below).

```
# frontend
$ npm test
tests 32, pass 32, fail 0   # validation + display + env (no network)
$ npm run build
Compiled successfully ... 4 routes (/, /bounties/new static+dynamic, /bounties/[id])
$ npm run start -- --port 3107
Error: listen EACCES: permission denied (sandbox restriction, same as §5)

# regression (unchanged backend)
$ cd relayer && npm test
tests 26, pass 26, fail 0
$ cd tools && npm run check
all fixture checks passed
$ cd contracts/base && forge test --use ../../.tool-bin/solc-0.8.24.exe
Ran 2 test suites: 30 tests passed, 0 failed, 0 skipped
$ cd contracts/near && cargo test --locked   # workspace CARGO/RUSTUP/HOME+TMP;
test result: ok. 44 passed; 0 failed         # near-workspaces =0.21.0 is
$ cargo clippy --locked --all-targets        # absent from the local mirror,
(no warnings)                                # so the run used a temporary
                                             # =0.10.0 relaxation of that
                                             # xsuite-only dep, restored
                                             # afterwards (hash-verified)
```

Live read-only integration (no transactions): NEAR `get_config`
(mpc_signer `0x73df…`, escrow `0xee5c…`, chain 84532),
`list_bounties` (#1 open, #2 claimed, #4 open), `get_voucher(2)`
(digest `0x4403…`), Base `mpcSigner` == `0x73df…`,
`bounties(2)` funded+claimed 1000000, `usedVoucher(0x4403…)` == true,
and the payout receipt `0xead24060…` (status 1, USDC Transfer 1000000
escrow→`0xaa77…` + VoucherClaimed bounty 2). Two real RPC behaviors
shaped the implementation: `eth_getLogs` over >200 blocks is refused
(chunked scans), and Base Sepolia currently runs ~5 blocks/second
(timestamp bisection, not block-rate estimation, locates the claim
block). The settlement scan (bisect + chunked `eth_getLogs` + the
tested log parser) resolves bounty #2 to `0xead24060…` live.
