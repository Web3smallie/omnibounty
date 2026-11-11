# OmniBounty

GitHub contributors claim USDC bounties with verifiable proof of merged pull
requests. Sponsors fund bounties on Base Sepolia; contributors prove the merge
with Reclaim zkTLS; a NEAR contract verifies the proof and authorizes an
EIP-712 payout voucher via NEAR Chain Signatures (MPC); a relayer settles the
voucher on Base.

## Repository layout

| Path | Contents |
|---|---|
| `contracts/near` | NEAR contract: verification boundary, bounties, claims, vouchers, MPC |
| `contracts/base` | `OmniEscrow.sol`: USDC escrow + voucher settlement (Foundry) |
| `relayer` | NEAR→Base voucher courier (Node, ethers) |
| `frontend` | Next.js sponsor + contributor app |
| `testdata` | Independent-oracle fixtures shared by every suite |
| `tools` | Fixture generator/integrity checker, sandbox vendoring helpers |
| `docs` | Architecture, security, deployment, verification report |
| `spikes` | Original investigation scripts (diagnostics, not production code) |

## Quick verification (reviewers)

```sh
python tools/preflight.py                    # live-network prerequisites
cd tools && npm install && npm run check     # fixture integrity
cd ../contracts/near && cargo test           # NEAR unit suite (44 tests)
cargo test --features xsuite                 # + cross-contract suite
cd ../base && forge install foundry-rs/forge-std --tag v1.17.0 && forge test
cd ../../relayer && npm install && npm test
cd ../frontend && npm install && npm test && npm run build
node ../tools/live_handshake.mjs             # free testnet MPC rehearsal
```

See `docs/VERIFICATION.md` for the evidence log, `docs/ARCHITECTURE.md` for
design, `docs/SECURITY.md` for the threat model, and `docs/DEPLOYMENT.md`
for testnet/mainnet procedures.
