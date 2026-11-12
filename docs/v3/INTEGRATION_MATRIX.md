# V3 Cross-Chain Integration Matrix

Status: PHASE 5. How the NEAR qualification protocol, MPC signing,
relayer, and Base settlement fit together — every interface, format,
and verification responsibility, with evidence for each compatibility
claim. Companion to the e2e harness (`integration/`, all scenarios
green) and the prepared CI workflow (`.github/workflows/v3-integration.yml`,
unpushed).

Provenance legend used throughout: **LIVE-LOCAL** = executed here
against real code (Rust tests, Anvil-free in-process EVM, real relayer
class); **OFFLINE-REAL** = real logic executed offline with real crypto
(Rust-produced fixtures); **MOCK** = test double; **PENDING-LINUX** =
compile-verified, executes only on Linux CI; **REQUIRES-DEPLOY** =
needs live networks.

## 1. Component matrix

| # | Edge | Producer output | Consumer input | Format / contract | Verified by |
|---|---|---|---|---|---|
| 1 | Sponsor → NEAR | `create_bounty(id, token, criteria_json)` + deposit | stored `BountyV3` | strict JSON ≤32KB; slots ≤16 non-zero; checked sum | NEAR unit (LIVE-LOCAL) |
| 2 | Sponsor → Base | `createBounty` + `fundBounty` | stored `Bounty` + USDC | same ids/amounts/deadline/criteria as NEAR (cross-checked, §4) | Forge (LIVE-LOCAL) + relayer gate |
| 3 | GitHub → Reclaim | PR/checks/files API responses | zkTLS proofs | pinned endpoints, headers, matchers (matrix R-* rows) | Phase 1 fixtures (OFFLINE-REAL) |
| 4 | Prover → NEAR | `qualify_claim` bundle | `ClaimRecord` + nullifiers | ≥1 PR proof, URL/header pin, head join, all-PASS | NEAR unit w/ real ECDSA (LIVE-LOCAL) |
| 5 | NEAR → MPC | v3 `sign` (path `omnibounty-voucher-v2`, digest, domain 0) | `MpcSignature` envelope | strict parse + ecrecover self-check vs pinned signer | unit + xsuite mock matrix (PENDING-LINUX run) |
| 6 | NEAR → relayer | `list_unrelayed` / `get_bounty` views | V2 validation + tuple | snake_case JSON; exact §9 fields; digest recomputed | e2e with Rust-produced JSON (LIVE-LOCAL) |
| 7 | Relayer → Base | `claim(tuple10, v, r, s)` tx | `VoucherClaimed` / revert | ethers tuple in §9 order; minimal ABI + error fragments | e2e receipt+event asserts (LIVE-LOCAL) |
| 8 | Base → sponsor | `refundSlot` post-deadline | USDC + `SlotRefunded` | bitmap atomicity vs claims | Forge + e2e scenario E (LIVE-LOCAL) |

## 2. Lifecycle trace (with stage vocabulary)

```
pending → (sponsor funds both sides; relayer cross-checks schedules)
qualified → (NEAR all-PASS verdicts; nullifiers spent; evidence_digest event)
awaiting-signature → (finalize dispatches MPC; pending[digest] set)
voucher-ready → (callback verified + stored; list_unrelayed serves it)
submitted → (relayer tx hash exists)
confirmed → (receipt status 1 AND VoucherClaimed args verified) | failed (reason) | refunded
```

`confirmed` is defined as receipt-plus-event, enforced by the harness
(`assertConfirmedPayout`) and mirrored in production by the relayer's
`wait()` + `usedVoucher` re-check. No stage may be reported from a
different stage's evidence (in particular: submission ≠ payout).

## 3. Interface dependencies (exact)

- **VoucherV2 bytes**: NEAR `voucher_digest` == Solidity `digestOf` ==
  relayer `computeDigestV2` on all `eip712-voucher2.json` vectors
  (three implementations, one fixture; all green).
- **Typehash**: `0x1455b35c…54bfb` pinned in Rust, Solidity (`keccak`
  of literal), and JS (fixture cross-check). Frozen.
- **Domain**: `("OmniBounty","1",chainId,verifyingContract)` on all sides;
  fork-recompute on both contracts (Solidity tested via etched
  fixture-address deployment).
- **MPC signature wire**: `(v ∈ {27,28}, r, s)` hex; 65-byte sigs on NEAR
  views; `(uint8,bytes32,bytes32)` on the escrow call.
- **Slot/amount binding**: `uint8 slotIndex` ABI-encodes identically to
  NEAR's `u256(slot)`; escrow enforces `amount == amounts[slot]`.
- **Nullifier scoping**: `(bounty, recipient, type, identifier)` on NEAR;
  digest-keyed on Base; the two layers are independent (a digest replay
  and a slot double-claim are distinct reverts — both tested).
- **JSON shapes**: NEAR views are snake_case with decimal-string u256s
  and `0x` hex; the relayer normalizer accepts snake_case (production)
  and camelCase (mocks). Proven by feeding Rust-serialized views
  straight into the JS validator (e2e scenarios A–D).

## 4. Compatibility findings (found by integrating, not by unit tests)

1. **Escrow getter ABI shape**: the `bounties(uint256)` getter returns a
   single ABI tuple (solc tuples struct getters), not flat outputs.
   A hand-written flat fragment mis-decodes; the relayer now uses the
   exact tuple fragment (caught by e2e scenario A failing, fixed,
   re-verified green).
2. **Revert-name visibility**: minimal ABIs surface raw 4-byte selectors
   on the estimation path. The V2 relayer ABI now carries all custom
   errors (decode-only) so skip reasons stay human-readable; the harness
   accepts name-or-selector.
3. **Check ordering vs test design**: already-claimed slots mask field
   errors (bitmap precedes field checks, by design). E2E negatives use
   an unclaimed slot so each asserted revert is the intended one.
4. **Relayer pre-check layering**: `usedVoucher` + schedule checks resolve
   most replays/skips pre-submit (zero gas); the escrow independently
   reverts anything that reaches it. Both layers are asserted separately
   (scenario C/D), so neither can silently atrophy.
5. **Fixture determinism**: voucher/escrow addresses are
   deployment-order-deterministic; the harness fails fast on drift, and
   the regen flow (prepare → regen → run) is the documented procedure
   plus a CI determinism gate.

## 5. Reward-schedule consistency (carryover B — implemented)

`validateScheduleConsistency` (relayer) compares the NEAR `BountyView`
against the escrow `Bounty` on: funding flags, token, slot count, every
slot amount, totals, deadline, and criteria hash. `handleOne` (V2 path)
fetches both records after the `usedVoucher` pre-check and skips
pre-submit on any mismatch (`schedule mismatch: ...`), so a divergent
schedule costs zero gas. RPC failures stay transient errors, never
silent skips. Unit-tested per axis (including unknown/unfunded bounties
and fetch failure); e2e asserts the wired happy path with a REAL
Rust-produced `BountyView` plus a pre-submit unknown-bounty skip.
V1 path untouched. The escrow remains authoritative; this is defense in
depth with a clear operational signal.

## 6. Deadline-zero rule (carryover C — verified + recorded)

- Escrow: `refundSlot` on a `deadline == 0` bounty reverts
  `RefundUnavailable`; the slot stays claimable forever (forge test
  warps to `uint64.max` and then claims successfully).
- Relayer: never reports refund eligibility (no refund vocabulary in
  statuses; only `relayed`/`skipped`/`error`/`already`). Schedule check
  treats `0 == 0` as consistent without special-casing.
- NEAR: `deadline == 0` skips both the expiry and window gates (tested).
- Trace vocabulary emits `refunded` only after a real refund receipt.
- PHASE-6 FRONTEND WARNING (mandatory): the sponsor UI MUST show an
  explicit, blocking-acknowledgement warning before creating a
  `deadline == 0` bounty: funds can NEVER be refunded (only claimed),
  so an unfilled no-deadline bounty locks sponsor funds permanently.
  No silent default may select deadline-zero.

## 7. Proof gas calibration (carryover A — measured + bounded)

Method (all local, all reproducible): the NEAR unit-test mock meters
host calls through real VMLogic accounting with production mainnet fees
(`RuntimeFeesConfig::test` = real schedule, verified in
`near-parameters-0.31.1`), so `used_gas()` deltas across `qualify_claim`
are EXACT for host terms (keccak, storage, logs). WASM compute (serde,
k256 recovery math) is invisible to the mock; it is bounded below by a
release-mode native timing anchor plus explicit margin, NOT claimed as
measured. Final confirmation requires the Linux sandbox task (§10.4).

Measured host gas (production fees; `gas_host_cost_by_bundle_shape`):

| bundle (proofs × witnesses) | sigs | host gas |
|---|---|---|
| 2 × 1 (standard claim) | 2 | 0.785 Tgas |
| 2 × 4 | 8 | 0.898 Tgas |
| 2 × 8 | 16 | 1.048 Tgas |

The curve is near-flat in witness count (+0.019 Tgas/sig: address
keccak + vec ops), PROVING recovery math lives outside host metering —
recovery is k256-in-WASM (same as V2, verified in
`contracts/near/src/reclaim.rs:145`), with only the final address hash
as a host call. Per-proof host base ≈ 0.39 Tgas (identifier/context
keccaks, epoch + nullifier reads).

Native anchor: k256 recovery = 2.13 ms/release-mode (50 iters,
`gas_k256_recovery_native_timing`). Native x86 is far faster than
metered WASM per op, so this is a LOWER bound only; against the
schedule's ~1 Tgas/ms design rate it suggests single-digit Tgas per
on-chain recovery, versus 0.279 Tgas for the `env::ecrecover` host
function the contract does NOT currently use.

Model (300 Tgas tx limit): `total ≈ host(P,S) + S × W` where `W` =
per-recovery WASM cost (unmeasured, plausibly 2–6 Tgas). Consequences:

- Typical bundles (≤5 proofs, ≤3 witnesses, ≤15 sigs): fit with >10×
  margin under any plausible W. No concern.
- Heavy bundles (≤20 proofs / ≤64 sigs): fit if W ≤ ~4 Tgas. Plausible
  but UNCONFIRMED — Linux measurement required before blessing.
- Pathological max (40 proofs × 16 = 640 sigs): does NOT fit under any
  credible W (1300+ Tgas). Protocol caps permit it; physics does not.

Operational limits (effective immediately, enforced by guidance + the
150 Tgas attach floor, NOT by new consensus checks — out-of-gas fails
safe and all-or-nothing, burning only the caller's gas):
- Attach ≥150 Tgas always (floor); heavy bundles attach up to 300 Tgas.
  Frontend formula: `150T + 6T × total_signatures`, capped at 300T.
- Recommend ≤64 total witness signatures per qualify until Linux
  confirms headroom (fits even at pessimistic 4 Tgas/sig: ~260 Tgas).
- Storage deposits (exact serialized sizes: 16-slot bounty 661 B,
  claim 107 B; `storage_state_sizes_bounded` pins these): worst-case
  single-call growth ≈ 2 KB → attach 0.05 NEAR flat (2× margin).
- `finalize_claim` body ≈ 1–2 Tgas + 140 Tgas promise costs: 150 Tgas
  floor is correctly sized. Callback `apply` = 1 recovery + O(1)
  storage, far inside the 40 Tgas callback reserve.

Recommendation (NOT implemented — needs approval as a Phase-3
architecture change): migrate recovery + MPC-signer check from k256
WASM to the `env::ecrecover` host function (0.279 Tgas/sig,
schedule-pinned). Expected ~10× per-signature win, which would make
even the pathological max bundle fit (~190 Tgas). V2 compatibility is
unaffected (same math, golden vectors must still pass). If declined,
impose the ≤64-signature operational cap permanently instead.

## 8. MPC integration: mocks vs live (honest ledger)

| Claim | Evidence | Status |
|---|---|---|
| Envelope shape (v3 `sign` request/response) | mock-mpc mirrors `v1.signer-prod.testnet` wire format | MOCK (V2-proven shape) |
| Digest construction | Rust == Solidity == JS on ethers vectors | LIVE-LOCAL (3 impls) |
| Recovery + signer self-check | real k256 vectors incl. wrong-key/prefix/v cases | LIVE-LOCAL (Rust) |
| Callback auth + release/retry/supersede/stale-reject | full unit paths; xsuite mock matrix | unit LIVE-LOCAL; async legs PENDING-LINUX |
| Derivation path `omnibounty-voucher-v2` | constant in code + xsuite mock calls | MOCK (no live MPC call made) |
| Live MPC signature on testnet | — | NOT PERFORMED (forbidden this phase) |

No statement in this repo claims a live MPC round-trip. The first live
MPC call is an explicit deployment-milestone action with its own
checklist (funded testnet account, derivation-path confirmation via
`tools/mpc_derive.mjs`, small-value voucher, independent digest audit).

## 9. Linux xsuite + CI status

Linux execution remains impossible on this host (no WSL/Docker/VMs;
near-sandbox publishes linux-x86 + darwin-arm only). The prepared
workflow `.github/workflows/v3-integration.yml` (unpushed, review
draft) runs on `ubuntu-latest`: NEAR unit/clippy/fmt, wasm builds,
fixture determinism, the 5 sandbox xsuite scenarios, the full Foundry
suite, the relayer suite, and this e2e (prepare → regen → run) with
trace-artifact upload. The xsuite harness itself is compile-verified
here (`--no-run` green). First Linux run is a Phase-6 entry gate.

## 10. Remaining blockers (need deployment or live networks)

1. **Live NEAR deployment** of `omnibounty_v3.wasm` (testnet): required
   for the real RPC surface, real gas metering confirmation (§7 task),
   and the first live MPC handshake.
2. **Live MPC handshake**: funded account + derivation-path confirmation;
   recorded separately from all mock results above.
3. **Base Sepolia deployment** of `OmniEscrowV2` + USDC funding: required
   for real settlement, real `chainId`/`escrow` binding, and relayer
   production config.
4. **Linux CI first run**: xsuite sandbox scenarios + e2e on runners.
5. **Mainnet fee-schedule drift check**: re-run the §7 measurement tests
   against the then-current protocol version before mainnet use.

None of the above requires further protocol design — only execution
environments this sandbox cannot provide.
