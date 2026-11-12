# OmniBounty NEAR V3 — Contract Architecture

Status: APPROVED DESIGN (Phase 3). Implements `docs/v3/ACCEPTANCE_CRITERIA_SPEC.md`
against the evidence in `experiments/phase{1,2}-*` and fixtures in `testdata/v3/`.
Crate: `contracts/near-v3/` (fresh deployment; V2 winds down independently —
no migration code, no shared state).

## 1. State structures

All structs Borsh-serialized. Integers fixed-width; hashes `[u8; 32]`;
addresses `[u8; 20]`; amounts big-endian u256 `[u8; 32]` (EVM-exact).

```rust
Contract {
    owner: AccountId, pending_owner: Option<AccountId>,   // 2-step transfer
    paused: bool,
    mpc_contract: AccountId,
    mpc_signer: Option<[u8; 20]>,    // pinned expected signer (v/r recovery check)
    escrow: [u8; 20], chain_id: u64, voucher_path: String, domain_id: u64,
    max_proof_age_sec: u64, future_skew_sec: u64, voucher_ttl_sec: u64,
    pending_timeout_sec: u64,        // stuck-dispatch supersede horizon (6h)
    next_nonce: u64,                 // global voucher uniqueness (gaps allowed)
    bounty_ids: Vec<u64>,            // bounty_count == len (no separate field)
    epochs: LookupMap<u64, PinnedEpoch>,             // 'e' (u64 ids, V2 shape)
    bounties: LookupMap<u64, BountyV3>,              // 'b'
    claims: LookupMap<(u64, u8), ClaimRecord>,       // 'c' keyed (bounty, slot)
    pr_claims: LookupMap<(u64, u64), u8>,            // 'q' (bounty, pr) -> slot
    nullifiers: LookupSet<[u8; 32]>,                 // 'n' scoped replay keys
    pending: LookupMap<[u8; 32], PendingVoucher>,    // 'p' keyed by digest
    vouchers: LookupMap<(u64, u8), SignedVoucher>,   // 'v' keyed (bounty, slot)
    relayed: LookupSet<[u8; 32]>,                    // 'r' digest set (UX hint)
}
PinnedEpoch { witnesses: Vec<[u8; 20]> }  // ALL must sign

BountyV3 {
    id: u64, sponsor: AccountId, token: [u8; 20],
    criteria_hash: [u8; 32],          // keccak(canonical criteria JSON)
    slots: Vec<[u8; 32]>,             // per-slot base units (BE u256, ≤16)
    slots_filled: u8,                 // count + next slot index
    total_amount: [u8; 32],           // checked sum(slots) at creation
    funded: bool,                     // sponsor attests Base funding (UI also reads escrow)
    deadline: u64,                    // 0 = none (seconds); copied from criteria
    challenge_window: u64,            // seconds, 0 = immediate finality; copied
    created_at: u64,
    seq: u64,                         // per-bounty monotonic claim sequence
}
// NOTE: repo/policy/evidence_max_age live ONLY in the criteria document and
// are re-validated + re-hashed from the claim-supplied copy on every claim,
// so no setters or stored copies can drift from the commitment.

ClaimRecord {
    bounty_id: u64, slot: u8,
    pr_number: u64, head_sha: [u8; 20],
    recipient: [u8; 20], claim_seq: u64,
    qualified_at: u64,
    status: u8,                       // 0 Challengeable, 1 Finalized(dispatched)
    pending_digest: Option<[u8; 32]>, // in-flight MPC digest, if any
}
// NOTE: no stored "Signed" status — signed-ness is `vouchers.contains` (one
// source of truth). No stored proof list — audit via events + nullifiers,
// re-execution via dry_qualify (see §3: no counter-evidence engine).
// `claim_qualified` carries `evidence_digest` = keccak256 over the sorted
// per-proof (evidence_type || identifier) records, which auditors recompute
// from the qualify tx args (audit trail only; not part of VoucherV2).

PendingVoucher {
    bounty_id: u64, slot: u8, voucher: VoucherV2, claim_seq: u64,
    dispatched_at: u64,               // re-finalize timeout anchor
}

VoucherV2 {
    bounty_id: u64, slot_index: u8,
    recipient: [u8; 20], token: [u8; 20], amount: [u8; 32],
    nonce: u64, expiry: u64, chain_id: u64, escrow: [u8; 20],
    criteria_hash: [u8; 32],          // NEW: binds payout to committed terms
}
SignedVoucher { voucher: VoucherV2, v: u8, r: [u8; 32], s: [u8; 32] }
```

Rationale notes: tuple `(u64, u8)` map keys serialize deterministically;
`u8` slots (max 16 enforced, so `slots_filled` cannot overflow); claim
sequence is per-bounty (`seq` — global ordering across bounties is
meaningless since slots are per-bounty); no `version`/`mpc_version` fields
shipped (fresh deployment, no migration; the signer address is the binding).
V2 untouched.

## 2. Bounty lifecycle

```
                  create_bounty_v3            mark_funded              slot fills
NONE ─────────────────────────► OPEN(unfunded) ─────────► OPEN(funded) ─────────┐
                                       │                         │ qualify*     │
                                       │                         ▼              ▼
                                       │                    (slots fill)   CLOSED ◄── all slots filled
                                       │                         │
                                       └──── deadline passes ────┴──► EXPIRED-OPEN
                                                                              (no new qualifications;
                                                                               in-flight claims finalize;
                                                                               unfilled slots refundable on Base)
```

- `create`: validates criteria JSON strictly (full schema port), hashes,
  stores hash + slot/deadline/window copies. Requires a storage deposit
  covering the measured delta (closes V2's contract-pays-storage gap);
  overpayment is kept by the contract — no refund promises, no reentrancy
  surface (callers attach small deposits; frontends estimate).
- `mark_funded` (sponsor-only): asserts Base funding completed. Trust note:
  a lying sponsor only bricks their own bounty (escrow reverts unfunded
  payouts) and the UI independently shows escrow state. Claims require
  `funded == true`.
- `Closed` ⟺ `slots_filled == slots.len()`. Expiry blocks `qualify` only;
  qualified claims always finalize; refunds live on Base (deadline-gated,
  sponsor-only, per unclaimed slot).

## 3. Claim lifecycle (per slot)

```
                     qualify_claim
                     (all checks pass,
                      slot + seq assigned,
                      nullifiers spent)
no claim ─────────────────────► CHALLENGEABLE
                                      │ window elapsed, permissionless finalize_claim
                                      ▼
                                   FINALIZED ──MPC ok──► SIGNED (voucher stored;
                                      │                 relayer settles on Base)
                                      └──MPC fail/garbage ──► FINALIZED (retry
                                          (pending released)   with fresh digest;
                                                               nonce burned, gap documented)
```

- Qualification assigns `slot` = next open index (`slots_filled`, which
  equals lowest-unfilled since slots never free) and `claim_seq` =
  `bounty.seq++` as the LAST mutations (failed attempts consume nothing).
  Fairness gate: when `deadline != 0`, qualification is rejected with
  `CHALLENGE_WINDOW_EXCEEDS_DEADLINE` if `now + challenge_window` would
  exceed the deadline (exact boundary allowed; `deadline == 0` skips);
  `dry_qualify` reports the identical deterministic rejection. Rejected
  claims burn no nullifiers.
- `(bounty, pr_number)` recorded at qualification: same-PR second claims
  rejected regardless of prover/recipient. Same prover, different PRs: allowed.
- NO counter-evidence challenge engine ships (deliberate cut from the draft
  design): with deterministic point-in-time verification, counter-evidence
  challenges are vacuous — mutable classes (labels/reviews/check conclusions)
  cannot be absence-proven, and immutable classes (SHAs/numbers/diffs of a
  fixed head) cannot regress. The challenge window is therefore a fixed
  transparency delay (anyone may re-execute the claim via `dry_qualify`
  before finalization) plus a pause hook for the owner. There is no VOIDED
  state, no slot freeing, and no nullifier release: qualification is final
  once all verdicts PASS.
- Stuck-dispatch recovery (no privileged role): a pending MPC request older
  than `pending_timeout_sec` (6h) may be superseded by a fresh permissionless
  `finalize_claim`, which removes the stale pending entry first — so a late
  MPC response for the old digest finds no entry and Rejects instead of
  double-signing. Combined with failure-release, every claim always has a
  live path forward.
- MPC callback: private (predecessor == self), raw-bytes parse returning
  data (never panics after state intent is recorded) — the V2 wedge fix,
  retained verbatim in shape.
- `Signed` vouchers are immutable; `mark_relayed(digest)` stays a
  permissionless UX hint (escrow `usedVoucher` is ground truth, as in V2).

## 4. Multi-proof verification (per claim)

Claim input: `criteria_json: String` + `proofs: Vec<TaggedProof>` +
`recipient`. `TaggedProof = { evidence_type: u8, proof: ProofInput }`.
Evaluation order (shared by `qualify_claim` and the `dry_qualify` view —
single implementation, no drift):

1. Bounty exists, Open, funded, not past deadline; slot available.
2. Strict-parse + validate criteria JSON; `keccak(canonical)` MUST equal
   committed `criteria_hash` (else CRITERIA_MISMATCH).
3. 1 ≤ proofs ≤ MAX_CLAIM_PROOFS (40); ≥1 `pr` proof; per-proof: tag
   validity, shape caps (16KB params/context, 1..16 matchers), `verify_core`
   (provider `http`, identifier recompute, exact witness-set recovery),
   freshness within BOTH the protocol window (7d/300s, admin-tunable) and
   the criteria `evidence_max_age` (≤604800), owner == `recipient`
   (per-proof binding), scoped nullifier unused:
   `keccak("OMNIBOUNTY-V3-NULL" || bounty:u64be || recipient:20B ||
   type:u8 || identifier:32B)`.
4. URL pinning per evidence type (exact templates; query strings pinned
   where semantically load-bearing, e.g. contents `?ref=`); pinned request
   headers exact-matched (`Accept: application/vnd.github+json` on JSON
   proofs, `Accept: application/vnd.github.diff` on diff proofs — the
   representation discriminator; without it JSON-key regexes could run
   over attacker-influenced diff text).
5. Join: all PR numbers equal; all head SHAs equal (`pr.head_sha`, check
   `head_sha`, review `commit_id` (stale approvals excluded by equality),
   contents `ref`); (bounty, PR) unclaimed. Check-run LIST proofs have no
   consumer (existential single-run design) and are rejected, never ignored.
6. Criterion rules per VERIFICATION_MATRIX.md (checks/labels/reviews/files/
   protected/blob/patch/issue/association/fork/merge/commitment/recipient).
   Unknown extracted keys ignored; missing required evidence = UNVERIFIED
   = claim rejected.
7. Recipient rule: per-proof owner == `recipient` (step 3) plus a
   defense-in-depth uniform-prover check in the evaluator (unreachable via
   `qualify_claim`/`dry_qualify`, kept so the pure evaluator is
   self-protecting for any caller).
8. Identity policy: `open` → nothing further; `commitment` → PR response
   contains `omnibounty:<bounty_id>:<recipient_hex>` (attested via a
   contains matcher on the PR proof; the marker must cover the exact
   lowercased recipient).

## 5. Reward allocation, sequencing, refunds

- Slot amounts are explicit base-unit u256 values; at creation the contract
  computes `total_amount = checked_sum(slots)` (overflow rejected) and every
  voucher amount comes from the stored slots — never from claim input.
  `mark_funded` is a sponsor attestation that the Base escrow holds that
  total (NEAR cannot read Base state); the escrow independently enforces
  its own stored schedule, and the UI + any auditor cross-checks both
  views. Mismatched schedules brick claims safely (escrow reverts), never
  overpay.
- Sequence = per-bounty execution order via `bounty.seq`; ties impossible
  (single-threaded execution).
- Refunds are Base-side only (sponsor, post-deadline, unclaimed slots,
  exact slot amounts). NEAR needs no refund entrypoint: expiry gates new
  qualifications; settled/finalized claims are unaffected.

## 6. MPC signing and callback handling

- `finalize_claim` (permissionless, post-window): builds `VoucherV2`
  (slot amount, `nonce = next_nonce++`, `expiry = now + voucher_ttl`;
  the criteria deadline gates qualification only, so no deadline cap is
  applied), stores `pending[digest]` + `claim.pending_digest`, dispatches
  MPC v3 sign (100 Tgas, 1 yocto from contract balance — same constants
  as V2).
- `on_voucher_signed(digest_hex)`: asserts self-call; parses digest;
  requires pending entry; reads raw promise bytes; success → parse
  (r, s, v) → verify recovered signer == pinned `mpc_signer` → store
  voucher, clear pending state, emit event; any failure → release pending
  (nonce burned — uniqueness preserved, contiguity explicitly not
  guaranteed) and return `Rejected(reason)`. Unknown digests (stale
  retries) return `Rejected` without touching state.
- In-flight safety: re-finalize while a fresh dispatch is pending is
  rejected (exactly-once dispatch per digest — two digests would yield
  two independently valid vouchers for one slot); retry after failure
  mints a fresh digest; retry over a stuck dispatch is allowed after
  `pending_timeout_sec` with stale-entry removal (see §3).

## 7. Entrypoints

Mutating: `new(owner, mpc_contract, escrow, chain_id)`,
`create_bounty(bounty_id, token, criteria_json)` [payable],
`mark_funded(bounty_id)` [sponsor],
`qualify_claim(bounty_id, criteria_json, proofs, recipient)` [payable],
`finalize_claim(bounty_id, slot)` [payable, permissionless],
`on_voucher_signed(digest_hex)` [private],
`mark_relayed(digest_hex)` [payable, permissionless hint],
`upsert_epoch` [payable], `remove_epoch`, `set_mpc_signer`, `set_escrow`,
`set_chain_id`, `set_mpc_contract`, `set_freshness`, `set_pending_timeout`,
`set_paused`, `transfer_ownership` + `accept_ownership` +
`cancel_ownership_transfer` (two-step). No `challenge_claim` ships (see
§3). Views: `get_config`, `get_bounty`, `list_bounties`, `get_claim`,
`get_voucher(bounty, slot)`, `get_pending(digest_hex)`,
`get_claim_by_pr`, `list_unrelayed(limit)` → slot-tagged vouchers,
`is_nullifier_used(key)`, `is_relayed(digest)`, `get_epoch`,
`dry_qualify(bounty_id, criteria_json, proofs, recipient)` → full
per-criterion pass/fail/unverified outcome (no state change; total on
user input — never panics).

## 8. Storage and gas considerations

- Bounded everything: criteria ≤32KB, proofs ≤40/claim, 16KB
  params/context/proof (32 max JSON depth), ≤16 matchers (≤512 chars
  each), ≤16 slots, ≤16 attested file rows, ≤8 labels/reviews/keywords/
  patch strings. (40 proofs covers files-heavy bounties: 16 contents +
  PR + checks + reviews + files + diffs can exceed 32.)
- Phase 5.1 total caps (fail closed pre-crypto in `verify_bundle`,
  shared by `qualify_claim` and `dry_qualify`; counted from pure length
  reads, no nullifiers consumed): ≤64 total witness signatures
  (`TooManySignatures`) and ≤256KB total evidence bytes
  (`ProofTooLarge("bundle")`). Per-proof ≤16 signatures retained.
- Storage-paid-by-caller with exact measurement on every growing call
  (`create_bounty`, `qualify_claim`, `finalize_claim`, `mark_relayed`,
  `upsert_epoch`, ownership transfer); fixed-size updates take no deposit.
  No refunds (see §2).
- Recovery is host-metered: both legs use `env::ecrecover` (malleability
  flag `false`, full-range S, ethers/EVM semantics) at a measured
  0.2936 Tgas/call (pinned schedule). Phase 5.1 migrated from in-WASM
  k256, which spuriously rejected valid high-S signatures (its recovery
  re-verifies; k256 verification enforces low-S). Equivalence harness:
  `src/ecrecover_equiv.rs` (161 official vectors + twins + edges);
  k256 survives test-only for fixtures and the harness. WASM shrank
  759,447 → 688,578 bytes (-9.3%).
- Calibrated model (mock-measured, all terms host-metered):
  `gas ≈ 0.3T + 0.20T×proofs + 0.312T×sigs + 0.026T×KB(params+context)`,
  all calibration points within ~2%. Key numbers: 2×1 = 1.37T,
  2×8 = 5.74T, 4×16 (64 sigs, the cap) = 21.1T, 40 proofs/1MB = 42.6T,
  create_bounty = 0.17-0.18T, prepare_finalize = 0.19T, 640-sig
  rejection = 0.034T. Worst case under caps ≈ 35T mock + WASM JSON
  parse (unmetered here; ≤256KB keeps it small) ≈ 55T est. — 5x+
  margin under the 300T transaction limit.
- Gas constants: `SIGN_GAS` 100 Tgas + `CALLBACK_GAS` 40 Tgas retained;
  `QUALIFY_MIN_GAS`/`FINALIZE_MIN_GAS` 150 Tgas floors convert silent
  out-of-gas into a clear `INVALID_CONFIG: insufficient gas attached`
  error (the 150T floor covers the ~55T worst case 2.7x; unused gas is
  refunded by the protocol).
- Host vs Linux: mock numbers exclude WASM execution (JSON parse,
  serde, allocs). Linux CI collects the true totals via the
  `Gas numbers (Linux, --nocapture)` step; re-run §8 measurements
  before mainnet (fee-schedule drift).
- View `dry_qualify` runs the identical evaluator (shared code path).

### 8.1 Frontend requirements (Phase 6, normative)

The frontend MUST client-side pre-check every claim bundle and refuse
to submit (with a specific message) when any bound is exceeded:

1. proofs ≤ 40; 2. signatures per proof ≤ 16; 3. total signatures ≤ 64;
4. total evidence bytes (params + context, UTF-8 lengths) ≤ 262,144.
All four are computable from the assembled JSON without chain access.
Additionally: (a) preflight every claim through `dry_qualify` and show
its errors verbatim; (b) attach ≥150T gas to `qualify_claim`
(unused gas is refunded); (c) keep the mandatory deadline-zero
blocking warning (deadline-zero bounties lock funds permanently);
(d) never display progress for stages without evidence (see §5 of the
integration matrix for the state vocabulary).

## 9. Voucher V2 interface (NORMATIVE for Base escrow V2)

- Struct (EIP-712): `VoucherV2(uint256 bountyId,uint8 slotIndex,address
  recipient,address token,uint256 amount,uint256 nonce,uint256 expiry,
  uint256 chainId,address escrow,bytes32 criteriaHash)` — field order
  fixed as listed; `amount` = the SLOT amount (base units).
- Domain: name `"OmniBounty"`, version `"1"` (unchanged strings), chainId
  + verifyingContract = the NEW escrow (new separator follows).
- Digest: `keccak256(0x19‖0x01‖domainSeparator‖structHash)`;
  `structHash = keccak256(abi.encode(typehash, ...))` with u256-BE and
  left-padded addresses (same construction pattern as V2).
- Signature: MPC ECDSA secp256k1 over digest; `v/r/s` as before.
- Escrow MUST: store per-bounty slot schedule `{amounts[], bitmap,
  total, paid}`; check digest-unused, expiry, chain, self, token,
  `amount == slots[slotIndex]`, slot unclaimed, `ecrecover == mpcSigner`;
  effects (bitmap + totals) before transfer; emit
  `VoucherClaimed(bountyId, slotIndex, recipient, amount, nonce,
  criteriaHash, digest)`; expose sponsor `refund(bountyId, slotIndex)`
  post-deadline for unclaimed slots (exact amounts).
- Typehash pinned: `keccak256(type string)` =
  `0x1455b35cc7864127c56d1e0d2f4e6172e7170aa94cb677c301415aac89954bfb`
  (asserted by `constants_match_literals`; domain pieces likewise).
  Digest construction cross-checked against ethers-generated vectors in
  `testdata/v3/eip712-voucher2.json` (`oracle_fixture_digests_match`,
  green). MPC derivation path: `"omnibounty-voucher-v2"` (versioned apart
  from V2 so each protocol version derives a distinct key).

## 10. Differences from V2 (explicit)

New: criteria commitment + strict JSON + full validator; multi-proof
claims + join engine; scoped nullifiers; slots + sequencing; challenge
window (transparency delay, no counter-evidence engine) + permissionless
finalize; funded gate; storage-paid-by-caller; ownership transfer;
`dry_qualify` transparency view; VoucherV2 shape. Retained shape: Reclaim
core verification, MPC v3 envelope + raw-bytes callback discipline,
global nonce uniqueness, epoch/witness pinning, freshness windows,
relayer ground-truth architecture, event-driven UX. Retired with V2:
single-winner Bounty struct, PR-number-upfront binding, bare-identifier
nullifiers, single-slot voucher, contract-pays-storage.

Diverged in Phase 5.1: V3 recovery is host-backed (`env::ecrecover`,
full-range S); V2 retains in-WASM k256 recovery, which rejects valid
high-S signatures (latent: today's Reclaim witnesses emit low-S by
ethers construction, so no live breakage observed; the strictness is
still wrong for a verifier and V2 inherits it). V2 was NOT modified
(deployed and frozen); the finding is recorded for disclosure, not
patched here.
