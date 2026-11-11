# OmniEscrow (Base)

USDC bounty escrow settled by MPC-signed EIP-712 vouchers. Dependency-free
Solidity 0.8.24; tests use forge-std (see below).

## Build & test

```sh
# first time (needs network): fetch the pinned test dependency
forge install foundry-rs/forge-std --tag v1.17.0

forge build
forge test            # 30 tests incl. oracle cross-checks + live voucher + fuzz
```

`foundry.toml` pins `solc 0.8.24`. The suite reads `../../testdata/eip712.json`
(struct hashes, typehash) so encoding drift fails tests, not mainnet.

## Key behaviors

- `createBounty` / `fundBounty` (sponsor pulls USDC via approval) /
  `claim` / `cancelBounty` (sponsor refund before payout).
- `claim` re-checks every bound field (bounty, recipient, token, amount,
  nonce, expiry, chainId, escrow address), single-use digests, bounty state,
  and `ecrecover == mpcSigner` with `v ∈ {27,28}`.
- Effects-before-interactions plus a reentrancy guard; tolerates ERC20
  tokens without return values; fork-safe domain separator.
