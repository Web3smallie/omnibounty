# OmniBounty V3 qualification testing — Phases 1–5 record

Date (UTC): 2026-11-13. No transactions submitted. No contracts deployed.
No credentials stored here (proofs scanned: zero token patterns).

## Phase 1 — real GitHub PR proof: PASS
- Command: `node scripts/prove.mjs Web3smallie/omnibounty 1 proofs/proof-pr.json` (from frontend/)
- Proof received in ~4s. Local gate clean.
- SHA-256: 13d02c8c3d4c4dfddf034300e154558ad1da8eacf47bcd23299f6fd48e0ab336
- Extracted: merged=true author=Web3smallie id=130228599 repo=Web3smallie/omnibounty
  number=1 head=c77fd6e302ac228318ff68807bccdbe8835d5452
- Note: prove.mjs process lingers on open SDK handles after writing;
  bounded with `timeout`, success judged by artifact + validation, not exit code.

## Phase 2 — real identity proof: PASS
- Command: `GITHUB_TOKEN=<claimant, one-time env> timeout 180 node scripts/prove_identity.mjs proofs/proof-identity.json`
- Proof received in 3.4s. Extracted: id_login=Web3smallie id_num=130228599.
- SHA-256: e89ab692870a47b76a2f39ae959e81bdeb0db66f253ac338b7562a30976595dc
- Token-refuse guard passed; log + proof scanned: zero token patterns.
- Operator action: claimant GitHub token revocation (single use completed).

## Phase 3 — local verification: PASS
- Both proofs: shape ok, provider http, epoch 1, 1 signature each.
- Freshness: PR age ~54 min, identity age ~3 min (limit 604800s; skew ok).
- Owners equal: 0xaa77daf4a174b3d05d6046462a7cb0e8eb9fa426 (intended recipient).
- checkIdentityBinding: [] (login+id match PR author; owners match recipient).
- PR + identity template gates: [] clean.

## Phase 4 — on-chain dry_qualify: PASS
- Criteria recovered byte-exact (517 B) from create_bounty tx F6339b7j... (SuccessValue,
  receipts success); creation log confirms criteria_hash 0x499fc4d3...7e95b6.
- SHA-256 criteria: 3a8986168c413ed6c92cb04325611a459d193a59e668e6ff4fe27261958f837e
- Target: live omnibounty-v3.testnet (original 8d578171 WASM; view call, no state change).
- Result: ok:true, errors:[] — all 11 verdicts pass:
  bundle.shape, bundle.matchers, pr.matchers, identity.matchers, bundle.join,
  pr.merged, pr.author, pr.forks, identity.login, identity.id, pr.created_at.
- SHA-256 dry-result: fc891e1a5f954075e11fec097c6083f55b977b092716e61a711d75def2cd37b3
- SHA-256 dry-args: 6fd5676f7143689602fc1796248fe0925c14e6e0727ab8e1e98e2cd4e9d5ecab
- Nullifiers/slots NOT consumed (view only); real qualify_claim remains available.

## Phase 5 — evidence: COMPLETE
- proofs/proof-pr.json, proofs/proof-identity.json, proofs/demo-criteria.json,
  proofs/dry-result.json, proofs/dry-args.json — all hashed in SHA256SUMS (verified OK).
- No secrets in any artifact (scanned).

## Remaining before Phase 6 (needs separate approval)
- Revoke claimant GitHub token (one-time use done).
- Decide deployment order: qualify against live original WASM now, or deploy
  corrected 766c6b14 first (behavior-identical;dry_qualify transfers).
- Real qualify_claim tx (300 Tgas + deposit), scheduler/manual finalize_claim,
  MPC voucher, relayer Base settlement, 1 USDC receipt verification.
