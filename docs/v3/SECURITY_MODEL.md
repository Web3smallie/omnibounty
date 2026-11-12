# OmniBounty V3 — Security Model

What is cryptographically enforced, what is assumed, and what is explicitly
out of scope. Anything not in the first category MUST NOT be marketed as a
guarantee.

## 1. Trust anchors (cryptographic, on-chain enforced)

- **Reclaim witness signatures**: recovered signer set must equal the pinned
  epoch set exactly (carried over from V2 `verify_core`, proven live).
- **Identifier + nullifier scoping**: replay key binds bounty, recipient,
  evidence type and proof identifier (golden-tested construction).
- **Criteria commitment**: `criteria_hash` committed at funding; every claim
  re-supplies the document and the contract re-hashes before enforcing any
  rule. No criteria setters exist. Display layers re-hash too.
- **Voucher signatures + escrow accounting**: MPC-signed slot vouchers;
  escrow enforces slot bitmap + per-slot amounts + totals (V3 contract work).
- **Deterministic ordering**: slot assignment by contract sequence, never
  wall-clock races.

## 2. Explicit assumptions (NOT cryptographic)

- GitHub API returns truthful data at attestation instant (point-in-time).
- Reclaim attestor + witness set behave honestly per proof.
- MPC network and Base finality hold (as in V2).
- Block timestamps are sane within skew bounds.
- The funded criteria document is preserved off-chain (any host; integrity
  self-verifies by hash, availability does not).
- Sandbox note: Phase 1–2 proofs ran against the `:443` attestor via a
  documented shim because this sandbox blocks `:444`; production uses the
  flagged endpoint. A user-machine unshimmed confirmation run is advised.

## 3. Resolved security questions (from the Phase 2 brief)

1. **Protected-file integrity**: SOLVED POSITIVELY — per-file contents-API
   proofs (`path`+`blob_sha`+`size`) compared against committed blobs at the
   joined head SHA (P2-01 executed). No absence reasoning anywhere.
2. **Contributor identity**: HONESTLY BOUNDED — no trustless GitHub↔wallet
   link exists in this stack (proof owner = Reclaim app key holder, verified
   in SDK code). Two explicit policies: `open` (first valid prover paid,
   author as evidence) and `commitment` (PR body/title must bind
   `omnibounty:<bounty_id>:<recipient>`; branch-write access ≈ authorship,
   maintainer-push residual disclosed).
3. **Identifier scoping**: SOLVED — keyed nullifier construction specified
   with golden test vector; same evidence CAN back distinct bounties/
   recipients without cross-replay (fixes the V2 same-PR limitation).
4. **Multi-proof binding**: SOLVED — endpoint URL templates pinned per
   evidence type; PR numbers and head SHAs joined with equality; contents
   refs and list SHAs must equal the joined head. Implemented + tested
   against REAL Phase-1 fixtures sharing head `5621284b…`.
5. **Workflow provenance**: SOLVED for the enforceable part — required app
   slugs from allowlist + workflow-file blob integrity via contents proofs
   + head binding. Residual: a repo admin can change workflows; base-commit
   pinning + protected blobs make drift fail closed.
6. **Multi-review binding**: SOLVED — per-reviewer anchored patterns,
   executed live (P2-02). Bare approval COUNTS remain unsupported by design.
7. **Endpoint templates**: every matcher below is taken from executed proofs
   or locally pre-verified patterns; see VERIFICATION_MATRIX.md. Unproven
   shapes are marked SPECIFIED, never PROVEN.

## 4. Threat catalog (condensed; exploit → mitigation)

- **Criteria tampering post-funding** → altered doc re-hashes differently →
  rejected; no setters exist. **Display spoofing** → UI re-hashes before
  render; mismatch shows Unverified.
- **Wrong-PR / wrong-head evidence** → join equality fails the claim.
- **Fork confusion** → head-repo matching under `allow_forks:false`; explicit
  opt-in otherwise.
- **Stale evidence** → per-proof freshness bound + optional check max-age.
- **Replay / duplicate claims** → scoped nullifiers + (bounty, PR) claim key
  + per-slot bitmap.
- **Tampered proofs** → identifier/signature binding fails (proven live).
- **Criteria display vs enforcement drift** → single canonical bytes hashed
  by both UI preview and contract.
- **Challenge griefing** → fixed window, deterministic resolution, gas-cost
  spam, exactly-once finalization; no bonds, no judges.
- **Overpayment / double payout** → sum==funded at creation; slot bitmap +
  totals invariant at payout.
- **Sponsor rug (criteria change / fund diversion)** → impossible by
  construction (no setters; escrow rules fixed).
- **Metadata host compromise** → liveness-only impact; integrity self-checks.
- **Attestor/witness compromise** → out-of-band epoch rotation by owner
  (multisig-gated in production); per-epoch pinning bounds blast radius.
- **Regex injection via attacker content** (e.g. crafted PR body breaking
  out of a matcher) → anchored patterns validated per endpoint; patterns
  avoid unanchored `.*?` spans crossing trust boundaries; matcher set is
  part of the signed params the contract pins per endpoint template.

## 5. AI boundaries (hard rules)

AI may draft criteria from prose, explain failures, and summarize diffs. AI
output MUST NEVER: enter claim verification inputs, authorize payment,
override a deterministic check, or be displayed as proof/verification. Any
UI surface showing AI text labels it as advisory opinion. Tasks whose
acceptance is not expressible in this schema are out of scope for
automated bounties — say so instead of simulating judgment.

## 6. Residual risks (accepted, monitored)

R1: GitHub API dishonesty at attestation instant (no defense possible;
  inherent to oracle design). R2: Reclaim SDK/attestor migration drift
  (pin versions; re-run proof smoke suite on upgrade). R3: maintainer-push
  under `commitment` identity. R4: mutable metadata availability. R5: quantum/
  cryptographic primitive aging (standard, out of scope).
