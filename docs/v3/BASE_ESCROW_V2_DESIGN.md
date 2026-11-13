# Base Escrow V2 — Settlement Architecture

Status: PHASE 4 DESIGN. Settlement destination for NEAR V3
`VoucherV2` authorizations (`docs/v3/NEAR_V3_DESIGN.md` §9, frozen).
Fresh implementation under `contracts/base-v3/`; `contracts/base/OmniEscrow.sol`
(V2) is untouched.

Separation (non-negotiable): NEAR verifies qualification and authorizes;
MPC signs; the relayer submits; THIS contract verifies the voucher
signature plus its own funding state, then pays USDC. Base never
reinterprets GitHub evidence or acceptance criteria.

## 1. Contract state and storage structures

```solidity
struct Bounty {
    address token;          // USDC (any ERC-20 tolerated on transfer)
    address sponsor;        // == creator; sole refunder
    uint64 deadline;        // 0 = never refundable (funds locked until claimed)
    bytes32 criteriaHash;   // sponsor-declared; claims must match exactly
    bool funded;
    uint256 totalFunded;    // == sum(amounts), checked at fund time
    uint256[] amounts;      // immutable schedule, 1..16 entries, each > 0
    uint256 claimedBitmap;  // bit i = slot i claimed
    uint256 refundedBitmap; // bit i = slot i refunded (disjoint from claimed)
}

mapping(uint256 bountyId => Bounty) bounties;
mapping(bytes32 digest => bool) usedVoucher;  // EIP-712 digest nullifier
address mpcSigner;                            // set at deploy, owner-updatable
address owner; address pendingOwner;          // 2-step transfer (V2 had 1-step)
bool _locked;                                 // reentrancy guard (as V2)
uint256 _deploymentChainId; bytes32 _deploymentDomainSeparator; // fork-aware EIP-712 (as V2)
```

No migration, no proxy, no pooling: every wei is attributable to exactly
one `(bountyId, slotIndex)` from funding to payout-or-refund.

## 2. Bounty funding lifecycle

`createBounty(id, token, amounts[], deadline, criteriaHash)` (anyone;
sponsor = caller) validates the schedule (`1 ≤ len ≤ 16`, every amount
`> 0`, `token != 0`) and stores it immutably. `totalFunded` is computed
as a checked sum (Solidity 0.8 reverts on overflow — no explicit cap
needed). Then `fundBounty(id)` (sponsor-only, once) pulls exactly
`totalFunded` via transferFrom. Under/over-funding is impossible: the
pull amount is the stored total, not a caller argument.

`criteriaHash` and `deadline` are sponsor-declared and mechanically
cross-checked off-chain (UI/relayer recompute the criteria hash from the
public document and compare). A lying schedule only bricks that
sponsor's own bounty (claims fail closed) — same trust class as V2's
amount attestation. `deadline == 0` disables refunds permanently (funds
remain claimable forever); the UI must warn.

## 3. Multi-slot reward accounting

Up to 16 slots (NEAR V3 maximum). Each slot pays exactly
`amounts[slotIndex]` — no partial or caller-chosen amounts. Slots are
independent: per-slot claimed/refunded bits, never a bounty-wide
`claimed` flag (the core V2→V3 accounting change). Invariant, tested:
for every bounty, `sum(claimed) + sum(refunded) + escrowed == totalFunded`
at all times; claimed and refunded sets are disjoint.

## 4. Voucher verification

Exact frozen `VoucherV2` (field order and types normative, §9):

```
VoucherV2(uint256 bountyId,uint8 slotIndex,address recipient,address token,
uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId,address escrow,
bytes32 criteriaHash)
typehash 0x1455b35cc7864127c56d1e0d2f4e6172e7170aa94cb677c301415aac89954bfb
```

Domain `("OmniBounty","1",chainId,this)` with V2's fork-recompute pattern.
`claim(v, sigV, r, s)` enforces, in order: (1) digest unused; (2) not
expired (`block.timestamp > expiry` reverts; valid during the expiry
second, as V2); (3) `chainId == block.chainid`; (4) `escrow == address(this)`;
(5) bounty exists + funded; (6) `slotIndex < amounts.length`; (7) slot
neither claimed nor refunded; (8) token match; (9) `amount ==
amounts[slotIndex]` (exact); (10) `criteriaHash` match; (11) `v ∈ {27,28}`
and `ecrecover(digest) == mpcSigner` (nonzero). Then effects
(`usedVoucher`, claimed bit), transfer, `VoucherClaimed` event.

Signature malleability: deliberately NO low-S check — MPC may produce
high-S legitimately, so rejecting it would brick honest vouchers.
Malleation is harmless here: the nullifier keys on the digest (not the
signature) and the payout fields are digest-bound, so a malleated
variant pays the same recipient or reverts as used. Both cases tested.

## 5. Claim and refund state transitions

```
slot: UNFUNDED -(fund)-> OPEN -(claim)-> CLAIMED (terminal)
                        \-(refund, post-deadline)-> REFUNDED (terminal)
```

`refundSlot(bountyId, slotIndex)` (sponsor-only) requires: funded,
`deadline != 0`, `block.timestamp > deadline`, slot in range, slot
neither claimed nor refunded. Effects set the refunded bit, then the
exact slot amount transfers to the sponsor (`SlotRefunded` event).
Claim-after-refund and refund-after-claim both revert: the claim/refund
race resolves atomically on the two bitmaps — exactly one wins, the
other reverts, double-spend impossible regardless of transaction
ordering. The residual (identical in kind to V2, narrower in time) is a
sponsor racing an unrelayed but valid voucher post-deadline; mitigated
by prompt permissionless relay plus NEAR's qualify-time window gate,
which guarantees every qualified claim is finalizable before the
deadline.

## 6. Replay protection

Three independent layers: (a) `usedVoucher[digest]` nullifier — every
dispatch carries a fresh global NEAR nonce, so every digest is unique;
(b) per-slot claimed/refunded bits — even a second *distinct* valid
voucher for one slot (e.g. post-timeout re-dispatch) settles at most
once per state; (c) NEAR-side exactly-once dispatch (pending gate +
stale-entry removal). Cross-chain replay dies on `chainId`; cross-escrow
replay dies on `escrow == address(this)`; cross-bounty/slot/recipient
substitution dies on the bound fields + amount/schedule equality.

## 7. Token transfer safety

V2's low-level-call pattern retained verbatim in shape: accept tokens
that return nothing, require `true` when data is returned, revert
otherwise (`TransferFailed`). Same for `transferFrom` at funding.
Reentrancy guard + checks-effects-interactions on all three mutating
paths (`fundBounty`, `claim`, `refundSlot`); malicious-token (reentrant,
reverting, fee-on-transfer) behavior covered by adversarial tests. Note:
fee-on-transfer tokens would break the exact-amount invariant — the
contract targets standard USDC; exotic tokens are the sponsor's risk
(same posture as V2).

## 8. Events and external integration

- `BountyCreated(id, token, total, sponsor, deadline, criteriaHash)`
- `BountyFunded(id, sponsor, total)`
- `VoucherClaimed(id, slot, recipient, amount, nonce, criteriaHash, digest)`
- `SlotRefunded(id, slot, sponsor, amount)`
- `MpcSignerUpdated`, `OwnershipTransferProposed/Transferred`

The relayer consumes NEAR `list_unrelayed` + `usedVoucher` exactly as in
V2 (same view names); only the voucher shape it validates and forwards
changes (see §10). No NEAR changes required.

## 9. Gas and security considerations

Storage-minimal (one struct + two bitmaps per bounty; no per-proof data);
bitmaps keep claim/refund at 2 SSTOREs + 1 transfer. Target: comfortably
under the 24KB contract limit; gas measured per entrypoint in tests.
Solidity 0.8.24 + optimizer 200 (V2 toolchain, proven). No `delegatecall`,
no selfdestruct, no upgradeability, no owner fund access (owner can only
rotate `mpcSigner`/ownership — cannot touch balances). Pauseless by
design like V2 (no freeze authority over user funds).

## 10. Inconsistencies found vs frozen VoucherV2 (must fix for integration)

1. `relayer/src/validate.mjs` implements the V1 type string (8 fields, no
   `slotIndex`/`criteriaHash`) — rejects every V2 voucher as malformed.
   MUST add a V2 validation path (exact §9 type string + field order +
   slot/criteria/chain/escrow/expiry/signer checks).
2. `relayer/src/index.mjs` forwards `signed.voucher` + submits against the
   V1 escrow ABI and matches V1 revert names only. MUST submit the V2
   struct to `OmniEscrowV2.claim` and recognize the new errors.
3. NEAR V3 views emit `snake_case` (`bounty_id`, `slot_index`,
   `criteria_hash`, `chain_id`); the relayer normalizer only maps V1's
   two fields. MUST extend the mapping (accept both cases, as today).
4. `contracts/base/OmniEscrow.sol` is single-winner (`amount`/`claimed`
   flags, V1 typehash) — incompatible by design; V3 ships separately,
   V2 untouched.
5. Compatible as-is: EIP-712 domain name/version, MPC `(v,r,s)` 27/28
   format, global-nonce semantics, `mark_relayed`/`list_unrelayed`/
   `usedVoucher` integration points, expiry-as-unix-seconds.

Relayer judgment (Phase 4 scope): implement dual V1/V2 support in the
relayer now (shape-detected validation path; V1 behavior byte-identical
when given V1 vouchers). Rationale: without it nothing can relay V2
vouchers, leaving Phase 4 unintegrable; the change is small (~100 lines
+ tests), additive, and carries zero V2 regression risk. Documented here
before implementation, per instructions.
IMPLEMENTED: config-driven version selection (`VOUCHER_VERSION`, default
`"1"`), `validateSignedVoucherV2` + `isVoucherV2Shape` + V2 digest
(`relayer/src/validate.mjs`, V1 lines untouched), version-selected escrow
ABI and 10-field tuple plus extended revert-name matching
(`relayer/src/index.mjs`), `helperV2`/`validateV2`/`relayerV2` tests
(47/47 relayer suite green, V1 tests unmodified and passing).
