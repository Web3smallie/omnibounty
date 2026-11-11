# Recovery redeploy checklist — NEAR callback fix (bounty #3 wedge)

> SUPERSEDED — DO NOT EXECUTE. V1-incident redeploy plan that was never
> carried out: `v2.omnibounty.testnet` was deployed fresh instead, and
> `omnibounty.testnet` still runs the pre-fix code (`abc845…`, verified
> read-only 2026-11-11). Preserved for historical reference only (moved
> from docs/ 2026-11-11).

Deploy-turn procedure for the `VoucherCallbackOutcome` fix. Nothing here
executes until explicitly approved. All commands assume PowerShell at the
workspace root unless noted.

## 0. Pinned expectations (from final verification)

- Source: `contracts/near/src/lib.rs` (1407 lines, CRLF).
- Unit suite: `cargo test` → 44 passed, 0 failed.
- Clippy: `--all-targets --features xsuite` → zero warnings.
- Release artifact: `contracts/near/target/near/omnibounty.wasm`,
  327,928 bytes,
  sha256 `b848653ceaefb361b0b9527ed1a85b641e4faff58fc1abd4873e2af330abba4b`.
- Currently deployed: 328,572 bytes, sha256
  `abc845eacd273062f0c3c6ce9e775495547c05817bb1aa85ab977408a1f52590`
  (backup at `.link-temp/wasm_deployed.wasm`).
- ABI delta (machine diff deferred to Linux; source-certain): 26 functions
  unchanged; `on_voucher_signed.result.$ref` becomes
  `#/definitions/VoucherCallbackOutcome`; one new
  `VoucherCallbackOutcome` enum definition
  (`Applied(SignedVoucherView)` / `Rejected(String)`). Deployed-ABI
  baseline preserved at `.link-temp/abi_deployed.json`.

## 1. Pre-deploy snapshot (read-only)

Record every output with timestamps (new `testdata/redeploy_*.json`
record at deploy time). Expected pre-deploy values in brackets.
All RPC POSTs use `Content-Type: application/json` plus
`User-Agent: omnibounty-probe/1.0` (public RPCs reject headerless
clients); decode `call_function` results from the byte array.

```powershell
# 1a. Deployed code hash [must be abc845ea…2590]
#   query view_code omnibounty.testnet → sha256 hex of code_base64
# 1b. Config [escrow=0xee5c…c99, signer=0xc83b…b3cc, next_nonce=1,
#     bounty_count=3, unpaused]
#   get_config {}
# 1c. Bounties [1 open validation, 2 open cancelled-Base-side,
#     3 PENDING wedged — must stay exactly so through redeploy]
#   get_bounty {"bounty_id":1|2|3}
# 1d. Epoch [1 → single witness 0x2448…9072]
#   get_epoch {"epoch_id":1}
# 1e. Base side untouched [escrow USDC balance, sponsor balance]
#   cast call <USDC> 'balanceOf(address)' <escrow|sponsor>
```

## 2. Rebuild reproducibility check

```powershell
cd contracts/near
# (workspace CARGO_HOME/RUSTUP_HOME/TMP redirects + nearhome redirect,
#  Cargo.lock backup/restore — see final verification report)
cargo-near near build non-reproducible-wasm --no-abi
# assert: sha256(target/near/omnibounty.wasm) ==
#   b848653ceaefb361b0b9527ed1a85b641e4faff58fc1abd4873e2af330abba4b
```

`--no-abi` is required in this Windows sandbox: the ABI-gen host link
step fails on MSVC (LNK2019 on near-sys externs — cargo-near
tooling issue, not contract code). Full build incl. ABI must run on
Linux/macOS; diff its `omnibounty_abi.json` against
`.link-temp/abi_deployed.json` and confirm ONLY the §0 delta.

## 3. Redeploy (owner key, TESTNET ONLY)

- Account MUST be `omnibounty.testnet`, network MUST be testnet.
- Send a bare `DeployContract` with the §0 wasm bytes. NO `new()` /
  init call — state must carry over untouched (schema verified
  byte-identical: same fields, order, types, collection prefixes).
- Use a transient driver (key from `secrets/`, never on a command
  line), 2+ block confirmations. Record tx hash + block.
- Immediately: `view_code` → MUST equal the §0 sha256. Any other
  value → stop, investigate, consider rollback (§6).

## 4. Post-deploy state verification (read-only)

Re-run every §1 read and diff against the snapshot. ALL of the
following must hold exactly (only the code hash changes):

- `get_config`: byte-identical (owner, pause, MPC contract/signer,
  escrow, chain, path, domain, freshness, nonce, count).
- `get_bounty(1/2/3)`: identical — #3 still `pending` (the fix
  prevents future wedges; it cannot unwedge #3).
- `get_epoch(1)`: identical witness set.
- Negative control: `dry_run` (spike proof vs bounty #1) fails closed
  with the identical code as pre-deploy — proves verification logic
  intact.
- Escrow/sponsor USDC balances unchanged (deploy touches no funds).

## 5. Controlled failure-behavior test (throwaway accounts ONLY)

Never test failure modes against `omnibounty.testnet` production
state. Procedure (fresh helper accounts, mirroring the xsuite):

1. Build `tests/mock-mpc` to wasm; deploy mock + a fresh copy of the
   fixed contract to throwaway testnet accounts.
2. `new(owner, mock-address, escrow-placeholder, 84532)`,
   `set_mpc_signer(<mock key 0x42… address>)`, `upsert_epoch`,
   `create_bounty` (e.g. id 7, fixture terms).
3. For mock modes 1 (panic), 2 (garbage), 3 (wrong key): `claim` →
   assert tx SUCCEEDS, return value is
   `{"Rejected": "MPC_*"}`, `voucher_rejected` log present,
   `get_bounty` back to `open`; then reset mock to mode 0 and
   re-`claim` → `Applied`, `claimed`.
4. Delete/abandon throwaways (no funds involved at any point).

## 6. Rollback plan

If ANY §4 check fails: redeploy `.link-temp/wasm_deployed.wasm`
(abc845…) with the §3 procedure (no init), re-verify old hash +
§1 snapshot identical. Safe: schema unchanged in both directions.

## 7. Explicit non-goals for the deploy turn

- No bounty #3 Base cancel (separate approval).
- No bounty #4 creation/funding (separate approval).
- No production MPC retry (separate approval, after §5 passes).
- No monitoring changes (note: failures now surface as `Rejected`
  returns + `voucher_rejected` logs on successful receipts — update
  operator runbook accordingly).
