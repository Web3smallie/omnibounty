# E2E Run 5 — bounty 414201122891941 (fresh wallets, Render settlement) — evidence record

Date (UTC): 2026-11-14. This record supersedes the Run 4 record (renamed from
E2E-RUN4.md, not duplicated). Bounty ID: 414201122891941. Criteria: same 517
bytes as Run 4, hash 0x499fc4d32bc3bc91a8cab81785c6fb59e7073c3f769e2b03399b68bdcd7e95b6.
Recipient: 0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426. All USDC figures are Base
Sepolia TESTNET units (6 decimals), not mainnet funds.

## Wallets (all separation verified on-chain)

Run 5 used different sponsor and contributor wallets on both NEAR and
Base Sepolia: the deployer was separate; the sponsor used its own NEAR
account and Base wallet; the contributor used a different NEAR account
and Base wallet — sponsor and contributor wallets were distinct across
both chains, as the addresses below show. Separately, the wallets were
controlled by the project team, so the demo was self-funded and
self-claimed (GitHub: Web3smallie) and does not demonstrate independent
sponsor–contributor participation. Who did what is traceable per
transaction below; account pages:

- NEAR deployer/operator: omnibounty-v3.testnet (contract account,
  self-deployed).
  https://testnet.nearblocks.io/address/omnibounty-v3.testnet
- NEAR sponsor: run5sponsor.testnet (new, faucet-funded).
  https://testnet.nearblocks.io/address/run5sponsor.testnet
- NEAR contributor: run5contributor.testnet (new, faucet-funded).
  https://testnet.nearblocks.io/address/run5contributor.testnet
- EVM deployer/relayer: 0x7b8726add6b17a99bdcb938060a9f40e86dc12a5 (escrow
  creator, owner, Render relayer sender — one address, three
  infrastructure roles).
  https://sepolia.basescan.org/address/0x7b8726add6b17a99bdcb938060a9f40e86dc12a5
- EVM sponsor: 0xe8fA461508aCfE4b83f06ea40740728DAF8bA476 (unchanged from Run 4).
  https://sepolia.basescan.org/address/0xe8fA461508aCfE4b83f06ea40740728DAF8bA476
- EVM recipient: 0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426 (proof owner,
  unchanged: owner derives from the Reclaim app secret).
  https://sepolia.basescan.org/address/0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426
- MPC signer: 0x4b204ae1890a0cd49cc594fe712fea4ac765a2f9 (config + independent
  ecrecover of the voucher signature). MPC network: v1.signer-prod.testnet.
  https://sepolia.basescan.org/address/0x4b204ae1890a0cd49cc594fe712fea4ac765a2f9

## Bounty setup (NEAR sponsor run5sponsor.testnet, EVM sponsor 0xe8fA)

- NEAR create_bounty: 4vMcENqFKikCzdfTKFgHeqZujCHYbgcQwozNsi6CLJJW SuccessValue
  (13:47:48; bounty_created, sponsor recorded as run5sponsor.testnet)
  https://testnet.nearblocks.io/txns/4vMcENqFKikCzdfTKFgHeqZujCHYbgcQwozNsi6CLJJW
- Base createBounty: 0x9071258a5f857fce0519d8105c842382a6fcd5f8e73cdda5adb48598d71dab4b status 1 (13:50:26)
  https://sepolia.basescan.org/tx/0x9071258a5f857fce0519d8105c842382a6fcd5f8e73cdda5adb48598d71dab4b
- Base approve: 0x6271ac8f8b721023d2ae60189731388c4b850e3e9d0b32e7571693f00aad71f1 status 1 (13:50:43)
  https://sepolia.basescan.org/tx/0x6271ac8f8b721023d2ae60189731388c4b850e3e9d0b32e7571693f00aad71f1
- Base fundBounty: 0xdb6308d226b240fccbede52cc1fc090d4866701a6c2687515abc8479496a4de2 status 1 (13:50:59)
  https://sepolia.basescan.org/tx/0xdb6308d226b240fccbede52cc1fc090d4866701a6c2687515abc8479496a4de2
- NEAR mark_funded: 9tJfe4ZEts4HBaRY6XDLTrHqm1vQ4hTogzryqhHL7f3j SuccessValue (13:51:36, bounty_funded)
  https://testnet.nearblocks.io/txns/9tJfe4ZEts4HBaRY6XDLTrHqm1vQ4hTogzryqhHL7f3j
- Cross-check: Base sponsor 0xe8fA / funded / 1000000 == NEAR funded / slots ["1000000"].

## Contribution (fresh PR #2, merged to main)

- PR: https://github.com/Web3smallie/omnibounty/pull/2 — docs one-liner
  recording the escrow deployer (branch run5/contribution, commit 0b7b3fd).
- Created 13:52:11Z, squash-merged 13:52:17Z, author Web3smallie,
  head 0b7b3fd57e13340936bd80453f5517475974f49a. merged=true verified via API.

## Fresh proofs (proofs4/, same app pair as Run 4, new sessions)

- PR: ts 1794665417 (14:10:17), epoch 1, new identifier 0x4555d5a8...,
  extracted number=2 head=0b7b3fd... merged=true, gate clean.
- Identity: ts 1794665688 (14:14:48), epoch 1, id_login=Web3smallie
  id_num=130228599, gate clean.
- Owners equal 0xaa77...; binding clean; zero secret patterns in
  artifacts (sweep for ghp_/bearer/private_key empty; 64-hex hits are the
  public digest, criteria hash, and signature halves).
- dry_qualify on live contract pre-submit: ok:true, PR #2, head match.
  Post-state re-run correctly reports ok:false with exactly
  [NO_OPEN_SLOT, IDENTIFIER_REPLAY] (proofs consumed on-chain).

## Lifecycle

- qualify_claim (contributor key, via tools/qualify_claim.mjs --submit):
  8oyEHfjRiG6jF9xkQnXZcuA8bCU6AwKB6G8MBC27zCUi SuccessValue
  (14:17:44, claim_qualified slot 0, PR #2)
  https://testnet.nearblocks.io/txns/8oyEHfjRiG6jF9xkQnXZcuA8bCU6AwKB6G8MBC27zCUi
- finalize attempt 1 (Render relayer): HU43Wf7rkikzVhEpkdPruFRrUZC9SVrv85RohSgGxoRV
  (14:18:11) dispatched digest 0x4802... nonce 5 -> MPC returned
  prefix/recovery mismatch -> voucher_rejected (MPC_BAD_RESPONSE), released cleanly.
  https://testnet.nearblocks.io/txns/HU43Wf7rkikzVhEpkdPruFRrUZC9SVrv85RohSgGxoRV
- finalize attempt 2 (operator tool): tGmq8DLY5yQC59jviia3oyiq8k1NqzCQ6t4vhH9mEHR
  (14:18:20) dispatched digest 0xfac6... nonce 6 -> same MPC mismatch ->
  voucher_rejected, released cleanly.
  https://testnet.nearblocks.io/txns/tGmq8DLY5yQC59jviia3oyiq8k1NqzCQ6t4vhH9mEHR
- finalize attempt 3 (Render relayer): 6qFZgGE6wdLzQ6qurap8hyLEyokBigxTRrJmpxBC7H8u
  (14:20:15) SuccessValue voucher_signed digest 0x15a3e5ec9... nonce 7,
  amount 1000000, v=27, recovered signer 0x4b20...A2f9 (match).
  https://testnet.nearblocks.io/txns/6qFZgGE6wdLzQ6qurap8hyLEyokBigxTRrJmpxBC7H8u
- Base settle (Render relayer 0x7b87, claim selector 0x5b274d7c):
  0x3f171afb6649b3d0432bd4eaabdb90ede5fd2e871248a6153b89edc5024037e1
  status 1, block 58721205 (14:21:49, 94s after signing)
  https://sepolia.basescan.org/tx/0x3f171afb6649b3d0432bd4eaabdb90ede5fd2e871248a6153b89edc5024037e1
  VoucherClaimed(...941, 0, 0xAa77..., 1000000, nonce 7, 0x499f..., 0x15a3...).
  Transfer(escrow -> 0xAa77..., 1000000). Recipient 4000000 -> 5000000 (+1000000
  exact). Escrow 2000000 -> 1000000 (remainder = bounty #2 locked funds).
  Sponsor 18000000 -> 17000000. slotStatus claimed, usedVoucher true.

## Final state (independently re-read, read-only)

- NEAR bounty 414201122891941: sponsor run5sponsor.testnet, funded, filled 1/1, seq 1.
- NEAR claim slot 0: finalized, signed, recipient 0xaa77..., PR #2.
- Run 4 bounty 223339065907692 re-verified intact (funded, filled 1, seq 1).
- Base: slot claimed, usedVoucher(digest) true, balances conserve exactly.

## Incident notes (full disclosure)

- The first prove.mjs invocation hung ~15 min with no output (sandbox proxy
  stall on the attestor websocket, matching Node-HTTPS stalls seen earlier
  the same day). It was terminated before producing anything and rerun
  cleanly: proof received in 34s. Pre-submit and off-chain — no chain impact.
- MPC first-response mismatch struck twice (attempts 1-2, nonces 5-6);
  attempt 3 signed. Same known behavior as Run 4, which needed one retry.
- Node HTTPS to Base Sepolia stalled in this sandbox, so the funding leg
  used `cast` (identical signed calls); verification used receipts plus a
  Blockscout cross-check after the public RPC's getLogs range limits
  swallowed two event scans (operator-side issue, not a chain issue).
