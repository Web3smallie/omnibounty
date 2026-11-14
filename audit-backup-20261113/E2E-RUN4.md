# E2E run 4 — bounty #4 (sponsor 0xe8fA..., corrected contract) — evidence record

Date (UTC): 2026-11-13. Bounty ID: 223339065907692. Criteria: same 517 bytes,
hash 0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6.
Recipient: 0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426. All USDC figures are Base
Sepolia TESTNET units (6 decimals), not mainnet funds.

## Bounty setup (Base sponsor 0xe8fA461508aCfE4b83f06ea40740728DAF8bA476)
- NEAR create_bounty: HS6KDKti7wtK9XtNywMpmQsh6o8PQbodB1LMYqyzGXCU SuccessValue
  https://testnet.nearblocks.io/txns/HS6KDKti7wtK9XtNywMpmQsh6o8PQbodB1LMYqyzGXCU
- Base createBounty: 0xea42f6611f36514b0c0d22dc571c988ea398cd9983738e2e173da2876a6f2e29 status 1
  https://sepolia.basescan.org/tx/0xea42f6611f36514b0c0d22dc571c988ea398cd9983738e2e173da2876a6f2e29
- Base approve: 0xc0d21e049dca3c488a432a28271f60b761e6d8eeacf2df41f4e463d674b319cb status 1
  https://sepolia.basescan.org/tx/0xc0d21e049dca3c488a432a28271f60b761e6d8eeacf2df41f4e463d674b319cb
- Base fundBounty: 0x61929b5d2d1e811907fd7c8bb3c37f4c59278c6402e349eeae72dd919713b7d0 status 1
  https://sepolia.basescan.org/tx/0x61929b5d2d1e811907fd7c8bb3c37f4c59278c6402e349eeae72dd919713b7d0
- NEAR mark_funded: 9trFJqDSaP26TZE1KCwRszvDmx9pgxdHnGmqjZykY6aN SuccessValue (bounty_funded)
  https://testnet.nearblocks.io/txns/9trFJqDSaP26TZE1KCwRszvDmx9pgxdHnGmqjZykY6aN
- Cross-check: Base sponsor 0xe8fA / funded / 1000000 == NEAR funded / slots ["1000000"].

## Fresh proofs (proofs4/, corrected runner, explicit dir, no fallback)
- PR: ts 1794603118, epoch 1, gate clean (merged/author/repo/number/head/author_id/created).
- Identity: ts 1794603335, epoch 1, id_login=Web3smallie id_num=130228599, gate clean.
- Owners equal 0xaa77...; binding clean; zero token patterns in logs/artifacts.
- dry_qualify on live corrected contract: ok:true, 11/11 pass.

## Lifecycle
- qualify_claim (via qualify-runner.mjs proofs4 --submit):
  8kMiXeRhBPa6ptRGJAts9otavXfT8xp8wX1oDCBoUg8D SuccessValue (claim_qualified slot 0)
  https://testnet.nearblocks.io/txns/8kMiXeRhBPa6ptRGJAts9otavXfT8xp8wX1oDCBoUg8D
- finalize attempt 1: dispatched digest 0xbc85... nonce 3 -> MPC returned
  prefix/recovery mismatch -> voucher_rejected (MPC_BAD_RESPONSE), released cleanly.
- finalize retry: 5vnwhnBvQsiF5VxKTec6DqAzrN3e6WVtXqYPYTQNmbZd
  SuccessValue Applied (voucher_signed digest 0x934e... nonce 4, amount 1000000)
  https://testnet.nearblocks.io/txns/5vnwhnBvQsiF5VxKTec6DqAzrN3e6WVtXqYPYTQNmbZd
- Voucher: nonce 4, v=28; independent relayer validation ok:true, digest match.
- Base settle (relayer V2): 0xd946ced8e9570c493841c86200e78290737c6dba681c9446e149023fd25a8f81
  status 1 (older vouchers correctly "already")
  https://sepolia.basescan.org/tx/0xd946ced8e9570c493841c86200e78290737c6dba681c9446e149023fd25a8f81
  VoucherClaimed(...692, 0, 0xAa77..., 1000000, nonce 4, 0x499f..., 0x934e...).
  Transfer(escrow -> 0xAa77..., 1000000). Recipient 3000000 -> 4000000 (+1000000
  exact, archival delta). Escrow 2000000 -> 1000000 (remainder = bounty #2 funds).
  slotStatus claimed, usedVoucher true.

## Incident note (full disclosure)
One unintended extra transaction occurred during setup: a chained shell command
accidentally re-ran the bounty-#3 NEAR create script, which submitted
create_bounty(223339065907691) and failed with BountyExists. Failed txs mutate
nothing: bounty #3 state re-verified intact (funded, filled 1, seq 1) immediately
after. Single-purpose commands used exclusively afterwards.
