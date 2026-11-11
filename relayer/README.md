# OmniBounty relayer

Polls the NEAR contract for signed vouchers (`list_unrelayed`), validates each
voucher independently (field checks, EIP-712 digest recomputation, MPC signer
recovery), and submits valid ones to the Base escrow.

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
```

The relayer key needs Base Sepolia ETH for gas only; it can never redirect
funds (recipients are fixed inside MPC-signed vouchers).

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
