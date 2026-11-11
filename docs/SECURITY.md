# OmniBounty security

## Threat model

- **Attackers**: arbitrary NEAR/EVM accounts, malicious relayers, frontrunning
  searchers, compromised frontend hosts. The Reclaim attestor set and GitHub
  TLS are trusted for *data authenticity* (they attest what GitHub served);
  everything else they touch is re-validated.
- **Trusted**: contract owner keys (testnet: single key; mainnet: multisig +
  timelock required), the MPC network for voucher signing, Base/Circle USDC.
- **Explicitly untrusted**: the deployed `reclaim-protocol.*` contracts
  (never called), relayer operators, frontend inputs, proof submitters.

## Controls by attack

| Attack | Control |
|---|---|
| Forge proof without witness key | Signatures must recover to the pinned epoch set; identifier binds full claim bytes |
| Replay a proof / voucher | Identifier nullifiers on NEAR; single-use digests + claimed flags on Base; per-claim nonces |
| Claim someone else's proof (frontrun) | Payout recipient must equal proof owner; theft impossible, griefing harmless |
| Claim with closed-but-unmerged PR | `merged == "true"` predicate required; URL/author/repo/number bound to bounty |
| Stale proof reuse | 7-day window + future skew cap; voucher TTL ≤ 24h; escrow expiry check |
| Cross-chain / cross-contract replay | chainId + escrow address inside the signed struct; fork-safe domain separator |
| Malicious verifier-owner epoch | No dependency on the Reclaim contract; witnesses pinned in own state |
| Rogue MPC response | Strict response parsing + on-chain signer self-check vs configured address |
| Double-claim during MPC flight | `Pending` marker blocks duplicates; failure releases to `Open` |
| Malformed-input panics / DoS | Size/depth/count caps; zero panics on user input; typed errors |
| Reentrancy / weird ERC20 | Effects-before-interactions + mutex; return-data-tolerant transfers |
| Relayer misbehavior | Cannot forge/redirect/double-pay (see ARCHITECTURE.md); escrow is truth |
| Weak regex attestation | Values (not patterns) are checked; patterns additionally shape-validated |

## Residual risks (acknowledged, not hidden)

1. **Single attestor key on testnet.** Epoch 1 has one Reclaim witness; its
   compromise forges arbitrary claims. Acceptable for testnet; mainnet needs
   a multi-witness epoch and a rotation procedure.
2. **Owner keys.** Testnet admin is one key (pause, epochs, signer, config).
   Mainnet requires multisig + timelock; the contract interface already
   centralizes these calls for that migration.
3. **GitHub API semantics.** The contract trusts that `merged:true` at the
   pinned URL means what GitHub documents. A GitHub-side anomaly is outside
   the trust boundary; the 7-day proof window limits exposure.
4. **MPC contract upgrades.** The v3.18.0 wire interface is verified by
   source + probes + the live handshake (see ARCHITECTURE.md). If the MPC
   operators upgrade the signer contract, the version, shapes, or KDF could
   change: claims fail closed (self-check + strict parsing), and the
   handshake must be re-run before mainnet use. Re-verify `version()` and
   the interface sources on every deployment.
5. **USDC admin / depeg.** Standard stablecoin counterparty risk; the escrow
   holds whatever the configured token contract honors.
6. **Frontend supply chain.** Wallet-selector + zk-fetch are the largest
   dependency surfaces; lockfiles are committed and `npm audit` should gate
   releases.

## Reviewer checklist (Phase 1)

- `tools`: `npm run check` passes (fixture integrity); `preflight.py`
  passes (live-network prerequisites).
- `contracts/near`: `cargo test` passes (37 unit); `cargo test --features
  xsuite` compiles the cross-contract suite (sandbox on Linux/macOS,
  testnet mode where Rust TLS works); grep confirms no `unwrap`/`expect`/
  `panic!` outside `#[cfg(test)]` and `new` (deployer config only).
- `contracts/base`: `forge test` passes (30 tests incl. live-voucher
  settlement + fuzz).
- `relayer`, `frontend`: `npm test` pass; `npm run build` passes.
- EIP-712 digest for the e2e fixture matches across Rust, Solidity, ethers;
  the live MPC-signed digest verifies in all three too.
- `testdata/live_voucher.json` present: real testnet MPC signature with
  recorded transaction hashes.
- No `TODO`/mock/fixture values reachable from production code paths
  (`tests/mock-mpc` is sandbox-test-only and says so).
