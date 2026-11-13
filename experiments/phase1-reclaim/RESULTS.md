# Phase 1 Results — Reclaim Evidence Experiments

Branch: `v3-rebuild`. All runs executed 2026-11-11 against live GitHub API,
live Reclaim attestor, and live NEAR testnet views. No transactions sent, no
state changed, no secrets stored (proof fixtures contain public attestations
+ signatures only).

Method notes:
- zkFetch ran via pinned `@reclaimprotocol/zk-fetch@1.1.0` with the repo's
  existing Devtool credentials (presence-verified, values never printed).
- Sandbox egress passes 443 only; Reclaim's live flag steers to :444, so
  experiment scripts rewrite ONLY that flag response to the SDK's canonical
  `:443` attestor (documented in-script). All SDK logic/credentials/matchers
  ran stock. A user-machine re-run without the shim is recommended as
  confirmation (scripts accept it unmodified — delete the 3-line shim call).
- Every proof was verified by: UI shape gate + identifier recompute +
  ecrecover + live epoch witness-set equality + freshness window, plus
  ground-truth field comparison. One dry_run OK through the deployed V2
  contract (read-only view).

## Experiment verdicts

| ID | Target | Result | Time | Proof bytes |
|----|--------|--------|------|-------------|
| EXP-00 | backend/app-record/WSS reachability | PASS (app "OmniBounty" exists; WSS:443 opens) | 10–14s probes | — |
| EXP-00b | no-proxy control | PASS (proves egress is proxy-mediated, 443-only) | <1s fails | — |
| EXP-01 | stock path (:444) | FAIL environmentally (3× 90s RPC timeouts) | ~6min | — |
| EXP-01b | PR, current 4 matchers | PASS + live nullifier proven (IDENTIFIER_REPLAY on re-claim) | 47.7s | 1,366 |
| EXP-01c | PR, 5 matchers | PASS + dry_run bounty #4 **OK** | 41.6s | 1,475 |
| EXP-02 | identity: +head/author-assoc/base SHA | PASS 7/7 exact | 21.3s | 1,957 |
| EXP-03a | check-run LIST binding (307KB page) | PASS (anchored name→conclusion/head + total_count) | 22.3s | 1,517 |
| EXP-03b | single check-run (7 fields) | PASS 7/7 exact | 4.4s | 1,922 |
| EXP-04a | files rows + contains probe | PASS | 22.1s | 1,430 |
| EXP-04b | absent-file matcher (negative) | PASS (fail-closed "Invalid receipt") | fast-fail | — |
| EXP-05a | body contains + first label | PASS | 21.1s | 1,295 |
| EXP-05b | reviews (reviewer/state/commit) | PASS 3/3 | 4.6s | 1,561 |
| EXP-07 | 3 negatives via dry_run views | PASS (mismatch / tamper / predicate classes) | views only | — |
| EXP-08 | Accept-pinned diff proof | PASS (headers in signed params, diff attested) | 20.9s | 1,451 |

9 proof fixtures in `fixtures/` (1.3–2.1 KB each — proof size is
independent of response size).

## Evidence matrix verdicts

- **A. Identity** — SUPPORTED: number, author login, repo, merged, head SHA,
  author association, base SHA. First-match safe for exact keys; nesting needs
  anchored patterns (proven).
- **B. Check-runs** — SUPPORTED with discipline: list binding works iff the
  anchor is page-unique (occurrence-count gate demonstrated); single-run
  objects bind precisely. `total_count` attestation enables page-completeness
  proofs (bind `total_count <= per_page`).
- **C. Files/diff** — SUPPORTED for rows, counts, patch-contains; absence is
  UNPROVABLE by design (non-match fails the proof). Protected-file integrity
  must use allowlist comparison or per-file blob proofs, never absence
  patterns. Diff representation is attestable; pin via Accept (see Q7).
- **D. Body/labels/reviews** — SUPPORTED for contains, first-label, and
  (single-review-verified) reviewer/state/commit. Multi-review binding follows
  the EXP-03A anchor discipline (one confirmatory run recommended).
- **Workflow integrity** — PARTIAL: app slug + check identity + head SHA bind
  precisely; workflow FILE content/provenance needs contents-API proofs (same
  mechanism, not yet executed — Phase 2 task).

## The 8 critical questions

1. **Pinned Devtool flow works? YES** — 9 proofs generated and verified with
   zk-fetch 1.1.0 + existing credentials; app record live ("OmniBounty").
2. **Builder migration required? NO** — not for the current flow. Revisit if
   Reclaim retires the :443/Devtool path (watch: flag now steers to :444).
3. **Witness discovery? OPERATIONALLY SOLVED** — epoch comes in the proof;
   pinned set comes from the `get_epoch` view; equality verified live
   (epoch 1, witness 0x2448…). Canonical upstream registry still undocumented.
4. **Individual check-run proofs? YES** — EXP-03b, 7/7 fields, 4.4s.
5. **Cross-referenced multi-proof? YES, mechanism proven** — head SHAs extracted
   from PR + check-run + review proofs are byte-comparable; on-chain
   cross-checking is a V3 contract task (current template takes one proof).
6. **Protected-file integrity without absence/pagination traps? VIABLE VIA
   ALLOWLIST** — attest file list (or per-file blob SHAs) + contract-side
   comparison against committed allowlist + `total_count` completeness.
   Absence patterns proven impossible (EXP-04b).
7. **Accept bound to proof? YES** — headers are inside signed params
   (observed verbatim); V3 template can pin them. Closes the audit's Accept gap
   with no SDK change.
8. **Practical limits?** Largest response attested: 307KB/100 rows in 22.3s.
   Proof JSON stays ~1.4–2.1KB regardless. Contexts observed « 1KB vs the
   16KB on-chain cap. Matcher values used ≤ ~90 chars vs 512B cap; ≤7 matchers
   used vs 16 cap. Multi-MB single responses untested (flagged, not blocking:
   design around small single-object endpoints + total_count-gated pages).

## Security limitations discovered (all with execution evidence)

- L1. Attestor fails CLOSED on any non-matching matcher ("Invalid receipt") —
  good failure mode, confirmed 3 distinct ways (EXP-02 first attempt, EXP-04b).
- L2. First-match semantics demand per-endpoint-validated anchored patterns;
  naive patterns silently bind wrong values or fail (EXP-02 base-sha case).
- L3. Identifier binds (params, context) only — same PR+matchers can never
  back two bounties; timestamp/epoch/claimant are signed but NOT in the
  identifier (EXP-01b replay). V3 must scope identifiers per bounty/recipient.
- L4. Proofs are point-in-time: body/labels/reviews are mutable post-proof;
  the 7d window bounds staleness, it does not prevent it.
- L5. Claim timestampS is fetch-time, not event-time: `completed_at` strings
  are attestable as data, but only the attestation instant is cryptographically
  fresh. V3 must treat event timestamps as claims, not proofs.
- L6. Sandbox :444 egress blocked forced the documented :443 steering; a
  user-machine unshimmed confirmation run is recommended (scripts support it).

## V3 design inputs (binding rules established)

- R1. One proof per object; cross-reference on-chain (head SHA joins PR ↔
  checks ↔ reviews ↔ files).
- R2. Every array matcher ships with a proven anchor-uniqueness argument
  (occurrence gate) + total_count/per_page completeness binding.
- R3. Identifiers must bind bounty_id + recipient (or equivalent) in V3.
- R4. Pin method + URL + required headers (Accept) + matcher set hash in the
  criteria commitment.
- R5. Protected paths via committed allowlist + attested file list comparison,
  never absence.
- R6. Point-in-time + freshness semantics stated explicitly per evidence type.

## Open / recommended follow-ups

- F1. User-machine unshimmed re-run of EXP-01c (confirms :444 path health).
- F2. Confirmatory multi-review binding run (mechanism proven, second instance).
- F3. Live ProofTooOld execution impossible without a >7d-old real proof
  (covered by existing Rust unit tests instead — honestly bounded).
- F4. Multi-MB response stress (design avoids it; run once if V3 needs it).
- F5. Workflow-file contents proof (mechanism clear, execution deferred to V3).
