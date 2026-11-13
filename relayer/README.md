# OmniBounty relayer

Discovers signed vouchers, validates each one independently (field
checks, EIP-712 digest recomputation, MPC signer recovery), and submits
valid ones to the Base escrow. V2 discovery enumerates bounties, claim
slots, and signed vouchers directly and never trusts the permissionless
on-chain `relayed` hint set; V1 discovery still uses `list_unrelayed`.

In V2 mode with an operator key configured, each poll first submits the
permissionless V3 `finalize_claim` for unsigned claims whose challenge
window has expired, so qualification flows to MPC signing with no second
claimant action and no scheduler wait (see `../docs/v3/FINALIZATION.md`
for how this demo path coexists with the GitHub Actions scheduler).

## Configure

Copy the environment template and fill it in (see `../docs/DEPLOYMENT.md`):

```sh
NEAR_RPC_URL=https://rpc.testnet.near.org
NEAR_CONTRACT_ID=v2.omnibounty.testnet
BASE_RPC_URL=https://sepolia.base.org
ESCROW_ADDRESS=0x...
MPC_SIGNER_ADDRESS=0x...
RELAYER_PRIVATE_KEY=0x...
EXPECTED_CHAIN_ID=84532
POLL_INTERVAL_MS=30000
CONFIRMATIONS=2
MAX_ATTEMPTS=5
STATE_PATH=./relayer-state.json
# V3 auto-finalization (optional; V2 mode only):
NEAR_OPERATOR_ACCOUNT_ID=op.testnet
NEAR_OPERATOR_PRIVATE_KEY=ed25519:...
FINALIZE_ENABLED=true
```

The relayer key needs Base Sepolia ETH for gas only; it can never redirect
funds (recipients are fixed inside MPC-signed vouchers).

The NEAR operator key needs ~1-2 NEAR (0.1 NEAR storage deposit per
finalization plus gas) and no special permissions: `finalize_claim` is
permissionless and re-derives recipient/amount from stored claim state, so
the key cannot redirect funds either. Omit both `NEAR_OPERATOR_*` values
(or set `FINALIZE_ENABLED=false`) to run settlement-only. V1 mode never
finalizes, even with the key present.

## Run

```sh
npm install
npm run once    # single poll (cron-friendly)
npm start       # daemon loop
npm test        # unit + adversarial suite (mocked transports, no network)
```

## Safety properties

- Never submits a voucher that fails local validation (mirrors escrow checks).
- Treats `escrow.usedVoucher` as ground truth before every submission, so a
  crash between submission and bookkeeping cannot double-submit.
- Transaction reverts are final (recorded as skipped); transport errors retry
  with backoff up to `MAX_ATTEMPTS`. Finality matches generic
  execution-reverted wording plus every `OmniEscrow` custom error by name,
  so permanently-doomed vouchers never burn gas on retries.
- Local state (`STATE_PATH`) is a cache only; deleting it is safe.
- Secrets never appear in logs (covered by test).
- Auto-finalization skips signed claims and in-flight dispatches
  (`pending_digest`), submits at most once per claim per poll, and treats
  `SlotPending`/`AlreadyFinalized` races as benign: a duplicate MPC
  dispatch is impossible because the contract's pending entry + voucher
  map decide, not the caller. Finalization failures never block voucher
  settlement.
