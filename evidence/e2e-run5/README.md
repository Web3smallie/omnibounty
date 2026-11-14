# E2E Run 5 evidence (authoritative, published)

Bounty `414201122891941` full lifecycle on NEAR testnet + Base Sepolia,
2026-11-14: sponsor → fund → fresh merged PR #2 → live Reclaim proofs →
qualify → MPC sign (2 known first-response retries, 3rd signed) →
Render-relayer settlement of 1 testnet USDC. Start with `E2E-RUN5.md`, then
`DEPLOYED.md` for the contract deployment it ran against (unchanged).

This directory formerly held the Run 4 record; it was renamed and rewritten
for Run 5 (`E2E-RUN4.md` -> `E2E-RUN5.md`) — Run 4 is not presented as a
separate current run. Verify with `sha256sum -c SHA256SUMS` from this
directory.

Contents:
- `E2E-RUN5.md` — the run record (every tx hash + explorer link).
- `VERIFY-RUN5.md` — independent re-verification: fresh RPC queries and outputs confirming the payout and deployed bytecode.
- `DEPLOYED.md` — corrected-WASM deployment record (code hash, states).
- `proofs4/` — the run's live PR + identity proofs and issued voucher.
- `proofs/` — demo criteria (reused, hash-identical), current dry-run
  args/result, and earlier-run proofs kept as historical reference.
- `deploy/` — deploy tx JSON, pre/post state snapshots.
- `corrected/omnibounty_v3.fixed-f5b2539.wasm` — the deployed bytes
  (SHA-256 `766c6b14...`; `cmp` against live `view_code` to confirm).
- `qualify-runner.mjs`, `run-relayer-v2.mjs`, `deploy-corrected.mjs` —
  ARCHIVAL records of scripts used by earlier runs. They contain absolute
  workspace paths and are not runnable elsewhere; Run 5 used the tracked
  terminal equivalents in `tools/` (`qualify_claim.mjs`,
  `sponsor_bounty.mjs`, `finalize.mjs`) with settlement by the deployed
  Render relayer.

Live vs recorded: these proofs were live attestations on 2026-11-14 and
are CONSUMED on-chain (nullifiers spent). Reuse them only for
shape/crypto inspection and replay-demonstration (see JUDGES.md §8) —
never as fresh attestations.
