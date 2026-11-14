# Corrected WASM deployment readiness — OmniBounty V3

Status: PREPARED, NOT DEPLOYED. Live contract remains original 8d578171.
Source: main @ 6c15d03 (tree-identical to c77fd6e for all contract code).

## 1. Corrected changes confirmed (e78c753..c77fd6e)
- 1fb21d4: 2x ok_or_else->ok_or (rules.rs evaluate, TemplateMismatch statics)
  + 3x test-only len()==0->is_empty() (lib.rs:2788, rules.rs:2171, xsuite.rs:306).
- f5b2539: rustfmt whitespace + trailing commas only (token-identical modulo commas).
- c77fd6e: CI workflow e2e-env quoting fix (no contract code).
- Verified: NO struct/enum/function-signature/trait/const changes (grep over full diff);
  Cargo.toml/Cargo.lock untouched; contracts/base-v3 untouched.
- Scope note: the task text mentioned "loan settlement / repayment manipulation /
  milestone release / default handling" fixes — NONE exist in the V3 diff or V3
  codebase scope. The corrected implementation contains exactly the items above
  (plus pre-existing behavior already covered by the suite). Nothing invented.

## 2. Build result
- Clean release build (fresh target dir): `cargo +1.86.0 build --locked --offline
  --target wasm32-unknown-unknown --release` — exit 0, ZERO warnings (log: clean-build.log).
- Raw: 707985 bytes -> canon_leb.py (96 sites) -> 707605 bytes, --check clean.
- Artifact: audit-backup-20261113/corrected/omnibounty_v3.fixed-f5b2539.wasm
- SHA-256: 766c6b14accb4730b634a5d659a10ae804e3e1eb86c77fe1ba9a1fefc02a94d4
- NEAR code_hash (base58, roundtrip-verified): 8yGzesTCJSRu4egz4bBeS19ABLSb6Y6TJQpRHH7quiYj
- Reproducibility: 5 independent builds (3 paths + clean + mirror) all yield
  766c6b14 byte-identically. Intended V3 contract confirmed (exports/producers match).

## 3. Test results
- Unit: 133 passed / 0 failed / 2 ignored (near-v3, current source).
- Clippy CI gate (`--locked --all-targets -- -D warnings`): exit 0, zero warnings.
- rustfmt --check: clean.
- XSuite (sandbox, current source, corrected wasm): 6/6 pass (log: xsuite-final.log).
- Relayer: 82/82 pass. Base-v3: covered by CI green on c77fd6e (base-v3 untouched
  locally; forge unavailable in sandbox).
- CI on PR head c77fd6e: near-unit, near-xsuite, e2e-v3, relayer, base-v3 all success.

## 4. Compatibility with E2E baseline (baseline evidence moved off-tree)
- Reclaim verification: reclaim.rs/ecrecover.rs/rules matchers untouched; vector +
  equivalence tests pass; same pinned epoch/witnesses.
- Qualification/claims: only the two ok_or sites inside evaluate() changed;
  construction is side-effect-free, error values identical; all claim-path unit
  tests + xsuite qualify/finalize/callback scenarios pass on corrected bytes.
- MPC dispatch + VoucherV2: mpc.rs/voucher.rs untouched; digest/typechain identical;
  live 3.19.0 response shape accepted (proven by E2E voucher_signed on original
  bytes; corrected code path is the same code).
- Finalization: lib.rs finalize/on_voucher_signed untouched; xsuite failure-injection
  (modes 0-3) passes on corrected bytes.
- Storage/state: zero schema changes; Borsh field order identical; STATE_BYTES
  ruler unchanged (bounty16=661 claim=115).
- Escrow cross-chain: voucher bytes identical by construction (same inputs ->
  same code -> same digest); escrow untouched; V2 claim path covered by relayer
  tests + e2e-v3 CI green.
- Binary vs deployed 8d578171: imports/type/memory/table/global identical;
  +1 function (ok_or instantiation replaces closure); export NAMES identical (35);
  code +314 B (evaluate + inlining cascade); data same-length string reorder;
  producers identical (rustc 1.86.0).
- HONEST LIMIT: corrected bytes have NOT executed live E2E (only sandbox xsuite
  + static + suite evidence). Claimed: equivalence, not live execution.

## 5. State-preservation assessment
- DeployContract replaces code only; the storage trie is untouched by protocol.
- Schema-identical code deserializes all existing state bit-compatibly.
- Live state that MUST survive (post-E2E values): bounty slots_filled=1 seq=1;
  claim slot 0 status=finalized signed=true; voucher + MPC signature present;
  burned nullifiers (PR+identity); epoch 1 + witness; config next_nonce=1,
  bounty_count=1, paused=false; pr_claims[(id,1)] set.
- No migration, no init, no reconfiguration needed. Interface unchanged, so the
  scheduler, relayer, and tooling keep working unmodified.
- E2E baseline artifacts (txs, receipts, events) are historical on-chain facts;
  a code upgrade cannot invalidate them.
- Post-deploy note: dry_qualify with the SAME archived bundle will now report
  errors (slot filled, nullifiers burned, duplicate PR) — that is correct
  post-state behavior, not a failure. Post-deploy checks assert STATE UNCHANGED.

## 6. Exact deployment command (NOT executed)
  node audit-backup-20261113/deploy-corrected.mjs
- Deploys corrected/omnibounty_v3.fixed-f5b2539.wasm to EXISTING omnibounty-v3.testnet.
- Permissions: FullAccess key for omnibounty-v3.testnet (root .env; verified).
- Built-in gates: artifact hash + size assertion before sending; single
  DeployContract tx; prints tx hash. No account creation, no bounty recreation.
- Cost: ~negligible storage delta (+376 code bytes) + deploy gas; ~15 NEAR balance.

## 7. Post-deploy verification (to run immediately after approval+deploy)
1. view_code sha256 == 766c6b14... && view_account code_hash == 8yGzesTC...;
2. get_config/get_bounty/get_claim/get_voucher/get_epoch/list_unrelayed equal the
   Section 5 values exactly (claim finalized+signed, next_nonce=1);
3. escrow slotStatus claimed + usedVoucher(digest) still true (other chain, unaffected);
4. one scheduler tick observed clean (zero eligible, exit 0).

## 8. Remaining blockers
NONE for deployment mechanics. Residual notes (not blockers): corrected bytes lack
live-E2E execution (by design, pending this deploy); GitHub-token revocation for the
one-time claimant token (operator action, unrelated to deploy).
