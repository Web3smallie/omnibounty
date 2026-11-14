# E2E #4 evidence (authoritative, published)

Bounty `223339065907692` full lifecycle on NEAR testnet + Base Sepolia,
2026-11-13: sponsor → fund → qualify (live Reclaim proofs) → MPC sign →
Base settlement of 1 testnet USDC. Start with `E2E-RUN4.md`, then
`DEPLOYED.md` for the contract deployment it ran against.

Provenance: byte-identical copies of the workspace backup
(`audit-backup-20261113/`, checksummed there in `SHA256SUMS`), published
here so fresh clones can verify without workspace-local files. Verify
with `sha256sum -c SHA256SUMS` from this directory, then compare each
digest against the backup manifest.

Contents:
- `E2E-RUN4.md` — the run record (every tx hash + explorer link).
- `DEPLOYED.md` — corrected-WASM deployment record (code hash, states).
- `proofs4/` — the run's live PR + identity proofs and issued voucher.
- `proofs/` — earlier-run proofs, dry-run args/result, demo criteria.
- `deploy/` — deploy tx JSON, pre/post state snapshots.
- `corrected/omnibounty_v3.fixed-f5b2539.wasm` — the deployed bytes
  (SHA-256 `766c6b14...`; `cmp` against live `view_code` to confirm).
- `qualify-runner.mjs`, `run-relayer-v2.mjs`, `deploy-corrected.mjs` —
  ARCHIVAL records of the exact scripts used. They contain absolute
  workspace paths and are not runnable elsewhere; current terminal
  equivalents live in `tools/` (`qualify_claim.mjs`, `sponsor_bounty.mjs`,
  `finalize.mjs`) and `relayer/src/index.mjs --once`.

Live vs recorded: these proofs were live attestations on 2026-11-13 and
are CONSUMED on-chain (nullifiers spent). Reuse them only for
shape/crypto inspection and replay-demonstration (see JUDGES.md §8) —
never as fresh attestations.
