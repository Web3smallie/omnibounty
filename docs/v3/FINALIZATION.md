# V3 Claim Finalization: Two Mechanisms

V3 splits claiming into `qualify_claim` (verify everything, reserve the slot)
and `finalize_claim` (dispatch the MPC signing round). The second step is
**permissionless** — anyone may call it for a matured claim — but somebody
must still send the transaction. This document explains the two triggers,
why both exist, and the security boundary between demo and production.

## 1. Normal unattended operation — GitHub Actions scheduler

Workflow: `.github/workflows/finalize-scheduler.yml` (every 10 minutes +
manual dispatch). Batch logic: `tools/finalize_batch.mjs`, reusing the
audited one-shot core `tools/finalize.mjs`.

Why GitHub Actions instead of a keeper/Render worker:

- No new hosted service to deploy, fund, monitor, or keep alive.
- No long-lived server holding a key — the operator key lives in a GitHub
  Actions secret and exists only inside the 20-minute ephemeral runner.
- The 10-minute cadence matches the workload: finalization is
  deadline-driven (challenge windows are hours/days in production), not
  latency-sensitive.

How it works:

- Pages `list_bounties`, probes each filled slot's `get_claim`, and keeps
  unsigned claims whose `challenge_ends_at` has passed and that have no
  signed voucher yet.
- Runs the one-shot finalizer per claim with bounded polling (8 rounds ×
  15 s), so one slow MPC round cannot starve the batch. Failures are
  isolated per claim and retried on the next tick; already-signed claims
  are skipped without a transaction.
- Concurrency group `v3-finalize` serializes runs; `contents: read` is the
  only permission; the scheduler is best-effort, not an
  instant-execution guarantee.

Setup: repository secret `NEAR_OPERATOR_KEY_JSON`
(`{"account_id": "<op>.testnet", "private_key": "ed25519:..."}`) plus ~1–2
NEAR on a dedicated operator account (0.1 NEAR storage deposit per
finalization + gas; no special permissions needed). Recovery: run
`node tools/finalize.mjs <bountyId> <slot>` manually — same code path.

## 2. Live demo operation — automatic relayer-triggered finalization

The hackathon demo is strictly three minutes: waiting for the next
10-minute scheduler tick, or asking the judge to approve a second
transaction, would break the one-submit experience. The already-running
relayer therefore also finalizes: in V2 mode with operator credentials
configured, each poll first submits `finalize_claim` for matured unsigned
claims, then proceeds to normal voucher discovery and Base settlement
(`relayer/src/index.mjs`: `finalizePass`, `discoverMaturedClaims`,
`finalizeOne`).

- Enabled only when `VOUCHER_VERSION=2`, `FINALIZE_ENABLED` is not
  `"false"`, and both `NEAR_OPERATOR_ACCOUNT_ID` /
  `NEAR_OPERATOR_PRIVATE_KEY` are set. V1 deployments and unset
  credentials run settlement-only, exactly as before.
- Skips signed claims and in-flight dispatches (`pending_digest`), so no
  operator gas is burned on doomed resubmits.
- `SlotPending` / `AlreadyFinalized` races (scheduler, manual finalizer,
  or a second relayer) are benign: the contract's pending entry + voucher
  map make a duplicate MPC dispatch impossible.
- A failed finalize pass never blocks settlement: failures are recorded
  as results while voucher discovery proceeds.

The designated demo bounty uses `challenge_window_sec: "0"`, so a claim
is matured in the block it qualifies and the relayer's next poll (≤30 s
default, 10 s recommended for the demo) dispatches signing. Judges submit
once; the frontend tracks qualifying → qualified → finalizing → signing →
settling → paid, and shows "paid" only after the escrow `usedVoucher`
flag and payout log are confirmed.

## 3. Security distinction: what the challenge window protects

Zero challenge time is a deliberate, isolated **demo-bounty
configuration**, not a protocol change. Facts:

- The window is per-bounty criteria, committed by hash at creation and
  immutable afterwards. A window-0 demo bounty cannot affect any other
  bounty. Production bounties keep meaningful windows.
- There is no on-chain dispute/revoke action; the window's protection is
  **reaction time** for off-chain monitoring → human → owner global pause
  (`set_paused` blocks new qualifications and finalize dispatches, though
  not in-flight MPC callbacks). Window 0 removes that interval: a
  fraudulent-but-verifying claim could go from qualify to signed voucher
  in ~2 blocks + MPC latency with no pause point.
- Everything cryptographic is unchanged by the window: Reclaim proof
  verification, criteria evaluation, recipient/identity binding,
  nullifiers, duplicate-PR protection, voucher construction from stored
  state, the MPC signer self-check, and the Base escrow slot bitmap all
  enforce identically at window 0 — the same posture under which V2
  already settled a live $1 payout with no window at all.
- Demo hygiene: small amounts ($1), short-lived, clearly labeled, on
  testnet. Never configure window 0 on a production bounty holding
  meaningful funds.

## 4. Independence and coexistence

- Neither path depends on the other. The relayer finalizes on its own
  polls; the scheduler scans on its own ticks; the one-shot script works
  by hand. Any one of them alone completes every matured claim.
- All three share the same contract guards, so concurrent triggers
  collapse into polling instead of conflicting: at most one live dispatch
  per slot, at most one signed voucher per slot, at most one escrow
  payout per slot (slot bitmap).
- Honest performance note: automatic finalization removes *waiting*, not
  *MPC latency*. End-to-end time is dominated by the Chain Signatures
  round plus one relayer poll; see the demo runbook for the measured
  budget. A three-minute payout is the target, not a guarantee — if MPC
  is slow, the tracker says so instead of pretending.
