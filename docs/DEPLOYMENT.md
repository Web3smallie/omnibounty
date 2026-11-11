# OmniBounty deployment

Testnet-first. Every step below is validated in order; do not skip to
mainnet with untested parameters.

## 0. Prerequisites

- Rust 1.86.0 exactly (`contracts/near/rust-toolchain.toml` pins it;
  `cargo-near` refuses newer toolchains for near-sdk 5.1) +
  `wasm32-unknown-unknown` target + `cargo-near` 0.23.0.
- Foundry (`forge`) with solc 0.8.24; Node 20+; Python 3.11+.
- A NEAR testnet account with ~10 NEAR (or free helper subaccounts for
  rehearsal — see §5). NOTE: the testnet helper can only create
  `*.testnet` subaccounts now, not bare top-level names.
- A Base Sepolia EOA with ETH for gas plus Sepolia USDC
  (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) — ONLY for the funded
  payout run (§5); everything else is free.
- A registered Reclaim zkFetch application (app ID + secret) for proof
  generation. The secret lives only in the proving machine's environment.

## 1. Build and verify locally

```sh
# live-network prerequisites (no funds spent, no transactions)
python tools/preflight.py

# fixtures + oracle cross-checks
cd tools && npm install && npm run gen && npm run check

# NEAR contract (from contracts/near; toolchain auto-pinned to 1.86.0)
cargo test                                  # 37 hermetic unit tests
cargo test --features xsuite                # + cross-contract suite
                                            #   (sandbox: Linux/macOS only)
cargo clippy --all-targets --features xsuite
cargo near build non-reproducible-wasm      # -> target/near/*.wasm + ABI

# Base escrow (from contracts/base; first time needs network for forge-std)
forge install foundry-rs/forge-std --tag v1.17.0
forge build && forge test                   # 30 tests incl. live voucher

# relayer + frontend
cd relayer && npm install && npm test
cd frontend && npm install && npm test && npm run build
```

## 2. Deploy the escrow (Base Sepolia)

Immutable deployment, no proxy (Phase 5 decision — see the audit report).
The script deploys with the KDF-verified MPC signer directly, refuses any
chain other than 84532, verifies `mpcSigner`/`owner`/`DOMAIN_SEPARATOR`
on-chain, and writes `testdata/base_sepolia.json` (no secrets):

```sh
cd contracts/base && forge build && cd ../..
BASE_RPC_URL=... DEPLOY_KEY=0x... node tools/deploy_escrow.mjs --check-only
BASE_RPC_URL=... DEPLOY_KEY=0x... node tools/deploy_escrow.mjs
```

`DEPLOY_KEY` needs Sepolia ETH for gas only. The deployer EOA becomes the
escrow `owner` (testnet: single key; mainnet: multisig — see §7). Manual
fallback (same effect, no automated verification):

```sh
cd contracts/base
forge create OmniEscrow --rpc-url $BASE_RPC_URL \
  --private-key $DEPLOY_KEY --constructor-args <MPC_SIGNER>
```

where `<MPC_SIGNER>` is the verified address from step 4
(`node tools/mpc_derive.mjs`), never a placeholder. Then wire NEAR:

```sh
node tools/set_escrow.mjs <deployed-escrow> --check-only   # read-only preview
node tools/set_escrow.mjs <deployed-escrow>                # owner tx + verify
```

## 3. Deploy the NEAR contract

On testnet the scripted path is `node tools/deploy_production_v2.mjs`
(deploys, configures, validates, writes `testdata/production_testnet.json`;
`--resume` re-verifies read-only). The manual equivalent for any fresh
account:

```sh
cargo near deploy v2.omnibounty.testnet --network testnet -- \
  new '{"owner":"<you>.testnet","mpc_contract":"v1.signer-prod.testnet",'
  '"escrow":"0x<base-escrow>","chain_id":84532}'
```

Replace `<base-escrow>` with the address from step 2 (no `0x` prefix
duplication — the contract accepts both, but be exact).

## 4. Derive and configure the MPC signer (MUST-DO)

The voucher signer is the Chain Signatures address derived for
(predecessor=`<contract>`, path=`omnibounty-voucher-v1`).
Derive it with the verified tool — it asserts the KDF independently
(`root + tweak·G == derived_public_key` view) on every run:

```sh
node tools/mpc_derive.mjs v2.omnibounty.testnet omnibounty-voucher-v1
# { ..., "kdfCheck": "MATCH",
#   "voucherAddress": "0x73dfe93ac7024492b21c5ca8d6f301ea978abb82" }
```

(For `v2.omnibounty.testnet` the address is
`0x73dfe93ac7024492b21c5ca8d6f301ea978abb82` — re-derive, never copy,
if the contract account or MPC version changes.)

1. `set_mpc_signer("0x...")` on NEAR **and** `setMpcSigner(0x...)` on the
   escrow. Both sides must agree; the NEAR callback self-check
   (`MpcSignerMismatch`) fails closed on any discrepancy.
2. Pin the epoch witnesses: `upsert_epoch(1, [...])` after confirming the
   current attestor addresses out-of-band (Reclaim docs / on-chain
   `reclaim-protocol.testnet` `get_epoch_by_id`). Never trust a single
   chat message for these values.

## 5. Live validation (MUST-DO before real funds)

### 5a. Free rehearsal (no funds, runs now)

```sh
node tools/live_handshake.mjs
```

Deploys to fresh helper accounts, claims against the REAL MPC, asserts
digest recomputation + ecrecover + replay rejection, and exports
`testdata/live_voucher.json`. Then `forge test` settles that live vector
(`LiveVoucherTest`). This has passed on testnet; re-run after any
contract change.

### 5b. Funded $1 end-to-end (requires operator credentials)

1. Deploy §2–§4 with the production names/keys.
2. Create a $1 (1000000 base units) bounty with the SAME id on both
   chains: `create_bounty` on NEAR + escrow, `fundBounty` with real
   Sepolia USDC from the sponsor EOA.
3. Generate a REAL proof with `frontend/scripts/prove.mjs` against a
   merged PR matching the bounty (repo/number/author).
4. `dry_run` → `claim` → wait for `voucher_signed` → run the relayer
   (`npm run once`, then daemon) → confirm $1 USDC arrives at the
   contributor address.
5. Negative: an unmerged-PR proof must fail with `PREDICATE_FAILED`
   (covered in unit tests; re-confirm live if the template changed).
6. Only then fund production bounties.

Blockers that need the operator (nothing else): a funded Base Sepolia
EOA (ETH + USDC) and Reclaim app credentials for a real proof. The NEAR
leg needs no funds (helper accounts).

## 6. Run the relayer

```sh
cd relayer
export NEAR_RPC_URL NEAR_CONTRACT_ID=v2.omnibounty.testnet BASE_RPC_URL \
  ESCROW_ADDRESS MPC_SIGNER_ADDRESS RELAYER_PRIVATE_KEY
npm run once     # smoke test: expect [] or relayed results
npm start        # daemon (use systemd/supervisor in production)
```

Fund the relayer EOA with Sepolia ETH for gas. It needs no USDC and no
NEAR key (read-only on NEAR).

## 7. Mainnet migration checklist

- [ ] Multisig + timelock own both contracts (replace EOA owners).
- [ ] Multi-witness Reclaim epoch pinned; rotation runbook written.
- [ ] MPC derivation re-done for mainnet signer contract + account.
- [ ] Voucher TTL / proof window re-confirmed for mainnet finality.
- [ ] Full handshake re-run with $1 on mainnet before real bounties.
- [ ] Monitoring: relayer liveness, `voucher_signed` vs settled lag,
      owner-action alerts.
