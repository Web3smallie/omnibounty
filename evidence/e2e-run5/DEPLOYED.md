# Corrected WASM deployment record — OmniBounty V3

Date (UTC): 2026-11-13. Target: EXISTING omnibounty-v3.testnet (no new account).
Source: main @ 6c15d03 (contract tree == c77fd6e). Deploy script:
audit-backup-20261113/deploy-corrected.mjs (hash-gated, single DeployContract).

## Transaction
- Hash: 7yqc5RpEyfHcqBwXuvLgJtCoJQEbb2BjKQgarKRXvef5
- Explorer: https://testnet.nearblocks.io/txns/7yqc5RpEyfHcqBwXuvLgJtCoJQEbb2BjKQgarKRXvef5
- Action: DeployContract. Status: SuccessValue (receipts success).
- Gas burnt: 45984963289120 + 223182562500.
- Full tx JSON: deploy/deploy-tx.json.

## Deployed code (verified from chain via view_code + view_account)
- Bytes: 707605. SHA-256: 766c6b14accb4730b634a5d659a10ae804e3e1eb86c77fe1ba9a1fefc02a94d4 (match).
- Code hash: 8yGzesTCJSRu4egz4bBeS19ABLSb6Y6TJQpRHH7quiYj (match).
- Previous code 8d578171... replaced; no other account touched.

## State preservation (pre/post deep-compare, all views byte-identical)
- config (incl. next_nonce=1, bounty_count=1, paused=false): UNCHANGED
- bounty 223339065907689 (funded, slots_filled=1, seq=1): UNCHANGED
- claim slot 0 (finalized, signed): UNCHANGED
- voucher slot 0 (+ MPC signature): UNCHANGED
- epoch 1 + witness 0x244897572368eadf65bfbc5aec98d8e5443a9072: UNCHANGED
- list_unrelayed (1 entry): UNCHANGED
- Snapshots: deploy/pre-deploy-state.json, deploy/post-deploy-state.json.

## Post-deploy live behavior (new code executing on-chain)
- Relayer V2 discovery: finds voucher 0x994e..., reports status "already"
  (usedVoucher ground truth), submits nothing, exit 0.
- dry_qualify with consumed bundle: ok=false with exactly
  ["NO_OPEN_SLOT...", "IDENTIFIER_REPLAY"] — correct post-state behavior:
  crypto verification passed, state gates reject reuse. No template errors,
  no crashes: corrected evaluate() executes correctly live.
- Base escrow untouched and consistent (slot claimed, nullifier set).

## Base compatibility (re-verified pre-deploy, unchanged by NEAR deploy)
- Chain 84532, escrow 0x63391c272A49c30f79eb6c3d8E10F0652Bb0F767 (6276 B,
  sha 0x3b6ace4f...), VoucherV2 claim selector 0x5b274d7c present,
  mpcSigner 0x4b20...A2f9, USDC 6 decimals, escrow 0 / recipient +1000000.
- No Base redeployment necessary: voucher format, digest, chain/escrow
  constants, and units are identical (voucher.rs untouched; config unchanged).
