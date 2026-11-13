# OmniBounty V3

Cross-chain bounties: sponsors fund USDC on Base Sepolia without knowing
contributors; contributors claim by proving merged GitHub pull requests with
Reclaim zkTLS plus a GitHub identity proof; a NEAR contract verifies the
evidence; NEAR Chain Signatures (MPC) co-signs an EIP-712 voucher; an
off-chain relayer auto-finalizes matured claims and settles vouchers on Base.

## What OmniBounty does

1. A sponsor creates a bounty with machine-checkable criteria (repository,
   merge policy, reward slots) and funds USDC into the Base escrow. No
   contributor identity is needed up front.
2. A contributor discovers the bounty, lands a qualifying merged PR, and
   submits one claim: the criteria document plus Reclaim proofs of the PR
   and of their own GitHub identity.
3. The NEAR V3 contract verifies the proofs, binds the GitHub identity to
   the PR author, and qualifies the claim into a reward slot.
4. After the challenge window, the permissionless `finalize_claim` (sent
   automatically by the relayer) dispatches an MPC signing request.
5. Chain Signatures co-sign the EIP-712 `VoucherV2`; the relayer submits it
   to the escrow, which pays USDC to the signed recipient.

Current demo criteria establish a merged PR and identity binding. They do
not prove the submitted code solves the sponsor's task.

## Architecture and repository layout

V3 is the authoritative implementation. V1/V2 paths below are legacy and
retained for history only.

| Path | Contents |
|---|---|
| `contracts/near-v3` | NEAR V3 contract: criteria, claims, MPC dispatch, vouchers (Rust) |
| `contracts/base-v3` | `OmniEscrowV2.sol`: USDC escrow + voucher settlement (Foundry) |
| `relayer` | V2 discovery, automatic finalization, settlement (Node, ethers) |
| `frontend` | Next.js V3 claim form + settlement tracker (V1 journeys retained) |
| `integration` | Hardhat E2E harness (in-process chain, real relayer + escrow) |
| `testdata/v3` | V3 fixtures, deployment records, oracle vectors |
| `tools` | V3 finalizers, MPC derivation, fixture generators |
| `docs/v3` | V3 design, security, finalization, deployment notes |
| `docs` | Shared architecture, security, deployment, verification docs |
| `contracts/near`, `contracts/base` | Legacy V1/V2 contracts (historical) |
| `spikes`, `experiments` | Research scripts (diagnostics, not production code) |

## Quick verification (reviewers)

```sh
cd contracts/near-v3 && cargo test --lib              # NEAR unit suite (133 tests)
cargo test --features xsuite --test xsuite            # + sandbox suite (6 tests, needs built WASM)
cd ../base-v3 && forge test                            # escrow suite (26 tests)
cd ../../relayer && npm install && npm test            # relayer suite (82 tests)
cd ../tools && npm install && npm test                 # finalizer suites (21 tests)
cd ../frontend && npm install && npm test              # frontend suite (97 tests)
cd ../integration && npm ci && npm run e2e:prepare && npm run e2e   # E2E scenarios (7)
```

See `contracts/near-v3/tests/README.md` for the WASM build + XSuite procedure
(Rust 1.86.0, canonicalization step, sandbox notes).

## Sponsor journey

Pick a repository and merge policy, write the criteria document, deploy or
reuse the escrow, create the bounty on Base (`createBounty`, exact-USDC
`approve`, `fundBounty`), then create the matching NEAR bounty with the same
ID, criteria hash, token, amounts and deadline, and call `mark_funded`.
The sponsor never sees contributor identities.

## Contributor journey

Find a funded bounty, land a qualifying merged PR, generate the PR proof
(`frontend/scripts/prove.mjs`) and the identity proof
(`frontend/scripts/prove_identity.mjs`) with one Reclaim app identity, paste
both as the claim bundle, and submit once. The tracker follows qualification,
finalization, MPC signing, settlement, and payout.

## Technical architecture

- **NEAR validation:** `qualify_claim` checks criteria commitment, proof
  templates, authorship binding, freshness, epochs, and nullifiers; values
  are read only from proofs covering their own mandated matchers.
- **Reclaim verification:** zkFetch proofs over the GitHub API; PR evidence
  (merged, author, repo, number, head SHA, author ID, creation time) plus a
  mandatory authenticated `/user` identity proof, same owner throughout.
- **Base escrow:** slot schedules, exact funding, digest nullifiers, and
  claim/refund bitmap mutual exclusion; permissionless `claim` pays only
  the signed recipient.
- **MPC signing:** the contract dispatches `sign` to Chain Signatures over
  the EIP-712 digest; 24h vouchers; derivation path `omnibounty-voucher-v2`.
- **Relayer:** polls NEAR for matured unsigned claims and auto-submits
  `finalize_claim`, discovers signed vouchers, verifies digest/signature/
  schedule on every poll, and settles on Base with retry/skip handling.

## Deployment information

Testnet deployment (see `testdata/production_testnet_v3.json` for the full
record): NEAR `omnibounty-v3.testnet`, Base Sepolia escrow
`0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767`, chain ID 84532, Sepolia USDC
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`, MPC signer
`0x4b204ae1890a0cd49cc594fe712fea4ac765a2f9`, Reclaim epoch 1.

## Demonstrated versus pending

Demonstrated: all suites above; both testnet deployments; live Reclaim PR
and identity attestations verified individually against the epoch-1 witness;
a funded $1 demo bounty (ID `223339065907689`, zero challenge window).
Pending: a completed live claim → MPC signing → USDC payout, which needs a
merged PR by the claimant. The demo bounty is self-funded and self-claimed
by the same operator; this does not demonstrate independent
sponsor–contributor participation. No production-readiness claim is made:
single-key testnet owner/signer, manual deployment, no monitoring.

## Documentation index

- `docs/v3/FINALIZATION.md` — finalization mechanisms and demo operations
- `docs/v3/NEAR_V3_DESIGN.md` — NEAR contract design
- `docs/v3/BASE_ESCROW_V2_DESIGN.md` — escrow design
- `docs/v3/SECURITY_MODEL.md` — V3 threat model
- `docs/DEPLOYMENT.md` — deployment procedures
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md` — shared background (V1-era)
- `docs/VERIFICATION.md` — historical V1 evidence log (see scope note there)
- `contracts/near-v3/tests/README.md` — WASM build + XSuite guide
- `frontend/README.md` — app setup, V3 demo flow, proof scripts
